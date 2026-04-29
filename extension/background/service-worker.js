// Main background script. Owns the agent loop: receives a user message
// from the side panel, calls the configured LLM, executes any requested
// tools, feeds results back, and streams progress events to the panel.

import { getSettings, getConversation, saveConversation, newConversation } from "../lib/storage.js";
import { callProvider } from "../lib/providers/index.js";
import { browserTools, getEnabledTools } from "../lib/tools/browser-tools.js";
import { gatherMcpTools, callTool as callMcpTool } from "../lib/mcp/mcp-client.js";

// Open the side panel when the toolbar action is clicked. Set up the
// context menu items idempotently — onInstalled fires on install and update,
// but the menus persist, so we removeAll() first.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.warn("setPanelBehavior:", e));

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "ask-ai-page",
      title: "Ask AI about this page",
      contexts: ["page"]
    });
    chrome.contextMenus.create({
      id: "ask-ai-selection",
      title: "Ask AI about: \"%s\"",
      contexts: ["selection"]
    });
  });
});

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (e) {
    console.warn("sidePanel.open failed:", e);
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  await chrome.sidePanel.open({ windowId: tab.windowId });
  const seed =
    info.menuItemId === "ask-ai-selection"
      ? `Tell me more about this selection on ${tab.url}:\n\n"${info.selectionText}"`
      : `Summarize the page at ${tab.url}.`;
  // Slight delay so the panel script is up before we send.
  setTimeout(() => chrome.runtime.sendMessage({ type: "seed-input", text: seed }), 400);
});

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

const sessions = new Map(); // sessionId → { abort: AbortController }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "agent:run") {
    runAgent(msg.payload).catch((err) => {
      console.error(err);
      chrome.runtime.sendMessage({
        type: "agent:event",
        event: { kind: "error", message: String(err.message || err) }
      });
    });
    sendResponse({ ok: true });
    return true;
  }
  if (msg?.type === "agent:cancel") {
    const s = sessions.get(msg.sessionId);
    if (s) s.abort.abort();
    sendResponse({ ok: true });
    return true;
  }
  if (msg?.type === "tool:approve") {
    pendingApprovals.get(msg.callId)?.(msg.approved);
    pendingApprovals.delete(msg.callId);
    return false;
  }
  return false;
});

const pendingApprovals = new Map();

function emit(event) {
  chrome.runtime.sendMessage({ type: "agent:event", event }).catch(() => {});
}

async function requestApproval(call) {
  return new Promise((resolve) => {
    pendingApprovals.set(call.id, resolve);
    emit({ kind: "tool-approval-request", call });
  });
}

async function runAgent({ conversationId, userText, attachments }) {
  const settings = await getSettings();

  // Load or create conversation
  let convo =
    (conversationId && (await getConversation(conversationId))) ||
    newConversation(userText.slice(0, 60));
  convo.messages.push({
    role: "user",
    content: userText,
    attachments,
    ts: Date.now()
  });

  const sessionId = crypto.randomUUID();
  const abort = new AbortController();
  sessions.set(sessionId, { abort });
  emit({ kind: "session-start", sessionId, conversationId: convo.id });

  // Build the tool list
  const localTools = getEnabledTools(settings.enabledTools);
  const mcpTools = await gatherMcpTools(settings.mcpServers || []);
  const toolDefs = [
    ...Object.entries(localTools).map(([name, t]) => ({
      name,
      description: t.description,
      input_schema: t.input_schema
    })),
    ...mcpTools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema
    }))
  ];

  // Convert convo.messages → provider-neutral message stream
  const wireMessages = convo.messages.map((m) => {
    if (m.role === "user")
      return { role: "user", content: m.content };
    if (m.role === "assistant")
      return { role: "assistant", content: m.content };
    if (m.role === "tool")
      return {
        role: "tool",
        tool_use_id: m.tool_use_id,
        tool_name: m.tool_name,
        content: m.content,
        is_error: m.is_error
      };
    return m;
  });

  const maxIterations = settings.maxToolIterations || 12;
  let iter = 0;

  while (iter++ < maxIterations) {
    if (abort.signal.aborted) break;

    emit({ kind: "thinking", iteration: iter });

    const reply = await callProvider(settings, {
      system: settings.systemPrompt,
      messages: wireMessages,
      tools: toolDefs
    });

    // Persist the assistant turn
    convo.messages.push({
      role: "assistant",
      content: reply.assistantContent,
      ts: Date.now()
    });
    wireMessages.push({ role: "assistant", content: reply.assistantContent });

    if (reply.text) emit({ kind: "assistant-text", text: reply.text });

    if (!reply.toolCalls?.length) {
      emit({ kind: "done", stopReason: reply.stopReason });
      break;
    }

    // Execute each tool call
    for (const call of reply.toolCalls) {
      if (abort.signal.aborted) break;
      emit({ kind: "tool-call", call });

      let approved = true;
      const isLocal = !!localTools[call.name];
      const needsApproval =
        settings.approvalMode === "all" ||
        (settings.approvalMode === "writes" && !isReadOnly(call.name));
      if (needsApproval) approved = await requestApproval(call);

      let result, isError = false;
      if (!approved) {
        result = "User denied this tool call.";
        isError = true;
      } else {
        try {
          if (isLocal) {
            result = await localTools[call.name].execute(call.args || {});
          } else {
            const mcpDef = mcpTools.find((t) => t.name === call.name);
            if (!mcpDef) throw new Error(`Unknown tool: ${call.name}`);
            result = await callMcpTool(mcpDef, call.args || {});
          }
        } catch (e) {
          result = String(e.message || e);
          isError = true;
        }
      }

      const serialized =
        typeof result === "string" ? result : JSON.stringify(result, null, 2);
      emit({
        kind: "tool-result",
        callId: call.id,
        name: call.name,
        result: truncateForUI(serialized),
        isError
      });

      const toolMsg = {
        role: "tool",
        tool_use_id: call.id,
        tool_name: call.name,
        content: serialized,
        is_error: isError,
        ts: Date.now()
      };
      convo.messages.push(toolMsg);
      wireMessages.push(toolMsg);
    }
  }

  if (iter >= maxIterations)
    emit({ kind: "warning", message: `Hit max tool iterations (${maxIterations}).` });

  convo.updatedAt = Date.now();
  // First-line title heuristic if we just created it
  if (!convo.title || convo.title === "New chat") {
    const firstUser = convo.messages.find((m) => m.role === "user");
    if (firstUser) convo.title = firstUser.content.slice(0, 60);
  }
  await saveConversation(convo);
  emit({ kind: "session-end", conversationId: convo.id });
  sessions.delete(sessionId);
}

function isReadOnly(name) {
  return [
    "browser_get_page",
    "browser_query",
    "browser_screenshot",
    "tabs_list",
    "cookies_get"
  ].includes(name);
}

function truncateForUI(s, max = 4000) {
  return s.length > max ? s.slice(0, max) + `\n…[+${s.length - max} chars]` : s;
}

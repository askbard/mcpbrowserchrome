import { getSettings } from "../lib/storage.js";
import { PROVIDERS } from "../lib/providers/index.js";

const $ = (sel) => document.querySelector(sel);
const messagesEl = $("#messages");
const inputEl = $("#input");
const sendBtn = $("#send");
const stopBtn = $("#stop");
const newChatBtn = $("#new-chat");
const settingsBtn = $("#open-settings");
const modelChip = $("#current-model");
const modelChipText = $("#current-model-text");
const statusEl = $("#status");
const approvalEl = $("#approval");
const approvalBody = $("#approval-body");
const approveBtn = $("#approve");
const denyBtn = $("#deny");

let currentConversationId = null;
let pendingToolEls = new Map(); // call.id → element
let activeAssistantEl = null;
let currentApprovalCallId = null;
let currentSessionId = null;

// ---------- init ----------

(async function init() {
  const s = await getSettings();
  updateModelChip(s);
  if (!s.apiKeys[s.provider] && PROVIDERS[s.provider].needsKey) {
    appendSystem(
      `No API key for ${PROVIDERS[s.provider].label}. ` +
        "Click ⚙ to open settings and add one."
    );
  } else {
    appendSystem("Ready. Ask anything, or instruct me to act on this tab.");
  }
})();

modelChip.addEventListener("click", () => chrome.runtime.openOptionsPage());

// Live-update the chip whenever settings change (e.g. user saves in options).
chrome.storage.onChanged?.addListener(async (changes, area) => {
  if (area !== "sync" || !changes.settings) return;
  const s = await getSettings();
  updateModelChip(s);
});

function updateModelChip(s) {
  const p = PROVIDERS[s.provider];
  const label = p?.label?.split(" ")[0] || s.provider;
  const model =
    s.provider === "custom" ? s.customModel || "(no model)" : s.model || "(no model)";
  modelChipText.textContent = `${label} · ${model}`;
}

// ---------- send ----------

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
sendBtn.addEventListener("click", send);
stopBtn.addEventListener("click", () => {
  if (currentSessionId)
    chrome.runtime.sendMessage({ type: "agent:cancel", sessionId: currentSessionId });
});
newChatBtn.addEventListener("click", () => {
  currentConversationId = null;
  messagesEl.innerHTML = "";
  appendSystem("New chat started.");
});
settingsBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

approveBtn.addEventListener("click", () => sendApproval(true));
denyBtn.addEventListener("click", () => sendApproval(false));

function sendApproval(approved) {
  if (!currentApprovalCallId) return;
  chrome.runtime.sendMessage({
    type: "tool:approve",
    callId: currentApprovalCallId,
    approved
  });
  approvalEl.classList.add("hidden");
  currentApprovalCallId = null;
}

async function send() {
  const text = inputEl.value.trim();
  if (!text) return;
  appendUser(text);
  inputEl.value = "";
  setBusy(true);
  activeAssistantEl = null;
  pendingToolEls.clear();
  appendThinking();
  chrome.runtime.sendMessage({
    type: "agent:run",
    payload: { conversationId: currentConversationId, userText: text }
  });
}

function setBusy(busy) {
  sendBtn.disabled = busy;
  inputEl.disabled = busy;
  stopBtn.classList.toggle("hidden", !busy);
  statusEl.textContent = busy ? "Working…" : "";
}

// ---------- agent events ----------

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "seed-input") {
    inputEl.value = msg.text;
    inputEl.focus();
    return;
  }
  if (msg?.type !== "agent:event") return;
  handleEvent(msg.event);
});

function handleEvent(ev) {
  switch (ev.kind) {
    case "session-start":
      currentSessionId = ev.sessionId;
      currentConversationId = ev.conversationId;
      break;
    case "thinking":
      ensureThinking(`Thinking… (step ${ev.iteration})`);
      break;
    case "assistant-text":
      removeThinking();
      appendAssistant(ev.text);
      break;
    case "tool-call":
      removeThinking();
      appendToolCall(ev.call);
      break;
    case "tool-result":
      finalizeToolCall(ev);
      break;
    case "tool-approval-request":
      showApproval(ev.call);
      break;
    case "warning":
      appendWarning(ev.message);
      break;
    case "error":
      removeThinking();
      appendError(ev.message);
      setBusy(false);
      break;
    case "session-end":
      removeThinking();
      currentSessionId = null;
      setBusy(false);
      break;
    case "done":
      // session-end will follow
      break;
  }
}

// ---------- DOM helpers ----------

function appendUser(text) {
  const el = document.createElement("div");
  el.className = "msg user";
  el.textContent = text;
  messagesEl.appendChild(el);
  scroll();
}

function appendAssistant(text) {
  const el = document.createElement("div");
  el.className = "msg assistant";
  el.textContent = text;
  messagesEl.appendChild(el);
  activeAssistantEl = el;
  scroll();
}

function appendSystem(text) {
  const el = document.createElement("div");
  el.className = "msg system";
  el.textContent = text;
  messagesEl.appendChild(el);
  scroll();
}

function appendError(text) {
  const el = document.createElement("div");
  el.className = "msg error";
  el.textContent = "Error: " + text;
  messagesEl.appendChild(el);
  scroll();
}

function appendWarning(text) {
  const el = document.createElement("div");
  el.className = "msg warning";
  el.textContent = text;
  messagesEl.appendChild(el);
  scroll();
}

function appendThinking() {
  removeThinking();
  const el = document.createElement("div");
  el.className = "thinking";
  el.id = "thinking-row";
  el.textContent = "Thinking…";
  messagesEl.appendChild(el);
  scroll();
}

function ensureThinking(text) {
  let el = document.getElementById("thinking-row");
  if (!el) {
    el = document.createElement("div");
    el.className = "thinking";
    el.id = "thinking-row";
    messagesEl.appendChild(el);
  }
  el.textContent = text;
  scroll();
}

function removeThinking() {
  document.getElementById("thinking-row")?.remove();
}

function appendToolCall(call) {
  const el = document.createElement("details");
  el.className = "tool";
  el.open = true;
  const head = document.createElement("summary");
  head.className = "tool-head";
  head.innerHTML = `<span><span class="chev">▶</span> ${escapeHtml(call.name)}</span><span>running…</span>`;
  el.appendChild(head);
  const args = document.createElement("pre");
  args.textContent = JSON.stringify(call.args, null, 2);
  el.appendChild(args);
  messagesEl.appendChild(el);
  pendingToolEls.set(call.id, el);
  scroll();
}

function finalizeToolCall(ev) {
  const el = pendingToolEls.get(ev.callId);
  if (!el) return;
  if (ev.isError) el.classList.add("error");
  const head = el.querySelector(".tool-head");
  head.lastElementChild.textContent = ev.isError ? "error" : "ok";

  // If the result is a screenshot data URL, render the image inline.
  let body;
  try {
    const parsed = JSON.parse(ev.result);
    if (parsed && typeof parsed.image === "string" && parsed.image.startsWith("data:image/")) {
      const img = document.createElement("img");
      img.className = "screenshot";
      img.src = parsed.image;
      el.appendChild(img);
      return;
    }
  } catch {}
  body = document.createElement("pre");
  body.textContent = ev.result;
  el.appendChild(body);
  scroll();
}

function showApproval(call) {
  currentApprovalCallId = call.id;
  approvalBody.textContent = `${call.name}\n\n${JSON.stringify(call.args, null, 2)}`;
  approvalEl.classList.remove("hidden");
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

function scroll() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

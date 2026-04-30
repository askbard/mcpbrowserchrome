// Connects the extension to a local MCP bridge server. While Bridge mode
// is enabled, the extension long-polls the bridge for incoming MCP tool
// calls and dispatches them through the same browserTools registry the
// in-panel agent uses.
//
// MV3 detail: an in-flight fetch keeps the service worker alive, so the
// long-poll loop also serves as a keep-alive.

import { browserTools, getEnabledTools } from "../tools/browser-tools.js";
import { getSettings } from "../storage.js";

let activeAbort = null;
let activeBaseUrl = null;

export async function startBridgeIfEnabled() {
  const settings = await getSettings();
  if (!settings.bridgeEnabled) return stop("disabled");
  const url = (settings.bridgeUrl || "http://127.0.0.1:7842").replace(/\/+$/, "");
  if (activeBaseUrl === url && activeAbort) return; // already running
  stop("restart");
  activeBaseUrl = url;
  activeAbort = new AbortController();
  const signal = activeAbort.signal;
  registerLoop(url, signal);
  pollLoop(url, signal);
  console.log(`[bridge-client] started → ${url}`);
}

export function stop(reason = "stop") {
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
    activeBaseUrl = null;
    console.log(`[bridge-client] stopped (${reason})`);
  }
}

async function registerLoop(baseUrl, signal) {
  while (!signal.aborted) {
    try {
      const settings = await getSettings();
      const enabled = getEnabledTools(settings.enabledTools);
      const tools = Object.entries(enabled).map(([name, t]) => ({
        name,
        description: t.description,
        inputSchema: t.input_schema || { type: "object", properties: {} }
      }));
      const res = await fetch(`${baseUrl}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tools }),
        signal
      });
      if (!res.ok) throw new Error("register " + res.status);
      await sleep(60_000, signal); // re-register periodically (heartbeat)
    } catch (e) {
      if (signal.aborted) return;
      console.warn("[bridge-client] register failed:", e.message);
      await sleep(5_000, signal);
    }
  }
}

async function pollLoop(baseUrl, signal) {
  while (!signal.aborted) {
    try {
      const res = await fetch(`${baseUrl}/poll`, { signal });
      if (!res.ok) throw new Error("poll " + res.status);
      const data = await res.json();
      if (data.call) {
        // fire-and-forget: don't block the next poll on this call
        handleCall(baseUrl, data.call).catch((e) =>
          console.error("[bridge-client] handleCall:", e)
        );
      }
    } catch (e) {
      if (signal.aborted) return;
      console.warn("[bridge-client] poll failed:", e.message);
      await sleep(2_000, signal);
    }
  }
}

async function handleCall(baseUrl, call) {
  const settings = await getSettings();
  const enabled = getEnabledTools(settings.enabledTools);
  const tool = enabled[call.name];

  let payload;
  if (!tool) {
    payload = { callId: call.id, error: `Unknown or disabled tool: ${call.name}` };
  } else {
    try {
      const out = await tool.execute(call.arguments || {});
      payload = { callId: call.id, result: wrapAsMcpResult(out) };
    } catch (e) {
      payload = { callId: call.id, error: e.message || String(e) };
    }
  }

  await fetch(`${baseUrl}/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }).catch((e) => console.warn("[bridge-client] result post failed:", e.message));
}

// Convert a tool's native return into an MCP `content` array.
function wrapAsMcpResult(out) {
  // Screenshot: return as MCP image content.
  if (out && typeof out === "object" && typeof out.image === "string") {
    const m = out.image.match(/^data:image\/([^;]+);base64,(.+)$/);
    if (m) {
      return {
        content: [{ type: "image", mimeType: `image/${m[1]}`, data: m[2] }]
      };
    }
  }
  const text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
  return { content: [{ type: "text", text }] };
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

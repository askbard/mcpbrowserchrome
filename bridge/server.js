#!/usr/bin/env node
// MCP bridge: tiny local HTTP server that lets external MCP clients drive
// the Chrome extension's browser tools.
//
//   [ MCP client ] ──POST /mcp──▶ [ bridge ] ◀──long-poll /poll── [ extension ]
//
// Zero dependencies. Run with: node bridge/server.js [PORT]

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = parseInt(process.env.PORT || process.argv[2] || "7842", 10);
const HOST = process.env.HOST || "127.0.0.1";
const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "mcpbrowserchrome-bridge", version: "0.1.0" };

// ---- state ----
let workerTools = []; // last-registered tool list from the extension
let lastWorkerSeen = 0;
const pendingCalls = new Map(); // callId → { resolve }
const queuedCalls = []; // calls waiting for a poller
const workerWaiters = []; // poll responses awaiting a call

// ---- helpers ----
const json = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
const noBody = (res, code) => {
  res.writeHead(code);
  res.end();
};
const readBody = (req) =>
  new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
const rpcOk = (res, id, result) =>
  json(res, 200, { jsonrpc: "2.0", id, result });
const rpcErr = (res, id, code, message) =>
  json(res, 200, { jsonrpc: "2.0", id, error: { code, message } });

// ---- /mcp: MCP Streamable-HTTP-style endpoint (JSON variant) ----
async function handleMcp(req, res) {
  if (req.method !== "POST") return noBody(res, 405);
  let rpc;
  try {
    rpc = JSON.parse(await readBody(req));
  } catch {
    return rpcErr(res, null, -32700, "Parse error");
  }

  switch (rpc.method) {
    case "initialize":
      return rpcOk(res, rpc.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: true } },
        serverInfo: SERVER_INFO
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      return noBody(res, 202);

    case "tools/list":
      if (!isWorkerAlive()) {
        return rpcErr(
          res,
          rpc.id,
          -32000,
          "No browser worker connected. Open the Chrome extension, " +
            "enable Bridge mode in Settings, and try again."
        );
      }
      return rpcOk(res, rpc.id, { tools: workerTools });

    case "tools/call":
      return handleToolsCall(req, res, rpc);

    case "ping":
      return rpcOk(res, rpc.id, {});

    default:
      return rpcErr(res, rpc.id ?? null, -32601, `Method not found: ${rpc.method}`);
  }
}

async function handleToolsCall(req, res, rpc) {
  if (!isWorkerAlive()) {
    return rpcErr(res, rpc.id, -32000, "Browser worker not connected.");
  }
  if (!rpc.params?.name) {
    return rpcErr(res, rpc.id, -32602, "Missing params.name");
  }
  const callId = randomUUID();
  const call = {
    id: callId,
    name: rpc.params.name,
    arguments: rpc.params.arguments || {}
  };

  let timer;
  const resultPromise = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      pendingCalls.delete(callId);
      reject(new Error("Tool call timed out (60s)"));
    }, 60_000);
    pendingCalls.set(callId, {
      resolve: (r) => {
        clearTimeout(timer);
        resolve(r);
      }
    });
  });

  // Deliver to a waiting poller, else queue it.
  const waiter = workerWaiters.shift();
  if (waiter) waiter.deliver(call);
  else queuedCalls.push(call);

  // Cancel if the MCP client disconnects.
  req.on("close", () => {
    if (pendingCalls.has(callId)) {
      clearTimeout(timer);
      pendingCalls.delete(callId);
    }
  });

  try {
    const result = await resultPromise;
    return rpcOk(res, rpc.id, result);
  } catch (e) {
    return rpcErr(res, rpc.id, -32000, e.message);
  }
}

function isWorkerAlive() {
  // Fresh registration (~last 5 min) AND a current or recent poller.
  return workerTools.length > 0 && Date.now() - lastWorkerSeen < 5 * 60_000;
}

// ---- /register: extension declares its tool list ----
async function handleRegister(req, res) {
  if (req.method !== "POST") return noBody(res, 405);
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: "bad json" });
  }
  workerTools = Array.isArray(body.tools) ? body.tools : [];
  lastWorkerSeen = Date.now();
  console.log(`[bridge] worker registered ${workerTools.length} tool(s)`);
  return json(res, 200, { ok: true });
}

// ---- /poll: extension long-polls for a pending tool call ----
function handlePoll(req, res) {
  if (req.method !== "GET") return noBody(res, 405);
  lastWorkerSeen = Date.now();

  if (queuedCalls.length) {
    const call = queuedCalls.shift();
    return json(res, 200, { call });
  }

  let timer;
  const waiter = {
    deliver: (call) => {
      clearTimeout(timer);
      json(res, 200, { call });
    }
  };
  workerWaiters.push(waiter);
  timer = setTimeout(() => {
    const i = workerWaiters.indexOf(waiter);
    if (i >= 0) workerWaiters.splice(i, 1);
    json(res, 200, { idle: true });
  }, 25_000);

  req.on("close", () => {
    clearTimeout(timer);
    const i = workerWaiters.indexOf(waiter);
    if (i >= 0) workerWaiters.splice(i, 1);
  });
}

// ---- /result: extension returns a tool result ----
async function handleResult(req, res) {
  if (req.method !== "POST") return noBody(res, 405);
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: "bad json" });
  }
  const pending = pendingCalls.get(body.callId);
  if (!pending) return noBody(res, 404);
  pendingCalls.delete(body.callId);

  if (body.error) {
    pending.resolve({
      content: [{ type: "text", text: String(body.error) }],
      isError: true
    });
  } else {
    pending.resolve(body.result);
  }
  return noBody(res, 204);
}

// ---- /health ----
function handleHealth(_req, res) {
  return json(res, 200, {
    ok: true,
    workerConnected: isWorkerAlive(),
    toolsRegistered: workerTools.length,
    pendingCalls: pendingCalls.size,
    queuedCalls: queuedCalls.length
  });
}

// ---- top-level dispatcher ----
const server = createServer(async (req, res) => {
  // Permissive CORS for browser-extension and local mcp-inspector use.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return noBody(res, 204);

  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/mcp") return await handleMcp(req, res);
    if (url.pathname === "/register") return await handleRegister(req, res);
    if (url.pathname === "/poll") return handlePoll(req, res);
    if (url.pathname === "/result") return await handleResult(req, res);
    if (url.pathname === "/health") return handleHealth(req, res);
    return noBody(res, 404);
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`MCP bridge listening on http://${HOST}:${PORT}`);
  console.log(`  MCP endpoint:    POST http://${HOST}:${PORT}/mcp`);
  console.log(`  Health:          GET  http://${HOST}:${PORT}/health`);
  console.log(`Open the Chrome extension and enable Bridge mode in Settings.`);
});

// Export for tests.
export { server, handleMcp, handleRegister, handlePoll, handleResult };

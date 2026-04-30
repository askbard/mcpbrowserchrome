// End-to-end smoke test for the local MCP bridge.
// Spawns the bridge as a child process on a random port, then plays both
// roles: the MCP client (POST /mcp) and the browser worker (long-polls
// /poll, posts /result).

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import net from "node:net";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, "..", "bridge", "server.js");

let pass = 0,
  fail = 0;
const ok = (c, l) => {
  console.log((c ? "  ok  -" : "  FAIL -") + " " + l);
  c ? pass++ : fail++;
};

function pickPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

const PORT = await pickPort();
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"]
});
child.stdout.on("data", () => {});
child.stderr.on("data", (d) => process.stderr.write(`[bridge] ${d}`));

// Wait until the bridge is listening
async function waitForServer(timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("bridge did not start in time");
}

try {
  await waitForServer();

  // ---- 1. health before any worker registers ----
  console.log("\nbridge: health (no worker)");
  let health = await (await fetch(`${BASE}/health`)).json();
  ok(health.ok === true, "health.ok = true");
  ok(health.workerConnected === false, "no worker yet");
  ok(health.toolsRegistered === 0, "no tools yet");

  // ---- 2. tools/list before worker is registered → MCP error ----
  console.log("\nbridge: tools/list before registration");
  let resp = await (
    await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    })
  ).json();
  ok(resp.error?.code === -32000, "tools/list returns -32000 with helpful message");
  ok(/no browser worker/i.test(resp.error.message), "message names the worker");

  // ---- 3. worker registers tool list ----
  console.log("\nbridge: /register");
  const fakeTools = [
    {
      name: "echo",
      description: "echo input back",
      inputSchema: {
        type: "object",
        properties: { msg: { type: "string" } },
        required: ["msg"]
      }
    }
  ];
  resp = await (
    await fetch(`${BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tools: fakeTools })
    })
  ).json();
  ok(resp.ok === true, "register returns ok:true");

  // ---- 4. tools/list now succeeds ----
  console.log("\nbridge: tools/list");
  resp = await (
    await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    })
  ).json();
  ok(Array.isArray(resp.result?.tools), "tools/list returns array");
  ok(resp.result.tools[0].name === "echo", "tool round-trips");

  // ---- 5. initialize ----
  console.log("\nbridge: initialize");
  resp = await (
    await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" }
      })
    })
  ).json();
  ok(typeof resp.result?.protocolVersion === "string", "initialize returns protocolVersion");
  ok(resp.result?.serverInfo?.name?.includes("bridge"), "serverInfo.name is set");
  ok(resp.result?.capabilities?.tools, "capabilities.tools advertised");

  // ---- 6. tools/call: simulate the browser worker side concurrently ----
  console.log("\nbridge: tools/call (simulated worker)");
  // Start a poller (worker side)
  const pollPromise = (async () => {
    const r = await fetch(`${BASE}/poll`);
    return r.json();
  })();

  // Send a tools/call from the "client" side
  const callPromise = (async () => {
    const r = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "echo", arguments: { msg: "hi" } }
      })
    });
    return r.json();
  })();

  // Worker receives the call
  const polled = await pollPromise;
  ok(polled.call?.name === "echo", "worker poll receives the call by name");
  ok(polled.call.arguments.msg === "hi", "worker poll receives the arguments");

  // Worker posts the result
  await fetch(`${BASE}/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callId: polled.call.id,
      result: { content: [{ type: "text", text: "echo: hi" }] }
    })
  });

  // Client receives the wrapped result
  const callResp = await callPromise;
  ok(callResp.result?.content?.[0]?.text === "echo: hi", "client gets MCP result back");

  // ---- 7. tools/call error path ----
  console.log("\nbridge: tools/call error path");
  const pollPromise2 = (async () => (await fetch(`${BASE}/poll`)).json())();
  const callPromise2 = (async () =>
    (
      await fetch(`${BASE}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "echo", arguments: {} }
        })
      })
    ).json())();
  const polled2 = await pollPromise2;
  await fetch(`${BASE}/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callId: polled2.call.id, error: "missing required field 'msg'" })
  });
  const callResp2 = await callPromise2;
  ok(callResp2.result?.isError === true, "error result has isError:true");
  ok(/missing required/.test(callResp2.result.content[0].text), "error message preserved");

  // ---- 8. unknown method ----
  console.log("\nbridge: unknown method");
  resp = await (
    await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "does/not/exist" })
    })
  ).json();
  ok(resp.error?.code === -32601, "unknown method → -32601");

  // ---- 9. bad JSON ----
  console.log("\nbridge: bad JSON");
  resp = await (
    await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ this is not json"
    })
  ).json();
  ok(resp.error?.code === -32700, "bad JSON → -32700 parse error");

  console.log(`\n${pass} passed, ${fail} failed`);
} finally {
  child.kill("SIGTERM");
}

process.exit(fail ? 1 : 0);

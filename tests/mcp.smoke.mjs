// Smoke test for the MCP client: list tools + call a tool, with both
// JSON and SSE-wrapped responses (Streamable HTTP servers may return SSE).

import { listTools, callTool } from "../extension/lib/mcp/mcp-client.js";

let calls = [];
let nextResponse;

globalThis.fetch = async (url, init) => {
  calls.push({ url, init, body: JSON.parse(init.body) });
  const r = nextResponse;
  return {
    ok: true,
    status: 200,
    async text() {
      return r;
    }
  };
};

let pass = 0,
  fail = 0;
const ok = (cond, label) => {
  console.log((cond ? "  ok  -" : "  FAIL -") + " " + label);
  cond ? pass++ : fail++;
};

const server = {
  name: "demo",
  url: "https://mcp.example/mcp",
  headers: { "X-Test": "1" }
};

// 1. tools/list with plain JSON
console.log("\nMCP listTools (JSON)");
nextResponse = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: {
    tools: [
      {
        name: "ping",
        description: "say pong",
        inputSchema: { type: "object", properties: {} }
      }
    ]
  }
});
let tools = await listTools(server);
ok(tools.length === 1, "one tool returned");
ok(tools[0].name === "mcp__demo__ping", "tool namespaced as mcp__<server>__<name>");
ok(calls[0].body.method === "tools/list", "JSON-RPC method tools/list");
ok(calls[0].init.headers["X-Test"] === "1", "custom headers forwarded");

// 2. tools/call with SSE-wrapped response (Streamable HTTP style)
console.log("\nMCP callTool (SSE)");
calls = [];
nextResponse = [
  "event: message",
  'data: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"pong"}]}}',
  ""
].join("\n");
const result = await callTool(tools[0], { hello: "world" });
ok(result === "pong", "SSE-wrapped result parsed and content flattened");
ok(calls[0].body.method === "tools/call", "JSON-RPC method tools/call");
ok(calls[0].body.params.name === "ping", "passes original (non-namespaced) tool name");
ok(calls[0].body.params.arguments.hello === "world", "passes arguments through");

// 3. list tools failure swallowed
console.log("\nMCP listTools (error)");
nextResponse = JSON.stringify({
  jsonrpc: "2.0",
  id: 3,
  error: { code: -32000, message: "boom" }
});
const empty = await listTools(server);
ok(Array.isArray(empty) && empty.length === 0, "listTools returns [] on error");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

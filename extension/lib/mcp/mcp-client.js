// Minimal client for external MCP (Model Context Protocol) servers reachable
// over HTTP/SSE. Speaks JSON-RPC 2.0. Each registered server adds its tools
// into the model's tool list under a `mcp__<server>__<tool>` namespace.

let _id = 0;
const nextId = () => ++_id;

async function rpc(server, method, params) {
  const res = await fetch(server.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(server.headers || {})
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId(), method, params })
  });
  if (!res.ok) throw new Error(`MCP ${server.name} ${method}: ${res.status}`);
  const text = await res.text();
  // Streamable HTTP servers may return SSE; pick the last `data:` line.
  let body = text;
  if (text.startsWith("event:") || text.includes("\ndata:")) {
    const lines = text.split("\n").filter((l) => l.startsWith("data:"));
    body = lines[lines.length - 1].slice(5).trim();
  }
  const json = JSON.parse(body);
  if (json.error) throw new Error(json.error.message || "MCP error");
  return json.result;
}

export async function listTools(server) {
  try {
    const r = await rpc(server, "tools/list", {});
    return (r.tools || []).map((t) => ({
      name: `mcp__${server.name}__${t.name}`,
      description: t.description || "",
      input_schema: t.inputSchema || { type: "object", properties: {} },
      _server: server,
      _origName: t.name
    }));
  } catch (err) {
    console.warn(`MCP ${server.name} listTools failed:`, err);
    return [];
  }
}

export async function callTool(serverTool, args) {
  const r = await rpc(serverTool._server, "tools/call", {
    name: serverTool._origName,
    arguments: args || {}
  });
  // MCP returns content as an array of parts. Flatten to text for the model.
  if (Array.isArray(r?.content)) {
    return r.content
      .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
      .join("\n");
  }
  return r;
}

export async function gatherMcpTools(servers = []) {
  const all = await Promise.all(servers.filter((s) => s.enabled !== false).map(listTools));
  return all.flat();
}

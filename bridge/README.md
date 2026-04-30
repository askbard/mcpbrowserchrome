# MCP Browser Chrome — Bridge

Tiny zero-dependency Node server that lets **any MCP client** drive Chrome
through the MCP Browser Chrome extension.

```
[ MCP client ] ──POST /mcp──▶ [ bridge ] ◀──long-poll── [ Chrome extension ]
   curl, mcp-inspector,         localhost:7842         executes the tools
   Cursor, custom scripts                              via chrome.scripting
```

No Claude Desktop, no native messaging, no extra dependencies — just Node 18+.

## Run

```
node bridge/server.js
```

(Or `cd bridge && npm start`. Override the port with `PORT=9000 node server.js`.)

You should see:

```
MCP bridge listening on http://127.0.0.1:7842
  MCP endpoint:    POST http://127.0.0.1:7842/mcp
  Health:          GET  http://127.0.0.1:7842/health
```

Then in Chrome, open the extension's Settings, scroll to **External MCP
bridge**, tick **Enable bridge mode**, and Save. The bridge log will show
`[bridge] worker registered N tool(s)` once the extension connects.

## Connect an MCP client

Any MCP client that speaks Streamable HTTP can target `http://localhost:7842/mcp`.

### Quick test with `curl`

List tools:

```
curl -s -X POST http://localhost:7842/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Take a screenshot of the active tab:

```
curl -s -X POST http://localhost:7842/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"browser_screenshot","arguments":{}}}'
```

### `mcp-inspector`

```
npx @modelcontextprotocol/inspector@latest http://localhost:7842/mcp
```

### Cursor / Cline / Continue / your own client

Configure the MCP server URL as `http://localhost:7842/mcp` in whatever
config that client uses.

### Custom Python client (sketch)

```python
import requests, json
r = requests.post("http://localhost:7842/mcp", json={
    "jsonrpc": "2.0", "id": 1,
    "method": "tools/call",
    "params": {"name": "browser_get_page", "arguments": {}}
})
print(r.json()["result"]["content"][0]["text"])
```

## Endpoints

| Path       | Method | Who calls it      | Purpose                                |
| ---------- | ------ | ----------------- | -------------------------------------- |
| `/mcp`     | POST   | MCP clients       | Streamable-HTTP-style JSON-RPC entry   |
| `/poll`    | GET    | Extension         | Long-poll (≤25s) for the next tool call |
| `/result`  | POST   | Extension         | Return a tool result                   |
| `/register`| POST   | Extension         | Declare available tools                |
| `/health`  | GET    | Anyone            | Status JSON                            |

The bridge holds no state between restarts. Re-launching it is safe; the
extension re-registers automatically every minute.

## Security

- Listens on `127.0.0.1` only by default. To expose on the LAN, set
  `HOST=0.0.0.0` — but then anything on your network can drive your
  browser, so don't do that without thinking it through.
- No auth on `/mcp` by design (it's local-only). If you want a token,
  put it in front via a reverse proxy or wrap this server.

## Troubleshooting

- **`tools/list` returns "No browser worker connected"** — the extension
  isn't registered. Open Settings, toggle Bridge mode off then on, Save,
  and check the bridge logs for `worker registered`.
- **Calls hang** — the extension's poll loop may have died. Reload the
  extension at `chrome://extensions` and Save settings again to kick
  off a fresh poll.
- **Tool returned `isError: true`** — see the `text` content for the
  message (e.g. permissions, no active tab, tool disabled in Settings).

# MCP Browser Chrome

A bring-your-own-key Chrome extension inspired by Anthropic's official Claude
extension, but **provider-agnostic**: chat with **Claude, GPT, Gemini, or any
OpenAI-compatible endpoint** (Ollama, LM Studio, OpenRouter, vLLM, Together,
Groq…) and let the model **drive your browser** through MCP-style tools.

## Features

- **Side-panel chat UI** that opens next to any tab (`Ctrl/Cmd+Shift+M`).
- **Multi-provider** — Anthropic, OpenAI, Google, **OpenRouter** (first-class,
  with auto-loaded model catalog), or any OpenAI-compatible URL (Ollama,
  LM Studio, Groq, Together, …). One unified API-key field that swaps content
  per selected provider; keys are remembered per-provider in `chrome.storage.sync`.
- **MCP-style browser tools** the model can call directly:
  - `browser_get_page` — read URL, title, and visible text of a tab
  - `browser_query` — CSS-selector DOM snapshot
  - `browser_navigate`, `browser_click`, `browser_type`, `browser_scroll`
  - `browser_screenshot` — viewport PNG, fed back to the model as an image
  - `browser_eval` — power-user JS expression in the page
  - `tabs_list`, `tabs_switch`, `tabs_new`, `tabs_close`, `tabs_reload`,
    `tabs_history_back/forward`
  - `downloads_start`, `cookies_get` (off by default)
- **External MCP servers** — register any HTTP/SSE MCP endpoint in Settings;
  its tools join the model's tool list under `mcp__<server>__<tool>`.
- **Reverse bridge: any MCP client → Chrome.** Run `node bridge/server.js`
  and toggle "Enable bridge mode" in Settings. The extension long-polls the
  local bridge and exposes its browser tools over MCP, so external clients
  (mcp-inspector, Cursor, Cline, custom Python/Node scripts, even `curl`)
  can drive Chrome — no Claude Desktop, no native messaging required. See
  [`bridge/README.md`](bridge/README.md).
- **Approval modes** — auto, ask-before-writes (default), or ask-before-all.
- **Right-click menu** — "Ask AI about this page / selection".
- **Keys never leave your browser** except to the provider you selected.

## Install (developer mode)

1. Clone or download this repo.
2. Open `chrome://extensions`, toggle **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` folder.
4. Pin the toolbar icon, then click it to open the side panel.
5. Click **⚙** in the panel header → paste your API key for the provider you
   want, choose a default model, and Save.

## Files

```
extension/
├── manifest.json
├── background/service-worker.js     # Agent loop, tool execution, MCP bridge
├── sidepanel/                       # Chat UI (HTML/CSS/JS)
├── options/                         # Settings page
├── content/content.js               # Selection → side-panel hotkey
├── lib/
│   ├── storage.js                   # chrome.storage helpers, defaults
│   ├── providers/{anthropic,openai,google,index}.js
│   ├── tools/browser-tools.js       # MCP-style browser tool registry
│   └── mcp/mcp-client.js            # JSON-RPC client for remote MCP servers
└── icons/{16,48,128}.png
```

## Local LLM example (Ollama)

In Settings, choose **Custom OpenAI-compatible** as provider and set:

- Endpoint: `http://localhost:11434/v1`
- Custom model: `llama3.1:8b` (or any pulled model)

Ollama does not require an API key. Function-calling support depends on the
model.

## Safety notes

- The extension can read and act on **any page** because that's what a browser
  agent needs. Use **approval mode** to gate writes (the default).
- `browser_eval` runs arbitrary JS in the page context — disable it via the
  Tools toggle if you don't want the model to have it.
- API keys are stored in `chrome.storage.sync`. Treat your Chrome profile as
  the trust boundary.

## License

See [LICENSE](LICENSE).

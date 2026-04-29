import { getSettings, saveSettings, DEFAULT_SETTINGS } from "../lib/storage.js";
import { PROVIDERS } from "../lib/providers/index.js";

const $ = (id) => document.getElementById(id);

(async function init() {
  const s = await getSettings();
  const provSel = $("provider");
  for (const [key, p] of Object.entries(PROVIDERS)) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = p.label;
    provSel.appendChild(opt);
  }
  provSel.value = s.provider;
  document.body.classList.toggle("custom", s.provider === "custom");
  provSel.addEventListener("change", () => {
    document.body.classList.toggle("custom", provSel.value === "custom");
  });

  $("model").value = s.model;
  $("customEndpoint").value = s.customEndpoint || "";
  $("customModel").value = s.customModel || "";
  $("key-anthropic").value = s.apiKeys.anthropic || "";
  $("key-openai").value = s.apiKeys.openai || "";
  $("key-google").value = s.apiKeys.google || "";
  $("key-custom").value = s.apiKeys.custom || "";
  $("systemPrompt").value = s.systemPrompt;
  $("temperature").value = s.temperature;
  $("maxTokens").value = s.maxTokens;
  $("maxToolIterations").value = s.maxToolIterations;
  $("approvalMode").value = s.approvalMode;
  $("tool-browser").checked = s.enabledTools.browser;
  $("tool-tabs").checked = s.enabledTools.tabs;
  $("tool-screenshot").checked = s.enabledTools.screenshot;
  $("tool-downloads").checked = s.enabledTools.downloads;
  $("tool-cookies").checked = s.enabledTools.cookies;

  renderMcp(s.mcpServers || []);

  $("add-mcp").addEventListener("click", () => {
    const list = currentMcpRows();
    list.push({ name: "", url: "", enabled: true });
    renderMcp(list);
  });

  $("save").addEventListener("click", async () => {
    const merged = {
      ...DEFAULT_SETTINGS,
      provider: provSel.value,
      model: $("model").value.trim(),
      customEndpoint: $("customEndpoint").value.trim(),
      customModel: $("customModel").value.trim(),
      apiKeys: {
        anthropic: $("key-anthropic").value.trim(),
        openai: $("key-openai").value.trim(),
        google: $("key-google").value.trim(),
        custom: $("key-custom").value.trim()
      },
      systemPrompt: $("systemPrompt").value,
      temperature: parseFloat($("temperature").value) || 0.7,
      maxTokens: parseInt($("maxTokens").value, 10) || 4096,
      maxToolIterations: parseInt($("maxToolIterations").value, 10) || 12,
      approvalMode: $("approvalMode").value,
      enabledTools: {
        browser: $("tool-browser").checked,
        tabs: $("tool-tabs").checked,
        screenshot: $("tool-screenshot").checked,
        downloads: $("tool-downloads").checked,
        cookies: $("tool-cookies").checked
      },
      mcpServers: currentMcpRows().filter((s) => s.name && s.url)
    };
    await saveSettings(merged);
    $("status").textContent = "Saved.";
    setTimeout(() => ($("status").textContent = ""), 1500);
  });
})();

function renderMcp(servers) {
  const host = $("mcp-servers");
  host.innerHTML = "";
  servers.forEach((s, i) => {
    const row = document.createElement("div");
    row.className = "mcp-row";
    row.innerHTML = `
      <input data-k="name" placeholder="name (a-z0-9)" value="${escAttr(s.name || "")}" />
      <input data-k="url" placeholder="https://… (HTTP/SSE MCP endpoint)" value="${escAttr(s.url || "")}" />
      <label class="row-inline" style="margin:0"><input type="checkbox" data-k="enabled" ${s.enabled !== false ? "checked" : ""}/>on</label>
      <button type="button" data-act="del">✕</button>`;
    row.querySelector('[data-act="del"]').addEventListener("click", () => row.remove());
    host.appendChild(row);
  });
}

function currentMcpRows() {
  return Array.from(document.querySelectorAll(".mcp-row")).map((row) => ({
    name: row.querySelector('[data-k="name"]').value.trim(),
    url: row.querySelector('[data-k="url"]').value.trim(),
    enabled: row.querySelector('[data-k="enabled"]').checked
  }));
}

function escAttr(s) {
  return String(s).replace(/"/g, "&quot;");
}

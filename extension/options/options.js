import { getSettings, saveSettings, DEFAULT_SETTINGS } from "../lib/storage.js";
import { PROVIDERS, listGoogleModels } from "../lib/providers/index.js";

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

  // Custom-provider presets
  const PRESETS = {
    openrouter: {
      endpoint: "https://openrouter.ai/api/v1",
      model: "anthropic/claude-3.5-sonnet"
    },
    ollama: { endpoint: "http://localhost:11434/v1", model: "llama3.1:8b" },
    lmstudio: { endpoint: "http://localhost:1234/v1", model: "" },
    groq: { endpoint: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
    together: {
      endpoint: "https://api.together.xyz/v1",
      model: "meta-llama/Llama-3.3-70B-Instruct-Turbo"
    }
  };
  document.querySelectorAll("[data-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const p = PRESETS[btn.dataset.preset];
      if (!p) return;
      $("customEndpoint").value = p.endpoint;
      if (p.model) $("customModel").value = p.model;
      $("status").textContent = `${btn.textContent} preset filled. Don't forget to add your API key in the Custom field and Save.`;
    });
  });

  $("list-google-models").addEventListener("click", async () => {
    const key = $("key-google").value.trim();
    const out = $("google-models-result");
    if (!key) {
      out.textContent = "Enter a Google API key first.";
      return;
    }
    out.textContent = "Loading…";
    try {
      const models = await listGoogleModels(key);
      if (!models.length) {
        out.textContent = "No models with generateContent support found.";
        return;
      }
      out.textContent =
        `Found ${models.length} usable model(s):\n` +
        models
          .map(
            (m) =>
              `  • ${m.name}` +
              (m.displayName ? `  (${m.displayName})` : "") +
              (m.inputTokenLimit ? `  in: ${m.inputTokenLimit}` : "")
          )
          .join("\n") +
        `\n\nClick one to use it as your default model:\n`;
      for (const m of models) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "link";
        btn.textContent = m.name;
        btn.addEventListener("click", () => {
          $("model").value = m.name;
          $("status").textContent = `Default model set to ${m.name}. Don't forget to Save.`;
        });
        out.appendChild(document.createTextNode("  "));
        out.appendChild(btn);
      }
    } catch (e) {
      out.textContent = "Error: " + (e.message || e);
    }
  });

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

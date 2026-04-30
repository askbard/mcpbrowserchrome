import { getSettings, saveSettings, DEFAULT_SETTINGS } from "../lib/storage.js";
import {
  PROVIDERS,
  listGoogleModels,
  listOpenRouterModels,
  formatOpenRouterPrice,
  formatOpenRouterContext
} from "../lib/providers/index.js";

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

  // Show OpenRouter helper iff the endpoint looks like OpenRouter.
  const orTools = $("openrouter-tools");
  const orFilter = $("openrouter-filter");
  const orResults = $("openrouter-results");
  const orRefreshBtn = $("refresh-openrouter-models");
  const orDatalist = $("openrouter-models");
  let orCachedModels = [];

  function isOpenRouterEndpoint() {
    return /openrouter\.ai/i.test($("customEndpoint").value || "");
  }
  function syncOpenRouterUi() {
    orTools.style.display = isOpenRouterEndpoint() ? "block" : "none";
  }
  syncOpenRouterUi();
  $("customEndpoint").addEventListener("input", syncOpenRouterUi);

  function renderOpenRouterList(models) {
    orResults.innerHTML = "";
    if (!models.length) {
      orResults.textContent = "No models match the filter.";
      return;
    }
    orRefreshBtn.style.display = "inline";
    orFilter.style.display = "block";
    for (const m of models.slice(0, 250)) {
      const row = document.createElement("div");
      row.className = "or-row";
      const [pub, ...rest] = m.id.split("/");
      const name = rest.join("/") || m.id;
      const meta =
        [
          formatOpenRouterContext(m.contextLength),
          "in: " + formatOpenRouterPrice(m.promptUsdPerMTok),
          "out: " + formatOpenRouterPrice(m.completionUsdPerMTok)
        ]
          .filter(Boolean)
          .join("  •  ");
      const toolsBadge =
        m.supportsTools === true ? "tools"
        : m.supportsTools === false ? "no tools"
        : "?";
      const toolsClass = m.supportsTools === true ? "or-tools yes" : "or-tools";
      row.innerHTML = `
        <div class="or-id">${rest.length ? `<span class="pub">${esc(pub)}/</span>${esc(name)}` : esc(m.id)}</div>
        <div class="or-meta">${esc(meta)}</div>
        <span class="${toolsClass}">${toolsBadge}</span>`;
      row.title = m.description || m.id;
      row.addEventListener("click", () => {
        $("customModel").value = m.id;
        $("status").textContent = `Custom model set to ${m.id}. Don't forget to Save.`;
      });
      orResults.appendChild(row);
    }
    if (models.length > 250) {
      const more = document.createElement("div");
      more.className = "or-meta";
      more.style.padding = "6px 8px";
      more.textContent = `…+${models.length - 250} more (filter to narrow).`;
      orResults.appendChild(more);
    }
  }

  function applyFilter() {
    const q = orFilter.value.trim().toLowerCase();
    if (!q) return renderOpenRouterList(orCachedModels);
    const terms = q.split(/\s+/);
    const filtered = orCachedModels.filter((m) => {
      const hay = `${m.id} ${m.name} ${m.description}`.toLowerCase();
      return terms.every((t) => {
        if (t === "free")
          return m.promptUsdPerMTok === 0 && m.completionUsdPerMTok === 0;
        if (t === "tools") return m.supportsTools === true;
        return hay.includes(t);
      });
    });
    renderOpenRouterList(filtered);
  }
  orFilter.addEventListener("input", applyFilter);

  async function loadOpenRouter(force = false) {
    orResults.textContent = "Loading OpenRouter catalog…";
    try {
      const apiKey = $("key-custom").value.trim();
      const models = await listOpenRouterModels({ apiKey, force });
      orCachedModels = models;
      // Populate datalist for autocomplete on the Custom model input.
      orDatalist.innerHTML = "";
      for (const m of models) {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.label = formatOpenRouterContext(m.contextLength);
        orDatalist.appendChild(opt);
      }
      applyFilter();
      $("status").textContent =
        `Loaded ${models.length} OpenRouter models. Click a row to select, ` +
        `or type to autocomplete in the model field.`;
    } catch (e) {
      orResults.textContent = "Error: " + (e.message || e);
    }
  }
  $("load-openrouter-models").addEventListener("click", () => loadOpenRouter(false));
  orRefreshBtn.addEventListener("click", () => loadOpenRouter(true));

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

function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

// OpenRouter catalog helper. /api/v1/models is public (no key required) but
// will accept and reflect a user's key for any user-specific overrides.

const MODELS_URL = "https://openrouter.ai/api/v1/models";
const CACHE_KEY = "openrouter_models_cache";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h

export async function listOpenRouterModels({ apiKey, force = false } = {}) {
  if (!force) {
    const cached = await readCache();
    if (cached) return cached;
  }
  const headers = {
    "HTTP-Referer": "https://github.com/askbard/mcpbrowserchrome",
    "X-Title": "MCP Browser Chrome"
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(MODELS_URL, { headers });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenRouter models ${res.status}: ${t}`);
  }
  const data = await res.json();
  const models = (data.data || data.models || []).map(normalizeModel);
  models.sort((a, b) => a.id.localeCompare(b.id));
  await writeCache(models);
  return models;
}

function normalizeModel(m) {
  const promptUsd = num(m.pricing?.prompt);
  const completionUsd = num(m.pricing?.completion);
  const params = m.supported_parameters || [];
  return {
    id: m.id,
    name: m.name || m.id,
    contextLength: m.context_length || m.top_provider?.context_length || null,
    promptUsdPerMTok: promptUsd != null ? promptUsd * 1_000_000 : null,
    completionUsdPerMTok: completionUsd != null ? completionUsd * 1_000_000 : null,
    supportsTools: Array.isArray(params) ? params.includes("tools") : null,
    description: m.description || ""
  };
}

function num(v) {
  if (v == null || v === "") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

async function readCache() {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return null;
  try {
    const { [CACHE_KEY]: cached } = await chrome.storage.local.get(CACHE_KEY);
    if (!cached) return null;
    if (Date.now() - cached.ts > CACHE_TTL_MS) return null;
    return cached.models;
  } catch {
    return null;
  }
}

async function writeCache(models) {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  try {
    await chrome.storage.local.set({ [CACHE_KEY]: { ts: Date.now(), models } });
  } catch {}
}

// Convenience formatters for UI.
export function formatPrice(usdPerMTok) {
  if (usdPerMTok == null) return "—";
  if (usdPerMTok === 0) return "free";
  if (usdPerMTok < 1) return `$${usdPerMTok.toFixed(3)}/M`;
  return `$${usdPerMTok.toFixed(2)}/M`;
}

export function formatContext(n) {
  if (!n) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M ctx`;
  if (n >= 1000) return `${Math.round(n / 1000)}k ctx`;
  return `${n} ctx`;
}

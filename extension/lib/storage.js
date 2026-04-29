// Thin wrappers around chrome.storage. Settings live in `sync`,
// chat history and large blobs live in `local`.

export const DEFAULT_SETTINGS = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  apiKeys: {
    anthropic: "",
    openai: "",
    google: "",
    custom: ""
  },
  customEndpoint: "",
  customModel: "",
  systemPrompt:
    "You are a helpful assistant running inside a Chrome extension. " +
    "You can use the provided browser tools to read and act on web pages " +
    "on the user's behalf. Prefer reading the page before acting. Ask for " +
    "confirmation before doing anything destructive (purchases, deletions, " +
    "sending messages).",
  temperature: 0.7,
  maxTokens: 4096,
  maxToolIterations: 12,
  enabledTools: {
    browser: true,
    tabs: true,
    screenshot: true,
    downloads: false,
    cookies: false
  },
  mcpServers: [],
  approvalMode: "auto",
  theme: "system"
};

export async function getSettings() {
  const stored = await chrome.storage.sync.get("settings");
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

export async function saveSettings(settings) {
  await chrome.storage.sync.set({ settings });
}

export async function patchSettings(patch) {
  const current = await getSettings();
  const merged = { ...current, ...patch };
  if (patch.apiKeys) merged.apiKeys = { ...current.apiKeys, ...patch.apiKeys };
  if (patch.enabledTools)
    merged.enabledTools = { ...current.enabledTools, ...patch.enabledTools };
  await saveSettings(merged);
  return merged;
}

const HISTORY_KEY = "conversations";

export async function listConversations() {
  const { [HISTORY_KEY]: convos = [] } = await chrome.storage.local.get(HISTORY_KEY);
  return convos;
}

export async function getConversation(id) {
  const convos = await listConversations();
  return convos.find((c) => c.id === id) || null;
}

export async function saveConversation(convo) {
  const convos = await listConversations();
  const idx = convos.findIndex((c) => c.id === convo.id);
  if (idx >= 0) convos[idx] = convo;
  else convos.unshift(convo);
  // keep last 50
  const trimmed = convos.slice(0, 50);
  await chrome.storage.local.set({ [HISTORY_KEY]: trimmed });
}

export async function deleteConversation(id) {
  const convos = await listConversations();
  await chrome.storage.local.set({
    [HISTORY_KEY]: convos.filter((c) => c.id !== id)
  });
}

export function newConversation(title = "New chat") {
  return {
    id: crypto.randomUUID(),
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: []
  };
}

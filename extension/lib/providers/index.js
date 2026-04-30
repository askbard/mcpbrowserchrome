import * as anthropic from "./anthropic.js";
import * as openai from "./openai.js";
import * as google from "./google.js";
import * as openrouter from "./openrouter.js";

export { listModels as listGoogleModels } from "./google.js";
export {
  listOpenRouterModels,
  formatPrice as formatOpenRouterPrice,
  formatContext as formatOpenRouterContext
} from "./openrouter.js";

export const PROVIDERS = {
  anthropic: {
    label: "Anthropic (Claude)",
    chat: anthropic.chat,
    models: anthropic.ANTHROPIC_MODELS,
    needsKey: true,
    keyPlaceholder: "sk-ant-…",
    keyHelp: "https://console.anthropic.com/settings/keys"
  },
  openai: {
    label: "OpenAI (GPT)",
    chat: openai.chat,
    models: openai.OPENAI_MODELS,
    needsKey: true,
    keyPlaceholder: "sk-…",
    keyHelp: "https://platform.openai.com/api-keys"
  },
  google: {
    label: "Google (Gemini)",
    chat: google.chat,
    models: google.GOOGLE_MODELS,
    needsKey: true,
    keyPlaceholder: "AIza…",
    keyHelp: "https://aistudio.google.com/app/apikey"
  },
  openrouter: {
    label: "OpenRouter (any model)",
    chat: openrouter.chat,
    // Models are loaded dynamically from the OpenRouter catalog.
    models: [],
    needsKey: true,
    keyPlaceholder: "sk-or-v1-…",
    keyHelp: "https://openrouter.ai/keys",
    isOpenRouter: true
  },
  custom: {
    label: "Custom OpenAI-compatible (Ollama, LM Studio, …)",
    chat: openai.chat,
    models: [],
    needsKey: false,
    keyPlaceholder: "optional bearer token",
    keyHelp: ""
  }
};

export async function callProvider(settings, args) {
  const p = PROVIDERS[settings.provider];
  if (!p) throw new Error(`Unknown provider: ${settings.provider}`);
  const apiKey = settings.apiKeys?.[settings.provider] || "";
  if (p.needsKey && !apiKey)
    throw new Error(
      `No API key set for ${p.label}. Open the extension options and add one.`
    );
  const model =
    settings.provider === "custom" && settings.customModel
      ? settings.customModel
      : settings.model;
  if (!model) {
    throw new Error(
      `No model selected for ${p.label}. Open Settings and pick one.`
    );
  }

  let endpoint;
  if (settings.provider === "custom") {
    endpoint = (settings.customEndpoint || "").trim();
    if (!endpoint) {
      throw new Error(
        "Custom provider selected but no endpoint URL is set. " +
          'Open Settings and fill in "Custom endpoint base URL". ' +
          "Examples:\n" +
          "  • OpenRouter:  https://openrouter.ai/api/v1\n" +
          "  • Ollama:      http://localhost:11434/v1\n" +
          "  • LM Studio:   http://localhost:1234/v1\n" +
          "  • Groq:        https://api.groq.com/openai/v1\n" +
          "  • Together AI: https://api.together.xyz/v1"
      );
    }
    // Strip a trailing slash so concatenation with /chat/completions is clean.
    endpoint = endpoint.replace(/\/+$/, "");
    if (!model) {
      throw new Error(
        'Custom provider needs a model name. Set "Custom model name" in Settings ' +
          "(e.g. anthropic/claude-3.5-sonnet for OpenRouter, llama3.1:8b for Ollama)."
      );
    }
  }

  return p.chat({
    apiKey,
    model,
    endpoint,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    ...args
  });
}

import * as anthropic from "./anthropic.js";
import * as openai from "./openai.js";
import * as google from "./google.js";

export const PROVIDERS = {
  anthropic: {
    label: "Anthropic (Claude)",
    chat: anthropic.chat,
    models: anthropic.ANTHROPIC_MODELS,
    needsKey: true
  },
  openai: {
    label: "OpenAI (GPT)",
    chat: openai.chat,
    models: openai.OPENAI_MODELS,
    needsKey: true
  },
  google: {
    label: "Google (Gemini)",
    chat: google.chat,
    models: google.GOOGLE_MODELS,
    needsKey: true
  },
  custom: {
    label: "Custom OpenAI-compatible (Ollama, LM Studio, OpenRouter, …)",
    chat: openai.chat,
    models: [],
    needsKey: false
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
  return p.chat({
    apiKey,
    model,
    endpoint: settings.provider === "custom" ? settings.customEndpoint : undefined,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    ...args
  });
}

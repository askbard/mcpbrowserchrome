// Anthropic Messages API adapter.

const API = "https://api.anthropic.com/v1/messages";

function toAnthropicMessages(messages) {
  // Strip system messages (Anthropic uses a top-level `system` field) and
  // merge consecutive tool results into a single user message — the API
  // rejects two user messages in a row.
  const out = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: m.tool_use_id,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        is_error: !!m.is_error
      };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }
    if (m.role === "assistant" && Array.isArray(m.content)) {
      out.push({ role: "assistant", content: m.content });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

function toAnthropicTools(tools) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema
  }));
}

export async function chat({ apiKey, model, system, messages, tools, temperature, maxTokens }) {
  const body = {
    model,
    max_tokens: maxTokens || 4096,
    temperature,
    system,
    messages: toAnthropicMessages(messages)
  };
  if (tools?.length) body.tools = toAnthropicTools(tools);

  const res = await fetch(API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic ${res.status}: ${err}`);
  }
  const data = await res.json();
  // Normalize to a unified shape
  const text = (data.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
  const toolCalls = (data.content || [])
    .filter((c) => c.type === "tool_use")
    .map((c) => ({ id: c.id, name: c.name, args: c.input }));
  return {
    text,
    toolCalls,
    raw: data,
    assistantContent: data.content,
    stopReason: data.stop_reason
  };
}

export const ANTHROPIC_MODELS = [
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "claude-opus-4-1-20250805",
  "claude-3-5-sonnet-20241022",
  "claude-3-5-haiku-20241022"
];

// OpenAI Chat Completions adapter (also used for any OpenAI-compatible API
// like Ollama, LM Studio, vLLM, OpenRouter, Together, Groq, etc.).

function toOpenAIMessages(messages, system) {
  const out = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    if (m.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: m.tool_use_id,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content)
      });
      continue;
    }
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const textParts = m.content.filter((c) => c.type === "text").map((c) => c.text);
      const toolUses = m.content.filter((c) => c.type === "tool_use");
      const msg = { role: "assistant", content: textParts.join("") || null };
      if (toolUses.length) {
        msg.tool_calls = toolUses.map((tu) => ({
          id: tu.id,
          type: "function",
          function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) }
        }));
      }
      out.push(msg);
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

function toOpenAITools(tools) {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema || { type: "object", properties: {} }
    }
  }));
}

export async function chat({
  apiKey,
  model,
  system,
  messages,
  tools,
  temperature,
  maxTokens,
  endpoint
}) {
  const url = (endpoint || "https://api.openai.com/v1") + "/chat/completions";
  const body = {
    model,
    messages: toOpenAIMessages(messages, system),
    temperature,
    max_tokens: maxTokens || 4096
  };
  if (tools?.length) {
    body.tools = toOpenAITools(tools);
    body.tool_choice = "auto";
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI ${res.status}: ${err}`);
  }
  const data = await res.json();
  const choice = data.choices?.[0]?.message || {};
  const text = choice.content || "";
  const toolCalls = (choice.tool_calls || []).map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    args: safeParse(tc.function.arguments)
  }));

  // Re-shape into a unified assistant content array (mirrors Anthropic's).
  const assistantContent = [];
  if (text) assistantContent.push({ type: "text", text });
  for (const tc of toolCalls) {
    assistantContent.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args });
  }

  return {
    text,
    toolCalls,
    raw: data,
    assistantContent,
    stopReason: data.choices?.[0]?.finish_reason
  };
}

function safeParse(s) {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return { _raw: s };
  }
}

export const OPENAI_MODELS = [
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
  "o3-mini",
  "o4-mini"
];

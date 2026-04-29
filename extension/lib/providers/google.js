// Google Gemini (generativelanguage.googleapis.com v1beta) adapter.

function toGeminiContents(messages) {
  const contents = [];
  const pushPart = (role, part) => {
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(part);
    else contents.push({ role, parts: [part] });
  };
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      pushPart("user", {
        functionResponse: {
          name: m.tool_name || "tool",
          response: {
            content: typeof m.content === "string" ? m.content : m.content
          }
        }
      });
      continue;
    }
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c.type === "text") pushPart("model", { text: c.text });
        if (c.type === "tool_use")
          pushPart("model", { functionCall: { name: c.name, args: c.input || {} } });
      }
      continue;
    }
    pushPart(m.role === "assistant" ? "model" : "user", {
      text: typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    });
  }
  return contents;
}

function toGeminiTools(tools) {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: stripUnsupported(t.input_schema)
      }))
    }
  ];
}

function stripUnsupported(schema) {
  if (!schema || typeof schema !== "object") return schema;
  // Gemini's schema dialect rejects $schema, additionalProperties, default.
  const { $schema, additionalProperties, default: _d, ...rest } = schema;
  if (rest.properties) {
    rest.properties = Object.fromEntries(
      Object.entries(rest.properties).map(([k, v]) => [k, stripUnsupported(v)])
    );
  }
  if (rest.items) rest.items = stripUnsupported(rest.items);
  return rest;
}

export async function chat({
  apiKey,
  model,
  system,
  messages,
  tools,
  temperature,
  maxTokens
}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: toGeminiContents(messages),
    generationConfig: { temperature, maxOutputTokens: maxTokens || 4096 }
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (tools?.length) body.tools = toGeminiTools(tools);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini ${res.status}: ${err}`);
  }
  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts
    .filter((p) => p.text)
    .map((p) => p.text)
    .join("");
  const toolCalls = parts
    .filter((p) => p.functionCall)
    .map((p, i) => ({
      id: `call_${Date.now()}_${i}`,
      name: p.functionCall.name,
      args: p.functionCall.args || {}
    }));

  const assistantContent = [];
  if (text) assistantContent.push({ type: "text", text });
  for (const tc of toolCalls)
    assistantContent.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args });

  return {
    text,
    toolCalls,
    raw: data,
    assistantContent,
    stopReason: data.candidates?.[0]?.finishReason
  };
}

export const GOOGLE_MODELS = [
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-1.5-pro",
  "gemini-1.5-flash"
];

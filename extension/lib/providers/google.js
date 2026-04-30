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
      // Gemini wants `response` to be an object. If we have a JSON-encoded
      // object as the tool's content, pass it through; otherwise wrap.
      let response;
      if (typeof m.content === "string") {
        try {
          const parsed = JSON.parse(m.content);
          response = parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed
            : { result: parsed };
        } catch {
          response = { result: m.content };
        }
      } else if (m.content && typeof m.content === "object") {
        response = Array.isArray(m.content) ? { result: m.content } : m.content;
      } else {
        response = { result: m.content };
      }
      pushPart("user", {
        functionResponse: {
          name: sanitizeName(m.tool_name || "tool"),
          response
        }
      });
      continue;
    }
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c.type === "text" && c.text) pushPart("model", { text: c.text });
        if (c.type === "tool_use")
          pushPart("model", {
            functionCall: { name: sanitizeName(c.name), args: c.input || {} }
          });
      }
      continue;
    }
    pushPart(m.role === "assistant" ? "model" : "user", {
      text: typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    });
  }
  return contents;
}

function toGeminiTools(tools, nameMap) {
  const decls = tools
    .map((t) => {
      const safe = sanitizeName(t.name);
      nameMap.set(safe, t.name);
      const decl = { name: safe, description: t.description || "" };
      const params = sanitizeSchema(t.input_schema);
      // Gemini rejects `parameters: { type: "object", properties: {} }`.
      // Omit `parameters` entirely when there are no real inputs.
      if (params && hasAnyProperty(params)) decl.parameters = params;
      return decl;
    })
    .filter(Boolean);
  return decls.length ? [{ functionDeclarations: decls }] : undefined;
}

// Tool names must match ^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$
function sanitizeName(name) {
  let n = String(name).replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!/^[a-zA-Z_]/.test(n)) n = "_" + n;
  return n.slice(0, 63);
}

function hasAnyProperty(schema) {
  if (!schema || typeof schema !== "object") return false;
  if (schema.properties && Object.keys(schema.properties).length > 0) return true;
  return false;
}

// Gemini's OpenAPI-flavored schema dialect rejects a number of standard
// JSON-Schema keywords. Strip them everywhere in the tree.
const UNSUPPORTED_KEYS = new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "additionalProperties",
  "default",
  "examples",
  "patternProperties",
  "unevaluatedProperties",
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "const",
  "title",
  "exclusiveMaximum",
  "exclusiveMinimum"
]);

function sanitizeSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (UNSUPPORTED_KEYS.has(k)) continue;
    if (k === "properties" && v && typeof v === "object") {
      const cleaned = {};
      for (const [pk, pv] of Object.entries(v)) cleaned[pk] = sanitizeSchema(pv);
      out.properties = cleaned;
      continue;
    }
    if (k === "items") {
      out.items = sanitizeSchema(v);
      continue;
    }
    if (k === "enum" && Array.isArray(v)) {
      // Gemini supports enum on strings only.
      out.enum = v.map(String);
      continue;
    }
    out[k] = v;
  }
  // Default to object type if missing — Gemini requires a top-level type.
  if (!out.type && out.properties) out.type = "object";
  return out;
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
  const contents = toGeminiContents(messages);
  // Gemini requires the conversation to start with a user turn. If the
  // first content slipped in as `model` (e.g. an orphan assistant message),
  // prepend a synthetic user turn.
  if (contents.length === 0 || contents[0].role !== "user") {
    contents.unshift({ role: "user", parts: [{ text: " " }] });
  }
  const body = {
    contents,
    generationConfig: {
      temperature: temperature ?? 0.7,
      maxOutputTokens: maxTokens || 4096
    }
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const nameMap = new Map();
  const geminiTools = tools?.length ? toGeminiTools(tools, nameMap) : undefined;
  if (geminiTools) body.tools = geminiTools;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errText = await res.text();
    let detail = errText;
    try {
      const parsed = JSON.parse(errText);
      detail = parsed?.error?.message || errText;
    } catch {}
    throw new Error(`Gemini ${res.status}: ${detail}`);
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
      // Translate the sanitized name back to the registry name so the agent
      // loop can dispatch it.
      name: nameMap.get(p.functionCall.name) || p.functionCall.name,
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

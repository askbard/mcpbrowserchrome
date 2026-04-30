// Smoke tests for the provider adapters. Mocks `fetch` so we can assert the
// request shape each provider sends and verify the normalized response.
// Run with: node tests/providers.smoke.mjs

import * as anthropic from "../extension/lib/providers/anthropic.js";
import * as openai from "../extension/lib/providers/openai.js";
import * as google from "../extension/lib/providers/google.js";

let captured;
let nextReply;
globalThis.fetch = async (url, init) => {
  captured = { url, init, body: JSON.parse(init.body) };
  const reply = nextReply;
  return {
    ok: true,
    status: 200,
    async json() {
      return reply;
    },
    async text() {
      return JSON.stringify(reply);
    }
  };
};

const tools = [
  {
    name: "browser_get_page",
    description: "read page",
    input_schema: { type: "object", properties: {} }
  }
];

const sampleConvo = [
  { role: "user", content: "What's on this page?" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Let me check." },
      { type: "tool_use", id: "tu_1", name: "browser_get_page", input: {} }
    ]
  },
  { role: "tool", tool_use_id: "tu_1", tool_name: "browser_get_page", content: "Hello world" },
  // Second tool result to test the consecutive-tool-result merge.
  { role: "tool", tool_use_id: "tu_2", tool_name: "browser_get_page", content: "Second" }
];

let pass = 0,
  fail = 0;
function assert(cond, label) {
  if (cond) {
    console.log("  ok  -", label);
    pass++;
  } else {
    console.log("  FAIL -", label);
    fail++;
  }
}

// ---- Anthropic ----
console.log("\nAnthropic adapter");
captured = null; nextReply = null;
nextReply = {
  content: [
    { type: "text", text: "Done." },
    { type: "tool_use", id: "tu_a", name: "browser_get_page", input: {} }
  ],
  stop_reason: "tool_use"
};
let res = await anthropic.chat({
  apiKey: "sk-ant-test",
  model: "claude-sonnet-4-6",
  system: "you are helpful",
  messages: sampleConvo,
  tools,
  temperature: 0.5,
  maxTokens: 1024
});
assert(captured.url.includes("anthropic.com"), "POSTs to anthropic.com");
assert(captured.init.headers["x-api-key"] === "sk-ant-test", "passes x-api-key");
assert(captured.init.headers["anthropic-version"], "sets anthropic-version");
assert(captured.body.system === "you are helpful", "uses top-level system");
assert(Array.isArray(captured.body.tools) && captured.body.tools.length === 1, "sends tools");

// Tool-result merge: two consecutive tool messages should fold into ONE
// user message with two tool_result blocks.
const userMsgsWithTr = captured.body.messages.filter(
  (m) =>
    m.role === "user" &&
    Array.isArray(m.content) &&
    m.content.some((c) => c.type === "tool_result")
);
assert(userMsgsWithTr.length === 1, "merges consecutive tool results into one user message");
assert(
  userMsgsWithTr[0].content.length === 2,
  "merged user message contains both tool_result blocks"
);
assert(res.text === "Done.", "extracts text");
assert(res.toolCalls[0].name === "browser_get_page", "extracts tool call");

// ---- OpenAI ----
console.log("\nOpenAI adapter");
captured = null; nextReply = null;
nextReply = {
  choices: [
    {
      message: {
        role: "assistant",
        content: "Hi.",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "browser_get_page", arguments: '{"max_chars":1000}' }
          }
        ]
      },
      finish_reason: "tool_calls"
    }
  ]
};
res = await openai.chat({
  apiKey: "sk-test",
  model: "gpt-4o",
  system: "sys",
  messages: sampleConvo,
  tools,
  temperature: 0.3,
  maxTokens: 512
});
assert(captured.url.endsWith("/chat/completions"), "POSTs to /chat/completions");
assert(captured.init.headers.Authorization === "Bearer sk-test", "passes Bearer auth");
assert(
  captured.body.messages[0].role === "system" &&
    captured.body.messages[0].content === "sys",
  "system message prepended"
);
assert(
  captured.body.tools[0].type === "function" &&
    captured.body.tools[0].function.name === "browser_get_page",
  "OpenAI tools schema converted"
);
const assistantToolCallMsg = captured.body.messages.find(
  (m) => m.role === "assistant" && m.tool_calls
);
assert(
  assistantToolCallMsg &&
    assistantToolCallMsg.tool_calls[0].function.name === "browser_get_page",
  "prior assistant tool_use → tool_calls roundtrip"
);
const toolMsgs = captured.body.messages.filter((m) => m.role === "tool");
assert(toolMsgs.length === 2, "two tool messages preserved");
assert(toolMsgs[0].tool_call_id === "tu_1", "tool message tool_call_id preserved");
assert(res.toolCalls[0].args.max_chars === 1000, "JSON-parses tool call args");

// Custom endpoint override
captured = null; nextReply = null;
nextReply = { choices: [{ message: { role: "assistant", content: "" } }] };
await openai.chat({
  apiKey: "",
  model: "llama3.1:8b",
  system: "sys",
  messages: [{ role: "user", content: "hi" }],
  tools: [],
  endpoint: "http://localhost:11434/v1"
});
assert(
  captured.url === "http://localhost:11434/v1/chat/completions",
  "custom endpoint honored (Ollama-style)"
);
assert(!captured.init.headers.Authorization, "no Authorization header when no key");

// ---- Google Gemini ----
console.log("\nGoogle Gemini adapter");
captured = null; nextReply = null;
nextReply = {
  candidates: [
    {
      content: {
        parts: [
          { text: "ok" },
          { functionCall: { name: "browser_get_page", args: {} } }
        ]
      },
      finishReason: "STOP"
    }
  ]
};
res = await google.chat({
  apiKey: "AIzaTEST",
  model: "gemini-2.5-pro",
  system: "sys",
  messages: sampleConvo,
  tools,
  temperature: 0.5,
  maxTokens: 1024
});
assert(captured.url.includes("generativelanguage.googleapis.com"), "Gemini URL");
assert(captured.url.includes("key=AIzaTEST"), "API key in query string");
assert(captured.body.systemInstruction.parts[0].text === "sys", "systemInstruction set");
assert(
  captured.body.tools[0].functionDeclarations[0].name === "browser_get_page",
  "Gemini functionDeclarations converted"
);
// Consecutive tool roles should merge into a single user content with two parts.
const userTrContents = captured.body.contents.filter(
  (c) => c.role === "user" && c.parts.some((p) => p.functionResponse)
);
assert(userTrContents.length === 1, "Gemini merges consecutive functionResponse parts");
assert(userTrContents[0].parts.length === 2, "two functionResponse parts preserved");
assert(res.toolCalls[0].name === "browser_get_page", "extracts Gemini functionCall");

// ---- Gemini schema sanitization ----
console.log("\nGemini schema sanitization");
captured = null; nextReply = null;
nextReply = {
  candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }]
};
const trickyTools = [
  // Empty input schema — Gemini rejects empty `properties: {}`.
  {
    name: "browser_screenshot",
    description: "shot",
    input_schema: { type: "object", properties: {} }
  },
  // Schema with default + enum + $schema (all unsupported by Gemini).
  {
    name: "browser_scroll",
    description: "scroll",
    input_schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      properties: {
        direction: { type: "string", enum: ["up", "down"], default: "down" },
        amount: { type: "number", default: 800 }
      }
    }
  }
];
await google.chat({
  apiKey: "k",
  model: "gemini-2.5-pro",
  system: "",
  messages: [{ role: "user", content: "hi" }],
  tools: trickyTools,
  temperature: 0.4,
  maxTokens: 1024
});
const decls = captured.body.tools[0].functionDeclarations;
const screenshot = decls.find((d) => d.name === "browser_screenshot");
assert(screenshot && !screenshot.parameters, "empty-properties tool: parameters omitted");
const scroll = decls.find((d) => d.name === "browser_scroll");
assert(scroll && scroll.parameters, "non-empty tool keeps parameters");
assert(!("$schema" in scroll.parameters), "$schema stripped");
assert(!("additionalProperties" in scroll.parameters), "additionalProperties stripped");
assert(
  !("default" in (scroll.parameters.properties.direction || {})),
  "nested default stripped"
);
assert(
  Array.isArray(scroll.parameters.properties.direction.enum),
  "enum preserved"
);

// ---- Gemini name sanitization round-trip ----
console.log("\nGemini name sanitization round-trip");
captured = null; nextReply = null;
const dottedName = "mcp__demo.server__do.thing";
const safeName = "mcp__demo_server__do_thing";
nextReply = {
  candidates: [
    {
      content: { parts: [{ functionCall: { name: safeName, args: {} } }] },
      finishReason: "STOP"
    }
  ]
};
const dotted = await google.chat({
  apiKey: "k",
  model: "gemini-2.5-pro",
  messages: [{ role: "user", content: "go" }],
  tools: [
    {
      name: dottedName,
      description: "x",
      input_schema: { type: "object", properties: { a: { type: "string" } } }
    }
  ],
  temperature: 0.5,
  maxTokens: 256
});
assert(
  captured.body.tools[0].functionDeclarations[0].name === safeName,
  "dotted tool name sanitized on wire"
);
assert(
  dotted.toolCalls[0].name === dottedName,
  "tool call name translated back to original for dispatch"
);

// ---- Gemini functionResponse: JSON-parseable content becomes the object ----
console.log("\nGemini functionResponse content shape");
captured = null; nextReply = null;
nextReply = {
  candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }]
};
await google.chat({
  apiKey: "k",
  model: "gemini-2.5-pro",
  messages: [
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "x", name: "browser_get_page", input: {} }]
    },
    {
      role: "tool",
      tool_use_id: "x",
      tool_name: "browser_get_page",
      content: '{"title":"Hello","url":"https://example.test"}'
    }
  ],
  tools: [
    {
      name: "browser_get_page",
      description: "x",
      input_schema: { type: "object", properties: {} }
    }
  ]
});
const fr = captured.body.contents.find((c) =>
  c.parts.some((p) => p.functionResponse)
);
const responseObj = fr.parts[0].functionResponse.response;
assert(responseObj.title === "Hello" && responseObj.url === "https://example.test",
  "JSON-string tool result lifted into response object");

// ---- Gemini auto-prepends user turn if conversation starts wrong ----
console.log("\nGemini contents must start with user");
captured = null; nextReply = null;
nextReply = { candidates: [{ content: { parts: [{ text: "ok" }] } }] };
await google.chat({
  apiKey: "k",
  model: "gemini-2.5-pro",
  messages: [
    { role: "assistant", content: [{ type: "text", text: "hi" }] }
  ],
  tools: []
});
assert(captured.body.contents[0].role === "user", "synthetic user turn prepended");

// ---- Custom provider validation ----
console.log("\nCustom provider validation");
const { callProvider } = await import("../extension/lib/providers/index.js");
let threwForMissingEndpoint = false;
try {
  await callProvider(
    {
      provider: "custom",
      apiKeys: { custom: "sk-or-test" },
      customEndpoint: "",
      customModel: "anthropic/claude-3.5-sonnet"
    },
    { messages: [{ role: "user", content: "hi" }], tools: [] }
  );
} catch (e) {
  threwForMissingEndpoint = /no endpoint URL is set/i.test(e.message);
}
assert(threwForMissingEndpoint, "custom provider with empty endpoint throws helpful error");

// Trailing-slash trimming + OpenRouter attribution headers
captured = null; nextReply = null;
nextReply = { choices: [{ message: { role: "assistant", content: "ok" } }] };
await callProvider(
  {
    provider: "custom",
    apiKeys: { custom: "sk-or-test" },
    customEndpoint: "https://openrouter.ai/api/v1/",
    customModel: "anthropic/claude-3.5-sonnet"
  },
  { messages: [{ role: "user", content: "hi" }], tools: [] }
);
assert(
  captured.url === "https://openrouter.ai/api/v1/chat/completions",
  "trailing slash on custom endpoint is normalized"
);
assert(
  captured.init.headers["HTTP-Referer"] && captured.init.headers["X-Title"],
  "OpenRouter attribution headers added"
);
assert(
  captured.init.headers.Authorization === "Bearer sk-or-test",
  "custom key sent to custom endpoint, NOT to OpenAI"
);

let threwForMissingModel = false;
try {
  await callProvider(
    {
      provider: "custom",
      apiKeys: { custom: "x" },
      customEndpoint: "http://localhost:11434/v1",
      customModel: "",
      model: ""
    },
    { messages: [{ role: "user", content: "hi" }], tools: [] }
  );
} catch (e) {
  threwForMissingModel = /no model selected/i.test(e.message);
}
assert(threwForMissingModel, "missing model throws helpful error");

// ---- OpenRouter as first-class provider ----
console.log("\nOpenRouter first-class provider");
const { PROVIDERS } = await import("../extension/lib/providers/index.js");
assert(PROVIDERS.openrouter, "PROVIDERS.openrouter registered");
assert(PROVIDERS.openrouter.isOpenRouter === true, "openrouter flagged");
assert(PROVIDERS.openrouter.needsKey === true, "openrouter needs a key");

captured = null; nextReply = null;
nextReply = { choices: [{ message: { role: "assistant", content: "ok" } }] };
await callProvider(
  {
    provider: "openrouter",
    apiKeys: { openrouter: "sk-or-test" },
    model: "anthropic/claude-3.5-sonnet"
  },
  { messages: [{ role: "user", content: "hi" }], tools: [] }
);
assert(
  captured.url === "https://openrouter.ai/api/v1/chat/completions",
  "openrouter routes to OpenRouter URL without customEndpoint"
);
assert(
  captured.init.headers.Authorization === "Bearer sk-or-test",
  "openrouter uses apiKeys.openrouter"
);
assert(
  captured.init.headers["HTTP-Referer"] && captured.init.headers["X-Title"],
  "openrouter still gets attribution headers"
);
assert(
  captured.body.model === "anthropic/claude-3.5-sonnet",
  "openrouter uses settings.model (not customModel)"
);

// Missing key on first-class openrouter
let threwForMissingOrKey = false;
try {
  await callProvider(
    {
      provider: "openrouter",
      apiKeys: {},
      model: "anthropic/claude-3.5-sonnet"
    },
    { messages: [{ role: "user", content: "hi" }], tools: [] }
  );
} catch (e) {
  threwForMissingOrKey = /no api key set/i.test(e.message);
}
assert(threwForMissingOrKey, "openrouter without key throws helpful error");

// ---- summary ----
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

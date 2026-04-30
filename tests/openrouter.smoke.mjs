// Smoke test for the OpenRouter catalog helper.
import {
  listOpenRouterModels,
  formatPrice,
  formatContext
} from "../extension/lib/providers/openrouter.js";

let lastInit;
let nextResponse;
globalThis.fetch = async (url, init) => {
  lastInit = { url, init };
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(nextResponse);
    },
    async json() {
      return nextResponse;
    }
  };
};

let pass = 0,
  fail = 0;
const ok = (c, l) => {
  console.log((c ? "  ok  -" : "  FAIL -") + " " + l);
  c ? pass++ : fail++;
};

console.log("\nlistOpenRouterModels");
nextResponse = {
  data: [
    {
      id: "anthropic/claude-3.5-sonnet",
      name: "Anthropic: Claude 3.5 Sonnet",
      context_length: 200000,
      pricing: { prompt: "0.000003", completion: "0.000015" },
      supported_parameters: ["temperature", "tools", "tool_choice"]
    },
    {
      id: "meta-llama/llama-3.3-70b-instruct:free",
      name: "Llama 3.3 70B (free)",
      context_length: 128000,
      pricing: { prompt: "0", completion: "0" },
      supported_parameters: ["temperature"]
    },
    {
      id: "openai/gpt-4o",
      name: "OpenAI: GPT-4o",
      context_length: 128000,
      pricing: { prompt: "0.0000025", completion: "0.00001" },
      supported_parameters: ["tools"]
    }
  ]
};

const models = await listOpenRouterModels({ apiKey: "sk-or-test", force: true });
ok(models.length === 3, "parsed 3 models");
ok(
  lastInit.url === "https://openrouter.ai/api/v1/models",
  "called the right URL"
);
ok(
  lastInit.init.headers.Authorization === "Bearer sk-or-test",
  "key passed when given"
);
ok(
  lastInit.init.headers["HTTP-Referer"] && lastInit.init.headers["X-Title"],
  "attribution headers set"
);
ok(
  models[0].id === "anthropic/claude-3.5-sonnet",
  "models sorted alphabetically"
);
const claude = models.find((m) => m.id.includes("claude"));
ok(claude.contextLength === 200000, "context_length passed through");
ok(
  Math.abs(claude.promptUsdPerMTok - 3) < 0.01,
  "prompt price normalized to USD per million tokens"
);
ok(
  Math.abs(claude.completionUsdPerMTok - 15) < 0.01,
  "completion price normalized to USD per million tokens"
);
ok(claude.supportsTools === true, "supportsTools detected (true)");
const llama = models.find((m) => m.id.includes("llama"));
ok(llama.supportsTools === false, "supportsTools detected (false)");
ok(llama.promptUsdPerMTok === 0, "free model priced at 0");

console.log("\nformatters");
ok(formatPrice(0) === "free", "0 → free");
ok(formatPrice(null) === "—", "null → em dash");
ok(formatPrice(0.5) === "$0.500/M", "fractional price formatted to 3dp");
ok(formatPrice(15) === "$15.00/M", "integer price formatted to 2dp");
ok(formatContext(200000) === "200k ctx", "200000 → 200k ctx");
ok(formatContext(2_000_000) === "2.0M ctx", "2M → 2.0M ctx");

// fetch error path
console.log("\nlistOpenRouterModels error");
globalThis.fetch = async () => ({
  ok: false,
  status: 503,
  async text() {
    return "service unavailable";
  }
});
let threw = false;
try {
  await listOpenRouterModels({ force: true });
} catch (e) {
  threw = /OpenRouter models 503/.test(e.message);
}
ok(threw, "503 surfaces as helpful error");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

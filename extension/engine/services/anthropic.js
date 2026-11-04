// The one Anthropic client, and the request/response handling every AI feature shares.
// The SDK is bundled into vendor/ (npm run vendor). It talks straight to api.anthropic.com from the
// extension; there is no server in between. That's what dangerouslyAllowBrowser acknowledges: the key
// lives in this browser profile, which is the point of a bring-your-own-key extension.
import { Anthropic } from "../../vendor/anthropic.mjs";
import { apiKey } from "./settings.js";

export { Anthropic };

// Built on first use from the saved key; rebuilt after the key changes in Settings.
let client = null;
export function getClient() {
  if (client) return client;
  const key = apiKey();
  if (!key) throw Object.assign(new Error("No Anthropic API key. Add one in Settings."), { noKey: true });
  return (client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true }));
}
export const resetClient = () => { client = null; };

// The AI declined the request (usually over an explicit image).
export class Refused extends Error {}

// Models that accept a server-side fallback when they decline; Haiku doesn't.
const FALLBACK_MODELS = ["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"];

// A structured-output request: the answer must match `schema`.
export function jsonRequest({ model, effort, system, content, schema, maxTokens = 8000 }) {
  const params = {
    model,
    max_tokens: maxTokens,
    system,
    output_config: { effort, format: { type: "json_schema", schema } },
    messages: [{ role: "user", content }],
  };
  if (FALLBACK_MODELS.includes(model)) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }
  return params;
}

// Token counts priced the way they're billed: cache writes 1.25x, cache reads ~0.1x normal input.
export function billedTokens(u = {}) {
  return {
    input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) * 1.25 + (u.cache_read_input_tokens || 0) * 0.1,
    output: u.output_tokens || 0,
  };
}

// The parsed JSON answer, or Refused / an error saying why there's none.
export function jsonAnswer(res) {
  if (res.stop_reason === "refusal") throw new Refused("declined");
  if (res.stop_reason === "max_tokens") throw new Error("The answer was too long to finish; try again.");
  const text = res.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error(`No output (stop_reason: ${res.stop_reason})`);
  return JSON.parse(text);
}

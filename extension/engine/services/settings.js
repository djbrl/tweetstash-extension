// App settings and the API key, saved in the database's kv table (private to this extension). The key is
// never sent to the dashboard: it only learns "saved, ends in …abcd".
import { db } from "../db/index.js";
import { MODELS, EFFORTS } from "../catalog.js";
import { Anthropic, resetClient } from "./anthropic.js";

const DEFAULTS = {
  tagModel: "claude-opus-5-5",
  tagEffort: "low",
  searchModel: "claude-opus-5-5",
  searchEffort: "low",
  hideNsfw: false,
  tagger: null, // "local" (CLIP in the browser, free) or "claude" (needs a key); unset: Claude if there's a key
  // Average tokens actually used, per "model|effort": { n, input, output } (per post / per search).
  measuredTag: {},
  measuredSearch: {},
};

const read = (key) => db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key)?.value ?? null;
const write = (key, value) =>
  value == null ? db.prepare(`DELETE FROM kv WHERE key = ?`).run(key) : db.prepare(`INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`).run(key, value);

let current = { ...DEFAULTS };
try { current = { ...DEFAULTS, ...JSON.parse(read("settings") || "{}") }; } catch {}

export const settings = () => current;
export const tagger = () => current.tagger || (apiKey() ? "claude" : "local");
export const apiKey = () => read("anthropic_api_key") || "";

const save = () => write("settings", JSON.stringify(current));

export function updateSettings(patch = {}) {
  const isModel = (m) => MODELS.some((x) => x.id === m);
  if (isModel(patch.tagModel)) current.tagModel = patch.tagModel;
  if (isModel(patch.searchModel)) current.searchModel = patch.searchModel;
  if (EFFORTS.includes(patch.tagEffort)) current.tagEffort = patch.tagEffort;
  if (EFFORTS.includes(patch.searchEffort)) current.searchEffort = patch.searchEffort;
  if (typeof patch.hideNsfw === "boolean") current.hideNsfw = patch.hideNsfw;
  if (patch.tagger === "local" || patch.tagger === "claude") current.tagger = patch.tagger;
  save();
  return publicSettings();
}

// Running average of real usage, so price estimates get better after each run.
export function recordUsage(kind, model, effort, count, usage) {
  if (!count || !usage?.input) return;
  // Tagging answers got longer (descriptions, subjects) in format 2, so older averages don't apply.
  const key = kind === "tag" ? `${model}|${effort}|v2` : `${model}|${effort}`;
  const bucket = kind === "tag" ? current.measuredTag : current.measuredSearch;
  const m = bucket[key] || { n: 0, input: 0, output: 0 };
  const n = m.n + count;
  bucket[key] = {
    n,
    input: Math.round((m.input * m.n + usage.input) / n),
    output: Math.round((m.output * m.n + usage.output) / n),
  };
  save();
}

// What the browser may see: everything except the key itself.
export function publicSettings() {
  const key = apiKey();
  return { ...current, tagger: tagger(), models: MODELS, efforts: EFFORTS, hasKey: !!key, keyHint: key ? "…" + key.slice(-4) : "" };
}

// ---------- API key ----------

// Checks the key with a free call (reading one model's details) before saving it.
export async function setApiKey(key) {
  key = String(key || "").trim();
  if (!key) throw new Error("Paste a key first.");
  if (!/^sk-ant-[\w-]{20,}$/.test(key)) throw new Error("That doesn't look like an Anthropic key (they start with sk-ant-).");
  try {
    await new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true }).models.retrieve("claude-haiku-5-5");
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error("Anthropic didn't accept this key.");
    if (err instanceof Anthropic.PermissionDeniedError) throw new Error("This key isn't allowed to use the API.");
    throw new Error("Couldn't check the key: " + (err?.message || err));
  }
  write("anthropic_api_key", key);
  resetClient();
  return publicSettings();
}

export function removeApiKey() {
  write("anthropic_api_key", null);
  resetClient();
  return publicSettings();
}

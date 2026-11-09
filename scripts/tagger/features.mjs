// Builds the local tagger's features for a labelled stash, the same way the extension does, and caches
// them. The answer key is a TweetStash server database whose posts were tagged by Claude.
//   NEST_DB=~/tweet-nest/data/nest.db THUMBS=<dir of <id>.jpg, 360px> IMG_VECS=<prefix of CLIP picture vectors>
//   MODELS=<transformers cache> OUT=<dir> node scripts/tagger/features.mjs
// Only the posts' own words and first picture are used, never anything Claude wrote about them.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { wordsOf, e5WordsOf, isSensitive, featureVector } from "../../extension/engine/services/features.js";

const { NEST_DB, IMG_VECS, MODELS, OUT } = process.env;
fs.mkdirSync(OUT, { recursive: true });

const db = new DatabaseSync(NEST_DB, { readOnly: true });
const posts = db.prepare(`SELECT id, text, quoted, media, raw, category, medium FROM tweets
  WHERE removed_at IS NULL AND category IS NOT NULL`).all();
console.log(`${posts.length} labelled posts`);

const readVecs = (prefix) => {
  const { ids, dim } = JSON.parse(fs.readFileSync(prefix + ".json", "utf8"));
  const buf = fs.readFileSync(prefix + ".f32");
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return new Map(ids.map((id, i) => [id, all.slice(i * dim, (i + 1) * dim)]));
};
const img = readVecs(IMG_VECS);

const t = await import("@huggingface/transformers");
t.env.cacheDir = MODELS;
t.env.allowRemoteModels = false; // everything needed is already in the cache
const normalize = (v) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return Float32Array.from(v, (x) => x / n); };
const rows = (tensor) => { const d = tensor.dims.at(-1); return Array.from({ length: tensor.dims[0] }, (_, i) => normalize(tensor.data.subarray(i * d, (i + 1) * d))); };

async function batched(list, n, fn) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(...(await fn(list.slice(i, i + n))));
  return out;
}

const cachePath = (name) => path.join(OUT, name + ".json");
async function cached(name, make) {
  if (fs.existsSync(cachePath(name))) return new Map(JSON.parse(fs.readFileSync(cachePath(name), "utf8")).map(([k, v]) => [k, v && Float32Array.from(v)]));
  const m = await make();
  fs.writeFileSync(cachePath(name), JSON.stringify([...m].map(([k, v]) => [k, v && Array.from(v, (x) => Math.round(x * 1e5) / 1e5)])));
  return m;
}

// CLIP's words: same model and cut as the extension.
const clipTxt = await cached("clip-txt", async () => {
  const tok = await t.AutoTokenizer.from_pretrained("Xenova/clip-vit-base-patch16");
  const tm = await t.CLIPTextModelWithProjection.from_pretrained("Xenova/clip-vit-base-patch16", { dtype: "fp32" });
  const withWords = posts.filter((p) => wordsOf(p));
  const vecs = await batched(withWords.map(wordsOf), 32, async (b) => rows((await tm(tok(b, { padding: true, truncation: true }))).text_embeds));
  return new Map(withWords.map((p, i) => [p.id, vecs[i]]));
});
console.log("CLIP words done");

// The text model: multilingual-e5-small, 8-bit, as the extension runs it.
const e5 = await cached("e5", async () => {
  const fe = await t.pipeline("feature-extraction", "Xenova/multilingual-e5-small", { dtype: "q8" });
  const withWords = posts.filter((p) => e5WordsOf(p));
  const vecs = await batched(withWords.map((p) => "passage: " + e5WordsOf(p)), 16, async (b) => rows(await fe(b, { pooling: "mean", normalize: true })));
  return new Map(withWords.map((p, i) => [p.id, vecs[i]]));
});
console.log("e5 done");

// Category prompts for the current zero-shot tagger, so the test can compare against it.
const { CATEGORY_PICTURES, CATEGORY_WORDS } = await import("./zero-shot-prompts.mjs");
const tok = await t.AutoTokenizer.from_pretrained("Xenova/clip-vit-base-patch16");
const tm = await t.CLIPTextModelWithProjection.from_pretrained("Xenova/clip-vit-base-patch16", { dtype: "fp32" });
const embed = async (list) => rows((await tm(tok(list, { padding: true, truncation: true }))).text_embeds).map((v) => Array.from(v));
const prompts = {};
for (const c of Object.keys(CATEGORY_PICTURES)) {
  prompts[c] = { pics: await embed(CATEGORY_PICTURES[c].map((p) => "a picture of " + p)), words: (await embed([CATEGORY_WORDS[c]]))[0] };
}

const out = posts.map((p) => {
  const f = { img: img.get(p.id) || null, txt: clipTxt.get(p.id) || null, e5: e5.get(p.id) || null, sensitive: isSensitive(p.raw) };
  return {
    id: p.id, category: p.category, medium: p.medium,
    img: f.img && Array.from(f.img), txt: f.txt && Array.from(f.txt), x: Array.from(featureVector(f), (v) => Math.round(v * 1e5) / 1e5),
  };
});
fs.writeFileSync(path.join(OUT, "dataset.json"), JSON.stringify({ posts: out, prompts }));
console.log(`wrote ${out.length} posts (${out.filter((p) => p.img).length} with a picture, ${out.filter((p) => p.x[1410]).length} with e5 words)`);

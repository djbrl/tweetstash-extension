// The free local tagger, running in this worker. Two models turn each post into numbers:
//  - CLIP (ViT-B/16): what the first picture looks like, and the start of the words;
//  - multilingual-e5-small: what the words mean, in any language (CLIP only knows short English captions).
// A small classifier trained offline (classifier.js, scripts/tagger) turns those numbers into a category;
// your own fixes adjust it (personal.js). Nothing is generated and nothing leaves the browser except the
// one-time model download from Hugging Face, which the browser keeps.
// With a GPU (WebGPU) CLIP runs at 16 bits (~300 MB); without one, 8 bits on the CPU (~150 MB). The text
// model is 8-bit everywhere (~130 MB), as it was trained.
import { db, transaction } from "../db/index.js";
import { normTag, topTags } from "../db/tags.js";
import { smallImage, firstThumb } from "./images.js";
import { wordsOf, e5WordsOf, featureVector } from "./features.js";
import { headReady, classify, taughtTags, noAnswers } from "./personal.js";

const MODEL_ID = "Xenova/clip-vit-base-patch16";
const TEXT_ID = "Xenova/multilingual-e5-small";
const TEXT_MB = 135;
const GPU = { dtype: "fp16", mb: 300 + TEXT_MB, files: ["vision_model_fp16.onnx", "text_model_fp16.onnx"] };
const CPU = { dtype: "q8", mb: 152 + TEXT_MB, files: ["vision_model_quantized.onnx", "text_model_quantized.onnx"] };

db.exec(`CREATE TABLE IF NOT EXISTS local_vectors (tweet_id TEXT PRIMARY KEY, img BLOB, txt BLOB, model TEXT)`);
// e5: the text model's vector; v2: computed by 0.1.2 or later (has e5 when the post has words).
for (const col of ["e5 BLOB", "v2 INTEGER"]) { try { db.exec(`ALTER TABLE local_vectors ADD COLUMN ${col}`); } catch {} }

// ---------- the model ----------

// state: "none" (not downloaded) | "loading" | "ready" | "error"
export const model = { state: "none", loaded: 0, total: 0, error: null, device: null };
let loaded = null;
let loading = null;

let gpu = null;
async function hasGpu() {
  if (gpu === null) { try { gpu = !!(await navigator.gpu?.requestAdapter()); } catch { gpu = false; } }
  return gpu;
}

// What this computer would download and run, and whether it's already downloaded.
export async function modelInfo() {
  const plan = (await hasGpu()) ? GPU : CPU;
  let downloaded = model.state === "ready";
  try {
    const keys = (await (await caches.open("transformers-cache")).keys()).map((r) => r.url);
    downloaded ||= plan.files.every((f) => keys.some((u) => u.includes(MODEL_ID) && u.endsWith(f)))
      && keys.some((u) => u.includes(TEXT_ID) && u.endsWith("model_quantized.onnx"));
  } catch {}
  return { ...model, downloaded, mb: plan.mb, gpu: await hasGpu() };
}

export function loadModel() {
  if (loaded) return Promise.resolve(loaded);
  if (loading) return loading;
  Object.assign(model, { state: "loading", loaded: 0, total: 0, error: null });
  const files = new Map(); // file -> { loaded, total }, for one overall progress number
  const progress_callback = (p) => {
    if (p.status !== "progress" || !p.total) return;
    files.set(`${p.name}/${p.file}`, { loaded: p.loaded, total: p.total }); // both models have a config.json
    model.loaded = [...files.values()].reduce((s, f) => s + f.loaded, 0);
    model.total = [...files.values()].reduce((s, f) => s + f.total, 0);
  };
  loading = (async () => {
    const t = await import("../../vendor/transformers.mjs");
    const here = new URL("../../vendor/", import.meta.url).href;
    t.env.allowLocalModels = false;
    t.env.useBrowserCache = true;
    // It would otherwise re-load its runtime from a blob: URL, which an extension's security policy blocks.
    // The runtime ships inside the extension anyway, so there's nothing to cache.
    t.env.useWasmCache = false;
    t.env.backends.onnx.wasm.wasmPaths = { mjs: here + "ort-wasm-simd-threaded.asyncify.mjs", wasm: here + "ort-wasm-simd-threaded.asyncify.wasm" };
    t.env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    const device = (await hasGpu()) ? "webgpu" : "wasm";
    const opts = { dtype: (device === "webgpu" ? GPU : CPU).dtype, device, progress_callback };
    const [tokenizer, textModel, processor, visionModel, reader] = await Promise.all([
      t.AutoTokenizer.from_pretrained(MODEL_ID, { progress_callback }),
      t.CLIPTextModelWithProjection.from_pretrained(MODEL_ID, opts),
      t.AutoProcessor.from_pretrained(MODEL_ID, { progress_callback }),
      t.CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, opts),
      t.pipeline("feature-extraction", TEXT_ID, { dtype: "q8", device: "wasm", progress_callback }),
    ]);
    loaded = { t, tokenizer, textModel, processor, visionModel, reader };
    Object.assign(model, { state: "ready", device });
    return loaded;
  })().catch((err) => {
    Object.assign(model, { state: "error", error: err?.message || String(err) });
    loading = null;
    throw err;
  });
  return loading;
}

// Frees the model and deletes the downloaded files.
export async function removeModel() {
  loaded = null;
  loading = null;
  try {
    const cache = await caches.open("transformers-cache");
    for (const req of await cache.keys()) if (req.url.includes(MODEL_ID) || req.url.includes(TEXT_ID)) await cache.delete(req);
  } catch {}
  Object.assign(model, { state: "none", loaded: 0, total: 0, error: null });
  return model;
}

// ---------- vectors ----------

const DIM = 512;
const normalize = (v) => {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
};
export const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const rows = (tensor, dim = DIM) => Array.from({ length: tensor.dims[0] }, (_, i) => normalize(tensor.data.subarray(i * dim, (i + 1) * dim)));
const toBlob = (v) => (v ? new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)) : null);
const fromBlob = (b) => (b ? new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) : null);

export async function embedTexts(texts) {
  const { tokenizer, textModel } = await loadModel();
  const { text_embeds } = await textModel(tokenizer(texts, { padding: true, truncation: true })); // CLIP reads ~77 tokens
  return rows(text_embeds);
}

// The text model's vector for a post's words ("passage: " is how e5 marks stored text).
async function embedPassage(words) {
  const { reader } = await loadModel();
  return rows(await reader(["passage: " + words], { pooling: "mean", normalize: true }), 384)[0];
}

// A post's first picture, small. Fetched ahead (see prefetch) so downloading overlaps the model's work.
export async function fetchPicture(row) {
  const small = smallImage(firstThumb(row));
  if (!small || getVec.get(row.id, MODEL_ID)?.v2) return null;
  try {
    const res = await fetch(small, { signal: AbortSignal.timeout(8000) });
    return res.ok ? await res.blob() : null;
  } catch {
    return null; // no picture: the post is judged on its words
  }
}

async function embedImage(blob) {
  if (!blob) return null;
  const { t, processor, visionModel } = await loadModel();
  try {
    const { image_embeds } = await visionModel(await processor(await t.RawImage.fromBlob(blob)));
    return rows(image_embeds)[0];
  } catch {
    return null;
  }
}

// Vectors for this post, computing (and keeping) any that are missing. Posts from 0.1.1 have CLIP's
// vectors already and only get the text model's.
const getVec = db.prepare(`SELECT img, txt, e5, v2 FROM local_vectors WHERE tweet_id = ? AND model = ?`);
const putVec = db.prepare(`INSERT OR REPLACE INTO local_vectors (tweet_id, img, txt, e5, v2, model) VALUES (?, ?, ?, ?, 1, ?)`);
export async function vectorsFor(row, picture) {
  const have = getVec.get(row.id, MODEL_ID);
  if (have?.v2) return { img: fromBlob(have.img), txt: fromBlob(have.txt), e5: fromBlob(have.e5) };
  let img, txt;
  if (have) {
    img = fromBlob(have.img);
    txt = fromBlob(have.txt);
  } else {
    const words = wordsOf(row);
    [txt] = words ? await embedTexts([words]) : [null];
    img = await embedImage(await picture);
  }
  const passage = e5WordsOf(row);
  const e5 = passage ? await embedPassage(passage) : null;
  putVec.run(row.id, toBlob(img), toBlob(txt), toBlob(e5), MODEL_ID);
  return { img, txt, e5 };
}

// Every post's features, from the stored vectors (no model needed), for retraining and re-sorting.
export function allFeatures() {
  const out = new Map();
  for (const r of db.prepare(`SELECT v.tweet_id AS id, v.img, v.txt, v.e5, t.raw LIKE '%"possibly_sensitive":true%' AS sensitive
      FROM local_vectors v JOIN tweets t ON t.id = v.tweet_id WHERE v.v2 = 1 AND v.model = ?`).all(MODEL_ID)) {
    out.set(r.id, featureVector({ img: fromBlob(r.img), txt: fromBlob(r.txt), e5: fromBlob(r.e5), sensitive: !!r.sensitive }));
  }
  return out;
}

// ---------- tagging ----------

// Pictures for each category, used only to find posts to ask about while teaching (personal.js).
export const CATEGORY_PICTURES = {
  "Art & Illustration": ["a digital illustration or painting", "concept art of a character", "a sketch or drawing"],
  "Design & UI": ["a user interface design", "a website or app mockup", "a graphic design layout with typography"],
  "Dev & Engineering": ["a screenshot of code", "a programming terminal", "a software engineering diagram"],
  "AI & ML": ["a post about artificial intelligence", "a screenshot of a chatbot", "a machine learning chart"],
  "Tools & Resources": ["a screenshot of a software tool", "a list of useful websites and resources", "a product page of an app"],
  "Business & Freelance": ["a chart about money and business", "advice about freelancing and clients", "a post about startups and revenue"],
  "Career & Learning": ["advice about careers and jobs", "a tutorial or study notes", "a post about learning a skill"],
  "Games": ["a video game screenshot", "official art from a video game", "a game character in a fighting game"],
  "Anime & Manga": ["an anime screenshot", "a manga page", "anime fan art"],
  "Film & TV": ["a still from a movie", "a scene from a TV show", "a movie poster"],
  "News & Opinion": ["a screenshot of a news headline", "a political post or opinion", "a photo from a news event"],
  "Humor & Memes": ["a funny meme with text", "a joke or reaction image", "a silly cartoon meme"],
  "Life & Health": ["a photo about fitness or health", "a photo of food or cooking", "advice about daily life and wellbeing"],
  "Other": ["a random everyday photo", "a picture of an object", "a miscellaneous image"],
  "NSFW & Thirst": ["an explicit pornographic photo", "a nude person", "a woman in lingerie", "a sexy pin-up pose", "ecchi anime girl"],
};
const MEDIUMS = {
  photo: "a photograph", drawing: "a digital drawing or illustration", painting: "a painting", "3d": "a 3D render",
  "pixel-art": "pixel art", comic: "a comic page", screenshot: "a screenshot of an app or website", meme: "a meme with text",
};

let guess = null;
async function guesses() {
  if (guess) return guess;
  const mediumNames = Object.keys(MEDIUMS);
  const mediums = await embedTexts(mediumNames.map((m) => MEDIUMS[m]));
  guess = { mediumNames, mediums };
  return guess;
}

const argmax = (a) => a.reduce((bi, s, i) => (s > a[bi] ? i : bi), 0);

const hashtags = (text) => [...new Set([...(text || "").matchAll(/#([\p{L}\p{N}_]{2,40})/gu)].map((m) => normTag(m[1])).filter(Boolean))];

// Every 1-3 word run in the post, joined both ways ("league-of-legends", "leagueoflegends").
function phrases(text) {
  const words = (text || "").toLowerCase().replace(/https:\/\/t\.co\/\S+/g, " ").match(/[\p{L}\p{N}]+/gu) || [];
  const out = new Set();
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= 3 && i + n <= words.length; n++) {
      const run = words.slice(i, i + n);
      out.add(run.join("-"));
      if (n > 1) out.add(run.join(""));
    }
  }
  return out;
}

// Names worth spotting in a post's words: tags already in the stash, and hashtags seen 3+ times.
export function vocabulary() {
  const counts = new Map();
  for (const { text } of db.prepare(`SELECT text FROM tweets WHERE text LIKE '%#%'`).all()) {
    for (const h of hashtags(text)) counts.set(h, (counts.get(h) || 0) + 1);
  }
  const frequent = [...counts].filter(([, n]) => n >= 3).map(([h]) => h);
  // Very short names ("ai", "ui") match too much ordinary text; they still come in as #hashtags.
  return new Set([...topTags(400), ...frequent].filter((t) => t.length >= 3));
}

// One post's category, medium and tags.
export async function tagOne(row, vocab, picture) {
  const g = await guesses();
  await headReady();
  const { img, txt, e5 } = await vectorsFor(row, picture);
  const x = featureVector({ img, txt, e5, sensitive: !!row.sensitive });
  const { category, confidence, unsure } = img || txt || e5
    ? classify(x, noAnswers().get(row.id))
    : { category: "Other", confidence: 0, unsure: true };
  const medium = /"(video|animated_gif)"/.test(row.media || "") ? "video"
    : img ? g.mediumNames[argmax(g.mediums.map((m) => dot(m, img)))] : "text";
  const tags = new Set(hashtags(row.text));
  for (const p of phrases(row.text)) if (vocab.has(p)) tags.add(p);
  for (const t of taughtTags(x, row.id)) tags.add(t);
  return { id: row.id, category, confidence, unsure, medium, tags: [...tags].slice(0, 8) };
}

const delAiTags = db.prepare(`DELETE FROM tags WHERE tweet_id = ? AND source = 'ai'`);
const addTag = db.prepare(`INSERT OR IGNORE INTO tags (tweet_id, tag, source) VALUES (?, ?, 'ai')`);
// A category you picked yourself is never replaced.
const setResult = db.prepare(`UPDATE tweets SET medium = ?, tagged_at = ?, tag_error = NULL,
  category = CASE WHEN category_by = 'user' THEN category ELSE ? END,
  tag_confidence = CASE WHEN category_by = 'user' THEN NULL ELSE ? END,
  tag_unsure = CASE WHEN category_by = 'user' THEN 0 ELSE ? END,
  category_by = CASE WHEN category_by = 'user' THEN 'user' ELSE 'local' END
  WHERE id = ?`);

export function saveResult(r) {
  transaction(() => {
    delAiTags.run(r.id);
    for (const t of r.tags) addTag.run(r.id, t);
    setResult.run(r.medium, Date.now(), r.category, r.confidence, r.unsure ? 1 : 0, r.id);
  });
}

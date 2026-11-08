// The free local tagger: CLIP (ViT-B/16) running in this worker. It turns each post's first picture and
// its words into vectors, then picks the closest category and medium. Nothing is generated and nothing
// leaves the browser except the one-time model download from Hugging Face, which the browser keeps.
// With a GPU (WebGPU) it runs the 16-bit model: ~300 MB, ~0.1 s a post. Without one it falls back to the
// 8-bit model on the CPU: ~150 MB, ~1 s a post.
import { db, transaction } from "../db/index.js";
import { normTag, topTags } from "../db/tags.js";
import { NSFW_CATEGORY } from "../catalog.js";
import { smallImage, firstThumb } from "./images.js";

const MODEL_ID = "Xenova/clip-vit-base-patch16";
const GPU = { dtype: "fp16", mb: 300, files: ["vision_model_fp16.onnx", "text_model_fp16.onnx"] };
const CPU = { dtype: "q8", mb: 152, files: ["vision_model_quantized.onnx", "text_model_quantized.onnx"] };

db.exec(`CREATE TABLE IF NOT EXISTS local_vectors (tweet_id TEXT PRIMARY KEY, img BLOB, txt BLOB, model TEXT)`);

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
    downloaded ||= plan.files.every((f) => keys.some((u) => u.includes(MODEL_ID) && u.endsWith(f)));
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
    files.set(p.file, { loaded: p.loaded, total: p.total });
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
    const [tokenizer, textModel, processor, visionModel] = await Promise.all([
      t.AutoTokenizer.from_pretrained(MODEL_ID, { progress_callback }),
      t.CLIPTextModelWithProjection.from_pretrained(MODEL_ID, opts),
      t.AutoProcessor.from_pretrained(MODEL_ID, { progress_callback }),
      t.CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, opts),
    ]);
    loaded = { t, tokenizer, textModel, processor, visionModel };
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
    for (const req of await cache.keys()) if (req.url.includes(MODEL_ID)) await cache.delete(req);
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
const rows = (tensor) => Array.from({ length: tensor.dims[0] }, (_, i) => normalize(tensor.data.subarray(i * DIM, (i + 1) * DIM)));
const toBlob = (v) => (v ? new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)) : null);
const fromBlob = (b) => (b ? new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) : null);

export async function embedTexts(texts) {
  const { tokenizer, textModel } = await loadModel();
  const { text_embeds } = await textModel(tokenizer(texts, { padding: true, truncation: true })); // CLIP reads ~77 tokens
  return rows(text_embeds);
}

// A post's first picture, small. Fetched ahead (see prefetch) so downloading overlaps the model's work.
export async function fetchPicture(row) {
  const small = smallImage(firstThumb(row));
  if (!small || getVec.get(row.id, MODEL_ID)) return null;
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

// The post's own words, without links. CLIP only reads the start, so this stays short.
const wordsOf = (r) => (r.text || "").replace(/https:\/\/t\.co\/\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 300);

// Vectors for these posts, computing (and keeping) any that are missing.
const getVec = db.prepare(`SELECT img, txt FROM local_vectors WHERE tweet_id = ? AND model = ?`);
const putVec = db.prepare(`INSERT OR REPLACE INTO local_vectors (tweet_id, img, txt, model) VALUES (?, ?, ?, ?)`);
export async function vectorsFor(row, picture) {
  const have = getVec.get(row.id, MODEL_ID);
  if (have) return { img: fromBlob(have.img), txt: fromBlob(have.txt) };
  const words = wordsOf(row);
  const [txt] = words ? await embedTexts([words]) : [null];
  const img = await embedImage(await picture);
  putVec.run(row.id, toBlob(img), toBlob(txt), MODEL_ID);
  return { img, txt };
}

// ---------- tagging ----------

// What each category looks like (for pictures) and sounds like (for words). NSFW isn't guessed: CLIP
// doesn't spot it reliably, and a wrong guess would hide normal posts.
const CATEGORY_PICTURES = {
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
};
const CATEGORY_WORDS = {
  "Art & Illustration": "art, illustration, drawing, painting, concept art, sketch",
  "Design & UI": "graphic design, UI/UX, typography, web design",
  "Dev & Engineering": "programming, software engineering, code, developers",
  "AI & ML": "artificial intelligence, machine learning, LLMs, ChatGPT, AI models",
  "Tools & Resources": "useful tools, apps, websites and resources",
  "Business & Freelance": "business, freelancing, startups, money, marketing, clients",
  "Career & Learning": "careers, jobs, learning, studying, self-improvement advice",
  "Games": "video games, gaming, game release, players",
  "Anime & Manga": "anime, manga, episode, otaku",
  "Film & TV": "movies, TV shows, actors, cinema",
  "News & Opinion": "news, politics, opinion, world events",
  "Humor & Memes": "funny meme, joke, lol, humor",
  "Life & Health": "health, fitness, food, life advice, wellbeing",
  "Other": "miscellaneous, random",
};
const MEDIUMS = {
  photo: "a photograph", drawing: "a digital drawing or illustration", painting: "a painting", "3d": "a 3D render",
  "pixel-art": "pixel art", comic: "a comic page", screenshot: "a screenshot of an app or website", meme: "a meme with text",
};

let guess = null;
async function guesses() {
  if (guess) return guess;
  const names = Object.keys(CATEGORY_PICTURES).filter((c) => c !== NSFW_CATEGORY);
  const pics = [];
  for (const n of names) {
    const v = await embedTexts(CATEGORY_PICTURES[n].map((p) => "a picture of " + p));
    const m = new Float32Array(DIM);
    v.forEach((x) => x.forEach((y, i) => (m[i] += y / v.length)));
    pics.push(normalize(m));
  }
  const words = await embedTexts(names.map((n) => CATEGORY_WORDS[n]));
  const mediumNames = Object.keys(MEDIUMS);
  const mediums = await embedTexts(mediumNames.map((m) => MEDIUMS[m]));
  guess = { names, pics, words, mediumNames, mediums };
  return guess;
}

// Scores relative to the post's own average, so pictures and words compare fairly.
const z = (arr) => {
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  const sd = Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length) || 1;
  return arr.map((x) => (x - m) / sd);
};
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
  const { img, txt } = await vectorsFor(row, picture);
  let category = "Other";
  if (img || txt) {
    const sp = img ? z(g.pics.map((c) => dot(c, img))) : null;
    const st = txt ? z(g.words.map((c) => dot(c, txt))) : null;
    // Pictures count 1.5x: measured best on a real stash.
    category = g.names[argmax(g.names.map((_, k) => (sp ? 1.5 * sp[k] : 0) + (st ? st[k] : 0)))];
  }
  const medium = /"(video|animated_gif)"/.test(row.media || "") ? "video"
    : img ? g.mediumNames[argmax(g.mediums.map((m) => dot(m, img)))] : "text";
  const tags = new Set(hashtags(row.text));
  for (const p of phrases(row.text)) if (vocab.has(p)) tags.add(p);
  return { id: row.id, category, medium, tags: [...tags].slice(0, 8) };
}

const delAiTags = db.prepare(`DELETE FROM tags WHERE tweet_id = ? AND source = 'ai'`);
const addTag = db.prepare(`INSERT OR IGNORE INTO tags (tweet_id, tag, source) VALUES (?, ?, 'ai')`);
const setResult = db.prepare(`UPDATE tweets SET category = ?, medium = ?, tagged_at = ?, tag_error = NULL WHERE id = ?`);

export function saveResult(r) {
  transaction(() => {
    delAiTags.run(r.id);
    for (const t of r.tags) addTag.run(r.id, t);
    setResult.run(r.category, r.medium, Date.now(), r.id);
  });
}

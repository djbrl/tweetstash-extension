// What the local tagger knows about a post, as one row of numbers: CLIP's picture vector, CLIP's vector
// for the words, the text model's vector for the words, and X's own "sensitive media" flag. Shared by
// the extension and by the training script (scripts/tagger), so both build exactly the same thing.

export const IMG = 0, HAS_IMG = 512, TXT = 513, HAS_TXT = 1025, E5 = 1026, HAS_E5 = 1410, SENSITIVE = 1411;
export const DIM = 1412;

const noLinks = (s) => (s || "").replace(/https:\/\/t\.co\/\S+/g, "").replace(/\s+/g, " ").trim();

// CLIP reads only ~77 tokens, so it gets the start of the post.
export const wordsOf = (r) => noLinks(r.text).slice(0, 300);

// The text model reads more, including a quoted post's words: a quote's meaning is often in the quote.
export function e5WordsOf(r) {
  let quoted = "";
  try { quoted = r.quoted ? (typeof r.quoted === "string" ? JSON.parse(r.quoted) : r.quoted)?.text || "" : ""; } catch {}
  return [noLinks(r.text), noLinks(quoted)].filter(Boolean).join(" — ").slice(0, 500);
}

// X marks posts with sensitive media. Not reliable on its own, so it's one input among many.
export const isSensitive = (raw) => /"possibly_sensitive":true/.test(raw || "");

// { img, txt, e5, sensitive } -> Float32Array(DIM). Missing parts stay zero, with a flag saying so.
export function featureVector({ img, txt, e5, sensitive }) {
  const x = new Float32Array(DIM);
  if (img) { x.set(img, IMG); x[HAS_IMG] = 1; }
  if (txt) { x.set(txt, TXT); x[HAS_TXT] = 1; }
  if (e5) { x.set(e5, E5); x[HAS_E5] = 1; }
  x[SENSITIVE] = sensitive ? 1 : 0;
  return x;
}

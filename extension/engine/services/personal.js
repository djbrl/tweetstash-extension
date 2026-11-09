// What the local tagger learns from you, on this computer.
//
// Categories: the extension ships a classifier trained offline (models/categories.json). Every category
// you pick by hand (on a card, or "yes" in Teach) is an example; once there are 3, the classifier is
// adjusted toward them and every automatically sorted post is re-sorted in a few seconds. Only the
// categories your fixes involve (where posts were, where you moved them) change, so a fix about anime
// drawings can't push food photos into Humor. Measured on a real stash (12 fixes moving anime drawings
// to Art): 97 of 108 similar drawings followed; ~400 other posts moved too, mostly game and anime
// drawings into Art. "Undo" in Teach goes back to the shipped classifier.
// A "no" in Teach means "never this category for this post".
//
// Tags: Teach a tag of your own (yes/no rounds of 12); a small yes/no model learns it and can tag the
// rest of the stash. Ported from the TweetStash free edition.
//
// Nothing is generated and nothing leaves the browser.
import { db, transaction, ftsQuery } from "../db/index.js";
import { normTag } from "../db/tags.js";
import { CATEGORIES, NSFW_CATEGORY } from "../catalog.js";
import { train, probs, unpackWeights } from "./classifier.js";
import { allFeatures, embedTexts, dot, model as localModel, CATEGORY_PICTURES } from "./local.js";
import { IMG, HAS_IMG } from "./features.js";

const K = CATEGORIES.length;
const NSFW_SURE = 0.7; // NSFW only when this sure: measured 15 of 15 right on unseen posts, finding half
const UNSURE = 0.3; // below this, the post goes to "Check these" (~6% of posts; the rest ~81% right)
const ROUND = 12;

db.exec(`
  CREATE TABLE IF NOT EXISTS teach_answers (kind TEXT, label TEXT, tweet_id TEXT, yes INTEGER, at INTEGER, PRIMARY KEY (kind, label, tweet_id));
  CREATE TABLE IF NOT EXISTS teach_models (kind TEXT, label TEXT, w BLOB, b REAL, pos INTEGER, neg INTEGER, trained_at INTEGER, PRIMARY KEY (kind, label));
`);

const toBlob = (v) => new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
const fromBlob = (b) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const fail = (msg, status = 400) => { throw Object.assign(new Error(msg), { status }); };

// ---------- the category classifier ----------

let shipped = null;
let personal = null; // adjusted weights, or null while you've fixed fewer than MIN_FIXES posts
const MIN_FIXES = 3;

export async function headReady() {
  if (shipped) return;
  const res = await fetch(new URL("../models/categories.json", import.meta.url));
  const m = await res.json();
  if (m.categories.join("|") !== CATEGORIES.join("|")) throw new Error("The category model doesn't match this version's categories.");
  shipped = unpackWeights(m.weights);
  const saved = db.prepare(`SELECT w FROM teach_models WHERE kind = 'categories' AND label = ''`).get();
  if (saved) personal = fromBlob(saved.w);
}

export const categoryProbs = (x) => probs(personal || shipped, K, x);

// Which categories your fixes touched; kept so the guard below survives restarts.
const readInvolved = () => { try { return new Set(JSON.parse(db.prepare(`SELECT value FROM kv WHERE key = 'learned_involved'`).get()?.value || "[]")); } catch { return new Set(); } };
let involved = null;
const NSFW_K = CATEGORIES.indexOf(NSFW_CATEGORY);

// The category for a post's features. Learning from your fixes never takes a post out of NSFW unless
// your fixes were about NSFW: a fix about drawings shouldn't reveal explicit drawings in All bookmarks.
export function classify(x, excluded) {
  const d = decide(categoryProbs(x), excluded);
  if (!personal || d.category === NSFW_CATEGORY) return d;
  involved ||= readInvolved();
  if (involved.has(NSFW_K)) return d;
  const base = decide(probs(shipped, K, x), excluded);
  return base.category === NSFW_CATEGORY ? base : d;
}

// The category to use: the likeliest one, except NSFW unless it's quite sure, and never one you said no to.
export function decide(p, excluded) {
  const order = [...p.keys()].sort((a, b) => p[b] - p[a]).filter((k) => !excluded?.has(CATEGORIES[k]));
  let k = order[0];
  if (CATEGORIES[k] === NSFW_CATEGORY && p[k] < NSFW_SURE) k = order[1];
  return { category: CATEGORIES[k], confidence: p[k], unsure: p[k] < UNSURE };
}

// post id -> Set of categories you said "no" to.
let noCache = null;
export function noAnswers() {
  if (noCache) return noCache;
  noCache = new Map();
  for (const r of db.prepare(`SELECT tweet_id, label FROM teach_answers WHERE kind = 'category' AND yes = 0`).all()) {
    if (!noCache.has(r.tweet_id)) noCache.set(r.tweet_id, new Set());
    noCache.get(r.tweet_id).add(r.label);
  }
  return noCache;
}

// Adjusts the shipped classifier toward your own categories. Settings measured in scripts/tagger:
// your examples count 5x; 400 other posts, labelled by the shipped model, keep it from drifting.
function retrainCategories(F) {
  const mine = db.prepare(`SELECT id, category FROM tweets WHERE category_by = 'user' AND category IS NOT NULL`).all()
    .filter((r) => F.has(r.id) && CATEGORIES.includes(r.category));
  if (mine.length < MIN_FIXES) {
    personal = null;
    db.prepare(`DELETE FROM teach_models WHERE kind = 'categories'`).run();
    return { fixes: mine.length };
  }
  const taken = new Set(mine.map((r) => r.id));
  const anchors = seededSample([...F.keys()].filter((id) => !taken.has(id)), 400, "anchors");
  const argmax = (p) => p.indexOf(Math.max(...p));
  const X = [...mine.map((r) => F.get(r.id)), ...anchors.map((id) => F.get(id))];
  const y = [...mine.map((r) => CATEGORIES.indexOf(r.category)), ...anchors.map((id) => argmax(Array.from(probs(shipped, K, F.get(id)))))];
  const sampleWeight = Float32Array.from([...mine.map(() => 5), ...anchors.map(() => 0.3)]);
  // Only the categories involved: the ones you picked, and the ones the shipped model had said.
  const only = new Set(mine.flatMap((r) => [CATEGORIES.indexOf(r.category), argmax(Array.from(probs(shipped, K, F.get(r.id))))]));
  personal = train({ X, y, K, sampleWeight, prior: shipped, pull: 0.01, epochs: 100, lr: 0.005, l2: 0, only });
  involved = only;
  db.prepare(`INSERT OR REPLACE INTO kv (key, value) VALUES ('learned_involved', ?)`).run(JSON.stringify([...only]));
  db.prepare(`INSERT OR REPLACE INTO teach_models (kind, label, w, b, pos, neg, trained_at) VALUES ('categories', '', ?, 0, ?, 0, ?)`)
    .run(toBlob(personal), mine.length, Date.now());
  return { fixes: mine.length };
}

// Re-sorts every post this computer sorted (never yours, never Claude's) with the current classifier.
const setLocal = db.prepare(`UPDATE tweets SET category = ?, tag_confidence = ?, tag_unsure = ? WHERE id = ? AND category_by = 'local'`);
function resortAll(F) {
  const ids = db.prepare(`SELECT id FROM tweets WHERE category_by = 'local'`).all().map((r) => r.id).filter((id) => F.has(id));
  const no = noAnswers();
  let moved = 0;
  const before = new Map(db.prepare(`SELECT id, category FROM tweets WHERE category_by = 'local'`).all().map((r) => [r.id, r.category]));
  transaction(() => {
    for (const id of ids) {
      const d = classify(F.get(id), no.get(id));
      if (d.category !== before.get(id)) moved++;
      setLocal.run(d.category, d.confidence, d.unsure ? 1 : 0, id);
    }
  });
  return moved;
}

// After a fix, wait a moment for more (people fix several in a row), then learn and re-sort.
export const learning = { running: false, fixes: 0, moved: 0, at: null };
let timer = null;
export function scheduleLearning(delay = 2500) {
  clearTimeout(timer);
  timer = setTimeout(learnNow, delay);
}
export async function learnNow() {
  if (learning.running) return scheduleLearning(1000);
  learning.running = true;
  try {
    await headReady();
    const F = allFeatures();
    Object.assign(learning, retrainCategories(F));
    learning.moved = resortAll(F);
    learning.at = Date.now();
  } catch (err) {
    console.error("[learning]", err);
  } finally {
    learning.running = false;
  }
}

// You picked a category for a post (or cleared it with null, to let the tagger decide again).
export function setUserCategory(id, category) {
  if (category !== null && !CATEGORIES.includes(category)) fail("unknown category");
  if (category === null) {
    db.prepare(`UPDATE tweets SET category_by = 'local' WHERE id = ? AND category_by = 'user'`).run(String(id));
  } else {
    db.prepare(`UPDATE tweets SET category = ?, category_by = 'user', tag_unsure = 0, tag_confidence = NULL,
      tagged_at = COALESCE(tagged_at, ?) WHERE id = ?`).run(category, Date.now(), String(id));
  }
  scheduleLearning();
  return { ok: true };
}

// ---------- the yes/no model for a tag ----------

// Logistic regression by plain gradient descent, from the free edition (learning rate measured there).
function trainYesNo(pos, neg) {
  const X = [...pos, ...neg], y = [...pos.map(() => 1), ...neg.map(() => 0)], d = X[0].length;
  const w = new Float32Array(d);
  let b = 0;
  const up = neg.length / pos.length;
  for (let it = 0; it < 300; it++) {
    const g = new Float32Array(d);
    let gb = 0;
    for (let i = 0; i < X.length; i++) {
      const x = X[i], p = 1 / (1 + Math.exp(-(dot(w, x) + b) * 8)), e = (p - y[i]) * (y[i] ? up : 1);
      for (let k = 0; k < d; k++) g[k] += e * x[k];
      gb += e;
    }
    for (let k = 0; k < d; k++) w[k] -= 0.5 * (g[k] / X.length + 0.001 * w[k]);
    b -= (0.5 * gb) / X.length;
  }
  return { w, b };
}

function seededSample(ids, n, label) {
  let seed = [...label].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const pool = [...ids], out = [];
  for (let i = 0; i < n && pool.length; i++) out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  return out;
}

const tagModels = new Map(); // label -> { w, b } | null
function tagModel(label) {
  if (tagModels.has(label)) return tagModels.get(label);
  const r = db.prepare(`SELECT w, b FROM teach_models WHERE kind = 'tag' AND label = ?`).get(label);
  const m = r ? { w: fromBlob(r.w), b: r.b } : null;
  tagModels.set(label, m);
  return m;
}

// Tags a new post gets from what you've taught (never one you said "no" to for this post).
export function taughtTags(x, id) {
  const out = [];
  for (const { label } of db.prepare(`SELECT label FROM teach_models WHERE kind = 'tag'`).all()) {
    const m = tagModel(label);
    if (m && dot(m.w, x) + m.b > 0 && !db.prepare(`SELECT 1 FROM teach_answers WHERE kind = 'tag' AND label = ? AND tweet_id = ? AND yes = 0`).get(label, id)) out.push(label);
  }
  return out;
}

// ---------- teaching rounds ----------

function checkLabel(kind, label) {
  if (kind === "category") {
    if (!CATEGORIES.includes(label)) fail("unknown category");
    return label;
  }
  if (kind !== "tag") fail("kind must be tag or category");
  return normTag(label || "") || fail("Give the tag a name.");
}

function examples(kind, label) {
  const answered = db.prepare(`SELECT tweet_id, yes FROM teach_answers WHERE kind = ? AND label = ?`).all(kind, label);
  const no = new Set(answered.filter((a) => !a.yes).map((a) => a.tweet_id));
  const yes = new Set(answered.filter((a) => a.yes).map((a) => a.tweet_id));
  const byHand = kind === "tag"
    ? db.prepare(`SELECT tweet_id AS id FROM tags WHERE tag = ? AND source = 'user'`).all(label)
    : db.prepare(`SELECT id FROM tweets WHERE category = ? AND category_by = 'user'`).all(label);
  for (const r of byHand) if (!no.has(r.id)) yes.add(r.id);
  return { yes, no };
}

function retrainTag(label, F) {
  const { yes, no } = examples("tag", label);
  const pos = [...yes].map((id) => F.get(id)).filter(Boolean);
  if (pos.length < 3) return false;
  const others = seededSample([...F.keys()].filter((id) => !yes.has(id) && !no.has(id)), Math.max(30, pos.length * 3), label);
  const m = trainYesNo(pos, [...no, ...others].map((id) => F.get(id)).filter(Boolean));
  db.prepare(`INSERT OR REPLACE INTO teach_models (kind, label, w, b, pos, neg, trained_at) VALUES ('tag', ?, ?, ?, ?, ?, ?)`)
    .run(label, toBlob(m.w), m.b, pos.length, no.size, Date.now());
  tagModels.set(label, m);
  return true;
}

// Rank fusion: a post high in several lists comes first.
function fuse(lists) {
  const score = new Map();
  for (const { ids, weight } of lists) ids.forEach((id, i) => score.set(id, (score.get(id) || 0) + weight / (60 + i + 1)));
  return [...score].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

// Posts whose picture looks like these words (CLIP), when the model is on hand.
async function looksLike(phrases, F) {
  if (localModel.state !== "ready") return [];
  const q = await embedTexts(phrases.map((p) => "a picture of " + p));
  const out = [];
  for (const [id, f] of F) {
    if (!f[HAS_IMG]) continue;
    const img = f.subarray(IMG, IMG + 512);
    out.push([id, Math.max(...q.map((v) => dot(v, img)))]);
  }
  return out.sort((a, b) => b[1] - a[1]).slice(0, 300).map(([id]) => id);
}

function wordMatches(label) {
  const fq = ftsQuery(label.replace(/-/g, " "));
  if (!fq) return [];
  return db.prepare(`SELECT t.id FROM tweets t WHERE t.rowid IN (SELECT rowid FROM tweets_fts WHERE tweets_fts MATCH ?) LIMIT 300`).all(fq).map((r) => r.id);
}

function likeThese(ids, F) {
  const fs = [...ids].map((id) => F.get(id)).filter(Boolean);
  if (!fs.length) return [];
  const c = new Float32Array(fs[0].length);
  for (const f of fs) for (let i = 0; i < c.length; i++) c[i] += f[i] / fs.length;
  return [...F].map(([id, f]) => [id, dot(c, f)]).sort((a, b) => b[1] - a[1]).slice(0, 300).map(([id]) => id);
}

const postRows = (ids) => {
  if (!ids.length) return [];
  const rows = db.prepare(`SELECT id, author_name, author_handle, author_avatar, text, media, category, category_by,
      (SELECT GROUP_CONCAT(tag) FROM tags g WHERE g.tweet_id = t.id) AS tags
    FROM tweets t WHERE t.id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids));
  const pos = new Map(ids.map((id, i) => [id, i]));
  return rows.sort((a, b) => pos.get(a.id) - pos.get(b.id))
    .map((r) => ({ ...r, media: JSON.parse(r.media || "[]"), tags: r.tags ? r.tags.split(",") : [] }));
};

// The next posts to ask about: mostly the likeliest "yes", plus a few it can't decide on (they teach it most).
export async function nextRound(kind, rawLabel) {
  const label = checkLabel(kind, rawLabel);
  await headReady();
  const F = allFeatures();
  if (!F.size) fail("Tag your stash with the local tagger first, so it has looked at every post.", 409);
  const { yes, no } = examples(kind, label);
  const fresh = (id) => !yes.has(id) && !no.has(id) && F.has(id);
  let ids;
  if (kind === "category") {
    const k = CATEGORIES.indexOf(label);
    const userSet = new Set(db.prepare(`SELECT id FROM tweets WHERE category_by = 'user'`).all().map((r) => r.id));
    const scored = [...F].filter(([id]) => fresh(id) && !userSet.has(id)).map(([id, f]) => [id, categoryProbs(f)[k]]);
    const sure = [...scored].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id]) => id);
    const taken = new Set(sure);
    const unsure = scored.filter(([id]) => !taken.has(id)).sort((a, b) => Math.abs(a[1] - 0.5) - Math.abs(b[1] - 0.5)).slice(0, 4).map(([id]) => id);
    ids = [...sure, ...unsure];
  } else {
    const m = tagModel(label);
    if (!m) {
      ids = fuse([
        { ids: wordMatches(label), weight: 1 },
        { ids: await looksLike([label.replace(/-/g, " ")], F), weight: 1 },
        { ids: likeThese(yes, F), weight: 1.5 },
      ]).filter(fresh).slice(0, ROUND);
      if (ids.length < ROUND) ids.push(...seededSample([...F.keys()].filter((id) => fresh(id) && !ids.includes(id)), ROUND - ids.length, label + yes.size));
    } else {
      const scored = [...F].filter(([id]) => fresh(id)).map(([id, f]) => [id, dot(m.w, f) + m.b]);
      const sure = [...scored].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id]) => id);
      const taken = new Set(sure);
      const unsure = scored.filter(([id]) => !taken.has(id)).sort((a, b) => Math.abs(a[1]) - Math.abs(b[1])).slice(0, 4).map(([id]) => id);
      ids = [...sure, ...unsure];
    }
  }
  return { kind, label, trained: kind === "tag" ? !!tagModel(label) : !!personal, yes: yes.size, no: no.size, posts: postRows(ids) };
}

// answers: [{ id, yes }]. "Yes" tags the post (or sets its category) right away; "no" takes the tag off
// (or rules the category out for that post). Then it learns, and the next round comes back.
export async function answer(kind, rawLabel, answers) {
  const label = checkLabel(kind, rawLabel);
  if (!Array.isArray(answers) || answers.length > 100) fail("invalid answers");
  const put = db.prepare(`INSERT INTO teach_answers (kind, label, tweet_id, yes, at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (kind, label, tweet_id) DO UPDATE SET yes = excluded.yes, at = excluded.at`);
  transaction(() => {
    for (const a of answers) {
      if (typeof a?.id !== "string" || !/^\d{1,25}$/.test(a.id) || typeof a.yes !== "boolean") continue;
      put.run(kind, label, a.id, a.yes ? 1 : 0, Date.now());
      if (kind === "tag") {
        if (a.yes) db.prepare(`INSERT INTO tags (tweet_id, tag, source) VALUES (?, ?, 'user') ON CONFLICT (tweet_id, tag) DO UPDATE SET source = 'user'`).run(a.id, label);
        else db.prepare(`DELETE FROM tags WHERE tweet_id = ? AND tag = ?`).run(a.id, label);
      } else if (a.yes) {
        db.prepare(`UPDATE tweets SET category = ?, category_by = 'user', tag_unsure = 0, tag_confidence = NULL, tagged_at = COALESCE(tagged_at, ?) WHERE id = ?`).run(label, Date.now(), a.id);
      } else {
        // No longer yours if you'd picked it; the tagger will choose something else.
        db.prepare(`UPDATE tweets SET category_by = 'local' WHERE id = ? AND category = ? AND category_by = 'user'`).run(a.id, label);
      }
    }
  });
  noCache = null;
  if (kind === "tag") retrainTag(label, allFeatures());
  else await learnNow();
  return { next: await nextRound(kind, label) };
}

// Tags every post the tag's model says "yes" to (replacing its earlier guesses for that tag).
export function applyTag(rawLabel) {
  const label = checkLabel("tag", rawLabel);
  const m = tagModel(label);
  if (!m) fail("Teach it at least 3 posts first.", 409);
  const { no } = examples("tag", label);
  let guessed = 0;
  transaction(() => {
    db.prepare(`DELETE FROM tags WHERE tag = ? AND source = 'ai'`).run(label);
    for (const [id, f] of allFeatures()) {
      if (!no.has(id) && dot(m.w, f) + m.b > 0) { db.prepare(`INSERT OR IGNORE INTO tags (tweet_id, tag, source) VALUES (?, ?, 'ai')`).run(id, label); guessed++; }
    }
  });
  return { label, guessed, tagged: db.prepare(`SELECT COUNT(*) AS n FROM tags WHERE tag = ?`).get(label).n };
}

// What you've taught so far, for the Teach window.
export function teachStatus() {
  const rows = db.prepare(`SELECT kind, label, SUM(yes) AS yes, SUM(1 - yes) AS no, MAX(at) AS at FROM teach_answers GROUP BY kind, label`).all();
  const trained = new Set(db.prepare(`SELECT label FROM teach_models WHERE kind = 'tag'`).all().map((r) => r.label));
  const fixes = db.prepare(`SELECT COUNT(*) AS n FROM tweets WHERE category_by = 'user'`).get().n;
  return {
    taught: rows.map((r) => ({ ...r, trained: r.kind === "tag" ? trained.has(r.label) : !!personal })).sort((a, b) => b.at - a.at),
    fixes, minFixes: MIN_FIXES, learning, categories: CATEGORIES,
    ready: db.prepare(`SELECT COUNT(*) AS n FROM local_vectors WHERE v2 = 1`).get().n,
  };
}

// Forgets one label's answers and model. Tags and categories already set stay.
export function forget(kind, rawLabel) {
  const label = checkLabel(kind, rawLabel);
  db.prepare(`DELETE FROM teach_answers WHERE kind = ? AND label = ?`).run(kind, label);
  if (kind === "tag") { db.prepare(`DELETE FROM teach_models WHERE kind = 'tag' AND label = ?`).run(label); tagModels.delete(label); }
  noCache = null;
  return { ok: true };
}

// Undoes what it learned from your categories: back to the shipped classifier, and the posts it sorted
// are re-sorted with it. The categories you picked yourself become automatic again.
export async function resetCategories() {
  db.prepare(`UPDATE tweets SET category_by = 'local' WHERE category_by = 'user'`).run();
  db.prepare(`DELETE FROM teach_answers WHERE kind = 'category'`).run();
  noCache = null;
  await learnNow(); // fewer than 3 fixes now: shipped classifier, and a re-sort
  return { ok: true, moved: learning.moved };
}


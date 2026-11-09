// Tests the local tagger against Claude's categories (dataset from features.mjs), then trains the model
// that ships with the extension.
//   DATA=<dir with dataset.json> node scripts/tagger/evaluate.mjs [--ship]
// Reports: v0.1.1's zero-shot tagger, the trained model on posts it never saw, NSFW at several strictness
// levels, the "not sure" cut-off, and how much your own fixes help (simulated).
import fs from "node:fs";
import path from "node:path";
import { CATEGORIES, NSFW_CATEGORY } from "../../extension/engine/catalog.js";
import { train, probs, packWeights } from "../../extension/engine/services/classifier.js";
import { DIM } from "../../extension/engine/services/features.js";

const { posts, prompts } = JSON.parse(fs.readFileSync(path.join(process.env.DATA, "dataset.json"), "utf8"));
const K = CATEGORIES.length;
const data = posts.filter((p) => CATEGORIES.includes(p.category)).map((p) => ({ ...p, y: CATEGORIES.indexOf(p.category), x: Float32Array.from(p.x) }));
const HUMOR = CATEGORIES.indexOf("Humor & Memes"), NSFW = CATEGORIES.indexOf(NSFW_CATEGORY);

// Deterministic split by id: 80% to learn from, 20% never seen.
const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const test = data.filter((p) => hash(p.id) % 5 === 0), learn = data.filter((p) => hash(p.id) % 5 !== 0);
console.log(`${data.length} posts: ${learn.length} to learn from, ${test.length} to test on\n`);

const pct = (x) => (100 * x).toFixed(1) + "%";
function report(name, preds, set) {
  const right = preds.filter((p, i) => p === set[i].y).length;
  const recall = CATEGORIES.map((_, k) => {
    const idx = set.map((p, i) => [p, i]).filter(([p]) => p.y === k);
    return idx.length ? idx.filter(([, i]) => preds[i] === k).length / idx.length : null;
  });
  const valid = recall.filter((r) => r !== null);
  const humorShare = preds.filter((p) => p === HUMOR).length / preds.length;
  console.log(`${name}: ${pct(right / set.length)} right, ${pct(valid.reduce((a, b) => a + b, 0) / valid.length)} average per category, ${pct(humorShare)} put in Humor (Claude: ${pct(set.filter((p) => p.y === HUMOR).length / set.length)})`);
  return { accuracy: right / set.length, recall };
}

// ---------- v0.1.1: zero-shot ----------
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const norm = (v) => { const n = Math.sqrt(dot(v, v)) || 1; return v.map((x) => x / n); };
const zNames = Object.keys(prompts);
const zPics = zNames.map((n) => norm(prompts[n].pics.reduce((acc, v) => acc.map((a, i) => a + v[i] / prompts[n].pics.length), new Array(512).fill(0))));
const zWords = zNames.map((n) => prompts[n].words);
const z = (arr) => { const m = arr.reduce((a, b) => a + b, 0) / arr.length; const sd = Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length) || 1; return arr.map((x) => (x - m) / sd); };
const zeroShot = (p) => {
  if (!p.img && !p.txt) return CATEGORIES.indexOf("Other");
  const sp = p.img ? z(zPics.map((c) => dot(c, p.img))) : null, st = p.txt ? z(zWords.map((c) => dot(c, p.txt))) : null;
  const s = zNames.map((_, k) => (sp ? 1.5 * sp[k] : 0) + (st ? st[k] : 0));
  return CATEGORIES.indexOf(zNames[s.indexOf(Math.max(...s))]);
};
const results = { zeroShot: report("v0.1.1 zero-shot", test.map(zeroShot), test) };

// ---------- trained ----------
const classWeights = (set) => {
  const n = CATEGORIES.map((_, k) => set.filter((p) => p.y === k).length);
  return n.map((c) => (c ? Math.sqrt(set.length / (K * c)) : 0));
};
const fit = (set, opts = {}) => {
  const cw = classWeights(set);
  return train({ X: set.map((p) => p.x), y: set.map((p) => p.y), K, sampleWeight: Float32Array.from(set.map((p) => cw[p.y])), ...opts });
};

let t0 = Date.now();
const W = fit(learn);
console.log(`(trained in ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
const P = test.map((p) => probs(W, K, p.x));
const argmax = (a) => a.indexOf(Math.max(...a));

// NSFW only when it's sure: otherwise the next best category.
const decide = (p, nsfwCut) => {
  const k = argmax(p);
  if (k !== NSFW || p[NSFW] >= nsfwCut) return k;
  const q = Array.from(p); q[NSFW] = -1; return argmax(q);
};
results.trained = report("trained, plain", P.map((p) => argmax(p)), test);

console.log("\nNSFW strictness (on posts never seen):");
for (const cut of [0, 0.5, 0.6, 0.7, 0.8, 0.9]) {
  const preds = P.map((p) => decide(p, cut));
  const said = preds.map((k, i) => [k, i]).filter(([k]) => k === NSFW);
  const truly = test.filter((p) => p.y === NSFW).length;
  const right = said.filter(([, i]) => test[i].y === NSFW).length;
  console.log(`  needs ${cut}: marks ${said.length}, ${right} really NSFW (${pct(right / (said.length || 1))} right), finds ${right}/${truly}; overall ${pct(preds.filter((k, i) => k === test[i].y).length / test.length)}`);
}

console.log("\n\"Not sure\" cut-off (top score below it goes to Check these):");
for (const cut of [0.3, 0.4, 0.5, 0.6]) {
  const sure = P.map((p, i) => [p, i]).filter(([p]) => Math.max(...p) >= cut);
  const right = sure.filter(([p, i]) => decide(p, 0.7) === test[i].y).length;
  console.log(`  below ${cut}: ${pct(1 - sure.length / test.length)} to check; the rest ${pct(right / sure.length)} right`);
}

// ---------- your own fixes, simulated ----------
// The model learns from half the stash; the other half plays "you": you fix N of its mistakes, it adjusts
// (staying near what it knew), and it's tested on the rest of your half.
console.log("\nLearning from fixes (simulated):");
const half = data.filter((p) => hash(p.id + "u") % 2 === 0), mine = data.filter((p) => hash(p.id + "u") % 2 === 1);
const base = fit(half);
const myTest = mine.filter((p) => hash(p.id) % 3 === 0), myPool = mine.filter((p) => hash(p.id) % 3 !== 0);
const acc = (Wx, set) => set.filter((p) => decide(probs(Wx, K, p.x), 0.7) === p.y).length / set.length;
console.log(`  0 fixes: ${pct(acc(base, myTest))}`);
const wrong = myPool.filter((p) => decide(probs(base, K, p.x), 0.7) !== p.y).sort((a, b) => hash(a.id + "o") - hash(b.id + "o"));
for (const n of [10, 30, 100, 300]) {
  const fixes = wrong.slice(0, n);
  t0 = Date.now();
  const Wp = train({ X: fixes.map((p) => p.x), y: fixes.map((p) => p.y), K, prior: base, pull: 0.05, epochs: 60, lr: 0.01, l2: 0 });
  console.log(`  ${n} fixes: ${pct(acc(Wp, myTest))} (${Date.now() - t0} ms to learn)`);
}

// ---------- ship ----------
if (process.argv.includes("--ship")) {
  const Wall = fit(data);
  const file = path.resolve("extension/engine/models/categories.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, categories: CATEGORIES, dim: DIM, trainedOn: data.length, weights: packWeights(Wall) }));
  console.log(`\nwrote ${file} (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);
}

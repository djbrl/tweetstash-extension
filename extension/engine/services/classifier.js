// A small classifier over post features (features.js): one weight row per category, softmax on top.
// Not generative, and tiny: training a few hundred examples takes well under a second.
// Used three ways: the shipped model (trained offline, scripts/tagger), and the same model nudged by
// your own fixes and answers, on this computer (personal.js).

// W: Float32Array(K * (D + 1)), each row = D weights then a bias.
export function scores(W, K, x) {
  const D = x.length, out = new Float32Array(K);
  for (let k = 0; k < K; k++) {
    const o = k * (D + 1);
    let s = W[o + D];
    for (let i = 0; i < D; i++) s += W[o + i] * x[i];
    out[k] = s;
  }
  return out;
}

export function softmax(s) {
  let m = -Infinity;
  for (const v of s) if (v > m) m = v;
  let sum = 0;
  const p = new Float32Array(s.length);
  for (let i = 0; i < s.length; i++) sum += p[i] = Math.exp(s[i] - m);
  for (let i = 0; i < s.length; i++) p[i] /= sum;
  return p;
}

export const probs = (W, K, x) => softmax(scores(W, K, x));

// Trains (or, with `prior`, adjusts) the weights. Full-batch Adam on cross-entropy.
//  X: Float32Array[] of length D, y: class indexes, sampleWeight: per example (optional).
//  prior: weights to start from and stay near (strength `pull`), so a few examples nudge rather than
//  overwrite what the model already knows.
//  only: class indexes whose weights may change (the others stay exactly as in `prior`).
export function train({ X, y, K, sampleWeight = null, epochs = 200, lr = 0.05, l2 = 1e-4, prior = null, pull = 0, only = null }) {
  const D = X[0].length, R = D + 1, n = X.length;
  const W = prior ? Float32Array.from(prior) : new Float32Array(K * R);
  const m = new Float32Array(W.length), v = new Float32Array(W.length), g = new Float32Array(W.length);
  const sw = sampleWeight || new Float32Array(n).fill(1);
  const total = sw.reduce((a, b) => a + b, 0);
  const b1 = 0.9, b2 = 0.999, eps = 1e-8;
  for (let ep = 1; ep <= epochs; ep++) {
    g.fill(0);
    for (let i = 0; i < n; i++) {
      const x = X[i], p = probs(W, K, x), w = sw[i] / total;
      for (let k = 0; k < K; k++) {
        const e = (p[k] - (k === y[i] ? 1 : 0)) * w;
        if (!e) continue;
        const o = k * R;
        for (let d = 0; d < D; d++) g[o + d] += e * x[d];
        g[o + D] += e;
      }
    }
    for (let j = 0; j < W.length; j++) {
      if (only && !only.has(Math.floor(j / R))) continue;
      const isBias = j % R === D;
      let gj = g[j];
      if (!isBias) gj += l2 * W[j];
      if (prior) gj += pull * (W[j] - prior[j]);
      m[j] = b1 * m[j] + (1 - b1) * gj;
      v[j] = b2 * v[j] + (1 - b2) * gj * gj;
      W[j] -= (lr * (m[j] / (1 - b1 ** ep))) / (Math.sqrt(v[j] / (1 - b2 ** ep)) + eps);
    }
  }
  return W;
}

// Weights <-> a compact string (16-bit floats would lose too much on small weights; 32-bit base64).
export function packWeights(W) {
  const bytes = new Uint8Array(W.buffer, W.byteOffset, W.byteLength);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unpackWeights(b64) {
  const s = atob(b64), bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

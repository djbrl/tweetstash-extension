// Small helpers used everywhere: DOM lookup, escaping, formatting, the API wrapper, toasts.

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const fmtNum = (n) =>
  n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K" : String(n || 0);

export function fmtDate(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}

// "1m 05s" / "42s"
export const fmtDuration = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s` : `${Math.round(s)}s`);

export function money(d) {
  if (d >= 100) return "$" + Math.round(d);
  if (d >= 0.995) return "$" + d.toFixed(2);
  return d >= 0.01 ? Math.round(d * 100) + "¢" : (d * 100).toFixed(1) + "¢";
}

export const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

// Drops empty values: { q: "", tag: "art" } -> { tag: "art" }
export const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v));

let toastTimer = 0;
export function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

// Calls the engine through the extension's background worker (no server, no HTTP). GET when there's no
// body, POST otherwise. Aborting the signal stops the engine's work too (and its AI calls).
let nextRef = 1;
export async function api(path, body, signal) {
  const ref = `${Date.now()}-${nextRef++}`;
  const onAbort = () => chrome.runtime.sendMessage({ type: "abort", ref }).catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const call = chrome.runtime.sendMessage({ type: "api", method: body ? "POST" : "GET", path, body, ref });
    const r = await (signal
      ? Promise.race([call, new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }))])
      : call);
    if (!r?.ok) throw new Error(r?.error || "TweetStash's engine didn't answer.");
    return r.result;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

// Saves a value as a downloaded JSON file.
export function downloadJson(data, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// localStorage that never throws (private windows, blocked storage).
export const store = {
  get: (k, fallback = null) => { try { return localStorage.getItem(k) ?? fallback; } catch { return fallback; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

// Captures coming in from the browser extension, with live progress per account for the dashboard.
import { ingest, emptyStash } from "../db/bookmarks.js";
import { db } from "../db/index.js";

// Whether a full history sync has finished for an account (so later syncs can just fetch what's new).
const historyKey = (account) => `history-done:${account}`;
export const historyDone = (account) => !!db.prepare(`SELECT 1 FROM kv WHERE key = ?`).get(historyKey(account));
export function markHistoryDone(account) {
  db.prepare(`INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`).run(historyKey(account), String(Date.now()));
  return { ok: true };
}

export const syncs = Object.create(null); // account -> { pages, seen, added, last }

export function validateAccount(account) {
  if (typeof account !== "string" || !/^(?:@[A-Za-z0-9_]{1,30}|unknown)$/.test(account)) {
    throw Object.assign(new Error("invalid account"), { status: 400 });
  }
  return account;
}

export function receive(account = "unknown", payload) {
  validateAccount(account);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw Object.assign(new Error("invalid capture payload"), { status: 400 });
  // Bound the work before the recursive GraphQL parser sees attacker-controlled JSON.
  const pending = [[payload, 0]];
  let nodes = 0;
  while (pending.length) {
    const [value, depth] = pending.pop();
    if (++nodes > 200000 || depth > 64) throw Object.assign(new Error("capture payload is too complex"), { status: 400 });
    if (value && typeof value === "object") for (const child of Object.values(value)) pending.push([child, depth + 1]);
  }
  if (Array.isArray(payload.domTweets) && payload.domTweets.length > 200) throw Object.assign(new Error("too many posts in one capture"), { status: 400 });
  const r = ingest(account, payload);
  const s = (syncs[account] ||= { pages: 0, seen: 0, added: 0 });
  s.pages++;
  s.seen += r.seen;
  s.added += r.added;
  s.last = Date.now();
  return r;
}

export function empty(account = "") {
  const r = emptyStash(account);
  if (account) db.prepare(`DELETE FROM kv WHERE key = ?`).run(historyKey(account));
  else db.exec(`DELETE FROM kv WHERE key LIKE 'history-done:%'`);
  if (account) delete syncs[account];
  else for (const k in syncs) delete syncs[k];
  return r;
}

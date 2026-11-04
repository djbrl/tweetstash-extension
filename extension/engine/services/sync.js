// Captures coming in from the browser extension, with live progress per account for the dashboard.
import { ingest, emptyStash } from "../db/bookmarks.js";

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
  if (account) delete syncs[account];
  else for (const k in syncs) delete syncs[k];
  return r;
}

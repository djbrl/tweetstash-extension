// The SQLite database: the official WebAssembly build, stored in the extension's private file system
// (OPFS) so it survives restarts. Runs inside the engine worker. A small wrapper gives it the same
// prepare().all/get/run API as node:sqlite, so the queries are shared with the TweetStash server app.
import sqlite3InitModule from "../../vendor/sqlite3.mjs";

// Only the "SAH pool" storage below is used. The library would also try its other OPFS modes at startup;
// those need special page headers an extension doesn't have, and they log errors in chrome://extensions
// when they fail, so they're switched off.
globalThis.sqlite3ApiConfig = { disable: { vfs: { opfs: true, "opfs-wl": true } } };
const sqlite3 = await sqlite3InitModule();
// "SAH pool" is the OPFS storage that works without special page headers. One connection at a time,
// which is why only the engine worker ever opens the database.
const pool = await sqlite3.installOpfsSAHPoolVfs({ name: "tweetstash", initialCapacity: 8 });
const raw = new pool.OpfsSAHPoolDb("/tweetstash.db");
export { pool };

// Row values as plain JSON: 64-bit integers come back as numbers (like node:sqlite does).
const plain = (row) => {
  for (const k in row) if (typeof row[k] === "bigint") row[k] = Number(row[k]);
  return row;
};

// node:sqlite accepts { name: value } for :name; sqlite-wasm wants { ":name": value }, and only names the
// statement actually uses.
function bindArgs(stmt, args) {
  if (!args.length || !stmt.parameterCount) return;
  const one = args[0];
  if (args.length === 1 && one && typeof one === "object" && !Array.isArray(one)) {
    const named = {};
    for (const [k, v] of Object.entries(one)) {
      const name = /^[:@$]/.test(k) ? k : ":" + k;
      if (stmt.getParamIndex(name)) named[name] = v === undefined ? null : v;
    }
    stmt.bind(named);
  } else {
    stmt.bind(args.map((v) => (v === undefined ? null : v)));
  }
}

class Statement {
  constructor(sql) { this.stmt = raw.prepare(sql); }
  #run(args, fn) {
    const s = this.stmt;
    try { s.clearBindings(); bindArgs(s, args); return fn(s); }
    finally { s.reset(); }
  }
  all(...args) { return this.#run(args, (s) => { const out = []; while (s.step()) out.push(plain(s.get({}))); return out; }); }
  get(...args) { return this.#run(args, (s) => (s.step() ? plain(s.get({})) : undefined)); }
  run(...args) {
    return this.#run(args, (s) => { s.step(); return { changes: raw.changes(), lastInsertRowid: Number(sqlite3.capi.sqlite3_last_insert_rowid(raw)) }; });
  }
}

// Statements are cached by their SQL, so code can call db.prepare(sql) inline without leaking them.
const cache = new Map();
const MAX_CACHED = 300;
export const db = {
  prepare(sql) {
    let st = cache.get(sql);
    if (st) { cache.delete(sql); cache.set(sql, st); return st; } // most recently used last
    st = new Statement(sql);
    cache.set(sql, st);
    if (cache.size > MAX_CACHED) {
      const [oldSql, old] = cache.entries().next().value;
      cache.delete(oldSql);
      old.stmt.finalize();
    }
    return st;
  },
  exec(sql) { raw.exec(sql); },
};

db.exec(`
  PRAGMA journal_mode = DELETE;

  -- One row per post, whichever account saved it.
  CREATE TABLE IF NOT EXISTS tweets (
    id TEXT PRIMARY KEY,
    author_name TEXT, author_handle TEXT, author_avatar TEXT,
    text TEXT, created_at INTEGER,
    likes INTEGER DEFAULT 0, retweets INTEGER DEFAULT 0, replies INTEGER DEFAULT 0,
    views INTEGER DEFAULT 0, bookmarks INTEGER DEFAULT 0,
    media TEXT, urls TEXT, quoted TEXT, lang TEXT,
    category TEXT, tagged_at INTEGER,
    captured_at INTEGER, raw TEXT
  );
  -- Which account saved which post, and where it sits in that account's bookmark list.
  CREATE TABLE IF NOT EXISTS saves (
    tweet_id TEXT, account TEXT, sort_index INTEGER, saved_seq INTEGER,
    PRIMARY KEY (tweet_id, account)
  );
  -- source is 'ai' or 'user'; re-tagging only replaces the AI ones.
  CREATE TABLE IF NOT EXISTS tags (
    tweet_id TEXT, tag TEXT, source TEXT,
    PRIMARY KEY (tweet_id, tag)
  );
  CREATE INDEX IF NOT EXISTS tags_tag ON tags(tag);
  CREATE INDEX IF NOT EXISTS saves_account ON saves(account);

  -- Full-text search over the post, and over what tagging saw in its picture. Both keyed by tweets.rowid.
  CREATE VIRTUAL TABLE IF NOT EXISTS tweets_fts USING fts5(text, author_name, author_handle);
  CREATE VIRTUAL TABLE IF NOT EXISTS desc_fts USING fts5(description, subjects);

  -- App settings and the API key (this file is private to the extension).
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
`);

// Columns added after the first release. ALTER fails harmlessly when the column already exists.
const LATER_COLUMNS = [
  "tag_error TEXT", // why the last tagging attempt failed; cleared once tagged
  "description TEXT", // one line on what's in the picture, with any text in it
  "medium TEXT", // photo, drawing, video...
  "subjects TEXT", // named games, characters, people, brands
  "nsfw_level TEXT", // none / suggestive / explicit
  "ai_refused INTEGER", // the AI declined to tag it
];
for (const col of LATER_COLUMNS) {
  try { db.exec(`ALTER TABLE tweets ADD COLUMN ${col}`); } catch {}
}

// Runs fn inside a transaction, rolling back if it throws.
export function transaction(fn) {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// The server app copies the database to disk before destructive actions. An extension can't write files
// on its own, so here the safety net is the export/import in Settings; this stays as a hook for callers.
export function backup() {
  return null;
}

// FTS5 query from free text: every word as a prefix match ("drag" finds "dragon").
export function ftsQuery(q) {
  const words = String(q).match(/[\p{L}\p{N}_]+/gu) || [];
  return words.map((w) => `"${w}"*`).join(" ");
}

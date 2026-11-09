// Storing captured bookmarks and reading them back for the dashboard.
import { isSensitive } from "../services/features.js";
import { db, transaction, backup, ftsQuery } from "./index.js";
import { parseTweet, extractEntries, extras, sanitizePost } from "./parse.js";
import { normTag } from "./tags.js";
import { NSFW_CATEGORY } from "../catalog.js";

// ---------- writes ----------

const upsertTweet = db.prepare(`
  INSERT INTO tweets (id, author_name, author_handle, author_avatar, text, created_at, likes, retweets, replies, views, bookmarks, media, urls, quoted, lang, captured_at, raw)
  VALUES (:id, :author_name, :author_handle, :author_avatar, :text, :created_at, :likes, :retweets, :replies, :views, :bookmarks, :media, :urls, :quoted, :lang, :captured_at, :raw)
  ON CONFLICT(id) DO UPDATE SET
    author_name=excluded.author_name, author_handle=excluded.author_handle, author_avatar=excluded.author_avatar,
    text=excluded.text, likes=excluded.likes, retweets=excluded.retweets, replies=excluded.replies,
    views=excluded.views, bookmarks=excluded.bookmarks, media=excluded.media, urls=excluded.urls,
    quoted=excluded.quoted, raw=excluded.raw
`);
const existsSave = db.prepare(`SELECT 1 FROM saves WHERE tweet_id = ? AND account = ?`);
const upsertSave = db.prepare(`
  INSERT INTO saves (tweet_id, account, sort_index, saved_seq) VALUES (?, ?, ?, ?)
  ON CONFLICT(tweet_id, account) DO UPDATE SET sort_index = COALESCE(excluded.sort_index, saves.sort_index)
`);
const rowidOf = db.prepare(`SELECT rowid FROM tweets WHERE id = ?`);
const ftsDel = db.prepare(`DELETE FROM tweets_fts WHERE rowid = ?`);
const ftsIns = db.prepare(`INSERT INTO tweets_fts (rowid, text, author_name, author_handle) VALUES (?, ?, ?, ?)`);
const seqStmt = db.prepare(`SELECT COALESCE(MIN(saved_seq), 0) AS s FROM saves`);
const tweetExists = db.prepare(`SELECT 1 FROM tweets WHERE id = ?`);

// payload is either a raw GraphQL response from X, or { domTweets: [...] } already parsed off the page.
export function ingest(account, payload) {
  const items = Array.isArray(payload?.domTweets)
    ? payload.domTweets.map((tw) => ({ tw, sortIndex: null, raw: null }))
    : extractEntries(payload).map((e) => ({ tw: parseTweet(e.result), sortIndex: e.sortIndex, raw: e.result }));
  for (const it of items) it.tw = sanitizePost(it.tw);
  let added = 0, seen = 0;
  // saved_seq: fallback ordering when sortIndex is missing (later captures are further down the list).
  let seq = seqStmt.get().s;
  transaction(() => {
    for (const { tw, sortIndex: si, raw } of items) {
      if (!tw?.id) continue;
      seen++;
      const isNew = !existsSave.get(tw.id, account);
      // Page-scraped data is thinner than GraphQL data, so never let it overwrite a stored tweet.
      if (raw || !tweetExists.get(tw.id)) {
        upsertTweet.run({
          ...tw,
          media: JSON.stringify(tw.media || []), urls: JSON.stringify(tw.urls || []),
          quoted: tw.quoted ? JSON.stringify(tw.quoted) : null,
          captured_at: Date.now(), raw: raw ? JSON.stringify(raw) : null,
        });
        const { rowid } = rowidOf.get(tw.id);
        ftsDel.run(rowid);
        ftsIns.run(rowid, tw.text + (tw.quoted ? "\n" + tw.quoted.text : ""), tw.author_name, tw.author_handle);
      }
      let sortIndex = null;
      try { sortIndex = /^\d{1,25}$/.test(String(si)) ? BigInt(si) : null; } catch {}
      upsertSave.run(tw.id, account, sortIndex, --seq);
      if (isNew) added++;
    }
  });
  return { seen, added };
}

// Empties one account's bookmarks, or everything when no account is given.
export function emptyStash(account = "") {
  const file = backup("nest");
  return transaction(() => {
    const removed = (account ? db.prepare(`DELETE FROM saves WHERE account = ?`).run(account) : db.prepare(`DELETE FROM saves`).run()).changes;
    // Posts still saved by another account stay; anything orphaned goes, with its tags and search rows.
    const orphan = `SELECT id FROM tweets WHERE id NOT IN (SELECT tweet_id FROM saves)`;
    db.exec(`DELETE FROM tweets_fts WHERE rowid IN (SELECT rowid FROM tweets WHERE id IN (${orphan}))`);
    db.exec(`DELETE FROM desc_fts WHERE rowid IN (SELECT rowid FROM tweets WHERE id IN (${orphan}))`);
    db.exec(`DELETE FROM tags WHERE tweet_id IN (${orphan})`);
    db.exec(`DELETE FROM tweets WHERE id IN (${orphan})`);
    return { ok: true, removed, backup: file };
  });
}

// ---------- reads ----------

// Sorted by the local tagger, which wasn't sure ("Check these").
const UNSURE_SQL = "t.tag_unsure = 1 AND t.category_by = 'local'";
db.exec(`CREATE TABLE IF NOT EXISTS local_vectors (tweet_id TEXT PRIMARY KEY, img BLOB, txt BLOB, model TEXT)`);
try { db.exec(`ALTER TABLE local_vectors ADD COLUMN v2 INTEGER`); } catch {}

// sortIndex from X when we have it, capture order otherwise. (Too big for JS numbers, so it stays in SQL.)
const SAVED_KEY = "CASE WHEN s.si > 0 THEN s.si ELSE s.sq END";
const SORTS = {
  saved_desc: `${SAVED_KEY} DESC`,
  saved_asc: `${SAVED_KEY} ASC`,
  created_desc: "t.created_at DESC",
  created_asc: "t.created_at ASC",
  likes_desc: "t.likes DESC",
  views_desc: "t.views DESC",
  author_asc: "t.author_handle COLLATE NOCASE ASC, t.created_at DESC",
};

// The dashboard's list: filters from the sidebar and search box, one page at a time.
export function query({ q = "", account = "", tag = "", category = "", author = "", media = "", untagged = "", failed = "", unsure = "", hideNsfw = false, sort = "saved_desc", offset = 0, limit = 60, ids = null }) {
  const where = [];
  const params = {};
  if (ids) { where.push("t.id IN (SELECT value FROM json_each(:ids))"); params.ids = JSON.stringify(ids); }
  if (account) { where.push("EXISTS (SELECT 1 FROM saves s2 WHERE s2.tweet_id = t.id AND s2.account = :account)"); params.account = account; }
  if (tag) { where.push("EXISTS (SELECT 1 FROM tags g WHERE g.tweet_id = t.id AND g.tag = :tag)"); params.tag = tag; }
  if (category) { where.push("t.category = :category"); params.category = category; }
  if (author) { where.push("t.author_handle = :author COLLATE NOCASE"); params.author = author; }
  if (media === "1") where.push("t.media != '[]'");
  if (media === "video") where.push("t.media LIKE '%\"video\"%'");
  if (media === "links") where.push("t.urls != '[]'");
  if (untagged === "1") where.push("t.tagged_at IS NULL");
  if (failed === "1") where.push("t.tag_error IS NOT NULL");
  if (unsure === "1") where.push(UNSURE_SQL);
  if (hideNsfw && !ids) { where.push("COALESCE(t.category, '') != :nsfw"); params.nsfw = NSFW_CATEGORY; }
  const fq = q && ftsQuery(q);
  if (fq) {
    // Post text, what tagging saw in the picture, or an exact tag.
    where.push(`(t.rowid IN (SELECT rowid FROM tweets_fts WHERE tweets_fts MATCH :fq)
      OR t.rowid IN (SELECT rowid FROM desc_fts WHERE desc_fts MATCH :fq)
      OR EXISTS (SELECT 1 FROM tags g2 WHERE g2.tweet_id = t.id AND g2.tag = :qtag))`);
    params.fq = fq;
    params.qtag = normTag(q);
  }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const base = `
    FROM tweets t
    JOIN (SELECT tweet_id, MAX(COALESCE(sort_index, 0)) AS si, MAX(saved_seq) AS sq, GROUP_CONCAT(account) AS accounts
          FROM saves GROUP BY tweet_id) s ON s.tweet_id = t.id
    ${whereSql}`;
  const total = db.prepare(`SELECT COUNT(*) AS n ${base}`).get(params).n;
  const rows = db.prepare(`
    SELECT t.id, t.author_name, t.author_handle, t.author_avatar, t.text, t.created_at, t.likes, t.retweets,
           t.replies, t.views, t.bookmarks, t.media, t.urls, t.quoted, t.category, t.category_by, t.tag_unsure, t.tag_error, s.accounts,
           (SELECT GROUP_CONCAT(tag) FROM tags g WHERE g.tweet_id = t.id) AS tags
    ${base}
    ORDER BY ${unsure === "1" ? "t.tag_confidence ASC, " : ""}${SORTS[sort] || SORTS.saved_desc}, t.id DESC
    LIMIT :limit OFFSET :offset`).all({ ...params, limit: Math.max(1, Math.min(Math.trunc(Number(limit)) || 60, 200)), offset: Math.max(0, Math.trunc(Number(offset)) || 0) });
  return {
    total,
    items: rows.map((r) => ({
      ...r,
      media: JSON.parse(r.media || "[]"),
      urls: JSON.parse(r.urls || "[]"),
      quoted: r.quoted ? JSON.parse(r.quoted) : null,
      accounts: r.accounts ? r.accounts.split(",") : [],
      tags: r.tags ? r.tags.split(",").sort() : [],
    })),
  };
}

// Everything, for the JSON export (query() caps a page at 200).
export function exportAll() {
  const ids = db.prepare(`SELECT id FROM tweets`).all().map((r) => r.id);
  const out = [];
  for (let i = 0; i < ids.length; i += 200) out.push(...query({ ids: ids.slice(i, i + 200), limit: 200 }).items);
  return out;
}

// Counts for the sidebar.
export function stats() {
  return {
    total: db.prepare(`SELECT COUNT(*) AS n FROM tweets`).get().n,
    untagged: db.prepare(`SELECT COUNT(*) AS n FROM tweets WHERE tagged_at IS NULL`).get().n,
    failed: db.prepare(`SELECT COUNT(*) AS n FROM tweets WHERE tag_error IS NOT NULL`).get().n,
    unsure: db.prepare(`SELECT COUNT(*) AS n FROM tweets t WHERE ${UNSURE_SQL}`).get().n,
    outdated: outdatedIds().length,
    accounts: db.prepare(`SELECT account AS name, COUNT(*) AS n FROM saves GROUP BY account ORDER BY n DESC`).all(),
    categories: db.prepare(`SELECT category AS name, COUNT(*) AS n FROM tweets WHERE category IS NOT NULL GROUP BY category ORDER BY n DESC`).all(),
    tags: db.prepare(`SELECT tag AS name, COUNT(*) AS n FROM tags GROUP BY tag ORDER BY n DESC, tag LIMIT 300`).all(),
    authors: db.prepare(`SELECT author_handle AS name, MAX(author_name) AS display, MAX(author_avatar) AS avatar, COUNT(*) AS n FROM tweets GROUP BY author_handle COLLATE NOCASE ORDER BY n DESC LIMIT 40`).all(),
  };
}

export const countTweets = () => db.prepare(`SELECT COUNT(*) AS n FROM tweets`).get().n;

// Where this account's bookmarks sit in X's list: the sortIndex at every `size`-th position, newest
// first, plus the oldest. Turbo sync cuts one slice per entry. A page holds 96, so 84 leaves room for
// bookmarks X no longer returns (deleted posts) without a slice needing a second request.
export function pageMap(account, size = 84) {
  const sorts = db.prepare(`SELECT CAST(sort_index AS TEXT) AS s FROM saves WHERE account = ? AND sort_index > 0 ORDER BY sort_index DESC`)
    .all(account).map((r) => r.s);
  const cuts = [];
  for (let i = size - 1; i < sorts.length; i += size) cuts.push(sorts[i]);
  return { count: sorts.length, size, cuts, min: sorts.at(-1) || null };
}

// ---------- for AI tagging ----------

// Posts the local tagger sorted before 0.1.2: sorted by matching descriptions, before it had the text model
// and the trained classifier. Re-tagging them is free and keeps their pictures' vectors.
export const outdatedIds = () => db.prepare(`SELECT id FROM tweets t WHERE t.tagged_at IS NOT NULL AND t.description IS NULL
  AND t.category_by IS NULL AND COALESCE(t.ai_refused, 0) = 0
  AND EXISTS (SELECT 1 FROM local_vectors v WHERE v.tweet_id = t.id AND v.v2 IS NULL) ORDER BY captured_at DESC`).all().map((r) => r.id);

// Newest first. all: every post; failed: the ones the last run couldn't tag; default: never tagged.
export function idsToTag(all = false, failed = false) {
  const where = all ? "" : failed ? "WHERE tag_error IS NOT NULL" : "WHERE tagged_at IS NULL";
  return db.prepare(`SELECT id FROM tweets ${where} ORDER BY captured_at DESC`).all().map((r) => r.id);
}

// Posts with the extra context tagging uses (bio, alt text, link titles).
export function tweetsByIds(ids) {
  return db.prepare(`SELECT id, author_handle, author_name, text, urls, quoted, media, raw FROM tweets WHERE id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(ids)).map(({ raw, ...t }) => ({ ...t, ...extras(raw), sensitive: isSensitive(raw) }));
}

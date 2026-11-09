// Backups. An extension's data disappears if the extension is uninstalled, so Settings offers a full
// backup file and a way to load one back. The format keeps everything: posts, which account saved each
// one (and where), tags with their source, and what AI tagging found.
//
// Import also accepts the plain export from the TweetStash server app (its Settings → Export), which has
// posts, tags and accounts but not picture descriptions or bookmark order.
import { db, transaction } from "./index.js";
import { sanitizePost } from "./parse.js";
import { normTag } from "./tags.js";
import { CATEGORIES } from "../catalog.js";

const FORMAT = "tweetstash-backup";
const TWEET_COLUMNS = ["id", "author_name", "author_handle", "author_avatar", "text", "created_at", "likes", "retweets", "replies",
  "views", "bookmarks", "media", "urls", "quoted", "lang", "category", "tagged_at", "captured_at", "raw", "tag_error",
  "description", "medium", "subjects", "nsfw_level", "ai_refused", "category_by", "tag_confidence", "tag_unsure"];

export function backupAll() {
  return {
    format: FORMAT, version: 1, exportedAt: new Date().toISOString(),
    tweets: db.prepare(`SELECT ${TWEET_COLUMNS.join(", ")} FROM tweets`).all(),
    saves: db.prepare(`SELECT tweet_id, account, CAST(sort_index AS TEXT) AS sort_index, saved_seq FROM saves`).all(),
    tags: db.prepare(`SELECT tweet_id, tag, source FROM tags`).all(),
  };
}

// The same checks the capture path uses, so a hand-edited or hostile file can't smuggle in script URLs,
// tracking images or odd accounts.
const ACCOUNT = /^(?:@[A-Za-z0-9_]{1,30}|unknown)$/;
const LEVELS = ["none", "suggestive", "explicit"];
const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : null);
const int = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Math.trunc(Number(v)));

function cleanTweet(t) {
  const parse = (v, fallback) => { try { return typeof v === "string" ? JSON.parse(v) : v ?? fallback; } catch { return fallback; } };
  const post = sanitizePost({ ...t, media: parse(t.media, []), urls: parse(t.urls, []), quoted: parse(t.quoted, null) });
  if (!post?.id) return null;
  return {
    ...post,
    media: JSON.stringify(post.media || []), urls: JSON.stringify(post.urls || []), quoted: post.quoted ? JSON.stringify(post.quoted) : null,
    lang: str(t.lang, 10),
    category: CATEGORIES.includes(t.category) ? t.category : null,
    tagged_at: int(t.tagged_at), captured_at: int(t.captured_at) || Date.now(),
    raw: typeof t.raw === "string" && t.raw.length < 200000 ? t.raw : null,
    tag_error: str(t.tag_error, 300), description: str(t.description, 300), medium: str(t.medium, 40),
    subjects: str(t.subjects, 300), nsfw_level: LEVELS.includes(t.nsfw_level) ? t.nsfw_level : null, ai_refused: t.ai_refused ? 1 : 0,
    // Who set the category: your own picks are what the local tagger learns from.
    category_by: ["user", "local", "claude"].includes(t.category_by) ? t.category_by : null,
    tag_confidence: Number.isFinite(Number(t.tag_confidence)) && t.tag_confidence !== null ? Math.min(1, Math.max(0, Number(t.tag_confidence))) : null,
    tag_unsure: t.tag_unsure ? 1 : 0,
  };
}

// The server app's export: one object per post with tags and accounts inline.
function fromServerExport(items) {
  const tweets = [], saves = [], tags = [];
  for (const it of items) {
    tweets.push({ ...it, tagged_at: it.category ? Date.now() : null });
    for (const account of it.accounts || []) saves.push({ tweet_id: it.id, account, sort_index: null, saved_seq: 0 });
    for (const tag of it.tags || []) tags.push({ tweet_id: it.id, tag, source: "ai" });
  }
  return { tweets, saves, tags, partial: true };
}

const insertTweet = () => db.prepare(`
  INSERT INTO tweets (${TWEET_COLUMNS.join(", ")}) VALUES (${TWEET_COLUMNS.map((c) => ":" + c).join(", ")})
  ON CONFLICT(id) DO UPDATE SET ${TWEET_COLUMNS.filter((c) => c !== "id").map((c) => `${c} = COALESCE(excluded.${c}, tweets.${c})`).join(", ")}`);

// Merges a backup into what's already here: nothing is deleted, newer details win.
export function importBackup(data) {
  let src;
  if (data?.format === FORMAT && Array.isArray(data.tweets)) src = data;
  else if (Array.isArray(data) && data.every((x) => x && typeof x === "object" && "id" in x)) src = fromServerExport(data);
  else throw Object.assign(new Error("That file isn't a TweetStash backup."), { status: 400 });

  const known = new Set();
  let added = 0;
  transaction(() => {
    const exists = db.prepare(`SELECT rowid FROM tweets WHERE id = ?`);
    for (const t of src.tweets) {
      const row = cleanTweet(t || {});
      if (!row) continue;
      if (!exists.get(row.id)) added++;
      insertTweet().run(row);
      known.add(row.id);
      const { rowid } = exists.get(row.id);
      db.prepare(`DELETE FROM tweets_fts WHERE rowid = ?`).run(rowid);
      db.prepare(`INSERT INTO tweets_fts (rowid, text, author_name, author_handle) VALUES (?, ?, ?, ?)`)
        .run(rowid, row.text + (row.quoted ? "\n" + JSON.parse(row.quoted).text : ""), row.author_name, row.author_handle);
      db.prepare(`DELETE FROM desc_fts WHERE rowid = ?`).run(rowid);
      if (row.description || row.subjects) db.prepare(`INSERT INTO desc_fts (rowid, description, subjects) VALUES (?, ?, ?)`).run(rowid, row.description || "", row.subjects || "");
    }
    for (const s of src.saves || []) {
      if (!known.has(String(s?.tweet_id)) || !ACCOUNT.test(s.account)) continue;
      let sortIndex = null;
      try { sortIndex = /^\d{1,25}$/.test(String(s.sort_index)) ? BigInt(s.sort_index) : null; } catch {}
      db.prepare(`INSERT INTO saves (tweet_id, account, sort_index, saved_seq) VALUES (?, ?, ?, ?)
        ON CONFLICT(tweet_id, account) DO UPDATE SET sort_index = COALESCE(excluded.sort_index, saves.sort_index)`)
        .run(String(s.tweet_id), s.account, sortIndex, int(s.saved_seq) || 0);
    }
    for (const g of src.tags || []) {
      const tag = normTag(String(g?.tag || ""));
      if (!known.has(String(g?.tweet_id)) || !tag) continue;
      db.prepare(`INSERT OR IGNORE INTO tags (tweet_id, tag, source) VALUES (?, ?, ?)`).run(String(g.tweet_id), tag, g.source === "user" ? "user" : "ai");
    }
    // A post nobody saved wouldn't show anywhere; file it under "unknown".
    db.exec(`INSERT OR IGNORE INTO saves (tweet_id, account, sort_index, saved_seq) SELECT id, 'unknown', NULL, 0 FROM tweets WHERE id NOT IN (SELECT tweet_id FROM saves)`);
  });
  return { imported: known.size, added, partial: !!src.partial };
}

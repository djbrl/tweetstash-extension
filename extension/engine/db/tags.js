// Tags, categories and what AI tagging wrote about each post.
import { db, transaction } from "./index.js";

// Tags are lowercase letters, numbers and single hyphens:
// "Street Fighter III: 3rd Strike" -> "street-fighter-iii-3rd-strike", "Pallas's cat" -> "pallas-cat".
export function normTag(t) {
  return String(t).trim().toLowerCase().replace(/^#/, "").replace(/['’]s\b/g, "")
    .replace(/[\s_/]+/g, "-").replace(/[^\p{L}\p{N}-]+/gu, "").replace(/-{2,}/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

const addTag = db.prepare(`INSERT OR IGNORE INTO tags (tweet_id, tag, source) VALUES (?, ?, ?)`);
const moveTag = db.prepare(`INSERT OR IGNORE INTO tags (tweet_id, tag, source) SELECT tweet_id, ?, source FROM tags WHERE tag = ?`);
const dropTag = db.prepare(`DELETE FROM tags WHERE tag = ?`);

// Renames tags in bulk ([{ from, to }]); posts that had both keep one.
export function mergeTags(merges) {
  transaction(() => {
    for (const { from, to } of merges) {
      if (to) moveTag.run(to, from);
      dropTag.run(from);
    }
  });
}

// Renames stored tags that don't match normTag (older ones kept punctuation). Runs at startup.
export function renormalizeTags() {
  const odd = db.prepare(`SELECT DISTINCT tag FROM tags`).all().map((r) => r.tag).filter((t) => normTag(t) !== t);
  mergeTags(odd.map((t) => ({ from: t, to: normTag(t) })));
  return odd.length;
}

export function setUserTags(id, tags) {
  transaction(() => {
    db.prepare(`DELETE FROM tags WHERE tweet_id = ?`).run(id);
    for (const t of tags) if (normTag(t)) addTag.run(id, normTag(t), "user");
  });
}

export const tagCounts = () => db.prepare(`SELECT tag, COUNT(*) AS n FROM tags GROUP BY tag ORDER BY n DESC`).all();
export const distinctTagCount = () => db.prepare(`SELECT COUNT(DISTINCT tag) AS n FROM tags`).get().n;

export function topTags(n = 150) {
  return db.prepare(`SELECT tag FROM tags GROUP BY tag ORDER BY COUNT(*) DESC LIMIT ?`).all(n).map((r) => r.tag);
}

export function topAuthors(n = 80) {
  return db.prepare(`SELECT author_handle AS h FROM tweets GROUP BY author_handle COLLATE NOCASE ORDER BY COUNT(*) DESC LIMIT ?`).all(n).map((r) => r.h);
}

// ---------- AI tagging results ----------

const delAiTags = db.prepare(`DELETE FROM tags WHERE tweet_id = ? AND source = 'ai'`);
const setCategory = db.prepare(`UPDATE tweets SET category = ?, tagged_at = ?, tag_error = NULL WHERE id = ?`);
const setDetails = db.prepare(`UPDATE tweets SET description = ?, medium = ?, subjects = ?, nsfw_level = ?, ai_refused = ? WHERE id = ?`);
const descDel = db.prepare(`DELETE FROM desc_fts WHERE rowid = (SELECT rowid FROM tweets WHERE id = ?)`);
const descIns = db.prepare(`INSERT INTO desc_fts (rowid, description, subjects) SELECT rowid, ?, ? FROM tweets WHERE id = ?`);
const setTagError = db.prepare(`UPDATE tweets SET tag_error = ? WHERE id = ?`);
// Until the local model fills them in, declined posts count as tagged so they aren't retried every run.
const setRefused = db.prepare(`UPDATE tweets SET ai_refused = 1, tag_error = NULL, tagged_at = COALESCE(tagged_at, ?) WHERE id = ?`);

// results: [{ id, category, tags, subjects?, medium?, nsfw?, description?, refused? }]
export function applyAiTags(results) {
  transaction(() => {
    for (const r of results) {
      delAiTags.run(r.id);
      // Subjects double as tags, so "elden-ring" or "jinx" shows up in the tag list and tag filters.
      for (const tag of new Set([...r.tags, ...(r.subjects || [])].map(normTag).filter(Boolean))) addTag.run(r.id, tag, "ai");
      setCategory.run(r.category, Date.now(), r.id);
      if (r.description !== undefined) {
        const subjects = (r.subjects || []).join(", ");
        setDetails.run(r.description || null, r.medium || null, subjects || null, r.nsfw || null, r.refused ? 1 : 0, r.id);
        descDel.run(r.id);
        descIns.run(r.description || "", subjects, r.id);
      }
    }
  });
}

export function markRefused(ids) {
  transaction(() => { for (const id of ids) setRefused.run(Date.now(), id); });
}

export function markTagFailed(ids, reason) {
  transaction(() => { for (const id of ids) setTagError.run(String(reason).slice(0, 300), id); });
}

// Description search, step 2: turn the AI's search plan into a shortlist, entirely locally.
// Every signal adds to a post's score (keyword hit, matching tag, category, author, date range, media
// type); nothing is a hard filter, so one wrong guess in the plan can't hide the right post.
import { db, ftsQuery } from "./index.js";
import { normTag } from "./tags.js";

// Rare words say more than common ones: "dance" (a dozen posts) should outweigh "girl" (hundreds).
const rarity = (n) => (n <= 25 ? 1.6 : n <= 80 ? 1.2 : n <= 250 ? 0.8 : 0.4);

export function candidates(plan, account = "", limit = 150) {
  const score = new Map();
  const add = (rows, pts) => rows.forEach(({ id }) => score.set(id, (score.get(id) || 0) + pts));
  const addWeighted = (rows, pts) => add(rows, pts * rarity(rows.length));
  const scope = account ? `AND EXISTS (SELECT 1 FROM saves s WHERE s.tweet_id = t.id AND s.account = :account)` : "";
  const run = (sql, params = {}) => db.prepare(sql).all(account ? { ...params, account } : params);

  for (const k of (plan.keywords || []).slice(0, 12)) {
    const fq = ftsQuery(k);
    if (!fq) continue;
    // The post's own text, and what tagging saw in its picture.
    addWeighted(run(`SELECT t.id FROM tweets t WHERE (t.rowid IN (SELECT rowid FROM tweets_fts WHERE tweets_fts MATCH :fq)
      OR t.rowid IN (SELECT rowid FROM desc_fts WHERE desc_fts MATCH :fq)) ${scope}`, { fq }), 3);
  }
  for (const tag of (plan.tags || []).slice(0, 10)) {
    addWeighted(run(`SELECT t.id FROM tweets t JOIN tags g ON g.tweet_id = t.id WHERE g.tag = :tag ${scope}`, { tag: normTag(tag) }), 2);
  }
  for (const c of (plan.categories || []).slice(0, 3)) add(run(`SELECT t.id FROM tweets t WHERE t.category = :c ${scope}`, { c }), 1);
  for (const sub of (plan.subjects || []).slice(0, 6)) {
    const fq = ftsQuery(sub);
    if (fq) addWeighted(run(`SELECT t.id FROM tweets t WHERE t.rowid IN (SELECT rowid FROM desc_fts WHERE desc_fts MATCH :fq) ${scope}`, { fq: `subjects : (${fq})` }), 3);
  }
  // Extra candidates from local meaning search (text + picture), when it has been built.
  for (const [i, id] of (plan.similar || []).entries()) score.set(id, (score.get(id) || 0) + Math.max(1, 4 - i * 0.05));
  for (const a of (plan.authors || []).slice(0, 5)) {
    add(run(`SELECT t.id FROM tweets t WHERE t.author_handle = :a COLLATE NOCASE ${scope}`, { a: a.replace(/^@/, "") }), 3);
  }

  // Only boost posts that already matched something, so these don't flood the list on their own.
  const boost = (sql, params) => {
    const hit = new Set(run(sql, params).map((r) => r.id));
    for (const id of score.keys()) if (hit.has(id)) score.set(id, score.get(id) + 1);
  };
  const ms = (s) => (s ? Date.parse(s.length === 7 ? s + "-01" : s) : NaN);
  const after = ms(plan.after), before = ms(plan.before);
  if (!isNaN(after) || !isNaN(before)) {
    boost(`SELECT t.id FROM tweets t WHERE t.created_at >= :a AND t.created_at <= :b ${scope}`, { a: isNaN(after) ? 0 : after, b: isNaN(before) ? 9e15 : before });
  }
  if (plan.media === "video") boost(`SELECT t.id FROM tweets t WHERE t.media LIKE '%"video"%' ${scope}`);
  if (plan.media === "media") boost(`SELECT t.id FROM tweets t WHERE t.media != '[]' ${scope}`);
  if (plan.media === "links") boost(`SELECT t.id FROM tweets t WHERE t.urls != '[]' ${scope}`);
  if (plan.medium) boost(`SELECT t.id FROM tweets t WHERE t.medium = :m ${scope}`, { m: plan.medium });

  let ids = [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  // The meaning index's best guesses go near the top, alternating with the keyword ones, so they're among
  // the candidates the AI sees pictures of. Keyword scores alone would push a picture-only match far down.
  const near = (plan.similar || []).slice(0, 20);
  if (near.length) {
    const nearSet = new Set(near);
    const rest = ids.filter((id) => !nearSet.has(id));
    const mixed = [];
    for (let i = 0; i < near.length; i++) {
      if (i < rest.length) mixed.push(rest[i]);
      mixed.push(near[i]);
    }
    const used = new Set(mixed);
    ids = [...mixed, ...ids.filter((id) => !used.has(id))];
  }
  ids = ids.slice(0, limit);
  if (!ids.length) return [];
  return db.prepare(`
    SELECT t.id, t.author_handle, t.author_name, t.text, t.created_at, t.category, t.media, t.quoted, t.description, t.medium,
           (SELECT GROUP_CONCAT(tag) FROM tags g WHERE g.tweet_id = t.id) AS tags
    FROM tweets t WHERE t.id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids))
    .sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
}

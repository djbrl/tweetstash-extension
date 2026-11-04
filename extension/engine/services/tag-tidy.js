// Tag cleanup: merges duplicate and near-duplicate tags ("drawing" / "drawings" / "illustration-art"),
// so the same thing has one name and searches and filters find all of it. Only the tag list with counts
// is sent to the AI (a few cents); posts themselves aren't.
import { backup } from "../db/index.js";
import { normTag, mergeTags, tagCounts, distinctTagCount } from "../db/tags.js";
import { TIDY_SCHEMA, TIDY_SYSTEM } from "../prompts/tidy.js";
import { getClient, jsonRequest, jsonAnswer } from "./anthropic.js";
import { settings } from "./settings.js";

async function proposeMerges(tags) {
  // Streamed: with thousands of tags the answer can be long.
  const res = await getClient().beta.messages.stream(jsonRequest({
    model: settings().tagModel,
    effort: "medium",
    system: TIDY_SYSTEM,
    content: tags.map((t) => `${t.tag} (${t.n})`).join("\n"),
    schema: TIDY_SCHEMA,
    maxTokens: 48000,
  })).finalMessage();
  return { merges: jsonAnswer(res).merges, usage: res.usage };
}

// Follows chains (a -> b, b -> c) so everything lands on the final name, and drops unknown tags.
function resolveMerges(proposed, known) {
  const target = new Map(proposed
    .map((m) => ({ from: normTag(m.from), to: normTag(m.to) }))
    .filter((m) => m.from !== m.to && known.has(m.from) && known.has(m.to))
    .map((m) => [m.from, m.to]));
  const resolve = (t, seen = new Set()) => (target.has(t) && !seen.has(t) ? resolve(target.get(t), seen.add(t)) : t);
  return [...target.keys()].map((from) => ({ from, to: resolve(from) })).filter((m) => m.from !== m.to);
}

// dryRun: ask the AI and return its merges without changing anything.
// merges: apply exactly this (previewed) list, without asking the AI again.
export async function tidyTags({ dryRun = false, merges: given = null } = {}) {
  const tags = tagCounts();
  const known = new Set(tags.map((t) => t.tag));
  const { merges: proposed, usage = null } = Array.isArray(given) ? { merges: given } : await proposeMerges(tags);
  const merges = resolveMerges(proposed, known);
  if (dryRun || !merges.length) return { merges, applied: false, usage };

  const file = backup("before-tidy");
  mergeTags(merges);
  return { merges, applied: true, backup: file, tagsBefore: tags.length, tagsAfter: distinctTagCount(), usage };
}

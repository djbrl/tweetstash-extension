// AI tagging: sends batches of posts (text + first image) to Claude and stores a category, tags,
// subjects, medium, NSFW level and a one-line picture description for each.
// One job runs at a time; the dashboard polls `job` for progress.
import { idsToTag, tweetsByIds } from "../db/bookmarks.js";
import { applyAiTags, topTags, markTagFailed, markRefused } from "../db/tags.js";
import { TAG_SCHEMA, TAG_SYSTEM, tagInput } from "../prompts/tagging.js";
import { Anthropic, getClient, jsonRequest, jsonAnswer, billedTokens, Refused } from "./anthropic.js";
import { fetchImage, smallImage, firstThumb } from "./images.js";
import { settings, recordUsage } from "./settings.js";

const BATCH = 25;
const CONCURRENCY = 4;

export const job = { running: false, total: 0, done: 0, failed: 0, error: null, startedAt: null, usage: { input: 0, output: 0 } };

async function callTagger(rows, withImages) {
  const vocab = topTags(150);
  // Text first, then each post as its JSON followed by its image (when it has one).
  const images = withImages ? await Promise.all(rows.map((t) => fetchImage(firstThumb(t)))) : [];
  const content = [{ type: "text", text: `Existing tag vocabulary: ${vocab.length ? vocab.join(", ") : "(none yet)"}\n\nBookmarks:` }];
  rows.forEach((t, i) => {
    content.push({ type: "text", text: JSON.stringify(tagInput(t)) });
    if (images[i]) content.push(images[i]);
  });
  const res = await getClient().beta.messages.create(jsonRequest({
    model: job.model,
    effort: job.effort,
    system: [{ type: "text", text: TAG_SYSTEM, cache_control: { type: "ephemeral" } }],
    content,
    schema: TAG_SCHEMA,
    maxTokens: 16000,
  }));
  const used = billedTokens(res.usage);
  job.usage.input += used.input;
  job.usage.output += used.output;
  const ids = new Set(rows.map((r) => r.id));
  return jsonAnswer(res).results
    .filter((r) => ids.has(r.id))
    .map((r) => ({ ...r, tags: r.tags.slice(0, 5), subjects: r.subjects.slice(0, 5), description: r.description.slice(0, 300) }));
}

// When the AI declines a batch (usually over one explicit image), split it and retry, down to single
// posts; the ones still declined are marked as refused instead of failing the whole batch.
async function tagWithSplitting(rows, withImages) {
  try {
    return { results: await callTagger(rows, withImages), refused: [] };
  } catch (err) {
    if (!(err instanceof Refused)) throw err;
    if (rows.length === 1) return { results: [], refused: rows.map((r) => r.id) };
    const mid = Math.ceil(rows.length / 2);
    const [a, b] = await Promise.all([tagWithSplitting(rows.slice(0, mid), withImages), tagWithSplitting(rows.slice(mid), withImages)]);
    return { results: [...a.results, ...b.results], refused: [...a.refused, ...b.refused] };
  }
}

// Tags one batch and stores the results. Returns how many posts were handled.
async function tagBatch(rows, { withImages = true } = {}) {
  const { results, refused } = await tagWithSplitting(rows, withImages);
  applyAiTags(results);
  if (refused.length) {
    markRefused(refused);
    job.refused += refused.length;
  }
  const skipped = rows.filter((r) => !results.some((x) => x.id === r.id) && !refused.includes(r.id)).map((r) => r.id);
  if (skipped.length) markTagFailed(skipped, "The AI skipped it in its answer");
  // The last post of the batch, for the dashboard's tagging window to show as it goes.
  const last = results.at(-1);
  const row = last && rows.find((r) => r.id === last.id);
  if (row) {
    job.last = {
      text: (row.text || "").replace(/https:\/\/t\.co\/\S+/g, "").trim().slice(0, 140),
      category: last.category,
      tags: [...last.subjects, ...last.tags].slice(0, 4),
      thumb: smallImage(firstThumb(row)),
    };
  }
  // Refused ones count as handled (the dashboard shows them as declined).
  return results.length + refused.length;
}

const isAuthError = (err) =>
  err?.noKey || err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError || /authentication method/i.test(err?.message || "");

// all: re-tag everything; failed: retry the ones that failed; ids: exactly these; limit: only the newest N.
export function startTagging({ all = false, failed = false, limit = 0, ids: only = null } = {}) {
  if (job.running) return job;
  let ids = Array.isArray(only) ? only.map(String) : idsToTag(all, failed);
  if (limit > 0) ids = ids.slice(0, limit);
  const { tagModel, tagEffort } = settings();
  Object.assign(job, {
    model: tagModel, effort: tagEffort, running: true, stopping: false, stoppedByUser: false, fatal: false,
    total: ids.length, done: 0, failed: 0, failedIds: [], refused: 0, error: null, last: null,
    startedAt: Date.now(), finishedAt: null, usage: { input: 0, output: 0 },
  });
  const chunks = [];
  for (let i = 0; i < ids.length; i += BATCH) chunks.push(ids.slice(i, i + BATCH));

  const worker = async () => {
    while (chunks.length && !job.stopping) {
      const chunk = chunks.shift();
      const rows = tweetsByIds(chunk);
      try {
        let n;
        try {
          n = await tagBatch(rows);
        } catch (err) {
          // The API refused something in the request (usually one bad image): retry on text alone.
          if (!(err instanceof Anthropic.BadRequestError)) throw err;
          console.error("[tagging] retrying a batch without images:", err.message);
          n = await tagBatch(rows, { withImages: false });
        }
        job.done += n;
        job.failed += chunk.length - n;
      } catch (err) {
        job.failed += chunk.length;
        job.failedIds.push(...chunk);
        const auth = isAuthError(err);
        if (!auth) markTagFailed(chunk, err?.message || String(err));
        job.error = err?.noKey ? err.message : err?.message || String(err);
        console.error("[tagging]", job.error);
        // Key problems won't fix themselves; stop instead of burning through every batch.
        if (auth) job.fatal = job.stopping = true;
      }
    }
  };
  Promise.all(Array.from({ length: CONCURRENCY }, worker)).finally(() => {
    job.running = false;
    job.stopping = false;
    job.finishedAt = Date.now();
    recordUsage("tag", job.model, job.effort, job.done, job.usage); // per-post averages for Settings' estimates
  });
  return job;
}

// Stops after the batches already in flight (up to 4 × 25 posts) come back; those are kept.
export function stopTagging() {
  if (job.running) job.stopping = job.stoppedByUser = true;
  return job;
}

// Description search: "find the bookmark I'm describing".
// 1. A small model (Haiku) turns the request into a search plan, using the stash's own tags and authors.
// 2. candidates() scores the whole stash against the plan locally and keeps a shortlist.
// 3. The chosen search model reads only the shortlist (with pictures for the strongest) and picks the matches.
// Sending the whole stash every time would cost over a dollar per search; this stays at a few cents.
import { candidates } from "../db/candidates.js";
import { query } from "../db/bookmarks.js";
import { topTags, topAuthors } from "../db/tags.js";
import { priceOf } from "../catalog.js";
import { PLAN_SCHEMA, planSystem, fallbackPlan, PICK_SCHEMA, PICK_SYSTEM, pickInput } from "../prompts/search.js";
import { getClient, jsonRequest, jsonAnswer, billedTokens, Refused } from "./anthropic.js";
import { fetchImage, firstThumb } from "./images.js";
import { settings, recordUsage } from "./settings.js";

const PLAN_MODEL = "claude-haiku-5-5"; // writing the plan is a small job; Haiku does it for a fraction of a cent
const SHORTLIST = 150;
const IMAGES_IN_PICK = 40; // the top candidates are shown as 360px images (~140 tokens each)

// One structured call; token use is added to `usage`, per model.
async function ask(usage, signal, { model, effort, system, content, schema }) {
  const res = await getClient().beta.messages.create(jsonRequest({ model, effort, system, content, schema }), { signal });
  const used = billedTokens(res.usage);
  const m = (usage[model] ||= { input: 0, output: 0 });
  m.input += used.input;
  m.output += used.output;
  return jsonAnswer(res);
}

async function writePlan(q, usage, signal) {
  const vocabulary = topTags(300);
  try {
    return await ask(usage, signal, {
      model: PLAN_MODEL,
      effort: "low",
      // The vocabulary block changes rarely, so it's cached; the request itself comes after it.
      system: [
        { type: "text", text: planSystem() },
        { type: "text", text: `Tag vocabulary: ${vocabulary.join(", ")}\nFrequent authors: ${topAuthors(80).join(", ")}`, cache_control: { type: "ephemeral" } },
      ],
      content: `What they're looking for: ${q}`,
      schema: PLAN_SCHEMA,
    });
  } catch (err) {
    // Haiku has no automatic fallback model: if it declines, search on the request's own words.
    if (err instanceof Refused) return fallbackPlan(q, vocabulary);
    throw err;
  }
}

export async function search({ q = "", account = "" }, signal) {
  q = String(q).trim().slice(0, 500);
  if (!q) return { items: [], plan: null, note: "" };
  const usage = {};
  const started = Date.now();
  const { searchModel, searchEffort } = settings();

  // (The server app also mixes in matches from a local image model; this version leaves that out.)
  const plan = await writePlan(q, usage, signal);
  const shortlist = candidates(plan, account, SHORTLIST);

  const finish = (items, note) => {
    const total = priceAs(searchModel, usage);
    recordUsage("search", searchModel, searchEffort, 1, total);
    return { items, plan, note, considered: shortlist.length, usage: total, usageByModel: usage, ms: Date.now() - started };
  };
  if (!shortlist.length) return finish([], "Nothing in your stash matched that. Try describing it with words the post might use.");

  // Text for every candidate; images for the strongest ones, right after their JSON.
  const images = await Promise.all(shortlist.map((t, i) => (i < IMAGES_IN_PICK ? fetchImage(firstThumb(t)) : null)));
  if (signal?.aborted) throw new Error("aborted");
  const content = (withImages) => {
    const out = [{ type: "text", text: `What they're looking for: ${q}\n\nCandidates:` }];
    shortlist.forEach((t, i) => {
      out.push({ type: "text", text: JSON.stringify(pickInput(t)) });
      if (withImages && images[i]) out.push(images[i]);
    });
    return out;
  };
  const pickWith = (withImages) =>
    ask(usage, signal, { model: searchModel, effort: searchEffort, system: PICK_SYSTEM, content: content(withImages), schema: PICK_SCHEMA });

  // If the model declines (explicit pictures, usually), retry on the descriptions alone; if it still
  // declines, show the closest matches by local score rather than nothing.
  let pick, note = "";
  try {
    pick = await pickWith(true);
  } catch (err) {
    if (!(err instanceof Refused)) throw err;
    try {
      pick = await pickWith(false);
    } catch (err2) {
      if (!(err2 instanceof Refused)) throw err2;
      pick = { matches: shortlist.slice(0, 20).map((t) => ({ id: t.id, reason: "" })), note: "" };
      note = "The AI declined to judge these, so these are the closest matches by local search.";
    }
  }

  // Model output is untrusted too: a post's prompt injection must not escape the candidate/account filter.
  const candidateIds = new Set(shortlist.map((t) => t.id));
  const matches = pick.matches.filter((m) => candidateIds.has(m.id));
  const reasons = new Map(matches.map((m) => [m.id, m.reason]));
  const order = [...new Set(matches.map((m) => m.id))];
  const items = order.length ? query({ ids: order, limit: 60 }).items : [];
  items.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  items.forEach((it) => (it.reason = reasons.get(it.id)));
  return finish(items, note || pick.note);
}

// Total tokens priced as `model`, for the per-search estimate in Settings: the Haiku plan is converted to
// its equivalent in search-model tokens so the estimate stays honest.
function priceAs(model, usage) {
  const to = priceOf(model);
  const total = { input: 0, output: 0 };
  for (const [m, u] of Object.entries(usage)) {
    const from = priceOf(m);
    total.input += (u.input * from.input) / to.input;
    total.output += (u.output * from.output) / to.output;
  }
  return { input: Math.round(total.input), output: Math.round(total.output) };
}

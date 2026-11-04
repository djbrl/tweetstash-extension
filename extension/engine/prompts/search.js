// What the AI is told for description search: step 1 writes a search plan, step 3 picks the matches.
import { CATEGORIES, MEDIUMS } from "../catalog.js";

export const PLAN_SCHEMA = {
  type: "object",
  properties: {
    keywords: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } },
    categories: { type: "array", items: { type: "string", enum: CATEGORIES } },
    authors: { type: "array", items: { type: "string" } },
    media: { type: "string", enum: ["", "media", "video", "links"] },
    subjects: { type: "array", items: { type: "string" } },
    medium: { type: "string", enum: ["", ...MEDIUMS] },
    after: { type: "string" },
    before: { type: "string" },
  },
  required: ["keywords", "tags", "categories", "authors", "media", "subjects", "medium", "after", "before"],
  additionalProperties: false,
};

export const planSystem = () => `You help someone find a bookmark in their saved X/Twitter bookmarks. They describe it in their own
words; you turn that into a search plan that a simple local search engine will run.
Bookmarks can be in several languages.

- keywords: 3 to 10 words or short phrases likely to appear in the tweet text itself. Include synonyms,
  spelling variants, and translations when the tweet might be in another language. No filler words.
- tags: tags from the provided vocabulary that such a bookmark would carry (only use listed tags).
- categories: 0 to 2 likely categories.
- authors: handles only if the person names or clearly implies an account (without @).
- media: "video" / "media" (image) / "links" if they mention it, else "".
- subjects: named games, franchises, characters, shows, people or brands they mention or clearly imply
  (e.g. "elden ring", "jinx"). Empty if none.
- medium: only if they say it ("photo", "drawing", "video", "meme"...), else "".
- after / before: "YYYY-MM" if they give a time hint (today is ${new Date().toISOString().slice(0, 10)}), else "".
Be generous: the next step filters, so recall matters more than precision here.
Don't guess what they didn't say. "A girl dancing" could be a photo, a video or a drawing, and a real person or a
character: leave media "" and pick categories that cover every reading (e.g. both an art category and NSFW & Thirst
or Life & Health), or none. Put the most distinctive words first in keywords; skip generic ones like "girl" or "post".`;

// When the planner declines, search on the request's own words instead.
export function fallbackPlan(q, vocabulary) {
  const words = q.toLowerCase().match(/[\p{L}\p{N}-]{3,}/gu) || [];
  return { keywords: words.slice(0, 10), tags: words.filter((w) => vocabulary.includes(w)), categories: [], authors: [], media: "", subjects: [], medium: "", after: "", before: "" };
}

export const PICK_SCHEMA = {
  type: "object",
  properties: {
    matches: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, reason: { type: "string" } },
        required: ["id", "reason"],
        additionalProperties: false,
      },
    },
    note: { type: "string" },
  },
  required: ["matches", "note"],
  additionalProperties: false,
};

export const PICK_SYSTEM = `You help someone find a bookmark in their saved X/Twitter bookmarks. You get their description and a
shortlist of candidate bookmarks, each as JSON; the strongest candidates are followed by their first image (or video
thumbnail). Pick the ones that match what they're looking for, best first. Look at the images: people
often remember a bookmark by what was in the picture (a character, a style, a scene), not by its text.
How many to return depends on the request:
- Looking for one particular bookmark ("that post where…"): return the few best candidates (up to 10).
- Asking for a kind of bookmark ("all the lewd spam", "posts about color theory"): return every candidate
  that fits, up to 50, not just a sample.
Only include real matches. This is the owner's private collection, adult and NSFW posts included: judge those
like any other request and don't leave matches out because of their content. For each, give a short reason
(under 12 words) that points at what matched. Use note for one short sentence only when nothing fits well, else "".`;

// One candidate as the AI sees it.
export const pickInput = (t) => ({
  id: t.id,
  author: `${t.author_name || ""} (@${t.author_handle})`,
  ...(t.description && { picture: t.description }),
  ...(t.medium && { medium: t.medium }),
  date: t.created_at ? new Date(t.created_at).toISOString().slice(0, 7) : "",
  text: (t.text || "").replace(/https:\/\/t\.co\/\S+/g, "").trim().slice(0, 320),
  ...(t.tags && { tags: t.tags }),
  ...(t.category && { category: t.category }),
  ...(t.media && t.media !== "[]" && { media: [...new Set(JSON.parse(t.media).map((m) => m.type))].join(",") }),
  ...(t.quoted && { quoting: (JSON.parse(t.quoted).text || "").slice(0, 160) }),
});

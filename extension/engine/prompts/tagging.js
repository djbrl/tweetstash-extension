// What the AI is told when tagging, and the shape its answer must have.
import { CATEGORIES, MEDIUMS } from "../catalog.js";

export const TAG_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          category: { type: "string", enum: CATEGORIES },
          tags: { type: "array", items: { type: "string" } },
          subjects: { type: "array", items: { type: "string" } },
          medium: { type: "string", enum: MEDIUMS },
          nsfw: { type: "string", enum: ["none", "suggestive", "explicit"] },
          description: { type: "string" },
        },
        required: ["id", "category", "tags", "subjects", "medium", "nsfw", "description"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
};

// Kept identical across batches so the API can cache it (the tag vocabulary goes in the message instead).
export const TAG_SYSTEM = `You organize someone's saved X/Twitter bookmarks so they can find any of them later by
describing it in their own words. Bookmarks cover art, games, tech, memes, news and adult content alike.

For every bookmark you get, return:
- category: the single best fit from the allowed list.
- tags: 2 to 4 short lowercase tags (1-2 words, hyphenated, no #) for what it's about or useful for
  (e.g. "color-theory", "react", "portfolio-tips", "job-board", "character-design"), not generic words like
  "tweet", "interesting", "thread" or the format alone ("video-clip" is never enough on its own).
- subjects: named things it shows or is about: games, franchises, characters, shows, real people, brands,
  tools (e.g. "elden ring", "nightreign", "malenia", "jinx", "street fighter 6", "blender"). Empty if none.
  For game footage or game art, always name the game. Use the author's name and bio as clues (an account
  named after a game character usually posts that game).
- medium: what the main media is (photo, video, drawing, painting, 3d, pixel-art, comic, screenshot,
  meme, text when there's no media).
- nsfw: "none", "suggestive" (thirst traps, lingerie, teasing) or "explicit" (nudity, sex).
- description: one factual line, under 30 words, of what's in the picture or video as someone would
  remember it: who or what, doing what, setting, notable colors or style, plus any readable text in the
  image. E.g. "painted portrait of an osprey's head on a flat blue sky", "photo of a woman with blue hair
  in a black bodysuit, indoors", "Elden Ring Nightreign gameplay, three players fighting a dragon".
  For posts without media, describe what the post is (e.g. "thread listing free game-dev asset sites").
  Describe adult content plainly and factually, like everything else; this is the owner's private archive.

Category notes:
- "NSFW & Thirst": anything sexual or explicit, porn/OnlyFans-style spam and promo, and selfies or
  thirst-trap photos of people posted to show themselves off. When a bookmark is likely this, put it
  here even if it would also fit somewhere else, so the owner can filter it out in one click.
- "Anime & Manga": anime, manga, and their fandom posts (fan art of a series can go here or in
  Art & Illustration; pick Art & Illustration when the post is about the drawing itself).
- "Film & TV": movies, series, trailers, actors, recommendations.
- "Other" is a last resort; prefer the closest real category.

Images: when a bookmark has a photo or video, its first image (or the video's thumbnail) comes right
after its JSON. Judge mainly from the image: captions are often jokes or unrelated to the picture
(a thirst-trap photo captioned "cats" is NSFW & Thirst, not animals). Use the text, author, bio, alt text
and link titles for context the image can't give.

Reuse tags from the existing vocabulary whenever one fits, so the tag list stays small and consistent;
invent a new tag only when nothing existing fits. Return one result per input id.`;

// One post as the AI sees it.
export function tagInput(t) {
  const urls = JSON.parse(t.urls || "[]").map((u) => u.url);
  const quoted = t.quoted ? JSON.parse(t.quoted) : null;
  const media = JSON.parse(t.media || "[]").map((m) => m.type);
  return {
    id: t.id,
    author: `${t.author_name || ""} (@${t.author_handle})`,
    ...(t.bio && { author_bio: t.bio }),
    ...(t.alt && { image_alt_text: t.alt }),
    ...(t.linkTitle && { link_title: t.linkTitle }),
    text: (t.text || "").slice(0, 1200),
    ...(urls.length && { links: urls }),
    ...(media.length && { media }),
    ...(quoted && { quoting: `@${quoted.author_handle}: ${quoted.text.slice(0, 400)}` }),
  };
}

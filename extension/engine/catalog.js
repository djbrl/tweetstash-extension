// Fixed lists the app is built around: categories and mediums for tagging, and the AI models on offer.

export const CATEGORIES = [
  "Art & Illustration", "Design & UI", "Dev & Engineering", "AI & ML", "Tools & Resources",
  "Business & Freelance", "Career & Learning", "Games", "Anime & Manga", "Film & TV",
  "News & Opinion", "Humor & Memes", "Life & Health", "NSFW & Thirst", "Other",
];
export const NSFW_CATEGORY = "NSFW & Thirst";

export const MEDIUMS = ["photo", "video", "drawing", "painting", "3d", "pixel-art", "comic", "screenshot", "meme", "text"];

// Prices are $ per million tokens. Notes say what each model is for, per job, rather than ranking them.
// (Haiku 5.5's price is for prompts up to 100K tokens; tagging batches and searches stay far below.)
export const MODELS = [
  { id: "claude-haiku-5-5", label: "Haiku 5.5", input: 0.1, output: 0.5,
    tagNote: "General sorting: broad categories and common tags.",
    searchNote: "Quick lookups when you remember words from the post." },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", input: 2, output: 10,
    tagNote: "Everyday tagging with more detail: topics, tools, art styles.",
    searchNote: "Everyday searches from a rough description." },
  { id: "claude-opus-5-5", label: "Opus 5.5", input: 4, output: 20,
    tagNote: "Nuanced posts: recognizes specific games, characters, shows and media.",
    searchNote: "Vague memories, like finding a post by what was in the picture." },
  { id: "claude-fable-5-1", label: "Fable 5.1", input: 10, output: 50,
    tagNote: "The most precise tagging possible, for niche or hard-to-read posts.",
    searchNote: "The hardest searches, when you only remember a small detail." },
];
export const EFFORTS = ["low", "medium", "high"];

export const priceOf = (id) => MODELS.find((m) => m.id === id) || { input: 4, output: 20 };

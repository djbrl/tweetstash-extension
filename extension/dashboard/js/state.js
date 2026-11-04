// Shared page state. Filters mirror the URL's query string, so a filtered view can be bookmarked.
import { store } from "./util.js";

export const PAGE = 60;
export const FILTER_KEYS = ["q", "account", "tag", "category", "author", "media", "untagged", "failed"];

const params = new URLSearchParams(location.search);

export const state = {
  filters: Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) || ""])),
  sort: params.get("sort") || "saved_desc",
  view: store.get("nest-view", "grid"),
  offset: 0, total: 0, loading: false, done: false,
  reqId: 0, // bumped by every new list or search, so a slow older answer is ignored
  stats: null, // from /api/stats, refreshed by polling
  settings: null, // from /api/settings
  tagsExpanded: false,
  searchMode: "kw", // "kw" (keyword) or "ai" (describe); always starts on keyword
  asking: false, // true while description-search results are on screen (stops infinite scroll)
};

export function clearFilters() {
  for (const k of FILTER_KEYS) state.filters[k] = "";
}

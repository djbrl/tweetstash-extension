// The list of bookmarks: loading pages, the result line, the toolbar (sort, media, view) and filters.
import { $, $$, esc, clean, toast, api, store } from "./util.js";
import { state, PAGE } from "./state.js";
import { card, failReason } from "./cards.js";
import { renderSidebar } from "./sidebar.js";
import { startTagging } from "./tagging.js";

export async function load(reset = false) {
  if (reset) {
    state.offset = 0;
    state.done = false;
    state.reqId++;
    $("#feed").innerHTML = "";
    window.scrollTo({ top: 0 });
  }
  if ((state.loading && !reset) || state.done) return;
  state.loading = true;
  const myReq = state.reqId;
  const qs = new URLSearchParams({ ...clean(state.filters), sort: state.sort, offset: state.offset, limit: PAGE });
  try {
    const data = await api("/api/bookmarks?" + qs);
    if (myReq !== state.reqId) return; // a newer search replaced this one
    state.total = data.total;
    state.offset += data.items.length;
    state.done = data.items.length < PAGE;
    const frag = document.createDocumentFragment();
    // In the "Couldn't tag" list, each card says why.
    const showWhy = state.filters.failed === "1";
    for (const b of data.items) frag.appendChild(card(b, showWhy && b.tag_error ? `Couldn't tag: ${failReason(b.tag_error)}` : ""));
    $("#feed").appendChild(frag);
    renderResultLine();
  } catch (e) {
    toast("Couldn't load bookmarks: " + e.message);
  } finally {
    if (myReq === state.reqId) state.loading = false;
  }
}

export function renderResultLine() {
  const empty = state.stats && state.stats.total === 0;
  $("#empty").hidden = !empty;
  const active = Object.keys(clean(state.filters)).length;
  const n = state.total;
  $("#result-line").textContent = empty ? "" : active
    ? `${n.toLocaleString()} matching bookmark${n === 1 ? "" : "s"}`
    : `${n.toLocaleString()} bookmarks`;
  if (state.filters.failed === "1" && n && !state.stats?.job.running) {
    $("#result-line").insertAdjacentHTML("beforeend", ` · <button class="linkish" id="retry-failed" type="button">Retry these</button>`);
    $("#retry-failed").onclick = () => startTagging({ failed: true });
  }
  if (state.filters.unsure === "1" && n) {
    $("#result-line").insertAdjacentHTML("beforeend", ` · least sure first. Fix any that are wrong with the arrow next to the category: the tagger learns from it.`);
  }
}

const FILTER_LABELS = {
  q: (v) => `“${v}”`, account: (v) => v, tag: (v) => `#${v}`, category: (v) => v,
  author: (v) => `@${v}`, untagged: () => "Not tagged yet", failed: () => "Couldn't tag", unsure: () => "Check these",
  media: (v) => ({ 1: "Has media", video: "Has video", links: "Has links" }[v]),
};

// Toolbar, filter chips, sidebar highlights and the URL, from state.
export function renderFilters() {
  const f = state.filters;
  $("#active-filters").innerHTML = Object.entries(clean(f))
    .map(([k, v]) => `<span class="chip" data-clear="${k}">${esc(FILTER_LABELS[k](v))} ✕</span>`).join("");
  if (state.searchMode !== "ai") $("#q").value = f.q;
  $("#sort").value = state.sort;
  $$("#media-seg button").forEach((b) => b.classList.toggle("on", b.dataset.media === f.media));
  $$("#view-seg button").forEach((b) => b.classList.toggle("on", b.dataset.view === state.view));
  $("#feed").className = "feed " + state.view;
  $("[data-reset]").classList.toggle("active", !Object.keys(clean(f)).length);
  $$(".sidebar [data-filter]").forEach((el) => {
    const on = el.dataset.filter === "untagged" ? f.untagged === "1" : f[el.dataset.filter] === el.dataset.value;
    el.classList.toggle("active", on);
  });
  const qs = new URLSearchParams({ ...clean(f), ...(state.sort !== "saved_desc" && { sort: state.sort }) });
  history.replaceState(null, "", qs.toString() ? "?" + qs : location.pathname);
}

// Re-renders everything that depends on the filters and reloads the list from the top.
export function refreshList() {
  renderFilters();
  renderSidebar();
  load(true);
}

// Clicking an active filter again turns it off.
export function setFilter(key, value) {
  state.filters[key] = state.filters[key] === value ? "" : value;
  refreshList();
  document.body.classList.remove("drawer");
}

export function initFeed() {
  $("#sort").addEventListener("change", (e) => { state.sort = e.target.value; renderFilters(); load(true); });
  $("#media-seg").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    state.filters.media = b.dataset.media;
    renderFilters();
    load(true);
  });
  $("#view-seg").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    state.view = b.dataset.view;
    store.set("nest-view", state.view);
    renderFilters();
  });
  // Infinite scroll (paused while description-search results are showing).
  new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && !state.asking) load();
  }, { rootMargin: "800px" }).observe($("#sentinel"));
}

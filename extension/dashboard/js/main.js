// Entry point: wires up every part of the page, handles clicks that cross parts, and loads data.
import { $, clean, api } from "./util.js";
import { state, clearFilters } from "./state.js";
import { load, renderFilters, refreshList, setFilter, initFeed } from "./feed.js";
import { renderTagList, toggleSection, initSidebar } from "./sidebar.js";
import { refreshStats } from "./stats.js";
import { initTagging, renderTaggingButton } from "./tagging.js";
import { removeTag, openTagInput } from "./tag-edit.js";
import { clearSearch, initSearch } from "./search.js";
import { initVoice } from "./voice.js";
import { initSettings, loadSettings } from "./settings.js";
import { initTeach } from "./teach.js";
import { openCategoryMenu } from "./category-edit.js";

// Start the engine and load settings before polling, search, or background UI work.
try {
  state.settings = await api("/api/settings");
} catch (err) {
  document.body.textContent = err.message;
  throw err;
}

const closeDrawer = () => document.body.classList.remove("drawer");

// Logo: on the plain list, glide back to the top; otherwise reset filters and search (which lands at the top).
function goHome() {
  closeDrawer();
  const plain = !Object.keys(clean(state.filters)).length && !state.asking && !$("#q").value;
  if (plain) return window.scrollTo({ top: 0, behavior: "smooth" });
  clearSearch({ reload: false });
  clearFilters();
  refreshList();
}

// One listener for clicks on things that are re-rendered often (cards, chips, sidebar items).
document.addEventListener("click", (e) => {
  const t = e.target;
  const on = (sel) => t.closest(sel);

  if (on("[data-home]")) { e.preventDefault(); return goHome(); }
  const secTitle = on(".side-section h3");
  if (secTitle && !on("input")) return toggleSection(secTitle.parentElement);
  if (on("[data-reset]")) { clearFilters(); refreshList(); return closeDrawer(); }

  // Cards
  const rm = on("[data-remove]");
  if (rm) return removeTag(rm.closest(".card"), rm.dataset.remove);
  const tagChip = on(".card-tags [data-tag]");
  if (tagChip) return setFilter("tag", tagChip.dataset.tag);
  if (on(".add-tag")) return openTagInput(on(".card"), on(".add-tag"));
  if (on("[data-cat-edit]")) return openCategoryMenu(on(".card"), on("[data-cat-edit]"));
  if (on(".cat-menu")) return;
  if (on(".more-text")) {
    const txt = on(".card").querySelector(".text");
    txt.classList.toggle("clamp");
    t.textContent = txt.classList.contains("clamp") ? "Show more" : "Show less";
    return;
  }

  // Filters (sidebar items, author names, categories, active-filter chips)
  const f = on("[data-filter]");
  if (f) return setFilter(f.dataset.filter, f.dataset.value);
  const author = on("[data-author]");
  if (author) { e.preventDefault(); return setFilter("author", author.dataset.author); }
  const cat = on("[data-category]");
  if (cat) return setFilter("category", cat.dataset.category);
  const clear = on("[data-clear]");
  if (clear) return setFilter(clear.dataset.clear, state.filters[clear.dataset.clear]);
  if (t.id === "tags-more") { state.tagsExpanded = true; return renderTagList(); }

  // Mobile drawer
  if (on("#menu-btn")) return document.body.classList.toggle("drawer");
  if (document.body.classList.contains("drawer") && !on(".sidebar")) closeDrawer();
});

initFeed();
initSidebar();
initTagging();
initSearch();
initVoice();
initSettings();
initTeach();

renderFilters();
load(true);
refreshStats();
loadSettings().then(() => state.stats && renderTaggingButton());


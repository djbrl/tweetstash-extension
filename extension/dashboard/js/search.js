// The search box: Keyword mode filters live as you type; Describe mode sends a description to the AI
// on Enter and shows its picks. Esc stops a running search, then clears, then leaves the box.
import { $, $$, api } from "./util.js";
import { state } from "./state.js";
import { card } from "./cards.js";
import { load, renderFilters } from "./feed.js";

let askCtl = null; // AbortController of the running description search
let typingTimer = 0;

export function setSearchMode(mode) {
  if (mode === state.searchMode) return;
  stopAsk();
  state.searchMode = mode;
  const text = $("#q").value.trim();
  applySearchMode();
  if (mode === "kw") {
    // Back to keyword: whatever is typed becomes the live filter again.
    state.asking = false;
    state.filters.q = text;
    renderFilters();
    load(true);
  } else if (state.filters.q) {
    state.filters.q = "";
    $("#q").value = text;
    renderFilters();
    load(true);
  }
  $("#q").focus();
}

export function applySearchMode() {
  const ai = state.searchMode === "ai";
  $("#search").classList.toggle("ai", ai);
  $$("#mode-seg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === state.searchMode));
  placeModePill();
  $("#q").placeholder = ai ? "Describe what you're looking for, then press Enter" : "Search text, authors, tags…";
  $("#ask-go").hidden = !ai;
  $("#kbd-slash").hidden = ai;
}

// Slides the highlight under the active mode. The first placement is instant; later ones animate.
function placeModePill() {
  const seg = $("#mode-seg");
  const on = seg.querySelector("button.on");
  if (!on) return;
  seg.style.setProperty("--x", on.offsetLeft + "px");
  seg.style.setProperty("--w", on.offsetWidth + "px");
  if (!seg.classList.contains("ready")) requestAnimationFrame(() => requestAnimationFrame(() => seg.classList.add("ready")));
}

function setAskRunning(running) {
  const b = $("#ask-go");
  b.classList.toggle("stop", running);
  b.innerHTML = running ? "Stop" : 'Enter <span class="key" aria-hidden="true">↵</span>';
  $("#search").classList.toggle("running", running);
  syncClear();
}

// The × in the search box: shown when there's text or AI results to clear.
export function syncClear() {
  $("#q-clear").hidden = !($("#q").value || state.asking);
}

// Empties the box and drops search results, back to the plain list.
export function clearSearch({ reload = true } = {}) {
  stopAsk();
  const had = state.asking || state.filters.q;
  state.asking = false;
  state.filters.q = "";
  $("#q").value = "";
  syncClear();
  renderFilters();
  if (had && reload) load(true);
}

// Stops a running description search: aborts the request, and the engine aborts its AI calls in turn.
export function stopAsk() {
  if (!askCtl) return;
  askCtl.abort();
  askCtl = null;
  setAskRunning(false);
  $("#result-line").textContent = "Search stopped.";
}

async function describeSearch(q) {
  const myReq = ++state.reqId;
  askCtl?.abort();
  const ctl = (askCtl = new AbortController());
  setAskRunning(true);
  state.asking = true;
  $("#feed").innerHTML = "";
  $("#empty").hidden = true;
  window.scrollTo({ top: 0 });
  $("#result-line").innerHTML = `<span class="thinking">Looking through your stash</span>`;
  try {
    const r = await api("/api/ask", { q, account: state.filters.account }, ctl.signal);
    if (myReq !== state.reqId) return;
    askCtl = null;
    setAskRunning(false);
    const n = r.items.length;
    $("#result-line").textContent = n ? `${n} match${n === 1 ? "" : "es"}` : r.note || "Nothing matched.";
    const frag = document.createDocumentFragment();
    for (const b of r.items) frag.appendChild(card(b, b.reason || ""));
    $("#feed").appendChild(frag);
  } catch (e) {
    if (myReq !== state.reqId || e.name === "AbortError") return;
    askCtl = null;
    setAskRunning(false);
    $("#result-line").textContent = `Couldn't search: ${e.message}`;
  }
}

export function initSearch() {
  const q = $("#q");
  q.addEventListener("input", () => {
    syncClear();
    if (state.searchMode === "ai") return; // Describe waits for Enter
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      state.filters.q = q.value.trim();
      renderFilters();
      load(true);
    }, 200);
  });
  // Enter never adds a line break: it searches (Describe) or does nothing (Keyword already filters live).
  q.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (state.searchMode === "ai" && !askCtl && q.value.trim()) describeSearch(q.value.trim());
  });
  $("#q-clear").onclick = () => { clearSearch(); q.focus(); };
  $("#ask-go").addEventListener("click", () => {
    if (askCtl) return stopAsk();
    if (q.value.trim()) describeSearch(q.value.trim());
    else q.focus();
  });
  $("#mode-seg").addEventListener("click", (e) => {
    const b = e.target.closest("[data-mode]");
    if (b) setSearchMode(b.dataset.mode);
  });
  document.fonts?.ready.then(placeModePill); // widths change once the font loads

  document.addEventListener("keydown", (e) => {
    // "/" jumps to the search box.
    if (e.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
      e.preventDefault();
      q.focus();
      return;
    }
    if (e.key !== "Escape" || document.querySelector("dialog[open]")) return;
    if (askCtl) { e.preventDefault(); return stopAsk(); }
    if (state.asking || q.value) { e.preventDefault(); return clearSearch(); }
    if (document.activeElement === q) q.blur();
  });
  applySearchMode();
}


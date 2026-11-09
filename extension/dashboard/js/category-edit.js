// Changing a post's category from its card. The pick is yours from then on (re-tagging keeps it), and the
// local tagger learns from it: a moment later it re-sorts the posts it sorted itself.
import { esc, toast, api } from "./util.js";
import { state } from "./state.js";
import { catHtml } from "./cards.js";
import { refreshStats } from "./stats.js";

let menu = null;

function close() {
  menu?.remove();
  menu = null;
  removeEventListener("pointerdown", outside, true);
  removeEventListener("keydown", onKey, true);
}
const outside = (e) => { if (menu && !menu.contains(e.target) && !e.target.closest("[data-cat-edit]")) close(); };
const onKey = (e) => {
  if (e.key === "Escape") { e.preventDefault(); close(); }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const items = [...menu.querySelectorAll("button")];
    const i = items.indexOf(document.activeElement);
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  }
};

export function openCategoryMenu(cardEl, btn) {
  if (menu) { const same = menu._card === cardEl; close(); if (same) return; }
  const b = cardEl._data;
  const all = state.stats?.categories_all || [];
  menu = document.createElement("div");
  menu.className = "cat-menu";
  menu.setAttribute("role", "menu");
  menu._card = cardEl;
  menu.innerHTML = `<h4>Move to</h4>` + all.map((c) =>
    `<button type="button" role="menuitem" data-pick="${esc(c)}" class="${c === b.category ? "on" : ""}">${esc(c)}</button>`).join("")
    + (b.category_by === "user" ? `<button type="button" role="menuitem" class="auto" data-pick="">Let the tagger decide</button>` : "");
  document.body.appendChild(menu);
  const r = btn.getBoundingClientRect(), h = menu.offsetHeight, w = menu.offsetWidth;
  menu.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + "px";
  menu.style.top = (r.bottom + 6 + h > innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6) + "px";
  menu.querySelector("button.on, button")?.focus();
  menu.onclick = (e) => {
    const p = e.target.closest("[data-pick]");
    if (p) { close(); pick(cardEl, p.dataset.pick || null); }
  };
  addEventListener("pointerdown", outside, true);
  addEventListener("keydown", onKey, true);
}

async function pick(cardEl, category) {
  const b = cardEl._data;
  if (category === b.category && b.category_by === "user") return;
  try {
    await api("/api/category", { id: b.id, category });
  } catch (e) {
    return toast("Couldn't change the category: " + e.message);
  }
  if (category) Object.assign(b, { category, category_by: "user", tag_unsure: 0 });
  else b.category_by = "local";
  const wrap = cardEl.querySelector(".cat-wrap");
  if (wrap) wrap.innerHTML = catHtml(b);
  toast(category ? `Moved to ${category}. The local tagger learns from this.` : "The tagger will decide this one again.");
  setTimeout(refreshStats, 4000); // counts and "Check these" after it re-sorts
}

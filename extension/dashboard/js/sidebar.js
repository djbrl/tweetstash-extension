// The left sidebar: counts, accounts, categories, tags, authors, folding sections, and "Empty stash".
import { downloadJson, $, $$, esc, toast, api, store } from "./util.js";
import { state } from "./state.js";
import { load } from "./feed.js";
import { refreshStats } from "./stats.js";
import { confirmDialog } from "./dialogs.js";

export function renderSidebar() {
  resetEmptyBtn();
  const s = state.stats;
  if (!s) return;
  $("#count-all").textContent = s.total.toLocaleString();
  $("#count-untagged").textContent = s.untagged.toLocaleString();
  $("#count-failed").textContent = s.failed.toLocaleString();
  $("#nav-failed").hidden = !s.failed && state.filters.failed !== "1";
  $("#count-unsure").textContent = s.unsure.toLocaleString();
  $("#nav-unsure").hidden = !s.unsure && state.filters.unsure !== "1";
  $("#total-sub").hidden = true;

  const item = (key, value, label, n, img = "") =>
    `<button data-filter="${key}" data-value="${esc(value)}" class="${state.filters[key] === value ? "active" : ""}">
      ${img}<span class="label">${esc(label)}</span><span class="count">${n.toLocaleString()}</span></button>`;

  $("#sec-accounts").hidden = !s.accounts.length;
  $("#list-accounts").innerHTML = s.accounts.map((a) => item("account", a.name, a.name, a.n)).join("");
  $("#sec-categories").hidden = !s.categories.length;
  $("#list-categories").innerHTML = s.categories.map((c) => item("category", c.name, c.name, c.n)).join("");
  $("#list-authors").innerHTML = s.authors.map((a) =>
    item("author", a.name, a.display || a.name, a.n, `<img src="${esc(a.avatar)}" referrerpolicy="no-referrer" loading="lazy" alt="">`)).join("");
  renderTagList();
}

export function renderTagList() {
  const all = state.stats.tags;
  const limit = state.tagsExpanded ? 300 : 40;
  const tags = all.slice(0, limit);
  $("#list-tags").innerHTML = tags.length
    ? tags.map((t) => `<button class="chip ${state.filters.tag === t.name ? "active" : ""}" data-filter="tag" data-value="${esc(t.name)}">${esc(t.name)}<small>${t.n}</small></button>`).join("")
      + (all.length > limit ? `<button class="chip more" id="tags-more">show all</button>` : "")
    : `<span style="color:var(--muted);font-size:12px;padding:0 2px">${state.stats.total ? "No tags yet — run AI tagging." : "—"}</span>`;
}

// Click a section title to fold it; remembered per browser.
export function toggleSection(sec) {
  sec.classList.toggle("collapsed");
  store.set("tweetstash-folded", JSON.stringify($$(".side-section.collapsed").map((x) => x.id)));
}

function restoreFolded() {
  try {
    for (const id of JSON.parse(store.get("tweetstash-folded", "[]"))) document.getElementById(id)?.classList.add("collapsed");
  } catch {}
}

// ---------- empty stash ----------
// Scope follows the account filter: one account if one is selected, otherwise everything.

const TRASH = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4"/></svg>`;
let emptying = false;

function resetEmptyBtn() {
  if (emptying) return;
  const b = $("#empty-btn");
  b.disabled = !state.stats?.total;
  b.innerHTML = TRASH + esc(state.filters.account ? `Empty ${state.filters.account}` : "Empty stash");
}

async function emptyStash() {
  const acct = state.filters.account;
  const n = acct ? state.stats?.accounts.find((a) => a.name === acct)?.n || 0 : state.stats?.total || 0;
  const ok = await confirmDialog({
    title: acct ? `Empty ${acct}?` : "Empty your stash?",
    body: `This deletes <b>${n.toLocaleString()} bookmark${n === 1 ? "" : "s"}</b>${acct ? ` saved from ${esc(acct)}` : ""}, with their tags. A backup file downloads first, so you can restore it from Settings.`,
    ok: "Empty stash",
    danger: true,
  });
  if (!ok) return;
  const b = $("#empty-btn");
  emptying = true;
  b.disabled = true;
  b.textContent = "Emptying…";
  try {
    downloadJson(await api("/api/backup"), `tweetstash-backup-${new Date().toISOString().slice(0, 10)}.json`);
    await api("/api/empty", { account: acct });
    if (acct) state.filters.account = "";
    await refreshStats();
    await load(true);
    toast("Stash emptied. The backup is in your downloads.");
  } catch {
    toast("Couldn't empty the stash.");
  }
  emptying = false;
  resetEmptyBtn();
}

export function initSidebar() {
  restoreFolded();
  $("#empty-btn").addEventListener("click", emptyStash);
}

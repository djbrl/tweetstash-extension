// The Teach window: show the local tagger what a category or a tag of yours means, 12 posts at a time.
// Click every post that fits; the rest count as "no" (or mark one "?" to leave it out). Each save learns
// on this computer and brings the next 12: mostly likely-yes posts, plus a few it can't decide on.
// Ported from the TweetStash free edition.
import { $, $$, esc, toast, api } from "./util.js";
import { state } from "./state.js";
import { load } from "./feed.js";
import { refreshStats } from "./stats.js";
import { confirmDialog } from "./dialogs.js";

let kind = "category";
let round = null; // { kind, label, trained, yes, no, posts }
const marks = new Map(); // id -> "yes" | "skip"

const safeUrl = (u) => (/^https?:\/\//i.test(String(u || "")) ? String(u) : "");
const thumbOf = (p) => {
  const m = (p.media || []).find((x) => safeUrl(x.thumb));
  return m ? safeUrl(m.thumb) + (m.thumb.includes("?") ? "" : "?name=small") : "";
};

// ---------- choosing what to teach ----------

function setKind(k) {
  kind = k;
  $$("#teach-kind button").forEach((b) => b.classList.toggle("on", b.dataset.kind === k));
  const input = $("#teach-label");
  input.value = "";
  input.placeholder = k === "tag" ? "A tag of yours, like creature-design or 2xko" : "Pick a category";
  const names = k === "tag" ? (state.stats?.tags || []).slice(0, 300).map((t) => t.name) : state.stats?.categories_all || [];
  $("#teach-labels").innerHTML = names.map((n) => `<option value="${esc(n)}">`).join("");
}

async function renderTaught() {
  let s = null;
  try { s = await api("/api/teach/status"); } catch {}
  if (!s) return;
  $("#teach-fixes").textContent = !s.ready
    ? "Tag your stash with the local tagger first (Settings → Tagging), so it has looked at every post."
    : s.fixes >= s.minFixes
      ? `It's learning from ${s.fixes.toLocaleString()} posts you sorted yourself.`
      : s.fixes ? `It starts learning from your own categories at ${s.minFixes} (you've sorted ${s.fixes}).` : "";
  $("#teach-undo").hidden = !s.ready || s.fixes < s.minFixes;
  $("#teach-taught").innerHTML = s.taught.length
    ? `<h3>Taught so far</h3>` + s.taught.map((r) => `<div class="taught-row">
        <button class="taught-go" type="button" data-kind="${r.kind}" data-label="${esc(r.label)}"><b>${r.kind === "tag" ? "#" : ""}${esc(r.label)}</b><small>${r.kind} · ${r.yes} yes, ${r.no} no${r.kind === "tag" && !r.trained ? " · needs 3 yes to learn" : ""}</small></button>
        <button class="linkish" type="button" data-forget="${esc(r.label)}" data-kind="${r.kind}">Forget</button></div>`).join("")
    : "";
}

async function begin(k, label) {
  label = String(label || "").trim();
  if (!label) return $("#teach-label").focus();
  if (k === "category" && !(state.stats?.categories_all || []).includes(label)) return toast("Pick one of the categories in the list");
  $("#teach-status").textContent = "";
  try {
    showRound(await api("/api/teach/next", { kind: k, label }));
  } catch (e) { toast(e.message); }
}

// ---------- a round ----------

function showRound(r) {
  round = r;
  marks.clear();
  $("#teach-pick").hidden = true;
  $("#teach-round").hidden = false;
  $("#teach-what").textContent = r.kind === "category" ? r.label : `#${r.label}`;
  $("#teach-count").textContent = `${r.yes} yes · ${r.no} no so far`;
  $("#teach-hint").innerHTML = r.posts.length
    ? `Click every post that ${r.kind === "category" ? "belongs in" : "is"} <b>${esc(r.label)}</b>. The rest count as no. ${r.kind === "tag" && !r.trained ? "It hasn't learned this tag yet: these are first guesses from its name." : "These are its best guesses, plus a few it's unsure about."}`
    : "It has seen every post. Nothing left to ask.";
  $("#teach-grid").innerHTML = r.posts.map((p) => {
    const img = thumbOf(p);
    const text = (p.text || "").replace(/https:\/\/t\.co\/\S+/g, "").trim();
    return `<div class="teach-tile" data-id="${esc(p.id)}" role="button" tabindex="0" aria-pressed="false">
      ${img ? `<img src="${esc(img)}" referrerpolicy="no-referrer" loading="lazy" alt="">` : ""}
      <div class="tt-text${img ? "" : " only"}">${esc(text.slice(0, img ? 90 : 260)) || "(no text)"}</div>
      <div class="tt-meta">@${esc(p.author_handle || "")}${p.category ? " · " + esc(p.category) : ""}</div>
      <button class="tt-skip" type="button" title="Not sure: leave it out">?</button>
      <span class="tt-check" aria-hidden="true">✓</span></div>`;
  }).join("");
  $("#teach-save").disabled = !r.posts.length;
  $("#teach-apply").hidden = !(r.kind === "tag" && r.trained);
  $("#teach-round").scrollTop = 0;
}

function toggle(tile, skip = false) {
  const id = tile.dataset.id;
  const cur = marks.get(id);
  const next = skip ? (cur === "skip" ? undefined : "skip") : cur === "yes" ? undefined : "yes";
  next ? marks.set(id, next) : marks.delete(id);
  tile.classList.toggle("yes", next === "yes");
  tile.classList.toggle("skip", next === "skip");
  tile.setAttribute("aria-pressed", String(next === "yes"));
}

async function save() {
  if (!round?.posts.length) return;
  const answers = round.posts.filter((p) => marks.get(p.id) !== "skip").map((p) => ({ id: p.id, yes: marks.get(p.id) === "yes" }));
  const b = $("#teach-save");
  b.disabled = true;
  b.textContent = "Learning…";
  try {
    const r = await api("/api/teach/answer", { kind: round.kind, label: round.label, answers });
    showRound(r.next);
    const yes = answers.filter((a) => a.yes).length;
    $("#teach-status").textContent = round.kind === "category"
      ? `Saved ${yes} yes, ${answers.length - yes} no. Your stash is re-sorted with it.`
      : r.next.trained
        ? `Saved ${yes} yes, ${answers.length - yes} no. It's learned from ${r.next.yes} yes and ${r.next.no} no.`
        : `Saved. It starts learning once it has 3 yes (${r.next.yes} so far).`;
  } catch (e) {
    toast(e.message);
  } finally {
    b.disabled = !round?.posts.length;
    b.textContent = "Save answers · next 12";
  }
}

async function apply() {
  const b = $("#teach-apply");
  b.disabled = true;
  try {
    const r = await api("/api/teach/apply", { label: round.label });
    toast(`${r.tagged.toLocaleString()} posts are tagged ${round.label} now`);
  } catch (e) { toast(e.message); }
  b.disabled = false;
}

function backToPick() {
  round = null;
  $("#teach-round").hidden = true;
  $("#teach-pick").hidden = false;
  renderTaught();
}

export function initTeach() {
  const dlg = $("#teach-dlg");
  $("#teach-btn").onclick = () => { setKind(kind); backToPick(); dlg.showModal(); };
  $("#teach-close").onclick = () => dlg.close();
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener("close", () => { load(true); refreshStats(); }); // show the new tags and categories
  $("#teach-kind").onclick = (e) => { const b = e.target.closest("[data-kind]"); if (b) setKind(b.dataset.kind); };
  $("#teach-new").onsubmit = (e) => { e.preventDefault(); begin(kind, $("#teach-label").value); };
  $("#teach-taught").onclick = async (e) => {
    const f = e.target.closest("[data-forget]");
    if (f) {
      try { await api("/api/teach/forget", { kind: f.dataset.kind, label: f.dataset.forget }); } catch (err) { toast(err.message); }
      return renderTaught();
    }
    const g = e.target.closest(".taught-go");
    if (g) begin(g.dataset.kind, g.dataset.label);
  };
  $("#teach-grid").onclick = (e) => {
    const tile = e.target.closest(".teach-tile");
    if (tile) toggle(tile, !!e.target.closest(".tt-skip"));
  };
  $("#teach-grid").onkeydown = (e) => {
    const tile = e.target.closest(".teach-tile");
    if (tile && (e.key === " " || e.key === "Enter")) { e.preventDefault(); toggle(tile); }
  };
  $("#teach-undo").onclick = async () => {
    const ok = await confirmDialog({
      title: "Undo what it learned?",
      body: "It goes back to sorting the way it came, and re-sorts your stash. Categories you picked yourself become automatic again, and your category answers in Teach are forgotten. Tags you taught stay.",
      ok: "Undo",
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await api("/api/teach/reset-categories", {});
      toast(`Back to how it came: ${r.moved.toLocaleString()} posts re-sorted`);
    } catch (e) { toast(e.message); }
    renderTaught();
  };
  $("#teach-save").onclick = save;
  $("#teach-apply").onclick = apply;
  $("#teach-back").onclick = backToPick;
}

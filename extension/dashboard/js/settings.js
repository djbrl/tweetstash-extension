// The Settings dialog. Theme and voice language are kept in localStorage; everything else is saved by
// the engine. The API key goes to the engine once and is never sent back: the page only learns
// "saved, ends in …abcd".
import { $, $$, esc, toast, api, money, store, downloadJson } from "./util.js";
import { state } from "./state.js";
import { load } from "./feed.js";
import { refreshStats } from "./stats.js";
import { renderTaggingButton } from "./tagging.js";
import { confirmDialog } from "./dialogs.js";

// ---------- price estimates ----------
// Tokens per post (tagging) and per search, until real runs replace these with measured averages.
// Tagging at low effort was measured on Opus (~$10.40 per 5,000); higher effort mostly adds thinking output.
const TAG_GUESS = { input: 420, output: { low: 110, medium: 170, high: 330 } };
const SEARCH_GUESS = { input: 24000, output: { low: 700, medium: 1600, high: 4000 } }; // the plan step runs on Haiku

export const modelLabel = (id) => state.settings?.models.find((m) => m.id === id)?.label || id;

function usagePer(kind, model, effort) {
  const s = state.settings;
  const m = kind === "tag" ? s.measuredTag[`${model}|${effort}|v2`] : s.measuredSearch[`${model}|${effort}`];
  if (m && m.n >= (kind === "tag" ? 25 : 1)) return { input: m.input, output: m.output, measured: true };
  const g = kind === "tag" ? TAG_GUESS : SEARCH_GUESS;
  return { input: g.input, output: g.output[effort], measured: false };
}

function estimate(kind, model, effort, count = 1) {
  const m = state.settings.models.find((x) => x.id === model);
  const u = usagePer(kind, model, effort);
  return { cost: ((u.input * m.input + u.output * m.output) / 1e6) * count, measured: u.measured };
}

// What tagging n posts costs with the current settings.
export const tagEstimate = (n) =>
  state.settings ? estimate("tag", state.settings.tagModel, state.settings.tagEffort, n).cost : n * 0.0021;

// ---------- rendering ----------

let keyEditing = false;

export async function loadSettings() {
  try { state.settings = await api("/api/settings"); } catch {}
}

function setTheme(t) {
  store.set("tweetstash-theme", t);
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  renderSettings();
}

const segHtml = (values, on) =>
  values.map((v) => `<button type="button" data-v="${v}" class="${v === on ? "on" : ""}">${v[0].toUpperCase() + v.slice(1)}</button>`).join("");

// Every model shows what it would cost at the chosen effort, so they compare at a glance.
function modelOptions(kind, chosen, effort, count, unit) {
  return state.settings.models.map((m) => {
    const note = kind === "tag" ? m.tagNote : m.searchNote;
    const e = estimate(kind, m.id, effort, count);
    return `<button type="button" class="model-opt ${m.id === chosen ? "on" : ""}" data-model="${m.id}">
      <i class="radio"></i><span><b>${esc(m.label)}</b><small>${esc(note)}</small></span>
      <span class="price">${money(e.cost)}<small>${unit}</small></span></button>`;
  }).join("");
}

function renderSettings() {
  const s = state.settings;
  if (!s) return;
  const theme = store.get("tweetstash-theme", "system");
  $$("#set-theme button").forEach((b) => b.classList.toggle("on", b.dataset.v === theme));

  $("#key-ok").hidden = !s.hasKey || keyEditing;
  $("#key-form").hidden = s.hasKey && !keyEditing;
  $("#key-hint").textContent = s.keyHint;

  const claudeCost = estimate("tag", s.tagModel, s.tagEffort, 1000).cost;
  $("#tagger-opts").innerHTML = [
    ["local", "On this computer", "Free and private. Less accurate.", "Free"],
    ["claude", "Claude", "Much better tags. Needs an API key.", money(claudeCost) + "<small>per 1,000</small>"],
  ].map(([v, title, note, price]) => `<button type="button" class="model-opt ${s.tagger === v ? "on" : ""}" data-tagger="${v}">
      <i class="radio"></i><span><b>${title}</b><small>${note}</small></span><span class="price">${price}</span></button>`).join("");
  $("#local-box").hidden = s.tagger !== "local";
  $("#claude-box").hidden = s.tagger !== "claude";
  $("#claude-nokey").hidden = s.hasKey;
  if (s.tagger === "local") renderLocalModel();
  $("#tag-models").innerHTML = modelOptions("tag", s.tagModel, s.tagEffort, 1000, "per 1,000");
  $("#search-models").innerHTML = modelOptions("search", s.searchModel, s.searchEffort, 1, "per search");
  $("#tag-effort").innerHTML = segHtml(s.efforts, s.tagEffort);
  $("#search-effort").innerHTML = segHtml(s.efforts, s.searchEffort);

  const total = state.stats?.total || 1000;
  const t = estimate("tag", s.tagModel, s.tagEffort, total);
  $("#tag-est").innerHTML = `Your whole stash (${total.toLocaleString()}): about <b>${money(t.cost)}</b>${t.measured ? ", from your past runs" : ""}.`;
  const q = estimate("search", s.searchModel, s.searchEffort);
  $("#search-est").innerHTML = `About <b>${money(q.cost)}</b> per search${q.measured ? ", from your past searches" : ""}.`;

  $("#set-nsfw").checked = s.hideNsfw;
  $("#set-voice").value = store.get("tweetstash-voice-lang", "en-US");
}

// One section at a time; the left list switches between them.
export function showSection(sec) {
  $$("#set-nav button").forEach((b) => b.classList.toggle("on", b.dataset.sec === sec));
  $$(".set-body .set-sec").forEach((x) => (x.hidden = x.dataset.sec !== sec));
  $(".set-body").scrollTop = 0;
}

// The local model: downloaded or not, and how fast it'll be here.
async function renderLocalModel() {
  let m;
  try { m = await api("/api/local-model"); } catch { return; }
  const speed = m.gpu ? "About 2 minutes per 1,000 bookmarks." : "About 20 minutes per 1,000 bookmarks (no graphics card found).";
  $("#local-status").textContent = m.state === "loading" && m.total
    ? `Downloading the model… ${Math.round((m.loaded / m.total) * 100)}%`
    : m.downloaded ? `Model downloaded (${m.mb} MB). ${speed}`
    : `Downloads a ${m.mb} MB model the first time. ${speed}`;
  $("#local-remove").hidden = !m.downloaded;
}

async function saveSettings(patch) {
  try { state.settings = await api("/api/settings", patch); } catch (e) { toast(e.message); }
  renderSettings();
  renderTaggingButton();
}

// ---------- actions ----------

async function saveKey(e) {
  e.preventDefault();
  const input = $("#key-input");
  const btn = $("#key-save");
  $("#key-msg").textContent = "";
  btn.disabled = true;
  btn.textContent = "Checking…";
  try {
    state.settings = await api("/api/settings/key", { key: input.value });
    input.value = ""; // don't keep it in the page
    keyEditing = false;
    toast("Key saved");
  } catch (err) {
    $("#key-msg").textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Save key";
    renderSettings();
  }
}

async function removeKey() {
  const ok = await confirmDialog({ title: "Remove your API key?", body: "AI tagging and description search stop working until you add a key again. Your tags stay.", ok: "Remove key", danger: true });
  if (!ok) return;
  try { state.settings = await api("/api/settings/key/remove", {}); } catch (e) { toast(e.message); }
  renderSettings();
}

async function exportJson() {
  const b = $("#set-export");
  b.disabled = true;
  try { downloadJson(await api("/api/export"), `tweetstash-${new Date().toISOString().slice(0, 10)}.json`); }
  catch (e) { toast(e.message); }
  b.disabled = false;
}

// Loads a backup file (or an export from the TweetStash server app) and merges it in.
async function restoreBackup(e) {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const b = $("#set-restore");
  b.disabled = true;
  b.textContent = "Restoring…";
  try {
    const r = await api("/api/import", { data: JSON.parse(await file.text()) });
    toast(`Restored ${r.imported.toLocaleString()} bookmarks (${r.added.toLocaleString()} new)` + (r.partial ? ". Picture descriptions weren't in that file." : ""), 5000);
    await refreshStats();
    load(true);
  } catch (err) {
    toast(err instanceof SyntaxError ? "That file isn't a TweetStash backup." : err.message);
  } finally {
    b.disabled = false;
    b.textContent = "Restore…";
  }
}

// Asks the AI for merges (dry run), shows them, and applies exactly what was shown.
async function tidyTags() {
  const b = $("#tidy-btn");
  b.disabled = true;
  b.textContent = "Looking…";
  try {
    const r = await api("/api/tags/tidy", { dryRun: true });
    if (!r.merges.length) return toast("Tags are already tidy");
    const list = r.merges.slice(0, 40).map((m) => `<li><code>${esc(m.from)}</code> → <code>${esc(m.to)}</code></li>`).join("");
    const ok = await confirmDialog({
      title: `Merge ${r.merges.length} tag${r.merges.length === 1 ? "" : "s"}?`,
      body: `<ul class="merge-list">${list}</ul>${r.merges.length > 40 ? `<p>…and ${r.merges.length - 40} more.</p>` : ""}A backup of the database is saved first.`,
      ok: "Merge tags",
    });
    if (!ok) return;
    b.textContent = "Merging…";
    const done = await api("/api/tags/tidy", { merges: r.merges });
    toast(`Merged: ${done.tagsBefore} tags → ${done.tagsAfter}`);
    await refreshStats();
  } catch (e) {
    toast(e.message);
  } finally {
    b.disabled = false;
    b.textContent = "Tidy tags";
  }
}

// Wires a container of [data-attr] buttons to a handler.
const onPick = (sel, attr, fn) => ($(sel).onclick = (e) => { const b = e.target.closest(`[data-${attr}]`); if (b) fn(b.dataset[attr]); });

export function initSettings() {
  const dlg = $("#settings-dlg");
  document.addEventListener("click", (e) => { if (e.target.closest("[data-open-settings]")) $("#settings-btn").click(); });
  $("#settings-btn").onclick = async () => {
    await loadSettings();
    keyEditing = false;
    $("#key-msg").textContent = "";
    renderSettings();
    dlg.showModal();
  };
  $("#set-close").onclick = () => dlg.close();
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); }); // backdrop
  dlg.addEventListener("close", () => {
    $("#key-input").value = "";
  });

  onPick("#set-theme", "v", setTheme);
  onPick("#tagger-opts", "tagger", (v) => saveSettings({ tagger: v }));
  onPick("#set-nav", "sec", showSection);
  dlg.addEventListener("click", (e) => { const g = e.target.closest("[data-goto]"); if (g) showSection(g.dataset.goto); });
  $("#local-remove").onclick = async () => {
    const ok = await confirmDialog({ title: "Delete the tagging model?", body: "Your tags stay. The model downloads again the next time you tag on this computer.", ok: "Delete model", danger: true });
    if (!ok) return;
    try { await api("/api/local-model/remove", {}); } catch (e) { toast(e.message); }
    renderLocalModel();
  };
  onPick("#tag-models", "model", (m) => saveSettings({ tagModel: m }));
  onPick("#search-models", "model", (m) => saveSettings({ searchModel: m }));
  onPick("#tag-effort", "v", (v) => saveSettings({ tagEffort: v }));
  onPick("#search-effort", "v", (v) => saveSettings({ searchEffort: v }));
  $("#set-nsfw").onchange = async (e) => { await saveSettings({ hideNsfw: e.target.checked }); load(true); };
  $("#set-voice").onchange = (e) => store.set("tweetstash-voice-lang", e.target.value);

  $("#key-replace").onclick = () => { keyEditing = true; renderSettings(); $("#key-input").focus(); };
  $("#key-form").onsubmit = saveKey;
  $("#key-remove").onclick = removeKey;
  $("#set-export").onclick = exportJson;
  $("#set-backup").onclick = async () => {
    try { downloadJson(await api("/api/backup"), `tweetstash-backup-${new Date().toISOString().slice(0, 10)}.json`); }
    catch (e) { toast(e.message); }
  };
  $("#set-restore").onclick = () => $("#restore-file").click();
  $("#restore-file").onchange = restoreBackup;
  $("#tidy-btn").onclick = tidyTags;
}

// AI tagging in the dashboard: the toolbar button and the floating progress window.
//
// The button says "Tag N new" when there's work, shows a progress fill while running (hover + click
// to stop, confirmed in a dialog), and when everything is tagged offers "Re-tag all" behind a confirm.
// The window appears while a run is going and stays to show the result until closed.
import { $, $$, esc, toast, api, money, fmtDuration } from "./util.js";
import { state, clearFilters } from "./state.js";
import { refreshList } from "./feed.js";
import { refreshStats } from "./stats.js";
import { confirmDialog } from "./dialogs.js";
import { tagEstimate, modelLabel } from "./settings.js";

const DOTS = 60;
let panelHiddenFor = null; // startedAt of the run whose window was closed with ×
let sawRun = false; // only show the window once a run has been seen in this tab
let lastTickerText = "";

export async function startTagging(body) {
  try {
    state.stats.job = await api("/api/tagging/start", body);
    renderTaggingButton();
    setTimeout(refreshStats, 800);
  } catch (e) {
    toast(e.message);
  }
}

export function renderTaggingButton() {
  renderPanel();
  const { job, untagged, total, failed } = state.stats;
  const b = $("#ai-btn");
  b.className = "ai-btn";
  b.title = "";
  b.hidden = !total;
  $("#ai-fill").style.width = "0";
  const label = $("#ai-label");
  if (job.running) {
    const n = job.done + job.failed;
    $("#ai-fill").style.width = (job.total ? (n / job.total) * 100 : 0) + "%";
    label.textContent = job.stopping ? "Stopping…" : b.matches(":hover") ? "Stop tagging" : `Tagging ${n.toLocaleString()} / ${job.total.toLocaleString()}`;
    if (!job.stopping) b.classList.add("stoppable");
  } else if (job.fatal) {
    b.classList.add("error");
    label.textContent = "Tagging failed";
    b.title = job.error;
  } else if (failed) {
    b.classList.add("primary");
    label.textContent = `Retry ${failed.toLocaleString()} failed`;
    b.title = job.error || "";
  } else if (untagged) {
    b.classList.add("primary");
    label.textContent = `Tag ${untagged.toLocaleString()} new`;
  } else {
    label.textContent = "All tagged";
    b.title = "Click to re-tag everything";
  }
}

async function onButtonClick() {
  const { job, untagged, total, failed } = state.stats;
  if (job.running) {
    panelHiddenFor = null; // bring the window back
    renderTaggingButton();
    return confirmStop();
  }
  if (failed && !job.fatal) return startTagging({ failed: true });
  if (untagged) return startTagging({});
  const s = state.settings;
  const ok = await confirmDialog({
    title: "Re-tag everything?",
    body: `AI re-reads all <b>${total.toLocaleString()} bookmarks</b> and replaces their AI tags and categories. Tags you added yourself are kept. With your settings (${esc(modelLabel(s?.tagModel))}, ${s?.tagEffort} effort) that costs about <b>${money(tagEstimate(total))}</b>.`,
    ok: "Re-tag all",
  });
  if (ok) startTagging({ all: true });
}

// ---------- stopping ----------

// Live "how many are tagged" line for the stop dialog; kept current while the dialog is open.
function stopCountText(job) {
  const left = Math.max(0, job.total - job.done - job.failed);
  return `<b>${job.done.toLocaleString()} of ${job.total.toLocaleString()}</b> bookmarks are tagged so far. They keep their new tags; the other ${left.toLocaleString()} stay as they are. Batches already in flight (up to 100 bookmarks) finish first.`;
}

async function confirmStop() {
  const job = state.stats?.job;
  if (!job?.running || job.stopping) return;
  const ok = await confirmDialog({ title: "Stop tagging here?", body: `<span id="dlg-stop-count">${stopCountText(job)}</span>`, ok: "Stop tagging", danger: true });
  if (!ok || !state.stats.job.running) return;
  try { state.stats.job = await api("/api/tagging/stop", {}); } catch (e) { toast(e.message); }
  renderTaggingButton();
}

// ---------- the floating window ----------

// Cost of the run so far, at the price of the model it's using.
function jobCost(job) {
  const m = state.settings?.models.find((x) => x.id === job.model) || { input: 4, output: 20 };
  return (job.usage.input * m.input + job.usage.output * m.output) / 1e6;
}

function renderPanel() {
  const job = state.stats?.job;
  const p = $("#tag-panel");
  if (!job) return;
  if (job.running) sawRun = true;
  p.hidden = !sawRun || !job.startedAt || panelHiddenFor === job.startedAt;
  if (p.hidden) return;

  const live = document.getElementById("dlg-stop-count");
  if (live && job.running) live.innerHTML = stopCountText(job);

  const n = job.done + job.failed;
  const finished = !job.running;
  const stopped = finished && (job.stoppedByUser || job.fatal || n < job.total);
  $("#tp-title").textContent = job.running ? (job.stopping ? "Stopping" : "Tagging") : stopped ? "Stopped" : "Tagged";
  $("#tp-done").textContent = n.toLocaleString();
  $("#tp-of").textContent = "/ " + job.total.toLocaleString();
  const cost = jobCost(job);
  $("#tp-cost").textContent = cost >= 0.01 ? "$" + cost.toFixed(2) : "";
  const secs = ((job.finishedAt || Date.now()) - job.startedAt) / 1000;
  $("#tp-time").textContent = fmtDuration(secs);

  // Progress dots, with a few "in flight" ones pulsing ahead of the filled ones.
  const filled = finished && !stopped ? DOTS : Math.floor((job.total ? n / job.total : 0) * DOTS);
  const flying = job.running ? Math.min(4, DOTS - filled) : 0;
  $$(".tp-dots i").forEach((d, i) => {
    const cls = i < filled ? "on" : i < filled + flying ? "fly" : "";
    if (d.className !== cls) d.className = cls;
  });

  // The ticker: the last post tagged, with what it got.
  const last = job.last;
  const row = $("#tp-latest");
  row.hidden = !last || finished;
  if (last && last.text + last.category !== lastTickerText) {
    lastTickerText = last.text + last.category;
    row.querySelector(".tp-txt").textContent = last.text || "(image)";
    row.querySelector(".tp-cat").textContent = [last.category, ...(last.tags || [])].join(" · ");
    row.querySelector(".tp-thumb").style.backgroundImage = last.thumb ? `url("${last.thumb}")` : "";
    row.classList.remove("in"); void row.offsetWidth; row.classList.add("in"); // restart the slide-in
  }

  const eta = job.running && n > 0 && !job.stopping ? fmtDuration((secs / n) * (job.total - n)) : "";
  $("#tp-status").textContent = job.running
    ? job.stopping ? "Finishing the batches in flight…" : eta ? `About ${eta} left` : "Starting…"
    : job.fatal ? job.error
    : stopped ? `Stopped after ${job.done.toLocaleString()}. The rest are unchanged.`
    : job.failed ? `Done. ${job.failed.toLocaleString()} couldn't be tagged.` : "Done. Everything is tagged.";
  $("#tp-show").hidden = job.running || !state.stats.failed;
  $("#tp-stop").hidden = !job.running;
  $("#tp-stop").disabled = !!job.stopping;
}

export function initTagging() {
  const b = $("#ai-btn");
  b.onmouseenter = b.onmouseleave = () => requestAnimationFrame(renderTaggingButton);
  b.onclick = onButtonClick;
  $(".tp-dots").innerHTML = "<i></i>".repeat(DOTS);
  $("#tp-close").onclick = () => { panelHiddenFor = state.stats.job.startedAt; renderPanel(); };
  $("#tp-stop").onclick = confirmStop;
  // "Show them": open the "Couldn't tag" list.
  $("#tp-show").onclick = () => {
    clearFilters();
    state.filters.failed = "1";
    refreshList();
  };
}

// Polls /api/stats: counts, tagging progress, sync activity. Polls faster while something is running.
import { $, toast, api } from "./util.js";
import { state } from "./state.js";
import { load, renderResultLine } from "./feed.js";
import { renderSidebar } from "./sidebar.js";
import { renderTaggingButton } from "./tagging.js";

let lastTotal = null, wasTagging = false, timer = 0;

export async function refreshStats() {
  clearTimeout(timer);
  try {
    state.stats = await api("/api/stats");
  } catch {
    $("#total-sub").textContent = "starting…";
    $("#total-sub").hidden = false;
    timer = setTimeout(refreshStats, 5000);
    return;
  }
  renderSidebar();
  renderTaggingButton();
  const s = state.stats;
  const syncing = Object.values(s.syncs).some((x) => Date.now() - x.last < 15000);
  // New captures arrived: reload the feed if the user is near the top, otherwise just tell them.
  if (lastTotal !== null && s.total !== lastTotal) {
    if (window.scrollY < 400) load(true);
    else toast(`${(s.total - lastTotal).toLocaleString()} new bookmarks captured`);
  }
  // Tagging finished: reload so new tags show on cards.
  if (wasTagging && !s.job.running) {
    load(true);
    toast(s.job.stoppedByUser ? "Tagging stopped" : s.job.failed ? `Tagging done, ${s.job.failed} failed` : "Tagging done ✦");
  }
  if (lastTotal === null) renderResultLine();
  lastTotal = s.total;
  wasTagging = s.job.running;
  timer = setTimeout(refreshStats, s.job.running ? 1500 : syncing ? 2500 : 8000);
}

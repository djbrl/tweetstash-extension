// Polls /api/stats: counts, tagging progress, sync activity. Polls faster while something is running.
import { $, toast, api } from "./util.js";
import { state } from "./state.js";
import { load, renderResultLine } from "./feed.js";
import { renderSidebar } from "./sidebar.js";
import { renderTaggingButton } from "./tagging.js";

let lastTotal = null, wasTagging = false, timer = 0, lastLearned = null;

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
  // It learned from your fixes and moved some posts: say so (the feed isn't reloaded under you).
  const l = s.learning;
  if (l?.at && lastLearned !== null && l.at !== lastLearned && l.moved) toast(`Learned from your fixes: ${l.moved.toLocaleString()} post${l.moved === 1 ? "" : "s"} re-sorted`);
  if (l) lastLearned = l.at;
  if (lastTotal === null) renderResultLine();
  lastTotal = s.total;
  wasTagging = s.job.running;
  timer = setTimeout(refreshStats, s.job.running ? 1500 : syncing ? 2500 : 8000);
}

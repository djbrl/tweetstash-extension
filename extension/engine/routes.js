// The engine's API: the same routes as the TweetStash server app, called over extension messaging
// instead of HTTP. Each route gets (body, url, signal) and returns what's sent back.
import { CATEGORIES } from "./catalog.js";
import { query, stats, pageMap, exportAll } from "./db/bookmarks.js";
import { setUserTags } from "./db/tags.js";
import { backupAll, importBackup } from "./db/backup.js";
import { settings, publicSettings, updateSettings, setApiKey, removeApiKey } from "./services/settings.js";
import { job, startTagging, stopTagging } from "./services/tagging.js";
import { search } from "./services/search.js";
import { model, modelInfo, loadModel, removeModel } from "./services/local.js";
import { tidyTags } from "./services/tag-tidy.js";
import { setUserCategory, nextRound, answer, applyTag, teachStatus, forget, resetCategories, learning } from "./services/personal.js";
import { syncs, receive, empty, validateAccount, historyDone, markHistoryDone } from "./services/sync.js";

export const routes = {
  // ---------- browsing ----------
  "GET /api/stats": () => ({ ...stats(), categories_all: CATEGORIES, job, syncs, learning }),
  "GET /api/bookmarks": (body, url) => {
    const p = Object.fromEntries(url.searchParams);
    // "Hide NSFW" applies to browsing; picking a category (the NSFW one included) still shows it.
    return query({ ...p, hideNsfw: settings().hideNsfw && !p.category });
  },
  "POST /api/tags": (body) => {
    setUserTags(String(body.id), Array.isArray(body.tags) ? body.tags.map(String) : []);
    return { ok: true };
  },
  // Your own category for a post (null: let the tagger decide again). The local tagger learns from it.
  "POST /api/category": (body) => setUserCategory(String(body.id), body.category ?? null),
  "GET /api/export": () => exportAll(),
  "GET /api/backup": () => backupAll(),
  "POST /api/import": (body) => importBackup(body.data),

  // ---------- capture (from X tabs, via the background worker) ----------
  "POST /api/ingest": (body) => receive(body.account, body.payload),
  "GET /api/pagemap": (body, url) => pageMap(validateAccount(url.searchParams.get("account"))),
  "GET /api/capture/status": (body, url) => {
    const account = validateAccount(url.searchParams.get("account"));
    return { count: stats().accounts.find((a) => a.name === account)?.n || 0, historyDone: historyDone(account) };
  },
  "POST /api/capture/history-done": (body) => markHistoryDone(validateAccount(body.account)),
  "POST /api/empty": (body) => empty(body.account),

  // ---------- AI tagging ----------
  "POST /api/tagging/start": (body) => startTagging(body),
  "POST /api/tagging/stop": () => stopTagging(),
  "POST /api/tags/tidy": (body) => tidyTags(body),

  // ---------- the local tagger's model ----------
  "GET /api/local-model": () => modelInfo(),
  "POST /api/local-model/download": () => { loadModel().catch(() => {}); return model; },
  "POST /api/local-model/remove": () => removeModel(),

  // ---------- teaching the local tagger (personal.js) ----------
  "GET /api/teach/status": () => teachStatus(),
  "POST /api/teach/next": (body) => nextRound(body.kind, body.label),
  "POST /api/teach/answer": (body) => answer(body.kind, body.label, body.answers),
  "POST /api/teach/apply": (body) => applyTag(body.label),
  "POST /api/teach/forget": (body) => forget(body.kind, body.label),
  "POST /api/teach/reset-categories": () => resetCategories(),

  // ---------- search ----------
  // The dashboard's Stop button aborts the AI calls so they aren't billed further.
  "POST /api/ask": (body, url, signal) => search(body, signal),

  // ---------- settings ----------
  "GET /api/settings": () => publicSettings(),
  "POST /api/settings": (body) => updateSettings(body),
  "POST /api/settings/key": (body) => setApiKey(body.key),
  "POST /api/settings/key/remove": () => removeApiKey(),
};

// Which routes each caller may use. X tabs are untrusted pages: their content script only gets capture.
export const CAPTURE_ROUTES = new Set(["POST /api/ingest", "GET /api/pagemap", "GET /api/capture/status", "POST /api/capture/history-done"]);

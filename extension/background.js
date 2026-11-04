// The background service worker: the switchboard. It
//  - watches X's own bookmarks request and hands its URL + headers to the capture script in that tab,
//  - starts the engine (offscreen document) and forwards requests to it, deciding who may call what:
//    the dashboard (this extension's own page) gets the full API, X tabs only get capture.
// It holds no data itself; Chrome stops it when idle and it restarts on the next message.
const IS_BOOKMARKS = /^\/i\/api\/graphql\/[^/]+\/(Bookmarks|BookmarkFolderTimeline)$/;
// Explicitly copy only replay headers, never Cookie or arbitrary browser/request credentials.
const REPLAY_HEADERS = /^(authorization|x-csrf-token|x-twitter-auth-type|x-twitter-active-user|x-twitter-client-language|x-client-transaction-id|accept|content-type)$/i;
const DASHBOARD = chrome.runtime.getURL("dashboard/index.html");
const CAPTURE_ROUTES = new Set(["POST /api/ingest", "GET /api/pagemap", "GET /api/capture/status", "POST /api/capture/history-done"]);

function isX(url) {
  try { return ["https://x.com", "https://twitter.com"].includes(new URL(url).origin); }
  catch { return false; }
}

// ---------- the engine ----------

let creating = null;
async function ensureEngine() {
  const url = chrome.runtime.getURL("engine/offscreen.html");
  const open = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
  if (open.length) return;
  creating ||= chrome.offscreen.createDocument({
    url, reasons: ["WORKERS"], justification: "Runs the bookmark database and AI tagging in a worker.",
  }).finally(() => { creating = null; });
  await creating;
}

async function engine(method, path, body, ref) {
  await ensureEngine();
  const r = await chrome.runtime.sendMessage({ target: "engine", method, path, body, ref });
  if (!r) throw new Error("TweetStash's engine didn't answer. Try again.");
  return r;
}

// ---------- X: spot the bookmarks request ----------

chrome.webRequest.onBeforeSendHeaders.addListener(
  (d) => {
    if (d.tabId < 0 || !isX(d.url) || !IS_BOOKMARKS.test(new URL(d.url).pathname)) return;
    if (d.requestHeaders?.some((h) => h.name.toLowerCase() === "x-tweetstash-replay")) return;
    const headers = {};
    for (const h of d.requestHeaders || []) if (REPLAY_HEADERS.test(h.name)) headers[h.name.toLowerCase()] = h.value;
    chrome.tabs.sendMessage(d.tabId, { type: "bookmarks-request", url: d.url, headers }).catch(() => {});
  },
  { urls: ["https://x.com/i/api/graphql/*", "https://twitter.com/i/api/graphql/*"] },
  ["requestHeaders"]
);

// ---------- messages ----------

const openDashboard = () => chrome.tabs.create({ url: DASHBOARD });
chrome.action.onClicked.addListener(openDashboard);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg || typeof msg !== "object" || msg.target) return;
  const fromDashboard = sender.url?.startsWith(chrome.runtime.getURL("dashboard/"));
  const fromX = sender.tab && sender.frameId === 0 && isX(sender.url);

  // The dashboard: the full API.
  if (fromDashboard) {
    if (msg.type === "abort") { chrome.runtime.sendMessage({ target: "engine-abort", ref: msg.ref }).catch(() => {}); return; }
    if (msg.type !== "api") return;
    engine(msg.method, msg.path, msg.body, msg.ref).then(sendResponse, (e) => sendResponse({ ok: false, error: e.message, status: 500 }));
    return true;
  }

  // X tabs: capture only (and opening the dashboard). Page content is untrusted.
  if (!fromX) return;
  const capture = (method, path, body) => {
    if (!CAPTURE_ROUTES.has(`${method} ${new URL(path, "https://x.invalid").pathname}`)) return sendResponse(null);
    engine(method, path, body).then(
      (r) => sendResponse(r.ok ? { ok: true, ...r.result } : { ok: false, error: r.error }),
      (e) => sendResponse({ ok: false, error: e.message }));
  };
  if (msg.type === "open-app") { openDashboard(); return; }
  if (msg.type === "ingest") {
    capture("POST", "/api/ingest", { account: msg.account, payload: msg.payload });
    return true;
  }
  if (msg.type === "history-done") {
    capture("POST", "/api/capture/history-done", { account: msg.account });
    return true;
  }
  if (msg.type === "pagemap" || msg.type === "stats") {
    const path = (msg.type === "pagemap" ? "/api/pagemap" : "/api/capture/status") + "?account=" + encodeURIComponent(msg.account);
    engine("GET", path).then((r) => sendResponse(r.ok ? r.result : null), () => sendResponse(null));
    return true;
  }
});

// Chrome doesn't run a reloaded/updated extension's content scripts in tabs that are already open.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
  for (const tab of tabs) chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["capture/inject.js", "capture/relay.js"] }).catch(() => {});
  if (reason === "install") openDashboard();
});

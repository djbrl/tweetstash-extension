// End-to-end test in a real Chromium with the extension loaded, using synthetic data only (no X login,
// no AI calls). Needs playwright-core and a Chromium build that allows --load-extension:
//   PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs CHROME_PATH=/path/to/Chromium npm test
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright-core");
const extension = path.resolve("extension");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tweetstash-ext-test-"));
let count = 0;
const check = (name, fn) => { fn(); console.log(`PASS ${++count}: ${name}`); };

const launch = async () => {
  const context = await chromium.launchPersistentContext(profile, {
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 10000 }));
  const id = new URL(worker.url()).host;
  return { context, worker, dashboardUrl: `chrome-extension://${id}/dashboard/index.html` };
};

const errors = [];
const watch = (page) => {
  page.on("pageerror", (e) => errors.push(`${page.url()}: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${page.url()}: ${m.text()}`); });
};
// Calls the engine the way the dashboard does.
const api = (page, method, p, body) => page.evaluate(([method, path, body]) => chrome.runtime.sendMessage({ type: "api", method, path, body, ref: "t" + Math.random() }), [method, p, body]);

const tweet = (id, text, handle = "audit") => ({ entryId: `tweet-${id}`, sortIndex: String(1800000000000000000n + BigInt(id)), content: { itemContent: { tweet_results: { result: {
  rest_id: id, legacy: { full_text: text, created_at: "Wed Oct 01 12:00:00 +0000 2025", entities: {} },
  core: { user_results: { result: { legacy: { screen_name: handle, name: "Audit" } } } } } } } } });

// A fake X that pages like the real one: each page ends with a cursor encoding the sortIndex to continue
// below, and turbo sync's hand-made cursors work too. `list` is newest first: [{ id, si, text }].
const encodeCursor = (si) => {
  let v = (si << 1n) ^ (si >> 63n);
  const b = [0x1c, 0x16];
  while (v >= 0x80n) { b.push(Number(v & 0x7fn) | 0x80); v >>= 7n; }
  b.push(Number(v), 0, 0);
  return Buffer.from(b).toString("base64");
};
const decodeCursor = (c) => {
  const b = Buffer.from(c, "base64");
  let v = 0n, shift = 0n;
  for (let i = 2; i < b.length; i++) { v |= BigInt(b[i] & 0x7f) << shift; shift += 7n; if (!(b[i] & 0x80)) break; }
  return (v >> 1n) ^ -(v & 1n);
};
async function fakeX(page, handle, list) {
  await page.route("https://x.com/**", (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.includes("/i/api/graphql/")) {
      return route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><a data-testid="AppTabBar_Profile_Link" href="/${handle}">${handle}</a><p>Synthetic X page</p>` });
    }
    const vars = JSON.parse(url.searchParams.get("variables") || "{}");
    const below = vars.cursor ? decodeCursor(vars.cursor) : null;
    const items = list.filter((t) => below === null || t.si < below).slice(0, Number(vars.count) || 20);
    const entries = items.map((t) => ({ ...tweet(t.id, t.text || "Bookmark " + t.id, handle), sortIndex: String(t.si) }));
    if (items.length) entries.push({ entryId: "cursor-bottom-" + items.at(-1).si, content: { value: encodeCursor(items.at(-1).si) } });
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { bookmark_timeline_v2: { timeline: { instructions: [{ type: "TimelineAddEntries", entries }] } } } }) });
  });
  await page.goto("https://x.com/i/bookmarks");
  await page.waitForSelector("#tweet-nest-panel");
}
// What the background worker does when X's page loads its bookmarks: hand the request to the panel.
const xLoadsBookmarks = (worker, tabId) => worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { type: "bookmarks-request", url: "https://x.com/i/api/graphql/audit/Bookmarks?variables={}", headers: { authorization: "Bearer SYNTHETIC" } }), tabId);

try {
  let { context, worker, dashboardUrl } = await launch();

  // ---------- dashboard starts, engine works ----------
  const dash = await context.newPage();
  watch(dash);
  await dash.goto(dashboardUrl);
  await dash.waitForSelector("#empty:not([hidden])", { timeout: 20000 });
  check("dashboard opens on an empty stash", () => {});
  const settings = await api(dash, "GET", "/api/settings");
  check("engine answers with settings, and no key yet", () => { assert.equal(settings.ok, true); assert.equal(settings.result.hasKey, false); });

  // ---------- capture from a (fixture) X page ----------
  const xpage = await context.newPage();
  watch(xpage);
  await fakeX(xpage, "audit", [
    { id: "333333333", si: 1800000000333333333n, text: "Genuine synthetic network bookmark about an osprey painting" },
    { id: "444444444", si: 1800000000222222222n, text: "Second synthetic bookmark <img src=x onerror=window.pwned=1>" },
  ]);
  const pageWorld = await xpage.evaluate(() => ({ runtime: typeof window.chrome?.runtime?.sendMessage, bridge: typeof window.tweetstashCapture }));
  check("X page scripts can't reach the extension", () => { assert.equal(pageWorld.runtime, "undefined"); assert.equal(pageWorld.bridge, "undefined"); });
  const tabs = await worker.evaluate(() => chrome.tabs.query({ url: "https://x.com/*" }));
  await xLoadsBookmarks(worker, tabs[0].id);
  await xpage.waitForTimeout(500);
  const before = (await api(dash, "GET", "/api/stats")).result.total;
  const collapsed = await xpage.evaluate(() => document.querySelector("#tweet-nest-panel").classList.contains("tn-min"));
  check("the panel appears expanded", () => assert.equal(collapsed, false));
  const label = await xpage.locator("#tn-sync-label").innerText();
  if (process.env.SCREENSHOT) await xpage.locator("#tweet-nest-panel").screenshot({ path: process.env.SCREENSHOT.replace(/\.png$/, "-first.png") });
  check("opening the bookmarks page saves nothing until you click Sync", () => { assert.equal(before, 0); assert.equal(label.trim(), "Sync"); });
  const goVisible = await xpage.locator("#tn-go").isVisible();
  check("Go to my stash is next to Sync", () => assert.equal(goVisible, true));
  await xpage.locator("#tn-sync").click();
  let stats;
  for (let i = 0; i < 60; i++) {
    stats = (await api(dash, "GET", "/api/stats")).result;
    if (stats.total >= 2) break;
    await dash.waitForTimeout(250);
  }
  check("bookmarks captured on X land in the extension's database", () => assert.equal(stats.total, 2));
  check("captures remember the X account", () => assert.deepEqual(stats.accounts, [{ name: "@audit", n: 2 }]));

  // ---------- dashboard shows them; search works ----------
  await dash.reload();
  await dash.waitForSelector(".card");
  const cards = await dash.locator(".card").allTextContents();
  check("dashboard shows captured bookmarks", () => assert.ok(cards.some((t) => t.includes("osprey painting"))));
  const pwned = await dash.evaluate(() => window.pwned);
  check("captured HTML renders as text", () => assert.equal(pwned, undefined));
  const found = (await api(dash, "GET", "/api/bookmarks?q=osprey")).result;
  check("keyword search finds by word prefix", () => assert.deepEqual(found.items.map((t) => t.id), ["333333333"]));
  await api(dash, "POST", "/api/tags", { id: "333333333", tags: ["Birds", "painting"] });
  const tagged = (await api(dash, "GET", "/api/bookmarks?tag=birds")).result;
  check("tags can be edited and filtered", () => assert.equal(tagged.total, 1));
  const ask = await api(dash, "POST", "/api/ask", { q: "the bird painting" });
  check("description search without a key explains what's missing", () => { assert.equal(ask.ok, false); assert.match(ask.error, /API key/); });

  // ---------- backup, empty, restore ----------
  const backup = (await api(dash, "GET", "/api/backup")).result;
  check("backup holds posts, saves and tags", () => { assert.equal(backup.tweets.length, 2); assert.equal(backup.saves.length, 2); assert.equal(backup.tags.length, 2); });
  await api(dash, "POST", "/api/empty", {});
  const emptied = (await api(dash, "GET", "/api/stats")).result.total;
  check("empty clears the stash", () => assert.equal(emptied, 0));
  const evil = structuredClone(backup);
  evil.tweets[0].author_avatar = "https://attacker.invalid/track.png";
  evil.tweets[0].urls = JSON.stringify([{ url: "javascript:alert(1)" }]);
  evil.saves.push({ tweet_id: "333333333", account: "__proto__" });
  const restored = (await api(dash, "POST", "/api/import", { data: evil })).result;
  check("restore brings everything back", () => assert.deepEqual(restored, { imported: 2, added: 2, partial: false }));
  const untagged = (await api(dash, "GET", "/api/stats")).result.untagged;
  check("restore keeps never-tagged posts untagged", () => assert.equal(untagged, 2));
  const after = (await api(dash, "GET", "/api/export")).result.find((t) => t.id === "333333333");
  check("restore keeps tags and accounts", () => { assert.deepEqual(after.tags, ["birds", "painting"]); assert.deepEqual(after.accounts, ["@audit"]); });
  check("restore strips tracking images and script links", () => { assert.equal(after.author_avatar, ""); assert.deepEqual(after.urls, []); });
  const bad = await api(dash, "POST", "/api/import", { data: { hello: "world" } });
  check("restore refuses files that aren't backups", () => assert.equal(bad.ok, false));
  const serverExport = [{ id: "555555555", author_handle: "other", author_name: "Other", text: "From the server app", media: [], urls: [], tags: ["art"], accounts: ["@me"], category: null }];
  const fromServer = (await api(dash, "POST", "/api/import", { data: serverExport })).result;
  check("restore reads the TweetStash server app's export", () => assert.deepEqual(fromServer, { imported: 1, added: 1, partial: true }));

  // ---------- data survives a browser restart ----------
  await context.close();
  ({ context, worker, dashboardUrl } = await launch());
  const again = await context.newPage();
  watch(again);
  await again.goto(dashboardUrl);
  await again.waitForSelector(".card", { timeout: 20000 });
  const total = (await api(again, "GET", "/api/stats")).result.total;
  check("the stash survives closing and reopening the browser", () => assert.equal(total, 3));

  // ---------- settings ----------
  const bogus = await api(again, "POST", "/api/settings/key", { key: "not-a-key" });
  check("a malformed API key is refused before any network call", () => { assert.equal(bogus.ok, false); assert.match(bogus.error, /sk-ant-/); });
  // A well-formed but fake key: proves the engine reaches api.anthropic.com from the browser (a free call).
  const fake = await api(again, "POST", "/api/settings/key", { key: "sk-ant-api03-" + "x".repeat(40) });
  check("the engine reaches Anthropic from inside the browser", () => { assert.equal(fake.ok, false); assert.match(fake.error, /didn't accept/); });
  const saved = (await api(again, "POST", "/api/settings", { hideNsfw: true, tagModel: "evil-model" })).result;
  check("settings save, and unknown models are ignored", () => { assert.equal(saved.hideNsfw, true); assert.equal(saved.tagModel, "claude-opus-5-5"); });

  // ---------- full history sync on a long list ----------
  // A fake X with 300 bookmarks that pages like the real one: cursors encode the sortIndex to continue
  // below, and turbo's hand-made cursors work too. Opening the page stores X's first page by itself;
  // Sync must still fetch the whole history, and only then switch to "just what's new".
  const list = Array.from({ length: 300 }, (_, i) => ({ id: String(700000000 + i), si: 1900000000000000000n - BigInt(i) * 1000n }));
  const xLong = await context.newPage();
  watch(xLong);
  await fakeX(xLong, "longlist", list);
  const longCount = async () => (await api(again, "GET", "/api/capture/status?account=%40longlist")).result;
  const waitFor = async (pred) => { for (let i = 0; i < 120; i++) { const r = await longCount(); if (pred(r)) return r; await again.waitForTimeout(250); } return longCount(); };
  const xTab = (await worker.evaluate(() => chrome.tabs.query({ url: "https://x.com/*" }))).at(-1);
  await xLoadsBookmarks(worker, xTab.id);
  await xLong.waitForTimeout(500);
  await xLong.locator("#tn-sync").click();
  const full = await waitFor((r) => r.count >= 300 && r.historyDone);
  check("Sync fetches the whole history of a long list", () => { assert.equal(full.count, 300); assert.equal(full.historyDone, true); });
  await xLong.waitForFunction(() => document.querySelector("#tn-sync-label")?.textContent === "Update", null, { timeout: 5000 });
  check("once the history is in, the button says Update", () => {});
  // New bookmarks at the top: the next Sync only fetches what's new.
  list.unshift(...Array.from({ length: 5 }, (_, i) => ({ id: String(800000000 + i), si: 1900000000000000000n + BigInt(5 - i) * 1000n })));
  await xLong.waitForTimeout(500);
  if (process.env.SCREENSHOT) await xLong.locator("#tweet-nest-panel").screenshot({ path: process.env.SCREENSHOT.replace(/\.png$/, "-update.png") });
  if (process.env.SCREENSHOT) await xLong.locator("#tweet-nest-panel").screenshot({ path: process.env.SCREENSHOT.replace(/\.png$/, "-collapsed.png") });
  await xLong.locator("#tn-sync").click();
  const caught = await waitFor((r) => r.count >= 305);
  if (process.env.SCREENSHOT) await xLong.locator("#tweet-nest-panel").screenshot({ path: process.env.SCREENSHOT.replace(/\.png$/, "-expanded.png") });
  check("after that, Update picks up new bookmarks", () => assert.equal(caught.count, 305));

  if (process.env.SCREENSHOT) { await again.setViewportSize({ width: 1280, height: 800 }); await again.reload(); await again.waitForSelector(".card"); await again.waitForTimeout(1500); await again.screenshot({ path: process.env.SCREENSHOT }); }
  const real = errors.filter((e) => !/AbortError|net::ERR|favicon/.test(e));
  check("no uncaught errors in the dashboard or capture", () => assert.deepEqual(real, []));
  await context.close();
  console.log(`\n${count} checks passed.`);
} finally {
  fs.rmSync(profile, { recursive: true, force: true });
}

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
  const payload = { data: { bookmark_timeline_v2: { timeline: { instructions: [{ type: "TimelineAddEntries", entries: [
    tweet("333333333", "Genuine synthetic network bookmark about an osprey painting"),
    tweet("444444444", "Second synthetic bookmark <img src=x onerror=window.pwned=1>"),
  ] }] } } } };
  await xpage.route("https://x.com/**", (route) => route.request().url().includes("/i/api/graphql/")
    ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) })
    : route.fulfill({ status: 200, contentType: "text/html", body: '<!doctype html><a data-testid="AppTabBar_Profile_Link" href="/audit">Audit</a><p>Synthetic X page</p>' }));
  await xpage.goto("https://x.com/i/bookmarks");
  await xpage.waitForSelector("#tweet-nest-panel");
  const pageWorld = await xpage.evaluate(() => ({ runtime: typeof window.chrome?.runtime?.sendMessage, bridge: typeof window.tweetstashCapture }));
  check("X page scripts can't reach the extension", () => { assert.equal(pageWorld.runtime, "undefined"); assert.equal(pageWorld.bridge, "undefined"); });
  const tabs = await worker.evaluate(() => chrome.tabs.query({ url: "https://x.com/*" }));
  await worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { type: "bookmarks-request", url: "https://x.com/i/api/graphql/audit/Bookmarks?variables={}", headers: { authorization: "Bearer SYNTHETIC" } }), tabs[0].id);
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

  if (process.env.SCREENSHOT) { await again.setViewportSize({ width: 1280, height: 800 }); await again.reload(); await again.waitForSelector(".card"); await again.waitForTimeout(1500); await again.screenshot({ path: process.env.SCREENSHOT }); }
  const real = errors.filter((e) => !/AbortError|net::ERR|favicon/.test(e));
  check("no uncaught errors in the dashboard or capture", () => assert.deepEqual(real, []));
  await context.close();
  console.log(`\n${count} checks passed.`);
} finally {
  fs.rmSync(profile, { recursive: true, force: true });
}

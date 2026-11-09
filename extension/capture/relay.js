// Isolated-world content script: receives captured pages from inject.js, sends them to the
// background worker, and draws a small control panel on the bookmarks page.
(() => {
  // found: unique bookmarks seen this run. added: ones tweetstash didn't have yet.
  // known: how many tweetstash already holds for this account (sets the progress bar's scale).
  // catchup: this run only looks for bookmarks newer than the stash (base = stash size at start).
  // upToDateAt: when a page X loaded on its own showed nothing new, so Sync can answer instantly.
  // historyDone: a full history sync has finished for this account. Until then, having some bookmarks
  // (X loads its first pages by itself when you open the list) says nothing about the older ones.
  const capture = globalThis.tweetstashCapture;
  const state = { historyDone: false, catchup: false, base: 0, upToDateAt: 0, complete: false, found: new Set(), added: 0, known: 0, progress: null, mode: null, quietPages: 0, lastPageAt: 0, startedAt: 0, error: null, status: "Waiting for bookmarks to load…" };
  const shown = { found: 0, added: 0 }; // what the counters display, eased toward the real values
  let panel;
  let scrollTimer = null;
  let lastAccount = null;

  function account() {
    const a = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    const handle = a?.getAttribute("href")?.replace(/^\//, "");
    return handle ? "@" + handle : "unknown";
  }

  // After the extension is reloaded or updated, this copy of the script keeps running in tabs that
  // were already open, but it can no longer talk to the extension. Detect that and retire quietly
  // instead of throwing "Extension context invalidated" on every page X loads.
  let dead = false;
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  function send(msg, cb) {
    if (!alive()) return retire();
    try { chrome.runtime.sendMessage(msg, cb); } catch { retire(); }
  }
  function retire() {
    if (dead) return;
    dead = true;
    clearInterval(routeTimer);
    clearInterval(scrollTimer);
    capture.subscribe(() => {});
    if (!panel) return;
    state.mode = null;
    state.complete = false;
    panel.querySelectorAll("button").forEach((b) => { if (b.id !== "tn-fold") b.disabled = true; });
    setStatus("tweetstash was updated. Refresh the page to keep going.");
  }

  const cmd = (c, extra = {}) => capture.command(c, extra);
  const onBookmarksPage = () => location.pathname === "/i/history" || location.pathname.startsWith("/i/bookmarks");

  // The background worker saw X's own bookmarks request: pass its URL + headers to inject.js.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "bookmarks-request") cmd("request", { url: msg.url, headers: msg.headers });
  });

  function onCaptureMessage(m) {
    if (m.type === "capture-error") return setStatus(`Capture failed: ${m.error}`);
    if (m.type === "page") return onPage(m);
    if (m.type === "request-seen" && !state.mode) setStatus(readyText());
    if (m.type === "fast-started" && state.mode) setStatus(m.turbo ? "Fetching your whole history…" : state.catchup ? "Checking for new bookmarks…" : "Syncing…");
    if (m.type === "fast-wait") setStatus(`Rate limited by X, resuming in ${m.seconds}s…`);
    if (m.type === "fast-failed" && state.mode === "turbo") {
      setStatus(`Turbo unavailable (${m.reason}), using normal sync…`);
      state.mode = "fast";
      cmd("fast");
      return;
    }
    if (m.type === "fast-failed") {
      finish(`Capture unavailable (${m.reason}). Refresh X and try again.`);
    }
    if (m.type === "fast-done" && state.mode) {
      if (m.error) return finish(`Stopped: ${m.error}`);
      // Only a finished turbo run covers the whole list (plain sync can stop at X's ~1,000-item limit).
      if (m.complete) { state.historyDone = true; send({ type: "history-done", account: account() }); }
      finish(!state.catchup ? "Done. Everything's in your stash." : state.added ? savedText() : UP_TO_DATE);
    }
  }
  capture.subscribe(onCaptureMessage);

  const idsIn = (payload) => payload.domTweets
    ? payload.domTweets.map((t) => t.id)
    : [...JSON.stringify(payload).matchAll(/"entryId":"tweet-(\d+)"/g)].map((x) => x[1]);

  function onPage(m) {
    state.lastPageAt = Date.now();
    // Pages still in flight when a run ends get stored, but don't move the counter or the card.
    const late = !state.mode && state.complete;
    const run = state.mode; // which run this page belongs to; its save can finish after the run has ended
    // Count what we found right away; "new" fills in when the app confirms.
    if (!late) {
      (m.ids || idsIn(m.payload)).forEach((id) => state.found.add(id));
      showLatest(latestOf(m.payload));
    }
    if (m.stats?.progress != null) state.progress = Math.max(state.progress || 0, m.stats.progress);
    render();
    send({ type: "ingest", account: account(), payload: m.payload }, (r) => {
      if (chrome.runtime.lastError || !r?.ok) {
        state.error = r?.error || chrome.runtime.lastError?.message || "unknown error";
        setStatus(state.error);
        return;
      }
      state.error = null;
      if (late) return;
      if (run) state.added += r.added;
      else if (r.seen) {
        // X loaded a page on its own (page load / scrolling): store it quietly.
        if (r.added) { state.known += r.added; state.upToDateAt = 0; }
        else if (state.known && state.historyDone) { state.upToDateAt = Date.now(); setStatus(UP_TO_DATE); }
      }
      // Sync-new mode: X lists newest first, so the first page containing something tweetstash
      // already has means everything below it is already stored.
      if (run === "fast" && state.mode === "fast" && state.catchup && r.added < r.seen) {
        stop();
        finish(state.added ? savedText() : UP_TO_DATE);
        state.upToDateAt = Date.now();
      }
      render();
    });
  }

  const UP_TO_DATE = "All your bookmarks are already saved.";
  const savedText = () => `Saved ${state.added.toLocaleString()} new bookmark${state.added === 1 ? "" : "s"}.`;
  const readyText = () => state.upToDateAt ? UP_TO_DATE : state.historyDone ? "Ready. Update grabs anything new." : "Ready. Sync grabs your whole history.";

  function refreshKnown() {
    send({ type: "stats", account: account() }, (r) => {
      state.known = r?.count || 0;
      state.historyDone = !!r?.historyDone;
      if (!state.mode && state.status.startsWith("Ready")) state.status = readyText(); // the total can land after the status
      render();
    });
  }

  function resetRun() {
    const txt = panel?.querySelector("#tn-latest .tn-txt");
    if (txt) txt.textContent = ""; // the ticker starts empty and fills with this run's tweets
    state.found = new Set();
    state.added = 0;
    state.quietPages = 0;
    state.progress = null;
    state.complete = false;
    state.startedAt = Date.now();
    shown.found = shown.added = 0;
  }

  // Sync: once this account's whole history is in, only fetch what's new (usually one request).
  // Until then (or with "full"), run Turbo over the whole history.
  function startSync(full) {
    resetRun();
    state.catchup = !full && state.known > 0 && state.historyDone;
    state.base = state.known;
    shown.found = state.catchup ? state.known : 0;
    // X just showed us its newest page and we had all of it: nothing to fetch.
    if (state.catchup && Date.now() - state.upToDateAt < 5 * 60e3) {
      state.complete = true;
      setStatus(UP_TO_DATE);
      return;
    }
    state.mode = state.catchup ? "fast" : "turbo";
    if (state.mode === "turbo") {
      // Once the whole history is in, what we know lets turbo skip the probing and cut one-page slices.
      // Before that, the stored bookmarks may be just the newest few, so turbo probes for the bottom.
      if (state.historyDone) send({ type: "pagemap", account: account() }, (map) => cmd("turbo", { map }));
      else cmd("turbo", { map: null });
      render();
      return;
    }
    cmd("fast");
    render();
  }

  function stop() {
    cmd("stop");
    clearInterval(scrollTimer);
    scrollTimer = null;
    state.mode = null;
    render();
  }

  function finish(msg) {
    state.complete = !/^Stopped/.test(msg);
    refreshKnown();
    clearInterval(scrollTimer);
    scrollTimer = null;
    state.mode = null;
    setStatus(msg);
  }

  function setStatus(s) {
    state.status = s;
    render();
  }

  const DOTS = 60;
  let raf = 0;
  let dotEls = [];
  function render() {
    if (!panel) return;
    const $ = (sel) => panel.querySelector(sel);
    $("#tn-acct").textContent = account();
    $("#tn-status").textContent = state.status;
    $("#tn-title").textContent = state.mode ? (state.catchup ? "Checking" : "Stashing") : state.complete ? "Stashed" : "tweetstash";
    const found = state.found.size;
    // Turbo reports true progress (how much of the history range is covered); otherwise compare
    // against what tweetstash already holds for this account.
    const frac = state.progress != null ? state.progress : state.known > 0 && found <= state.known ? found / state.known : null;
    // Idle: the big number is what's already in your stash. While syncing: found so far / stash size.
    const idle = !state.mode && !state.complete;
    $("#tn-of").textContent = idle || state.catchup ? (state.known ? "stashed" : "") : state.known ? "/ " + Math.max(state.known, found).toLocaleString() : "";
    // Dots: one per slice of your history. Black = stashed, orange = being fetched right now.
    let done, flying;
    // Idle with a stash, or finished: all black. A catch-up only touches the newest end, so it
    // keeps the dots black and blinks the first few; a full sync fills them from empty.
    if (!state.mode) { done = state.complete || state.known ? DOTS : 0; flying = 0; }
    else if (state.catchup) { done = 0; flying = 4; }
    else if (frac != null) { done = Math.min(DOTS, Math.floor(frac * DOTS)); flying = Math.min(6, DOTS - done); }
    else { done = Math.min(DOTS - 1, Math.floor(found / 96)); flying = 1; }
    const catchup = state.mode && state.catchup;
    dotEls.forEach((d, i) => {
      const cls = catchup ? (i < flying ? "fly" : "on") : i < done ? "on" : i < done + flying ? "fly" : "";
      if (d.className !== cls) d.className = cls;
    });
    // First time it's Sync (the whole history); once that's done, Update (just what's new).
    $("#tn-sync-label").textContent = $("#tn-msync-label").textContent = state.historyDone ? "Update" : "Sync";
    if (!raf) raf = requestAnimationFrame(tick);
    $("#tn-sync").hidden = !!state.mode;
    $("#tn-stop").hidden = !state.mode;
    $("#tn-msync").hidden = !!state.mode;
    $("#tn-mstop").hidden = !state.mode;
    // The tweet ticker only runs while stashing.
    $("#tn-latest").hidden = !state.mode || !$("#tn-latest .tn-txt").textContent;
    // Collapsed: one line with the count, Sync/Update (or Stop) and Go to my stash, plus a thin progress
    // line while syncing. Expanding shows the big counter, the dots and the latest bookmark.
    const min = panel.classList.contains("tn-min");
    $("#tn-mini").hidden = !min || !(state.mode || state.complete || state.known);
    $("#tn-acct").hidden = min;
    $(".tn-bar").style.transform = `scaleX(${state.complete ? 1 : state.mode ? Math.max(.03, frac ?? done / DOTS) : 0})`;
    $(".tn-bar").hidden = !min || !state.mode;
  }

  // Ease the counters toward their targets so they climb steadily instead of jumping per page.
  function tick() {
    raf = 0;
    if (!panel) return;
    let moving = false;
    const count = state.catchup ? state.base + state.added : state.mode || state.complete ? state.found.size : state.known;
    for (const [k, target] of [["found", count], ["added", state.added]]) {
      const d = target - shown[k];
      if (Math.abs(d) < 1) shown[k] = target;
      else { shown[k] += Math.max(1, Math.abs(d) * 0.12) * Math.sign(d); moving = true; }
    }
    panel.querySelector("#tn-count").textContent = Math.round(shown.found).toLocaleString();
    panel.querySelector("#tn-mini").textContent = Math.round(shown.found).toLocaleString();
    const added = Math.round(shown.added);
    panel.querySelector("#tn-new-count").textContent = added ? "+" + added.toLocaleString() + " new" : "";
    if (moving) raf = requestAnimationFrame(tick);
  }

  // The newest bookmark on a page, for the "just stashed" line: its text and first image.
  function latestOf(payload) {
    if (payload.domTweets) {
      const t = payload.domTweets[0];
      return t && { text: t.text, thumb: t.media?.[0]?.thumb || "", handle: t.handle || t.author?.handle || "" };
    }
    let entry = null;
    const findEntry = (x) => {
      if (!x || typeof x !== "object" || entry) return;
      if (Array.isArray(x)) return x.forEach(findEntry);
      if (typeof x.entryId === "string" && x.entryId.startsWith("tweet-")) { entry = x; return; }
      for (const k in x) findEntry(x[k]);
    };
    findEntry(payload);
    if (!entry) return null;
    let text = "", thumb = "", handle = "";
    const dig = (x) => {
      if (!x || typeof x !== "object") return;
      if (Array.isArray(x)) return x.forEach(dig);
      if (!text && typeof x.full_text === "string") text = x.full_text;
      if (!thumb && typeof x.media_url_https === "string") thumb = x.media_url_https;
      if (!handle && typeof x.screen_name === "string") handle = x.screen_name;
      for (const k in x) dig(x[k]);
    };
    dig(entry);
    return { text: text.replace(/https:\/\/t\.co\/\S+/g, "").trim(), thumb, handle };
  }

  let lastLatestAt = 0;
  function showLatest(item) {
    if (!panel || !state.mode || !item || (!item.text && !item.thumb)) return;
    if (Date.now() - lastLatestAt < 350) return;
    lastLatestAt = Date.now();
    const row = panel.querySelector("#tn-latest");
    row.hidden = false;
    row.querySelector(".tn-txt").textContent = item.text || "(image)";
    row.querySelector(".tn-thumb").style.backgroundImage = item.thumb ? `url("${item.thumb}?name=small")` : "";
    row.classList.remove("in");
    void row.offsetWidth; // restart the fade-in
    row.classList.add("in");
  }

  function mountPanel() {
    if (panel) return;
    panel = document.createElement("div");
    panel.id = "tweet-nest-panel";
    const logo = (size) => `<svg width="${size}" height="${size}" viewBox="4 4 32 32" aria-hidden="true"><path d="M8.9 5h22.2v30L20 27.8 8.9 35z" fill="#ff5b1f"/><path d="M20.01 22.97L20.01 22.97Q18.77 22.97 17.76 22.74Q16.75 22.51 16.01 22.03Q15.28 21.56 14.85 20.82Q14.42 20.08 14.34 19.11L14.34 19.11L17.08 18.20Q17.14 19.02 17.55 19.56Q17.95 20.10 18.64 20.36Q19.33 20.63 20.18 20.63L20.18 20.63Q21.00 20.63 21.55 20.42Q22.10 20.22 22.39 19.90Q22.67 19.58 22.67 19.21L22.67 19.21Q22.67 18.78 22.30 18.50Q21.93 18.22 21.29 18.02Q20.65 17.81 19.80 17.62L19.80 17.62Q18.83 17.39 17.90 17.11Q16.96 16.84 16.21 16.41Q15.45 15.97 15.01 15.28Q14.58 14.59 14.58 13.55L14.58 13.55Q14.58 12.36 15.18 11.49Q15.78 10.62 16.94 10.12Q18.11 9.63 19.82 9.63L19.82 9.63Q21.50 9.63 22.69 10.11Q23.87 10.60 24.51 11.46Q25.15 12.32 25.21 13.47L25.21 13.47L22.42 14.26Q22.42 13.70 22.23 13.27Q22.05 12.85 21.72 12.57Q21.39 12.28 20.90 12.14Q20.42 11.99 19.80 11.99L19.80 11.99Q19.06 11.99 18.55 12.17Q18.03 12.34 17.78 12.62Q17.53 12.91 17.53 13.27L17.53 13.27Q17.53 13.74 17.92 14.04Q18.32 14.34 19.01 14.54Q19.70 14.75 20.53 14.94L20.53 14.94Q21.37 15.12 22.26 15.38Q23.15 15.64 23.93 16.07Q24.70 16.49 25.18 17.22Q25.66 17.95 25.66 19.05L25.66 19.05Q25.66 20.24 25.02 21.12Q24.39 22.00 23.13 22.49Q21.87 22.97 20.01 22.97Z" fill="#fff"/></svg>`;
    panel.innerHTML = `
      <style>
        @font-face{font-family:"tweetstash Inter";src:url("${chrome.runtime.getURL("fonts/inter.woff2")}") format("woff2");font-weight:100 900;font-display:swap}
        @font-face{font-family:"tweetstash Bricolage";src:url("${chrome.runtime.getURL("fonts/bricolage-700.woff2")}") format("woff2");font-weight:700;font-display:swap}
        #tweet-nest-panel #tn-title{font-family:"tweetstash Bricolage","tweetstash Inter",sans-serif;font-weight:700;letter-spacing:-.02em}
        #tweet-nest-panel{position:fixed;right:20px;bottom:20px;z-index:2147483647;width:400px;box-sizing:border-box;
          font:13px/1.4 "tweetstash Inter",Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#0a0a0a;
          background:#fff;border:1px solid #eaeaea;border-radius:16px;overflow:hidden;
          box-shadow:0 1px 2px rgba(0,0,0,.04),0 24px 60px rgba(0,0,0,.18);font-feature-settings:"tnum" 1}
        #tweet-nest-panel *{box-sizing:border-box}
        #tweet-nest-panel .tn-mono{font-family:"Geist Mono",ui-monospace,"SF Mono",Menlo,monospace}
        #tweet-nest-panel .tn-h{display:flex;align-items:center;gap:8px;padding:18px 18px 0;font-weight:600}
        #tweet-nest-panel .tn-right{margin-left:auto;font-size:12px;font-weight:400;color:#666}
        #tweet-nest-panel .tn-body{padding:18px 18px 20px;display:flex;flex-direction:column;gap:18px}
        #tweet-nest-panel .tn-count{display:flex;align-items:baseline;gap:8px}
        #tweet-nest-panel .tn-count b{font-size:40px;font-weight:600;letter-spacing:-.05em;line-height:1}
        #tweet-nest-panel .tn-count span{font-size:13px;color:#666}
        #tweet-nest-panel .tn-count .tn-new{margin-left:auto;color:#0a0a0a;font-weight:500}
        #tweet-nest-panel .tn-dots{display:grid;grid-template-columns:repeat(20,minmax(0,1fr));gap:5px}
        #tweet-nest-panel .tn-dots i{display:block;aspect-ratio:1;border-radius:50%;background:#ededed;transition:background .2s}
        #tweet-nest-panel .tn-dots i.on{background:#0a0a0a;animation:tn-pop .28s cubic-bezier(.2,.8,.2,1)}
        #tweet-nest-panel .tn-dots i.fly{background:#ff5b1f;animation:tn-blink .9s ease-in-out infinite}
        @keyframes tn-pop{0%{transform:scale(.4)}60%{transform:scale(1.15)}100%{transform:scale(1)}}
        @keyframes tn-blink{0%,100%{opacity:1;transform:scale(.85)}50%{opacity:.35;transform:scale(.7)}}
        /* Latest bookmark, boxed so it reads as its own item. */
        #tweet-nest-panel .tn-latest{margin:0 18px 14px}
        #tweet-nest-panel .tn-card{display:flex;align-items:center;gap:12px;min-width:0;padding:10px 12px 10px 10px;
          background:#fff;border:1px solid #d4d4d4;border-radius:12px}
        #tweet-nest-panel .tn-latest.in .tn-card{animation:tn-in .35s cubic-bezier(.2,.8,.2,1)}
        @keyframes tn-in{from{opacity:0;transform:translateY(10px);filter:blur(3px)}to{opacity:1;transform:none;filter:none}}
        #tweet-nest-panel #tn-go svg{transition:transform .2s}
        #tweet-nest-panel #tn-go:hover svg{transform:translateX(3px)}
        /* Slide in when the panel appears, so you notice it on the bookmarks page. */
        #tweet-nest-panel{animation:tn-enter .6s .2s cubic-bezier(.16,1,.3,1) both}
        @keyframes tn-enter{from{opacity:0;transform:translateY(28px) scale(.96)}to{opacity:1;transform:none}}
        #tweet-nest-panel .tn-thumb{width:38px;height:38px;border-radius:8px;flex:none;background:#f2f2f2 center/cover no-repeat}
        #tweet-nest-panel .tn-txt{flex:1;min-width:0;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        #tweet-nest-panel .tn-status{color:#666;font-size:12px;min-height:16px;margin-top:-6px}
        #tweet-nest-panel .tn-row{display:flex;align-items:center;gap:4px;padding:6px 18px 18px}
        #tweet-nest-panel .tn-gap{flex:1}
        #tweet-nest-panel button{flex:none;height:36px;padding:0 14px;border-radius:10px;font:inherit;font-weight:500;cursor:pointer;white-space:nowrap;transition:background .15s,opacity .15s}
        #tweet-nest-panel .tn-primary{background:#0a0a0a;color:#fff;border:0}
        #tweet-nest-panel .tn-primary:hover{opacity:.85}
        #tweet-nest-panel .tn-ghost{background:#fff;color:#0a0a0a;border:1px solid #eaeaea}
        #tweet-nest-panel .tn-ghost:hover{background:#f2f2f2}
        #tweet-nest-panel button svg{display:block;flex:none}
        #tweet-nest-panel .tn-primary,#tweet-nest-panel .tn-ghost{display:inline-flex;align-items:center;gap:8px}
        #tweet-nest-panel #tn-sync svg{transition:transform .5s cubic-bezier(.2,.8,.2,1)}
        #tweet-nest-panel #tn-sync:hover svg{transform:rotate(180deg)}
        #tweet-nest-panel .tn-h{cursor:pointer;user-select:none;transition:padding .25s}
        #tweet-nest-panel .tn-fold{flex:none;width:24px;height:24px;padding:0;margin-left:2px;border:0;border-radius:7px;background:transparent;color:#999;display:grid;place-items:center}
        #tweet-nest-panel .tn-fold:hover{background:#f2f2f2;color:#0a0a0a}
        #tweet-nest-panel .tn-fold svg{transition:transform .25s cubic-bezier(.2,.8,.2,1)}
        #tweet-nest-panel.tn-min .tn-fold svg{transform:rotate(180deg)}
        #tweet-nest-panel .tn-more{display:grid;grid-template-rows:1fr;transition:grid-template-rows .3s cubic-bezier(.2,.8,.2,1),opacity .2s}
        #tweet-nest-panel .tn-more>div{min-height:0;overflow:hidden}
        #tweet-nest-panel.tn-min .tn-more{grid-template-rows:0fr;opacity:0}
        #tweet-nest-panel.tn-min .tn-h{padding:12px 12px 12px 14px}
        #tweet-nest-panel{transition:width .3s cubic-bezier(.2,.8,.2,1)}
        #tweet-nest-panel.tn-min{width:400px}
        #tweet-nest-panel .tn-acts{display:none;align-items:center;gap:4px;margin-left:6px}
        #tweet-nest-panel.tn-min .tn-acts{display:inline-flex}
        #tweet-nest-panel .tn-acts button{height:28px;padding:0 10px;border-radius:8px;font-size:12.5px;gap:6px}
        #tweet-nest-panel .tn-acts svg{width:13px;height:13px}
        #tweet-nest-panel #tn-msync:hover svg{transform:rotate(180deg)}
        #tweet-nest-panel #tn-msync svg{transition:transform .5s cubic-bezier(.2,.8,.2,1)}

        #tweet-nest-panel .tn-bar{position:absolute;left:0;right:0;bottom:0;height:2px;background:#ff5b1f;transform-origin:left;transition:transform .3s}
        #tweet-nest-panel .tn-link{height:auto;padding:4px 2px;border:0;background:none;color:#888;font-size:12px;font-weight:500;text-decoration:underline;text-decoration-color:#d4d4d4;text-underline-offset:3px}
        #tweet-nest-panel .tn-link:hover{color:#0a0a0a;text-decoration-color:currentColor}
        #tweet-nest-panel .tn-link.armed{color:#e5484d;text-decoration-color:currentColor}
        #tweet-nest-panel [hidden]{display:none!important}
      </style>
      <div class="tn-h" id="tn-head">${logo(18)}<span id="tn-title">tweetstash</span>
        <span class="tn-right" id="tn-acct"></span>
        <span class="tn-right tn-mono" id="tn-mini" hidden></span>
        <span class="tn-acts">
          <button class="tn-ghost" id="tn-mstop" type="button" hidden><svg width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10" rx="2" fill="currentColor"/></svg>Stop</button>
          <button class="tn-primary" id="tn-msync" type="button"><svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 6.5A5.5 5.5 0 0 0 3.3 4.6"/><path d="M3 2v3h3"/><path d="M2.5 9.5a5.5 5.5 0 0 0 10.2 1.9"/><path d="M13 14v-3h-3"/></svg><span id="tn-msync-label">Sync</span></button>
          <button class="tn-ghost" id="tn-mgo" type="button">Go to stash</button>
        </span>
        <button class="tn-fold" id="tn-fold" title="Collapse" aria-label="Collapse panel"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg></button></div>
      <div class="tn-more"><div>
      <div class="tn-body">
        <div class="tn-count"><b id="tn-count">0</b><span id="tn-of"></span><span class="tn-new" id="tn-new-count"></span></div>
        <div class="tn-dots" aria-hidden="true">${"<i></i>".repeat(DOTS)}</div>
        <div class="tn-status" id="tn-status"></div>
      </div>
      <div class="tn-latest" id="tn-latest" hidden><div class="tn-card"><span class="tn-thumb"></span><div class="tn-txt"></div></div></div>
      <div class="tn-row">
        <button class="tn-ghost" id="tn-go" type="button">Go to my stash<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h10M9 4l4 4-4 4"/></svg></button>
        <span class="tn-gap"></span>
        <button class="tn-ghost" id="tn-stop" hidden><svg width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10" rx="2" fill="currentColor"/></svg>Stop</button>
        <button class="tn-primary" id="tn-sync"><svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 6.5A5.5 5.5 0 0 0 3.3 4.6"/><path d="M3 2v3h3"/><path d="M2.5 9.5a5.5 5.5 0 0 0 10.2 1.9"/><path d="M13 14v-3h-3"/></svg><span id="tn-sync-label">Sync</span></button>
      </div>
      </div></div>
      <div class="tn-bar" hidden></div>
`;
    document.getElementById("tweet-nest-panel")?.remove(); // leftover from an older copy of the script
    document.documentElement.appendChild(panel);
    dotEls = [...panel.querySelectorAll(".tn-dots i")];
    panel.querySelector("#tn-sync").onclick = (e) => syncNow(e);
    panel.querySelector("#tn-stop").onclick = () => stopNow();
    const goStash = (e) => { if (e.isTrusted) send({ type: "open-app" }); };
    const syncNow = (e) => { if (e.isTrusted) startSync(false); };
    const stopNow = () => { stop(); setStatus("Stopped."); };
    panel.querySelector("#tn-go").onclick = goStash;
    panel.querySelector("#tn-mgo").onclick = goStash;
    panel.querySelector("#tn-msync").onclick = syncNow;
    panel.querySelector("#tn-mstop").onclick = stopNow;
    // The panel appears expanded; the chevron or a click on the header (not its buttons) collapses it.
    const setMin = (min) => {
      panel.classList.toggle("tn-min", min);
      const fold = panel.querySelector("#tn-fold");
      fold.title = min ? "Expand" : "Collapse";
      fold.setAttribute("aria-label", min ? "Expand panel" : "Collapse panel");
      render();
    };
    panel.querySelector("#tn-head").onclick = (e) => {
      if (e.target.closest(".tn-acts")) return; // the collapsed bar's own buttons
      setMin(!panel.classList.contains("tn-min"));
    };
    setMin(false);
    refreshKnown();
    render();
  }

  // X is a single-page app: show the panel only while on a bookmarks route.
  const routeTimer = setInterval(() => {
    if (!alive()) return retire();
    const onBookmarks = onBookmarksPage();
    if (onBookmarks && !panel && document.body) mountPanel();
    if (!onBookmarks && panel) { stop(); panel.remove(); panel = null; }
    // X draws the profile link late, and you can switch accounts without a reload.
    if (panel && account() !== lastAccount) { lastAccount = account(); refreshKnown(); }
  }, 800);
})();

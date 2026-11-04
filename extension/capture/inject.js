// Runs in the extension's isolated world alongside relay.js. No window messages or page globals:
// X page scripts cannot submit captures or supply replay URLs/headers through this channel.
(() => {
  const IS_BOOKMARKS = /^\/i\/api\/graphql\/[^/]+\/(Bookmarks|BookmarkFolderTimeline)$/;
  let lastReq = null; // { url, headers }
  let lastCursor = null;
  let fastRunning = false;

  let onMessage = () => {};
  let capturing = false;
  const post = (msg) => onMessage(msg);
  const origFetch = window.fetch.bind(window);
  globalThis.tweetstashCapture = { subscribe: (fn) => { onMessage = fn; }, command };

  function findBottomCursor(o) {
    let found = null;
    const walk = (x) => {
      if (!x || typeof x !== "object" || found) return;
      if (Array.isArray(x)) return x.forEach(walk);
      if (typeof x.entryId === "string" && x.entryId.startsWith("cursor-bottom")) {
        found = x.content?.value || x.content?.itemContent?.value || null;
        return;
      }
      for (const k in x) walk(x[k]);
    };
    walk(o);
    return found;
  }

  function handlePayload(url, json, origin) {
    lastCursor = findBottomCursor(json) || lastCursor;
    post({ type: "page", payload: json, origin });
  }

  // --- fast sync: replay the bookmarks query with successive cursors ---
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tweetIds = (json) => [...JSON.stringify(json).matchAll(/"entryId":"tweet-(\d+)"/g)].map((m) => m[1]);
  let pageSize = 100;

  function pageUrl(cursor, count) {
    const u = new URL(lastReq.url);
    const vars = JSON.parse(u.searchParams.get("variables") || "{}");
    if (cursor) vars.cursor = cursor;
    else delete vars.cursor;
    vars.count = count;
    u.searchParams.set("variables", JSON.stringify(vars));
    return u.href;
  }

  // Timing split per request: wait (until X's headers arrive), body (download), parse (JSON.parse).
  async function fetchPage(cursor, count = pageSize) {
    const t0 = performance.now();
    const res = await origFetch(pageUrl(cursor, count), { headers: { ...lastReq.headers, "x-tweetstash-replay": "1" }, credentials: "include", redirect: "error" });
    const t1 = performance.now();
    const rl = {
      limit: Number(res.headers.get("x-rate-limit-limit")) || null,
      remaining: Number(res.headers.get("x-rate-limit-remaining")),
      reset: Number(res.headers.get("x-rate-limit-reset")) * 1000 || null,
    };
    const text = res.ok ? await res.text() : null;
    const t2 = performance.now();
    const json = text ? JSON.parse(text) : null;
    const t3 = performance.now();
    return { res, json, rl, ms: Math.round(t3 - t0), timing: { wait: t1 - t0, body: t2 - t1, parse: t3 - t2 } };
  }

  async function fastSync() {
    if (!lastReq) return post({ type: "fast-failed", reason: "no-request-yet" });
    fastRunning = true;
    post({ type: "fast-started" });
    const seen = new Set();
    const started = performance.now();
    let cursor = null; // start from the newest bookmark
    let pages = 0;
    try {
      while (fastRunning) {
        const { res, json, rl, ms } = await fetchPage(cursor);
        if (res.status === 429) {
          const wait = Math.max(5000, (rl.reset || Date.now() + 60000) - Date.now() + 1000);
          post({ type: "fast-wait", seconds: Math.round(wait / 1000) });
          await sleep(Math.min(wait, 16 * 60 * 1000));
          continue;
        }
        if (!res.ok) {
          if (pages === 0) return post({ type: "fast-failed", reason: `HTTP ${res.status}` });
          throw new Error(`HTTP ${res.status}`);
        }
        const ids = tweetIds(json);
        const fresh = ids.filter((id) => !seen.has(id));
        fresh.forEach((id) => seen.add(id));
        const next = findBottomCursor(json);
        pages++;
        post({ type: "page", payload: json, origin: "fast", stats: { pages, unique: seen.size, ms, elapsed: Math.round(performance.now() - started), rl } });
        // X starts repeating itself at the end of the list: a page with nothing new means we're done.
        if (!fresh.length || !next || next === cursor) break;
        cursor = next;
        lastCursor = next;
        // No fixed delay: only slow down when X says the rate-limit budget is nearly spent.
        if (rl.remaining <= 1 && rl.reset) {
          const wait = rl.reset - Date.now() + 1000;
          post({ type: "fast-wait", seconds: Math.round(wait / 1000) });
          await sleep(Math.min(Math.max(wait, 0), 16 * 60 * 1000));
        }
      }
      post({ type: "fast-done", pages, unique: seen.size, elapsed: Math.round(performance.now() - started) });
    } catch (e) {
      post({ type: "fast-done", pages, error: String(e.message || e) });
    } finally {
      fastRunning = false;
    }
  }

  // --- turbo sync ---
  // X's bookmark cursor is just the sortIndex of the last item, thrift-encoded:
  //   0x1c 0x16 <zigzag varint sortIndex> 0x00 0x00
  // so we can build a cursor for any point in the list. That lets us (1) split the whole history
  // into slices fetched in parallel and (2) skip X's ~1000-item limit on following its own cursors.
  const TURBO = { slices: 12, workers: 6, page: 96 };

  function makeCursor(sortIndex) {
    let v = (sortIndex << 1n) ^ (sortIndex >> 63n);
    const b = [0x1c, 0x16];
    while (v >= 0x80n) { b.push(Number(v & 0x7fn) | 0x80); v >>= 7n; }
    b.push(Number(v), 0, 0);
    return btoa(String.fromCharCode(...b));
  }

  // One walk per page: tweet ids, and sortIndexes newest first.
  function scan(json) {
    const ids = [], sorts = [];
    const walk = (x) => {
      if (!x || typeof x !== "object") return;
      if (Array.isArray(x)) return x.forEach(walk);
      if (typeof x.entryId === "string" && x.entryId.startsWith("tweet-")) {
        ids.push(x.entryId.slice(6));
        if (x.sortIndex) sorts.push(BigInt(x.sortIndex));
        return; // nothing we need lives inside an entry
      }
      for (const k in x) walk(x[k]);
    };
    walk(json);
    sorts.sort((a, b) => (a < b ? 1 : -1));
    return { ids, sorts };
  }
  const tweetSorts = (json) => scan(json).sorts;

  async function turboSync(map) {
    if (!lastReq) return post({ type: "fast-failed", reason: "no-request-yet" });
    fastRunning = true;
    post({ type: "fast-started", turbo: true });
    const seen = new Set();
    const started = performance.now();
    let pages = 0, budget = 500, resetAt = 0, refused = 0;
    const slices = [];
    const progress = () => {
      if (!slices.length) return 0;
      const total = slices.reduce((s, x) => s + Number(x.top - x.floor), 0);
      const done = slices.reduce((s, x) => s + Number(x.top - (x.done ? x.floor : x.at > x.floor ? x.at : x.floor)), 0);
      return total ? done / total : 0;
    };
    // Where the time goes, summed over all requests (ms). "handoff" is our own work per page:
    // scanning it and posting it to relay.js. Read it after a run from window.__nestLastRun.
    const m = { requests: 0, wait: 0, body: 0, parse: 0, handoff: 0, maxWait: 0 };
    const emit = (r, ids) => {
      const t = performance.now();
      ids ||= scan(r.json).ids;
      ids.forEach((id) => seen.add(id));
      pages++;
      post({ type: "page", payload: r.json, ids, origin: "turbo", stats: { pages, unique: seen.size, ms: r.ms, elapsed: Math.round(performance.now() - started), progress: progress() } });
      m.handoff += performance.now() - t;
    };
    // One request, retried on rate limits. Returns null when X refuses.
    async function get(cursor) {
      while (fastRunning) {
        if (budget <= TURBO.workers && resetAt > Date.now()) {
          post({ type: "fast-wait", seconds: Math.round((resetAt - Date.now()) / 1000) });
          await sleep(resetAt - Date.now() + 1000);
        }
        const r = await fetchPage(cursor);
        m.requests++; m.wait += r.timing.wait; m.body += r.timing.body; m.parse += r.timing.parse;
        m.maxWait = Math.max(m.maxWait, r.timing.wait);
        if (r.rl.limit) { budget = r.rl.remaining; resetAt = r.rl.reset || resetAt; }
        if (r.res.status === 429) { budget = 0; continue; }
        return r.res.ok ? r : null;
      }
      return null;
    }

    try {
      const newSlice = (hi, lo) => ({ top: hi, floor: lo, at: hi, items: 0, done: false, busy: false });
      const cuts = (map?.cuts || []).map(BigInt);
      if (cuts.length && map.min) {
        // Account we already have: cut one slice per page we know about, so each slice is usually a
        // single request and there's nothing to probe. The top slice starts from X's newest page and
        // walks down to the first page we know, picking up anything bookmarked since.
        const bounds = [...cuts, BigInt(map.min)];
        const head = newSlice(cuts[0] + (cuts[0] - bounds[1]) + 1n, cuts[0]); // top is a guess until page 1 lands
        head.newest = true;
        slices.push(head);
        for (let i = 0; i < cuts.length; i++) if (cuts[i] > bounds[i + 1]) slices.push({ ...newSlice(cuts[i], bounds[i + 1]), exact: true });
        // And anything older than the oldest one we know (usually one empty page, confirming the end).
        slices.push(newSlice(BigInt(map.min), 0n));
      } else {
        // 1. Newest page: the top of the range.
        const first = await get(null);
        if (!first) return post({ type: "fast-failed", reason: "first page refused" });
        emit(first);
        const s0 = tweetSorts(first.json);
        if (s0.length < 2) return post({ type: "fast-done", pages, unique: seen.size, elapsed: Math.round(performance.now() - started), turbo: true, complete: true }); // the whole list fits on one page
        const top = s0[0] + 1n;
        const span = s0[0] - s0.at(-1);

        // 2. Find the bottom: probe further and further back in parallel. A probe that comes back
        // empty means nothing is older than that point. (Probe pages are real data, so keep them.)
        const points = [];
        for (let k = 1; k <= 14; k++) { const v = s0.at(-1) - span * (1n << BigInt(k)); points.push(v > 1n ? v : 1n); if (v <= 1n) break; }
        const probes = await Promise.all(points.map((v) => get(makeCursor(v)).then((r) => ({ v, r }))));
        let floor = 0n;
        for (const { v, r } of probes) {
          if (!r) continue;
          const { ids, sorts } = scan(r.json);
          if (sorts.length) emit(r, ids);
          else if (v > floor) floor = v;
        }
        const usable = probes.find((p) => p.r);
        if (!usable) return post({ type: "fast-failed", reason: "made-up cursors refused" });

        // 3. Slice [floor, top) and drain the slices with a few parallel workers.
        const step = (top - floor) / BigInt(TURBO.slices);
        for (let i = 0; i < TURBO.slices; i++) {
          const hi = top - step * BigInt(i);
          slices.push(newSlice(hi, i === TURBO.slices - 1 ? floor : hi - step));
        }
      }
      const globalDensity = () => {
        const covered = slices.reduce((a, x) => a + Number(x.top - x.at), 0);
        return covered ? seen.size / covered : 0;
      };
      // Items still expected in a slice, from the density seen so far inside it.
      const remaining = (x) => {
        const walked = Number(x.top - x.at);
        const d = x.items && walked ? x.items / walked : globalDensity();
        return Number(x.at - x.floor) * d;
      };
      // Work stealing: bookmarks are bunched in time, so equal slices aren't equal work. An idle
      // worker takes the bottom half of whichever busy slice has the most left, so nobody ends up
      // paging through a dense stretch alone at the end. Splits cost at most one partial page each.
      function nextSlice() {
        const fresh = slices.find((x) => !x.done && !x.busy);
        if (fresh) return fresh;
        let best = null;
        // Slices cut from the page map are a page each already; splitting one only adds a request.
        for (const x of slices) if (x.busy && !x.done && !x.exact && (!best || remaining(x) > remaining(best))) best = x;
        if (!best || remaining(best) < TURBO.page * 1.5) return null;
        const mid = best.floor + (best.at - best.floor) / 2n;
        const half = newSlice(mid, best.floor);
        best.floor = mid;
        slices.push(half);
        return half;
      }
      const worker = async () => {
        let sl;
        while (fastRunning && (sl = nextSlice())) {
          sl.busy = true;
          let next = get(sl.newest ? null : makeCursor(sl.at));
          while (next) {
            const r = await next;
            next = null;
            if (!r) { sl.done = true; if (fastRunning) refused++; break; }
            const t = performance.now();
            const { ids, sorts } = scan(r.json);
            if (sl.newest && sorts.length) { sl.newest = false; sl.top = sl.at = sorts[0] + 1n; }
            if (!sorts.length) sl.done = true;
            else {
              sl.items += sorts.filter((x) => x >= sl.floor).length;
              sl.at = sorts.at(-1); // next cursor: just below the oldest item on this page
              if (sl.at <= sl.floor) sl.done = true; // floor may have risen if another worker split us
            }
            // Send the next request first, then hand this page off while X is working on it.
            sl.pages = (sl.pages || 0) + 1;
            (sl.sizes ||= []).push(sorts.length);
            if (fastRunning && !sl.done) next = get(makeCursor(sl.at));
            m.handoff += performance.now() - t;
            emit(r, ids);
          }
          sl.busy = false;
        }
      };
      await Promise.all(Array.from({ length: TURBO.workers }, worker));
      const elapsed = Math.round(performance.now() - started);
      const avg = (x) => Math.round(x / (m.requests || 1));
      const timing = {
        requests: m.requests, elapsed,
        avgWait: avg(m.wait), avgBody: avg(m.body), avgParse: avg(m.parse), avgHandoff: avg(m.handoff),
        maxWait: Math.round(m.maxWait),
        usedMap: !!(map?.cuts?.length), slices: slices.length,
        multiPage: slices.filter((x) => x.pages > 1).map((x) => x.sizes),
      };
      window.__nestLastRun = timing;
      console.log("[tweet-nest] turbo timing", timing);
      // complete: every slice was walked to its end (not stopped, nothing refused), so the whole list is in.
      post({ type: "fast-done", pages, unique: seen.size, elapsed, turbo: true, complete: fastRunning && !refused, timing });
    } catch (e) {
      post({ type: "fast-done", pages, error: String(e.message || e) });
    } finally {
      fastRunning = false;
    }
  }

  // --- probe: measures what X allows, so we can tune sync. Results never include headers/cookies. ---
  function varints(bytes) {
    // Every LEB128 varint in the buffer, zigzag-decoded (thrift compact encoding uses both).
    const out = [];
    for (let i = 0; i < bytes.length; i++) {
      let v = 0n, shift = 0n, j = i;
      while (j < bytes.length) {
        const b = BigInt(bytes[j]);
        v |= (b & 0x7fn) << shift;
        shift += 7n;
        j++;
        if (!(b & 0x80n)) break;
      }
      if (j - i >= 8) out.push({ at: i, len: j - i, raw: v.toString(), zigzag: ((v >> 1n) ^ -(v & 1n)).toString() });
    }
    return out;
  }
  const decodeCursor = (c) => {
    try {
      const bytes = Uint8Array.from(atob(c.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));
      return { cursor: c, hex: [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" "), varints: varints(bytes) };
    } catch (e) {
      return { cursor: c, error: String(e) };
    }
  };
  function sortIndexes(json) {
    const out = [];
    const walk = (x) => {
      if (!x || typeof x !== "object") return;
      if (Array.isArray(x)) return x.forEach(walk);
      if (typeof x.entryId === "string" && x.sortIndex) out.push({ entryId: x.entryId.replace(/^tweet-/, "t:"), sortIndex: x.sortIndex });
      for (const k in x) walk(x[k]);
    };
    walk(json);
    return out;
  }

  async function probe(extra = {}) {
    if (!lastReq) return (window.__nestProbe = { error: "no-request-yet" });
    const r = (window.__nestProbe = { running: true, op: new URL(lastReq.url).pathname.split("/").pop(), sizes: [] });
    for (const n of extra.sizes || [20, 100, 200, 500]) {
      const { res, json, rl, ms } = await fetchPage(null, n);
      r.sizes.push({ count: n, status: res.status, tweets: json ? tweetIds(json).length : 0, ms, kb: json ? Math.round(JSON.stringify(json).length / 1024) : 0, rl });
    }
    const first = await fetchPage(null, 20);
    if (first.json) {
      const idx = sortIndexes(first.json);
      r.firstPage = { first: idx[0], last: idx.filter((x) => x.entryId.startsWith("t:")).pop(), bottom: decodeCursor(findBottomCursor(first.json) || ""), top: idx.find((x) => x.entryId.startsWith("cursor-top")) };
    }
    if (extra.cursor) {
      // Try a hand-made cursor: does X accept it, and where in the list does it land?
      const { res, json } = await fetchPage(extra.cursor, 20);
      const idx = json ? sortIndexes(json).filter((x) => x.entryId.startsWith("t:")) : [];
      r.forged = { status: res.status, tweets: idx.length, firstSort: idx[0]?.sortIndex, lastSort: idx.at(-1)?.sortIndex };
    }
    // Which bookmark-related GraphQL operations does X's web app know about?
    try {
      const srcs = [...document.scripts].map((s) => s.src).filter((s) => /responsive-web\/client-web/.test(s));
      const ops = {};
      await Promise.all(srcs.map(async (src) => {
        const t = await origFetch(src).then((x) => x.text()).catch(() => "");
        for (const m of t.matchAll(/queryId:"([^"]+)",operationName:"([^"]*Bookmark[^"]*)"/g)) ops[m[2]] = m[1];
      }));
      r.bookmarkOps = ops;
    } catch (e) {
      r.bookmarkOps = String(e);
    }
    r.running = false;
    return r;
  }

  function command(cmd, extra = {}) {
    if (cmd === "fast" && !fastRunning) fastSync();
    if (cmd === "turbo" && !fastRunning) turboSync(extra.map);
    if (cmd === "probe") probe(extra.options || {});
    // URL + headers of X's own bookmarks request, seen by the background worker.
    if (cmd === "request" && !fastRunning && !capturing) {
      let url;
      try { url = new URL(extra.url); } catch { return; }
      if (url.origin !== location.origin || !IS_BOOKMARKS.test(url.pathname)) return;
      lastReq = { url: url.href, headers: extra.headers };
      post({ type: "request-seen" });
      // Isolated scripts cannot hook page fetch/XHR. Replay the observed request once instead.
      capturing = true;
      origFetch(url.href, { headers: { ...extra.headers, "x-tweetstash-replay": "1" }, credentials: "include", redirect: "error" })
        .then((res) => res.ok ? res.json() : null)
        .then((json) => { if (json) handlePayload(url.href, json, "page"); })
        .catch((error) => post({ type: "capture-error", error: error.message }))
        .finally(() => { capturing = false; });
    }
    if (cmd === "stop") fastRunning = false;
  }
})();

// One bookmark card: author, text with links and search highlights, media, quote, link previews, tags.
import { esc, fmtNum, fmtDate, host } from "./util.js";
import { state } from "./state.js";

// Only web links: a stored URL like "javascript:..." must never become a clickable link or a source.
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || "")) ? String(u) : "");

const postUrl = (handle, id) => `https://x.com/${encodeURIComponent(handle || "i")}/status/${encodeURIComponent(id)}`;

// Post text as HTML: links, @mentions and #hashtags become links, search words are highlighted.
// The text is split into tokens first and each piece is escaped on its own, so nothing in a post can
// end up inside an attribute or become markup.
const TOKEN = /(https?:\/\/[^\s<>"']+)|(^|[^\w/])@(\w{1,15})|(^|[^\w&/])#(\w+)/gu;
const link = (href, label) => `<a href="${esc(href)}" target="_blank" rel="noopener">${label}</a>`;

function richText(text) {
  const terms = (state.filters.q.match(/[\p{L}\p{N}_]+/gu) || []).filter((w) => w.length > 1);
  const re = terms.length ? new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "giu") : null;
  const plain = (s) => (re ? esc(s).replace(re, "<mark>$1</mark>") : esc(s));
  let html = "", at = 0;
  for (const m of text.matchAll(TOKEN)) {
    html += plain(text.slice(at, m.index));
    if (m[1]) {
      const u = m[1];
      html += link(u, plain(u.replace(/^https?:\/\/(www\.)?/, "").slice(0, 48) + (u.length > 56 ? "…" : "")));
    } else if (m[3]) {
      html += plain(m[2]) + link(`https://x.com/${m[3]}`, "@" + plain(m[3]));
    } else {
      html += plain(m[4]) + link(`https://x.com/hashtag/${encodeURIComponent(m[5])}`, "#" + plain(m[5]));
    }
    at = m.index + m[0].length;
  }
  return html + plain(text.slice(at));
}

function mediaHtml(media, tweetUrl) {
  if (!media?.length) return "";
  const items = media.slice(0, 4).filter((m) => safeUrl(m.thumb)).map((m) => {
    if (m.type !== "photo" && m.video && media.length === 1) {
      return `<video src="${esc(safeUrl(m.video))}" poster="${esc(safeUrl(m.thumb))}" controls preload="none" playsinline ${m.type === "animated_gif" ? "loop muted" : ""}></video>`;
    }
    const thumb = safeUrl(m.thumb);
    if (!thumb) return "";
    const src = thumb + (thumb.includes("?") ? "" : "?name=medium");
    return `<a href="${esc(m.type === "photo" ? thumb + "?name=large" : tweetUrl)}" target="_blank" rel="noopener">
      <img src="${esc(src)}" loading="lazy" referrerpolicy="no-referrer" alt="">
      ${m.type !== "photo" ? '<span class="play">▶</span>' : ""}</a>`;
  });
  return `<div class="media n${items.length}">${items.join("")}</div>`;
}

function quoteHtml(q, url) {
  const href = q.id ? postUrl(q.author_handle, q.id) : url;
  return `<a class="quote" href="${esc(href)}" target="_blank" rel="noopener" style="display:block;color:inherit;text-decoration:none">
    <div class="qhead"><img src="${esc(safeUrl(q.author_avatar))}" referrerpolicy="no-referrer" alt=""><b>${esc(q.author_name)}</b> @${esc(q.author_handle)}</div>
    <div class="text">${esc(q.text.slice(0, 400))}${q.text.length > 400 ? "…" : ""}</div>
    ${mediaHtml(q.media?.slice(0, 1), "")}
  </a>`;
}

function linksHtml(links) {
  return `<div class="links">${links.slice(0, 2).map((u) => `
    <a class="link-card" href="${esc(safeUrl(u.url))}" target="_blank" rel="noopener">
      <span><b>${esc(host(u.url))}</b> ${esc(u.url.replace(/^https?:\/\/(www\.)?[^/]+/, ""))}</span>
    </a>`).join("")}</div>`;
}

export const tagChips = (tags) =>
  tags.map((t) => `<span class="chip" data-tag="${esc(t)}">${esc(t)}<span class="x" data-remove="${esc(t)}">×</span></span>`).join("");

export const tagRow = (tags) => tagChips(tags) + '<button class="chip add-tag">+ tag</button>';

// `note`: an optional line above the card (why it matched a search, why tagging failed).
// Masonry: in the grid view each card spans one 2px grid row per 2px of its height (plus the 14px gap),
// re-measured whenever it changes size (images loading, text expanding, window resizing). The grid places
// cards in order, each at the highest free spot, so they read left to right like the bookmarks on X.
const ROW = 2, GAP = 14;
const sizer = new ResizeObserver((entries) => {
  for (const e of entries) {
    if (!e.target.isConnected) { sizer.unobserve(e.target); continue; } // the feed was cleared
    const h = e.borderBoxSize?.[0]?.blockSize ?? e.target.offsetHeight;
    if (h) e.target.style.setProperty("--rows", Math.ceil((h + GAP) / ROW));
  }
});

// The category, plus a button to change it. "Not sure" and "picked by you" show on the dot.
export const catHtml = (b) =>
  `<span class="cat${b.tag_unsure && b.category_by === "local" ? " unsure" : ""}${b.category_by === "user" ? " mine" : ""}" data-category="${esc(b.category)}"
    title="${b.category_by === "user" ? "You picked this" : b.tag_unsure && b.category_by === "local" ? "The local tagger wasn't sure" : "Show all in this category"}">${esc(b.category)}</span>`
  + `<button class="cat-edit" type="button" data-cat-edit title="Change category" aria-label="Change category"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg></button>`;

export function card(b, note = "") {
  const url = postUrl(b.author_handle, b.id);
  const el = document.createElement("article");
  el.className = "card";
  el.dataset.id = b.id;
  const links = b.urls.filter((u) => safeUrl(u.url) && !/(^|\.)(x|twitter)\.com\//.test(u.url.replace(/^https?:\/\//, "")));
  const long = b.text.length > 520 || b.text.split("\n").length > 10;
  const multiAccount = (state.stats?.accounts.length || 0) > 1;
  el.innerHTML = `
    ${note ? `<div class="why">${esc(note)}</div>` : ""}
    <div class="card-head">
      <img class="avatar" src="${esc(safeUrl(b.author_avatar))}" loading="lazy" referrerpolicy="no-referrer" alt="">
      <div class="who">
        <a class="name" href="#" data-author="${esc(b.author_handle)}">${esc(b.author_name)}</a>
        <span class="handle">@${esc(b.author_handle)} · ${fmtDate(b.created_at)}</span>
      </div>
      <a class="open" href="${esc(url)}" target="_blank" rel="noopener" title="Open on X">Open ↗</a>
    </div>
    ${b.text ? `<div class="text ${long ? "clamp" : ""}">${richText(b.text)}</div>${long ? '<button class="more-text">Show more</button>' : ""}` : ""}
    ${mediaHtml(b.media, url)}
    ${b.quoted ? quoteHtml(b.quoted, url) : ""}
    ${links.length && !b.media.length ? linksHtml(links) : ""}
    <div class="card-tags">${tagRow(b.tags)}</div>
    <div class="card-foot">
      <span class="stat" title="Likes">♥ ${fmtNum(b.likes)}</span>
      <span class="stat" title="Reposts + quotes">⟲ ${fmtNum(b.retweets)}</span>
      ${b.views ? `<span class="stat" title="Views">◉ ${fmtNum(b.views)}</span>` : ""}
      ${multiAccount ? b.accounts.map((a) => `<span class="acct-badge">${esc(a)}</span>`).join("") : ""}
      ${b.category ? `<span class="cat-wrap">${catHtml(b)}</span>` : ""}
    </div>`;
  el._data = b;
  sizer.observe(el);
  return el;
}

// API errors arrive as raw JSON; keep just the human part.
export function failReason(msg) {
  const m = /"message":"([^"]+)"/.exec(msg);
  return (m ? m[1] : msg).slice(0, 160);
}

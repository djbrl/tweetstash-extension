// Turns X's GraphQL bookmark payloads into plain post objects. No database access here.

function unwrap(result) {
  if (!result) return null;
  if (result.__typename === "TweetWithVisibilityResults") return result.tweet;
  if (result.__typename === "TweetTombstone" || result.__typename === "TweetUnavailable") return null;
  return result;
}

function bestVideo(m) {
  const variants = (m.video_info?.variants || []).filter((v) => v.content_type === "video/mp4");
  variants.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  return variants[0]?.url;
}

const decodeEntities = (s) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

export function parseTweet(result) {
  const t = unwrap(result);
  if (!t?.legacy || !t.rest_id) return null;
  const L = t.legacy;
  const u = t.core?.user_results?.result || {};
  const ul = u.legacy || {};
  let text = t.note_tweet?.note_tweet_results?.result?.text || L.full_text || "";
  const urls = (L.entities?.urls || []).map((x) => ({ url: x.expanded_url, display: x.display_url, short: x.url }));
  const mediaRaw = L.extended_entities?.media || L.entities?.media || [];
  const media = mediaRaw.map((m) => ({
    type: m.type, // photo | video | animated_gif
    thumb: m.media_url_https,
    video: m.type === "photo" ? undefined : bestVideo(m),
    w: m.original_info?.width, h: m.original_info?.height,
  }));
  // Strip t.co links: media links entirely, other links swapped for their expanded form.
  for (const m of mediaRaw) if (m.url) text = text.replaceAll(m.url, "");
  for (const x of urls) if (x.short) text = text.replaceAll(x.short, x.url);
  const q = unwrap(t.quoted_status_result?.result);
  const quoted = q ? parseTweet(q) : null;
  return {
    id: t.rest_id,
    author_name: u.core?.name || ul.name || "",
    author_handle: u.core?.screen_name || ul.screen_name || "",
    author_avatar: u.avatar?.image_url || ul.profile_image_url_https || "",
    text: decodeEntities(text.trim()),
    created_at: Date.parse(L.created_at) || null,
    likes: L.favorite_count || 0,
    retweets: (L.retweet_count || 0) + (L.quote_count || 0),
    replies: L.reply_count || 0,
    views: Number(t.views?.count || 0),
    bookmarks: L.bookmark_count || 0,
    media, urls, lang: L.lang,
    quoted: quoted ? { id: quoted.id, author_name: quoted.author_name, author_handle: quoted.author_handle, author_avatar: quoted.author_avatar, text: quoted.text, media: quoted.media } : null,
  };
}

// Captures come from a page we don't control, so every post is checked before it's stored: ids are
// numbers, handles are X handles, links are web links, and media only comes from X's own servers.
// Anything else is dropped, so stored data can never smuggle a script or a tracking pixel into the
// dashboard.
const isHttp = (u) => typeof u === "string" && /^https?:\/\/[^\s"'<>]+$/i.test(u);
const fromX = (u, hosts) => typeof u === "string" && hosts.some((h) => u.startsWith(`https://${h}/`)) && isHttp(u);
const MEDIA_HOSTS = ["pbs.twimg.com"], VIDEO_HOSTS = ["video.twimg.com"], AVATAR_HOSTS = ["pbs.twimg.com", "abs.twimg.com"];
const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
const int = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);

export function sanitizePost(t, depth = 0) {
  if (!t || typeof t !== "object" || !/^\d{1,25}$/.test(String(t.id))) return null;
  return {
    id: String(t.id),
    author_name: str(t.author_name, 100),
    author_handle: /^\w{1,30}$/.test(t.author_handle) ? t.author_handle : "",
    author_avatar: fromX(t.author_avatar, AVATAR_HOSTS) ? t.author_avatar : "",
    text: str(t.text, 30000),
    created_at: Number.isFinite(t.created_at) ? t.created_at : null,
    likes: int(t.likes), retweets: int(t.retweets), replies: int(t.replies), views: int(t.views), bookmarks: int(t.bookmarks),
    media: (Array.isArray(t.media) ? t.media : []).filter((m) => fromX(m?.thumb, MEDIA_HOSTS)).slice(0, 4).map((m) => ({
      type: ["photo", "video", "animated_gif"].includes(m.type) ? m.type : "photo",
      thumb: m.thumb,
      video: fromX(m.video, VIDEO_HOSTS) ? m.video : undefined,
      w: int(m.w) || undefined, h: int(m.h) || undefined,
    })),
    urls: (Array.isArray(t.urls) ? t.urls : []).filter((u) => isHttp(u?.url)).slice(0, 20)
      .map((u) => ({ url: u.url, display: str(u.display, 200), short: isHttp(u.short) ? u.short : undefined })),
    lang: str(t.lang, 10),
    quoted: depth === 0 && t.quoted ? sanitizePost(t.quoted, 1) : null,
  };
}

// Walks any GraphQL payload and pulls out timeline tweet entries with their sortIndex.
export function extractEntries(payload) {
  const out = [];
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(walk);
    if (typeof o.entryId === "string" && o.entryId.startsWith("tweet-") && o.content?.itemContent?.tweet_results) {
      out.push({ sortIndex: o.sortIndex, result: o.content.itemContent.tweet_results.result });
      return;
    }
    for (const k in o) walk(o[k]);
  };
  walk(payload);
  return out;
}

// Context X sends that the post text doesn't show: the author's bio, image alt text, link card and
// article titles. Read from the stored raw payload.
export function extras(raw) {
  if (!raw) return {};
  try {
    const r = JSON.parse(raw);
    const user = r.core?.user_results?.result;
    const bio = user?.profile_bio?.description || user?.legacy?.description || "";
    const media = r.legacy?.extended_entities?.media || [];
    const alt = media.map((m) => m.ext_alt_text).filter(Boolean).join(" / ");
    const bv = r.card?.legacy?.binding_values || [];
    const cardTitle = (Array.isArray(bv) ? bv.find((b) => b.key === "title")?.value?.string_value : bv.title?.string_value) || "";
    const article = r.article?.article_results?.result?.title || "";
    return { bio: bio.slice(0, 160), alt: alt.slice(0, 300), linkTitle: [cardTitle, article].filter(Boolean).join(" / ").slice(0, 200) };
  } catch {
    return {};
  }
}

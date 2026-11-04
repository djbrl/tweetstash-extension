// Fetching post images small enough to send to the AI.

// X serves any image at 360px with ?format=jpg&name=360x360 (~140 tokens to Claude, vs ~1,600 full size).
export function smallImage(url) {
  const m = /^(https:\/\/pbs\.twimg\.com\/[^?]+?)(\.(jpe?g|png|webp))?(\?.*)?$/i.exec(url || "");
  return m ? `${m[1]}?format=jpg&name=360x360` : null;
}

// X sometimes answers ?format=jpg with a PNG anyway, and the API rejects an image whose declared type
// is wrong, so the type is read from the file's first bytes rather than trusted.
const ascii = (buf, a, b) => String.fromCharCode(...buf.subarray(a, b));
function sniffType(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (ascii(buf, 0, 4) === "GIF8") return "image/gif";
  if (ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 12) === "WEBP") return "image/webp";
  return null;
}

function base64(buf) {
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

// An image content block for Claude, or null when there's no usable image.
export async function fetchImage(url) {
  const small = smallImage(url);
  if (!small) return null;
  try {
    const res = await fetch(small, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    const media_type = sniffType(buf);
    if (!media_type) return null;
    return { type: "image", source: { type: "base64", media_type, data: base64(buf) } };
  } catch {
    return null; // a missing image just means the post is judged on its text
  }
}

// The first image (or video thumbnail) of a stored post row.
export const firstThumb = (row) => JSON.parse(row.media || "[]")[0]?.thumb;

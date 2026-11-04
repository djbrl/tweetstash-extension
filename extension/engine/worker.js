// The engine: database, AI tagging and search, running in a worker inside the offscreen document.
// Requests come in as { id, route, path, body } and get { id, ok, result | error } back.
import { routes } from "./routes.js";
import { renormalizeTags } from "./db/tags.js";

renormalizeTags();
const running = new Map(); // request id -> AbortController

self.onmessage = async ({ data }) => {
  if (data?.abort) return running.get(data.abort)?.abort();
  const { id, method, path, body } = data || {};
  const url = new URL(path, "https://tweetstash.invalid");
  const route = routes[`${method} ${url.pathname}`];
  if (!route) return self.postMessage({ id, ok: false, error: "not found", status: 404 });
  const ac = new AbortController();
  running.set(id, ac);
  try {
    const result = await route(body && typeof body === "object" ? body : {}, url, ac.signal);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    if (!err.status) console.error(err);
    self.postMessage({ id, ok: false, error: err?.message || String(err), status: err?.status || 500 });
  } finally {
    running.delete(id);
  }
};
self.postMessage({ ready: true });

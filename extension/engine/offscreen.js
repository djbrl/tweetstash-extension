// A hidden page Chrome keeps open for the extension (an "offscreen document"). It hosts the engine
// worker, which can't run in the background service worker: that one gets stopped when idle, and the
// database and long AI tagging runs need to stay up. Only the background worker talks to it, after
// checking who's asking (see background.js).
const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
const pending = new Map(); // worker request id -> sendResponse
const refs = new Map(); // caller's reference -> worker request id, for Stop
let nextId = 1;
let markReady;
const ready = new Promise((r) => (markReady = r));

worker.onmessage = ({ data }) => {
  if (data?.ready) return markReady();
  const reply = pending.get(data?.id);
  if (!reply) return;
  pending.delete(data.id);
  for (const [ref, id] of refs) if (id === data.id) refs.delete(ref);
  reply(data);
};
worker.onerror = (e) => console.error("[engine]", e.message);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Messages from the background worker have no tab and come from this extension.
  if (sender.id !== chrome.runtime.id || sender.tab || !msg || typeof msg !== "object") return;
  if (msg.target === "engine-abort") {
    const id = refs.get(msg.ref);
    if (id) worker.postMessage({ abort: id });
    return;
  }
  if (msg.target !== "engine") return;
  ready.then(() => {
    const id = nextId++;
    pending.set(id, sendResponse);
    if (msg.ref) refs.set(msg.ref, id);
    worker.postMessage({ id, method: msg.method, path: msg.path, body: msg.body });
  });
  return true; // reply comes later
});

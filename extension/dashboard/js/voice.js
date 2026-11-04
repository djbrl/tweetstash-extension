// Voice search with the browser's built-in speech recognition (Chrome sends the audio to Google to
// transcribe). Speaking switches to Describe. Enter (or the mic button) stops listening and leaves the
// text in the box to fix up; a second Enter searches. Escape cancels. It also stops after 30 seconds
// without speech.
import { $, toast, store } from "./util.js";
import { setSearchMode, applySearchMode, syncClear } from "./search.js";

const SILENCE_MS = 30000;

export function initVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  const mic = $("#mic");
  const q = $("#q");
  mic.hidden = false;
  let rec = null, listening = false, heard = "", before = "", lastHeard = 0, silenceTimer = 0;

  function begin() {
    rec = new SR();
    rec.lang = store.get("tweetstash-voice-lang", "en-US");
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      lastHeard = Date.now();
      let finals = "", interim = "";
      for (const r of e.results) (r.isFinal ? (finals += r[0].transcript + " ") : (interim += r[0].transcript));
      q.value = (heard + " " + finals + interim).replace(/\s+/g, " ").trim();
      if (e.results[e.results.length - 1].isFinal) q.dataset.voiceDone = q.value;
    };
    rec.onerror = (e) => {
      if (["no-speech", "aborted"].includes(e.error)) return;
      toast("Voice search: " + e.error);
      end("cancel");
    };
    // Chrome ends a session by itself after a short pause; keep going until Enter, Esc or 30 s of quiet.
    rec.onend = () => {
      if (!listening) return;
      heard = (q.dataset.voiceDone || heard).trim();
      begin();
    };
    rec.start();
  }

  function start() {
    setSearchMode("ai");
    listening = true;
    before = q.value;
    heard = "";
    delete q.dataset.voiceDone;
    q.value = "";
    q.placeholder = "Listening… Enter to stop, Esc to cancel";
    lastHeard = Date.now();
    mic.classList.add("listening");
    mic.title = "Finish (Enter)";
    clearInterval(silenceTimer);
    silenceTimer = setInterval(() => { if (Date.now() - lastHeard > SILENCE_MS) end("timeout"); }, 1000);
    begin();
  }

  // how: "stop" (Enter / mic: keep the text to edit), "cancel" (Esc), "timeout" (30 s of silence)
  function end(how) {
    if (!listening) return;
    listening = false;
    clearInterval(silenceTimer);
    try { rec?.abort(); } catch {}
    rec = null;
    mic.classList.remove("listening");
    mic.title = "Search by voice";
    applySearchMode(); // restores the placeholder
    setTimeout(syncClear);
    const text = q.value.trim();
    if (how === "cancel" || !text) { q.value = before; return; }
    if (how === "timeout") toast("Stopped listening. Press Enter to search.");
    q.focus();
    q.setSelectionRange(q.value.length, q.value.length);
  }

  mic.addEventListener("click", () => (listening ? end("stop") : start()));
  // Capture phase, so Enter/Esc go to voice first instead of the normal search handlers.
  document.addEventListener("keydown", (e) => {
    if (!listening) return;
    if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); end("stop"); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); end("cancel"); }
  }, true);
}

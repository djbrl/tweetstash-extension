// Applies the saved light/dark choice before the page paints (loaded as a plain blocking script).
try { const t = localStorage.getItem("tweetstash-theme"); if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; } catch {}

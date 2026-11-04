// Copies the two third-party libraries into extension/vendor/, as single files the extension can load.
// Chrome extensions can't load code from the internet, so everything ships inside the extension.
// Run after updating either package: npm run vendor
import fs from "node:fs";
import { build } from "esbuild";

const out = new URL("../extension/vendor/", import.meta.url);
fs.mkdirSync(out, { recursive: true });

// SQLite, compiled to WebAssembly (official build, includes full-text search).
const sqlite = new URL("../node_modules/@sqlite.org/sqlite-wasm/dist/", import.meta.url);
fs.copyFileSync(new URL("index.mjs", sqlite), new URL("sqlite3.mjs", out));
fs.copyFileSync(new URL("sqlite3.wasm", sqlite), new URL("sqlite3.wasm", out));

// The official Anthropic SDK, bundled into one ES module.
await build({
  stdin: { contents: 'export { default as Anthropic } from "@anthropic-ai/sdk";', resolveDir: new URL("..", import.meta.url).pathname },
  bundle: true, format: "esm", platform: "browser", target: "chrome120", minify: false, legalComments: "inline",
  outfile: new URL("anthropic.mjs", out).pathname, logLevel: "warning",
});
console.log("vendored sqlite-wasm and @anthropic-ai/sdk into extension/vendor/");

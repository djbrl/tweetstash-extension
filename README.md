# TweetStash (extension edition)

Your X/Twitter bookmarks in a searchable library, with AI tagging and "describe it" search. Everything
lives inside the Chrome extension: no server, no terminal, nothing to install besides the extension.

This is the extension-only version of [TweetStash](https://github.com/Djbrl/tweetstash). The server
version adds a local image model that helps description search find posts by what their pictures look
like; this one leaves it out to stay small.

## Install (developer mode, for now)

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick `extension/`.
2. Click the TweetStash icon in the toolbar to open your library.
3. Open https://x.com/i/bookmarks and click **Sync** in the panel at the bottom right.
4. For AI tagging and description search, add your Anthropic API key in **Settings**.

Moving from the server version? In its Settings, **Export**, then here, **Settings → Restore**.

## What's where

```
extension/
  manifest.json
  background.js        the switchboard: spots X's bookmarks request, routes messages, starts the engine
  capture/             runs on x.com in the extension's isolated world: replays X's request, draws the panel
  engine/              the "server", running in a worker inside an offscreen document
    worker.js          entry point: takes requests, runs routes
    routes.js          the API (same routes as the server version)
    db/                SQLite (WebAssembly) stored in the extension's private file system
    services/          tagging, search, sync, settings, the Anthropic client
    prompts/           what's sent to the AI
  dashboard/           the library page (plain ES modules, no build step)
  vendor/              SQLite and the Anthropic SDK, bundled (regenerate with npm run vendor)
scripts/
  vendor.mjs           copies/bundles the two libraries into extension/vendor/
  test.mjs             end-to-end test in a real Chromium, with synthetic data
```

## Privacy and safety

- Your stash lives only in this browser profile, in storage no website or other extension can read.
  **Uninstalling the extension deletes it.** Settings has **Download backup** and **Restore**, and
  emptying the stash downloads a backup first.
- There's no local server and no open port. X pages can only hand the extension captured bookmarks;
  page scripts on x.com can't reach the capture code, and the panel there has no delete button.
- Your X cookies never leave the browser. AI features send post text and small images straight from
  your browser to Anthropic, with your own key, which is stored with the rest of your data.
- Restored backups go through the same checks as captures (no script links, images only from X).

## Development

```bash
npm install
npm run vendor   # after updating @sqlite.org/sqlite-wasm or @anthropic-ai/sdk
npm test         # needs playwright-core and a Chromium that allows --load-extension (see scripts/test.mjs)
```

## License

MIT

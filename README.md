<img src="assets/logo.svg" width="56" height="56" alt="">

# TweetStash (extension edition)

**Search the posts you saved on X.** Keyword search, automatic tags and picture search for your bookmarks. Private, free, no account.

Everything lives inside the Chrome extension: no server, no terminal, nothing to install besides the
extension. Automatic tags and picture search use your own Anthropic API key.

This is the extension-only edition of TweetStash. A self-hosted server edition also exists; it adds a
local image model that helps description search find posts by what their pictures look like. This one
leaves that out to stay small and install in one step.

## Install (developer mode, for now)

You need Chrome 120 or newer (or another Chromium browser: Edge, Brave, Arc).

1. Download the code: on GitHub, **Code → Download ZIP**, then unzip it. Or:

   ```bash
   git clone https://github.com/djbrl/tweetstash-extension.git
   ```

2. Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked** and pick
   the `extension/` folder inside it. Keep the folder: Chrome runs the extension from there.
3. Your library opens by itself. Later, click the TweetStash icon in the toolbar to open it (pin it
   from the puzzle-piece menu so it stays visible).
4. Open https://x.com/i/bookmarks and click **Sync** in the panel at the bottom right. It fetches your
   whole history; after that the button says **Update** and only fetches what's new.
5. For AI tagging and description search, add your Anthropic API key in **Settings**.

Moving from the server version? In its Settings, **Export**, then here, **Settings → Restore**.

To update, replace the folder's contents with the new version and click the reload arrow on the
TweetStash card in `chrome://extensions`. Your library is kept.

## Uninstall

There's no model or other download to clean up: everything lives inside the extension.

1. **Keep a copy first, if you want one**: Settings → **Download backup**. Removing the extension
   deletes your library and your API key for good.
2. Open `chrome://extensions` and click **Remove** on TweetStash. Chrome deletes the extension's
   storage with it (the database, settings and key).
3. Delete the folder you loaded it from.

Left behind: any backups you downloaded, in your Downloads folder.

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
- Full details: [privacy policy](PRIVACY.md).
- Restored backups go through the same checks as captures (no script links, images only from X).

## Development

```bash
npm install
npm run vendor   # after updating @sqlite.org/sqlite-wasm or @anthropic-ai/sdk
npm test         # needs playwright-core and a Chromium that allows --load-extension (see scripts/test.mjs)
```

## License

MIT

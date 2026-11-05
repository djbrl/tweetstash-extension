<img src="assets/logo.svg" width="56" height="56" alt="">

# TweetStash

**Search the posts you saved on X.** Keyword search, automatic tags and picture search for your bookmarks. Private, free, no account.

Everything runs inside Chrome. AI tagging and description search use your own Anthropic API key.

## Install

You need Chrome 120 or newer, or another Chromium browser (Edge, Brave, Arc).

1. Download the code: **Code → Download ZIP** and unzip it, or:

   ```bash
   git clone https://github.com/djbrl/tweetstash-extension.git
   ```

2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the
   `extension/` folder. Keep the folder: Chrome runs the extension from it.
3. Your library opens. To come back to it, click the TweetStash icon in the toolbar.
4. Open https://x.com/i/bookmarks and click **Sync** in the panel at the bottom right. The first sync
   fetches everything; after that, **Update** fetches only what's new.
5. For AI tagging and description search, add your Anthropic API key in **Settings**.

**Update:** replace the folder's contents and click the reload arrow on TweetStash in
`chrome://extensions`. Your library is kept.

**Uninstall:** download a backup first if you want one (**Settings → Download backup**), then click
**Remove** in `chrome://extensions` and delete the folder. Removing the extension deletes your library
and API key.

## Privacy

- Your library stays in this browser profile. No website or other extension can read it.
- No server, no open port. Your X cookies never leave the browser.
- AI features send post text and small images from your browser straight to Anthropic, with your key.
- Backups can be restored in **Settings**. Emptying the library downloads a backup first.

Full details in the [privacy policy](PRIVACY.md).

## Project layout

```
extension/
  manifest.json
  background.js   spots X's bookmarks request, routes messages, starts the engine
  capture/        the sync panel on x.com
  engine/         database, search, tagging and sync, in a background worker
  dashboard/      the library page
  vendor/         SQLite (WebAssembly) and the Anthropic SDK
scripts/
  vendor.mjs      rebuilds extension/vendor/
  test.mjs        end-to-end test in Chromium
```

## Development

```bash
npm install
npm run vendor   # after updating @sqlite.org/sqlite-wasm or @anthropic-ai/sdk
npm test         # needs playwright-core and a Chromium that allows --load-extension
```

## License

MIT

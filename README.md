<img src="assets/logo.svg" width="56" height="56" alt="">

# TweetStash

**Search the posts you saved on X.** Keyword search, automatic tags and picture search for your bookmarks. Private, free, no account.

Everything runs inside Chrome. Tagging works for free on your computer, or with Claude for better tags
using your own Anthropic API key. Description search uses Claude too.

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
5. Click **Tag** to sort your bookmarks into categories. By default this runs on your computer, for free
   (a one-time download of about 290 MB, or 435 MB on computers with a graphics card). Fix a post's
   category with the arrow next to it and the tagger learns from it; **Teach** shows it what a category or
   a tag of yours means, a few posts at a time. Posts it wasn't sure about wait under **Check these**.
   For better tags and description search, add your Anthropic API key in **Settings** and pick Claude.

**Update:** replace the folder's contents and click the reload arrow on TweetStash in
`chrome://extensions`. Your library is kept.

**Uninstall:** download a backup first if you want one (**Settings → Download backup**), then click
**Remove** in `chrome://extensions` and delete the folder. Removing the extension deletes your library
and API key.

## Privacy

- Your library stays in this browser profile. No website or other extension can read it.
- No server, no open port. Your X cookies never leave the browser.
- Tagging on your computer sends nothing anywhere, and neither does what it learns from you. The models
  are downloaded once from Hugging Face.
- Claude features send post text and small images from your browser straight to Anthropic, with your key.
- Backups can be restored in **Settings**. Emptying the library downloads a backup first.

Full details in the [privacy policy](PRIVACY.md).

## Project layout

```
extension/
  manifest.json
  background.js   spots X's bookmarks request, routes messages, starts the engine
  capture/        the sync panel on x.com
  engine/         database, search, tagging (local or Claude) and sync, in a background worker
  engine/models/  the local tagger's category classifier (trained by scripts/tagger)
  dashboard/      the library page
  vendor/         SQLite (WebAssembly), the Anthropic SDK, Transformers.js and its ONNX runtime
scripts/
  vendor.mjs      rebuilds extension/vendor/
  test.mjs        end-to-end test in Chromium
  tagger/         builds and tests the local tagger's classifier against a stash Claude tagged
```

The free tagger's classifier was trained on the categories Claude gave about 6,000 real bookmarks (the
picture and words of each post, never Claude's descriptions). On posts it never saw, it agrees with
Claude 79% of the time, against 48% for 0.1.1's description matching. `scripts/tagger/evaluate.mjs`
reproduces the numbers from a TweetStash server database.

## Development

```bash
npm install
npm run vendor   # after updating sqlite-wasm, the Anthropic SDK or Transformers.js
npm test         # needs playwright-core and a Chromium that allows --load-extension
```

## License

MIT

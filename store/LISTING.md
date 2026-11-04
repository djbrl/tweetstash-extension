# Chrome Web Store submission

Dashboard: https://chrome.google.com/webstore/devconsole → **New item** → upload `tweetstash-0.1.0.zip`.
Then fill each tab below. Every field you need is here, ready to paste.

## Store listing tab

**Description** (the summary under the name comes from the manifest):

```
TweetStash turns your X (Twitter) bookmarks into a library you can actually search.

• Sync in one click: open your bookmarks on x.com and press Sync. TweetStash fetches your whole history once, then only what's new. Several X accounts? Each bookmark remembers who saved it.
• Browse your way: grid or list, newest or oldest first, filter by photos, videos or links, by account, author or tag.
• Instant keyword search across post text, authors and tags.
• Optional AI, with your own Anthropic API key: automatic tags and categories for every bookmark, and "describe it" search: type "that blue isometric city illustration" and get the post back, pictures included.
• Private by design: no server, no account, no tracking. Your library lives only in this browser. AI features talk straight to Anthropic with your key, and only when you use them.
• Backup and restore to a file at any time.

Open source: https://github.com/djbrl/tweetstash-extension
```

- **Category:** Productivity
- **Language:** English
- **Store icon:** `icon128.png`
- **Screenshots:** `1-library-light.png`, `2-library-dark.png`, `3-tag-filter.png` (1280×800, fictional demo data)
- **Small promo tile:** `promo-440x280.png`
- **Homepage URL:** https://github.com/djbrl/tweetstash-extension
- **Support URL:** https://github.com/djbrl/tweetstash-extension/issues

## Privacy tab

**Single purpose:**

```
Save the user's X (Twitter) bookmarks into a private library inside the browser, where they can browse, tag and search them.
```

**Permission justifications:**

| Permission | Justification |
|---|---|
| webRequest | Detects (read-only, never blocking or modifying) when the user's X bookmarks page requests their bookmark list, so the Sync button can fetch the rest of the list with the same request. |
| scripting | Re-injects the capture panel into x.com tabs that were already open when the extension was installed or updated, so Sync works without reloading the page. |
| offscreen | Runs the local database (SQLite compiled to WebAssembly, bundled in the package) in a worker inside an offscreen document, because a service worker can't keep a database open. |
| unlimitedStorage | Libraries of several thousand bookmarks with their tags and search index exceed the default storage quota. |
| Host: x.com, twitter.com | Shows the Sync panel on the bookmarks page and reads the bookmarks X returns to the signed-in user. |
| Host: pbs.twimg.com | Loads the bookmarks' images in the library, and makes small copies for AI tagging when the user turns it on. |
| Host: api.anthropic.com | Optional AI tagging and description search, sent with the user's own Anthropic API key, only when they use those features. |

**Remote code:** No, I am not using remote code. (Everything, including SQLite and the Anthropic SDK, is bundled in the package.)

**Data usage:** tick **Website content** (bookmarked posts' text and images, sent to Anthropic only when the user turns on AI features). Tick all three certifications:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** https://github.com/djbrl/tweetstash-extension/blob/main/PRIVACY.md

## Distribution tab

- **Visibility:** Public (or Unlisted to share by link first)
- **Regions:** All regions
- Payment: free

## Test instructions (for the reviewer, if asked)

```
No account or key is needed to test capture and browsing. Sign in to any X account that has a few bookmarks, open https://x.com/i/bookmarks and click Sync in the TweetStash panel at the bottom right. Click the toolbar icon to open the library. AI features need the user's own Anthropic API key (Settings) and are optional.
```

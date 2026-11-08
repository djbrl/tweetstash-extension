# TweetStash privacy policy

Last updated: 08 November 2026

TweetStash is a Chrome extension that saves your X (Twitter) bookmarks into a library inside your
browser, so you can browse, tag and search them.

## What it collects

- **Your bookmarks.** When you click Sync on https://x.com/i/bookmarks, TweetStash reads the bookmarks X
  shows you (post text, author name and handle, post date, counts, links and image addresses) and the
  handle of the X account you're signed in with, so each bookmark remembers which account saved it.
- **Your settings**, including your Anthropic API key if you add one.

All of this is stored only in your browser, in the extension's private storage. Uninstalling the
extension deletes it.

## Who it's shared with

- **Nobody, by default.** TweetStash has no server, no account, no analytics and no tracking. The
  developer never receives your data.
- **Anthropic, only if you turn on AI features.** If you add your own Anthropic API key and use AI
  tagging or description search, the text of the relevant posts and small copies of their images are
  sent directly from your browser to Anthropic's API (https://api.anthropic.com) with your key, and
  processed under [Anthropic's terms and privacy policy](https://www.anthropic.com/legal/privacy). You
  can remove your key at any time in Settings.
- Images in your library are loaded from X's image servers (pbs.twimg.com), as they are on X.
- **Hugging Face, for a one-time download only.** If you tag on this computer (the free option), TweetStash
  downloads an image-recognition model (CLIP) from Hugging Face (https://huggingface.co) the first time,
  and the browser keeps it. Nothing about you or your bookmarks is sent: it's a plain file download, and
  the tagging itself runs entirely in your browser. You can delete the model in Settings.

Your X cookies and password are never read, stored or sent anywhere. TweetStash doesn't sell or transfer
your data, and doesn't use it for anything except showing you your own library.

## Your control

- **Settings → Download backup** saves everything to a file on your computer.
- **Empty stash** deletes your library (a backup is downloaded first).
- Removing the extension deletes all of its data.

## Contact

Questions: open an issue at https://github.com/djbrl/tweetstash-extension/issues.

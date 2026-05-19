> Languages: **English** · [简体中文](README.zh-CN.md)

# YouTube Bilingual Subtitles (DeepSeek / Google Translation)

A Tampermonkey userscript that **intercepts YouTube's own caption requests**, translates them into any target language you pick, and overlays bilingual subtitles synchronized to the video's timeline.

> No subtitle extensions, no proxy server — translation goes directly to the DeepSeek or Google API of your choice.

## Features

- **Hijacks native captions**: hooks YouTube's `/api/timedtext` requests at the network layer, no DOM scraping
- **Smart sentence splitting**: accumulates across events, **only breaks at punctuation** — never mid-sentence
- **Two engines**: DeepSeek (high quality, batched prompts, preserves proper nouns) or Google (free, no API key required, fast)
- **Local caching**: each video is translated once per target language, replays read straight from cache
- **Direct connection**: the script talks to the official APIs directly; nothing routed through any third party
- **Bilingual UI** (v0.9.2+): menu commands and the in-page debug banner auto-detect your browser language (Chinese for `zh-*`, English otherwise); a Tampermonkey menu entry lets you flip it manually
- **Any source → any target** (v0.10.0+): source language is read straight from YouTube's caption metadata (works for English, Spanish, Japanese, Korean…); target language is your choice via a menu prompt (`zh-CN`, `en`, `ja`, `ko`, `es`, `fr`, `de`, `ru`, `pt`, `it`, `ar`, `hi`, `vi`, `th`, `id`, or any other ISO code). If source equals target, translation is skipped automatically.

## Install

### 1. Install a userscript manager

Pick one for your browser:

- Chrome / Edge / Brave: [Tampermonkey](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
- Firefox: [Tampermonkey](https://addons.mozilla.org/firefox/addon/tampermonkey/) or [Violentmonkey](https://addons.mozilla.org/firefox/addon/violentmonkey/)
- Safari: [Tampermonkey](https://apps.apple.com/app/tampermonkey/id1482490089)

### 2. Install the script

One-click install: open the [Raw script URL](https://raw.githubusercontent.com/wzy102720/youtube-ai-subtitle/main/youtube-bilingual-subs.user.js) — Tampermonkey will automatically prompt to install.

Alternatively, copy the contents of `youtube-bilingual-subs.user.js` into a new userscript in Tampermonkey's dashboard manually.

## Configuration

### Get a DeepSeek API key (recommended)

DeepSeek's translation quality is noticeably better than Google's, and pricing is cheap (~¥1 / million input tokens).

1. Sign up at [platform.deepseek.com](https://platform.deepseek.com/)
2. Top up ~¥10 — that goes a long way
3. **API Keys** → **Create API Key** → copy the `sk-...` value

### Set the key in the script

1. Open any YouTube video
2. Click the Tampermonkey icon in your browser toolbar
3. In the script's submenu, click **Set DeepSeek API Key**
4. Paste your `sk-...` key and confirm
5. Reload the page

### Or switch to Google Translate (no key, free)

1. Tampermonkey menu → **Switch engine** → confirm
2. Reload the page

## Usage

1. Open any YouTube video
2. **Turn on YouTube's own CC subtitle button** — the script intercepts caption requests, so the CC button must be active for any request to fire
3. A green debug banner appears at the top: "Please enable CC button, waiting for captions…"
4. Once captured, the original captions appear immediately while translation runs in the background
5. When translation completes, captions become bilingual (target language on top, original below)
6. The debug banner fades out after a few seconds

The overlay shows the translation in bold white text on top with a black stroke shadow, and the original captions in smaller semi-transparent text below — readable on both bright and dark frames.

## Tampermonkey menu commands

The menu labels follow your selected UI language. The English versions are shown below; the Chinese equivalents are in [README.zh-CN.md](README.zh-CN.md).

| Menu command (English UI) | What it does |
| --- | --- |
| Language / 语言: English | Toggle UI language between English and 中文; reload required |
| Set DeepSeek API Key | Set or change your DeepSeek API key |
| Switch engine (current: xxx) | Toggle between DeepSeek and Google |
| Target language / 目标: xxx | Open a prompt to change the translation target (e.g. `zh-CN`, `en`, `ja`); persists across reloads |
| Clear cache for current video | Clear the cached translation for the current video — required after editing the script logic, otherwise stale cues persist |
| Toggle debug banner | Show / hide the green debug banner at the top of the page |

## Subtitle splitting rules (v0.9.1)

| Trigger | Behavior |
| --- | --- |
| Token ends with `. ! ? 。 ！ ？` or `, ， ; ； : ：` | **Split immediately** as one caption |
| Accumulated > 10s with no punctuation | Force split (fallback, prevents stuck captions) |
| Event boundary without punctuation | **Don't split** — accumulate across events |

To tune caption length, edit this line in the script:

```javascript
const MAX_CHUNK_MS = 10000;  // fallback duration in milliseconds
```

- Smaller (e.g. 7000) → shorter, more frequent captions
- Larger (e.g. 15000) → longer captions that linger

## FAQ

**Q: Debug banner says "No captions captured within 30s"**
A: You forgot to enable YouTube's own CC button. The script hijacks caption requests — if CC is off, YouTube never makes the request.

**Q: Banner says "Parsed result empty"**
A: The video may use an unusual caption format. Open DevTools console and check for errors; please file an issue with the video URL.

**Q: Translation quality is bad or translation fails**
A: Check your DeepSeek balance, or switch to the Google engine to compare.

**Q: I edited the script but nothing changed**
A: Save in Tampermonkey (Ctrl+S) → **close and reopen** the YouTube tab (not just reload) → menu **Clear cache for current video**.

**Q: Subtitle position on the video is off**
A: Edit `#ytdsk-overlay { bottom: 12%; }` in the script — a larger value moves it higher.

**Q: I don't want the green debug banner**
A: Tampermonkey menu → **Toggle debug banner**, or edit `debugVisible: false` near the top of the script.

**Q: How much does it cost to translate one video?**
A: A 10-minute video uses roughly 2000–3000 input tokens plus a similar output — less than ¥0.01 on DeepSeek.

## Privacy

- All data is stored locally via Tampermonkey storage (`GM_setValue`). Nothing is uploaded to any server.
- Translation requests go **directly** to the official APIs (`api.deepseek.com` / `translate.googleapis.com`) — no proxy in between.
- Your API key is stored in your local browser only. The source is open and auditable.

## Changelog

- **0.10.0** Configurable translation pipeline:
  - Target language is now user-selectable via a new `Target language / 目标` menu command (defaults to `zh-CN` for Chinese UI, `en` for English UI)
  - Source language is auto-detected from YouTube's caption URL (`?lang=` parameter); displayed in the debug banner
  - DeepSeek prompt and Google `tl=` are dynamically built from the chosen target
  - When source equals target (same language), translation is skipped — the original captions become both lines instantly
  - Cue data fields renamed `en`/`zh` → `src`/`tgt`; CSS IDs renamed to match; multi-script font stack added (CJK + Latin + Arabic + Devanagari + Thai)
  - Cache key now includes the target language, so switching targets won't reuse stale translations
- **0.9.2** Added bilingual UI: menus, prompts, alerts and debug banner now follow `navigator.language` (Chinese for `zh-*`, English elsewhere). Added a `Language / 语言` menu entry to flip manually; choice persists via `GM_setValue`. Script source comments remain Chinese.
- **0.9.1** Rewrote the dedup pass in the subtitle parser to fix the "YouTube CC shows the sentence but the overlay skips it" bug:
  - Recognizes `aAppend === 1` rolling-caption frames in json3 (previously double-counted into the accumulator)
  - Three-way overlap dedup (exact duplicate / prefix-extension rolling / suffix-replay rolling); never discards events with genuinely different content (the root cause of the v0.9.0 "lazy dog" drop)
  - Render-side binary search uses "latest-started + 1.5s gap bridging" to eliminate flicker between cues
- **0.9.0** Rewrote subtitle parser: cross-event accumulation, punctuation-only splitting, 10s fallback. Fixed ASR captions being split mid-sentence at event boundaries (e.g. "I also teach around" / "50 students")
- **0.8.1** Fixed off-by-one in the comma-split heuristic
- **0.8.0** Reworked architecture to interception-based capture

## License

MIT — see [LICENSE](LICENSE).

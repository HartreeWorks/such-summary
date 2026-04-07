# Such Summary

Chrome extension that progressively summarises web articles using AI. Press **Alt+S** on any article to get:

1. **TL;DR** — 1–2 sentence summary
2. **Concise summary** — 5–8 bullet points
3. **Key quotes** — notable passages from the article

Also works with PDFs, YouTube videos, and Google Docs.

## Setup

1. Clone this repo
2. Go to `chrome://extensions/`, enable Developer mode
3. Click "Load unpacked" and select the `extension/` directory
4. Open the extension options and add your Anthropic API key

## How it works

The extension uses [Readability.js](https://github.com/mozilla/readability) to extract article content, then calls the Anthropic API directly to generate three progressive summary sections in parallel. Summaries are cached per URL.

Two modes are available:

- **Fast** — Claude Haiku (quick, cheap)
- **Best quality** — Claude Opus (slower, more thorough)

## Build

```bash
bash build.sh
```

Validates the extension, strips dev-only code, and packages a versioned zip for Chrome Web Store upload.

## Privacy

API keys are stored locally in your browser. Article content is sent directly to the Anthropic API — no intermediary servers.

Full privacy policy: https://wow.pjh.is/such-summary/privacy-policy

## Licence

MIT

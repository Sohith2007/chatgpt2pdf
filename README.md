# chatgpt2pdf

Turns a shared ChatGPT conversation link into a clean, readable PDF — markdown,
code with syntax highlighting, LaTeX math, and tables all preserved.

Ships as both a command line tool and a small local web app.

## Install

```bash
npm install
```

That pulls a private Chrome build for printing (~150 MB). If you would rather use
a browser you already have, set `CHROME_PATH`:

```bash
CHROME_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe" npm start
```

## Web app

```bash
npm start           # http://localhost:5178  (PORT overrides)
```

Paste a share link, pick options, preview the render in the page, download the PDF.

## Command line

```bash
node src/cli.js https://chatgpt.com/share/<id> -o chat.pdf
```

```
-o, --out <file>     output path (default: derived from the chat title)
    --html           also write the intermediate HTML next to the PDF
    --html-only      write only HTML, skip the PDF
    --json <file>    also dump the normalized conversation as JSON
    --from-json <f>  read a saved payload / data export instead of fetching
    --theme <name>   light | sepia | mono          (default: light)
    --page <size>    A4 | Letter | Legal           (default: A4)
    --tools          include tool / code-interpreter traffic
    --no-reasoning   drop reasoning summaries
    --no-timestamps  drop per-message timestamps
    --no-footer      drop the page-number footer
-q, --quiet          print only the output path
```

The link may be a full URL (`chatgpt.com/share/…`, `chat.openai.com/share/…`,
`/share/e/…`) or a bare share id.

## How it reads a conversation

Share pages are Cloudflare-fronted and render client-side, so extraction tries
four strategies in order and uses the first that yields messages:

1. a plain HTTPS call to `chatgpt.com/backend-api/share/<id>`
2. conversation JSON embedded in the server-rendered HTML
3. the same API call issued from inside headless Chrome, which inherits that
   browser's Cloudflare clearance
4. scraping the rendered DOM

If all four fail, the error lists what each one hit. Rendering then walks the
conversation tree (`linear_conversation`, or newest leaf back to the root),
drops system and hidden bookkeeping messages, and maps every content type
ChatGPT emits — text, multimodal parts, code, execution output, reasoning
summaries, and browsing quotes.

## Limitations

- **Public share links only.** A private `/c/<id>` link is visible only to your
  logged-in browser; it cannot be fetched here. Use **Share → Create link** first.
- **Images are not embedded.** Uploaded images live behind authenticated asset
  URLs, so they appear as labelled placeholders (`Image (1024×768)`).
- The share payload is OpenAI's private API shape and can change without notice.
  When it does, strategies 1–3 degrade to the DOM scrape, and `--from-json` lets
  you feed a saved payload directly.

## Tests

```bash
node test/smoke.mjs
```

Runs offline against a fixture payload: link parsing, tree normalization,
message filtering, markdown/math/code rendering, and a real PDF print.
Output lands in `test-output/`.

## License

MIT — see [LICENSE](LICENSE).

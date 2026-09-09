#!/usr/bin/env node
/** Command line entry point: share link (or saved JSON) -> PDF. */

import { writeFileSync, readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { extractConversation, normalizePayload } from './extract.js';
import { renderDocument, THEMES, DEFAULT_THEME } from './render.js';
import { htmlToPdf, getBrowser, closeBrowser } from './pdf.js';

const HELP = `
chatgpt2pdf \u2014 turn a shared ChatGPT conversation into a readable PDF

  usage: chatgpt2pdf <share-link> [options]

  options:
    -o, --out <file>     output path (default: derived from the chat title)
        --html           also write the intermediate HTML next to the PDF
        --html-only      write only HTML, skip the PDF
        --json <file>    also dump the normalized conversation as JSON
        --from-json <f>  read a saved share payload instead of fetching
        --theme <name>   light | sepia | mono | dark   (default: light)
        --dark           shorthand for --theme dark
        --page <size>    A4 | Letter | Legal           (default: A4)
        --tools          include tool / code-interpreter traffic
        --no-reasoning   drop reasoning summaries
        --no-timestamps  drop per-message timestamps
        --no-footer      drop the page-number footer
    -q, --quiet          only print the output path
    -h, --help           show this help

  examples:
    chatgpt2pdf https://chatgpt.com/share/68c1a0f4-...  -o chat.pdf
    chatgpt2pdf https://chatgpt.com/share/68c1a0f4-...  --theme sepia --tools
    chatgpt2pdf https://chatgpt.com/share/68c1a0f4-...  --dark -o chat-dark.pdf
`;

const FLAGS = {
  '--html': 'html',
  '--html-only': 'htmlOnly',
  '--tools': 'includeTools',
  '--no-reasoning': 'noReasoning',
  '--no-timestamps': 'noTimestamps',
  '--no-footer': 'noFooter',
  '-q': 'quiet',
  '--quiet': 'quiet',
};
const VALUES = {
  '-o': 'out', '--out': 'out',
  '--json': 'json',
  '--from-json': 'fromJson',
  '--theme': 'theme',
  '--page': 'pageSize',
};

function parseArgs(argv) {
  const opts = { theme: DEFAULT_THEME, pageSize: 'A4' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return { help: true };
    if (a === '--dark') opts.theme = 'dark';
    else if (FLAGS[a]) opts[FLAGS[a]] = true;
    else if (VALUES[a]) {
      const v = argv[++i];
      if (v == null) throw new Error(`${a} needs a value`);
      opts[VALUES[a]] = v;
    } else if (a.startsWith('-')) throw new Error(`Unknown option: ${a}`);
    else rest.push(a);
  }
  opts.theme = String(opts.theme).toLowerCase();
  if (!THEMES.includes(opts.theme)) {
    throw new Error(`Unknown theme "${opts.theme}". Choose one of: ${THEMES.join(', ')}`);
  }
  opts.link = rest[0];
  return opts;
}

const slug = (s) =>
  String(s || 'chatgpt-conversation')
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, 80)
    .replace(/^[-.]+|[-.]+$/g, '') || 'chatgpt-conversation';

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n${HELP}`);
    process.exit(2);
  }
  if (opts.help || (!opts.link && !opts.fromJson)) {
    console.log(HELP);
    process.exit(opts.help ? 0 : 2);
  }

  const log = (...a) => { if (!opts.quiet) console.error(...a); };

  let conv;
  if (opts.fromJson) {
    let raw = JSON.parse(readFileSync(opts.fromJson, 'utf8'));
    if (Array.isArray(raw)) {
      // An OpenAI data export (conversations.json) holds many chats.
      if (!raw.length) throw new Error(`${opts.fromJson} contains no conversations`);
      if (raw.length > 1) log(`${raw.length} conversations in file; using the first ("${raw[0].title}")`);
      [raw] = raw;
    }
    const src = opts.link || `file://${opts.fromJson}`;
    if (Array.isArray(raw.messages) && !raw.mapping && !raw.linear_conversation) {
      conv = { url: src, ...raw }; // already normalized (an earlier --json dump)
    } else {
      const payload = raw.mapping || raw.linear_conversation ? raw : raw.data || raw.serverResponse || raw;
      conv = normalizePayload(payload, src);
    }
    log(`read ${conv.messages.length} messages from ${basename(opts.fromJson)}`);
  } else {
    log(`fetching ${opts.link}`);
    conv = await extractConversation(opts.link, {
      getBrowser,
      onProgress: (m) => log(`  ${m}`),
    });
    log(`got "${conv.title}" \u2014 ${conv.messages.length} messages (via ${conv.source})`);
  }

  const html = renderDocument(conv, {
    theme: opts.theme,
    pageSize: opts.pageSize,
    timestamps: !opts.noTimestamps,
    includeTools: Boolean(opts.includeTools),
    reasoning: !opts.noReasoning,
  });

  const base = opts.out ? opts.out.replace(/\.(pdf|html)$/i, '') : slug(conv.title);
  const pdfPath = opts.out && extname(opts.out).toLowerCase() === '.pdf' ? opts.out : `${base}.pdf`;
  const htmlPath = `${base}.html`;

  if (opts.json) {
    writeFileSync(opts.json, JSON.stringify(conv, null, 2));
    log(`wrote ${opts.json}`);
  }
  if (opts.html || opts.htmlOnly) {
    writeFileSync(htmlPath, html);
    log(`wrote ${htmlPath}`);
    if (opts.htmlOnly) return console.log(htmlPath);
  }

  log('printing PDF...');
  await htmlToPdf(html, {
    path: pdfPath,
    pageSize: opts.pageSize,
    title: conv.title,
    footer: !opts.noFooter,
    theme: opts.theme,
  });
  console.log(pdfPath);
}

main()
  .catch((err) => {
    console.error(`\nerror: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(closeBrowser);

/**
 * Rendering layer: normalized conversation -> a single self-contained HTML
 * document tuned for print (no network fetches, so it also works offline).
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { marked } from 'marked';
import katex from 'katex';
import hljs from 'highlight.js';

const require = createRequire(import.meta.url);
const KATEX_CSS = readFileSync(require.resolve('katex/dist/katex.min.css'), 'utf8').replace(
  /url\((?!data:)[^)]*\)/g, // drop external font refs; katex falls back to system math glyphs
  'local("KaTeX_Main")',
);

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/* ------------------------------------------------------------------ markdown */

marked.setOptions({ gfm: true, breaks: false });

// marked v12 passes positional args, v13+ passes a token object. Accept both.
const renderer = new marked.Renderer();

renderer.code = function (code, infostring) {
  const [text, lang] =
    code && typeof code === 'object' ? [code.text, code.lang] : [code, infostring];
  return highlight(text || '', String(lang || '').split(/\s+/)[0]);
};

renderer.link = function (href, title, text) {
  let label = text;
  if (href && typeof href === 'object') {
    label = href.tokens ? this.parser.parseInline(href.tokens) : href.text;
    ({ title } = href);
    ({ href } = href);
  }
  const safe = /^(https?:|mailto:|#)/i.test(href || '') ? href : '#';
  return `<a href="${esc(safe)}"${title ? ` title="${esc(title)}"` : ''}>${label || esc(href)}</a>`;
};

// Images in shared chats point at authenticated asset URLs that will not load.
renderer.image = function (href, title, text) {
  if (href && typeof href === 'object') ({ href, title, text } = href);
  return /^(https?:|data:)/i.test(href || '')
    ? `<img src="${esc(href)}" alt="${esc(text)}">`
    : `<span class="attachment">Image: ${esc(text || href || 'attachment')}</span>`;
};

const GENERIC_LANGS = new Set(['text', 'txt', 'plaintext', 'plain', 'none', 'nohighlight', 'markdown', 'md']);

function highlight(code, lang) {
  const text = String(code || '');
  const known = lang && hljs.getLanguage(lang) ? lang : '';
  let body;

  if (known) {
    try {
      body = hljs.highlight(text, { language: known, ignoreIllegals: true }).value;
    } catch {
      body = esc(text);
    }
  } else if (text.length > 60 && text.includes('\n')) {
    // Auto-detection only earns its keep on a real snippet. Chats are full of
    // one-word fences ("Users", "Cache") where the guess is noise, and its
    // label would add a header bar to every one of them.
    try {
      body = hljs.highlightAuto(text).value;
    } catch {
      body = esc(text);
    }
  } else {
    body = esc(text);
  }

  // Only a language the author declared *and* that says something is worth a
  // header bar; chats mark thousands of fences "text", which labels nothing.
  const label = lang && !GENERIC_LANGS.has(lang.toLowerCase()) ? esc(lang) : '';
  // Short blocks stay whole; a tall one must be allowed to split, or it pushes
  // a mostly empty page ahead of itself.
  const lines = text.split('\n').length;
  const shape = lines === 1 ? ' oneline' : lines > 12 ? ' tall' : '';
  return `<figure class="code${shape}"${label ? ` data-lang="${label}"` : ''}><pre><code class="hljs">${body}</code></pre></figure>`;
}

/* ---------------------------------------------------------------------- math */

function renderMathSegment(tex, display) {
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'html' });
  } catch {
    return `<code>${esc(tex)}</code>`;
  }
}

/**
 * Markdown -> HTML. Code spans are stashed before math runs (so `$x$` inside a
 * code block stays literal), and math output is stashed before markdown runs
 * (so KaTeX markup is not re-parsed as emphasis).
 */
export function renderMarkdown(md) {
  const code = [];
  let text = String(md).replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`/g, (m) => {
    code.push(m);
    return `q7xC${code.length - 1}q7x`;
  });

  const math = [];
  const stashMath = (tex, display) => {
    math.push(renderMathSegment(tex, display));
    return `q7xM${math.length - 1}q7x`;
  };
  text = text
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => stashMath(tex, true))
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => stashMath(tex, true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => stashMath(tex, false))
    .replace(/(?<![\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\w)/g, (_, tex) => stashMath(tex, false));

  text = text.replace(/q7xC(\d+)q7x/g, (_, i) => code[Number(i)]);
  let html = marked.parse(text, { renderer });
  html = html.replace(/q7xM(\d+)q7x/g, (_, i) => math[Number(i)]);
  // A display equation on its own line lands inside a <p>; lift it back out.
  return html.replace(
    new RegExp('<p>(\\s*<span class="katex-display">[\\s\\S]*?<\\/span>\\s*)<\\/p>', 'g'),
    '$1',
  );
}

/* ------------------------------------------------------------------ messages */

const ROLE_LABELS = { user: 'You', assistant: 'ChatGPT', tool: 'Tool', system: 'System' };

function renderPart(part) {
  switch (part.kind) {
    case 'markdown':
      return renderMarkdown(part.text);
    case 'html':
      return `<div class="raw">${part.html}</div>`;
    case 'code':
      return highlight(part.text, part.language);
    case 'output':
      return `<figure class="code output" data-lang="output"><pre><code>${esc(part.text)}</code></pre></figure>`;
    case 'reasoning':
      return `<aside class="reasoning"><span class="tag">Reasoning</span>${renderMarkdown(part.text)}</aside>`;
    case 'quote':
      return (
        `<blockquote class="cited">${renderMarkdown(part.text)}` +
        (part.url ? `<cite>${esc(part.url)}</cite>` : '') +
        '</blockquote>'
      );
    case 'attachment':
      return `<p class="attachment">${esc(part.label)}${part.detail ? ` (${esc(part.detail)})` : ''}</p>`;
    default:
      return '';
  }
}

const fmtTime = (unix) => {
  if (!unix) return '';
  const d = new Date(unix * 1000);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
};

function renderMessage(msg, index, opts) {
  const role = msg.role === 'user' ? 'user' : msg.isTool ? 'tool' : msg.role;
  const label = msg.isTool && msg.name ? `Tool · ${esc(msg.name)}` : ROLE_LABELS[role] || esc(role);
  const stamp = opts.timestamps ? fmtTime(msg.createTime) : '';
  const body = msg.parts.map(renderPart).join('\n');
  return `<article class="msg ${esc(role)}" id="m${index}">
  <header><span class="who">${label}</span>${stamp ? `<time>${esc(stamp)}</time>` : ''}</header>
  <div class="body">${body}</div>
</article>`;
}

/* ---------------------------------------------------------------------- page */

function styles(theme) {
  const themes = {
    light: { page: '#ffffff', ink: '#16181d', muted: '#6b7280', rule: '#e3e6ec', userBg: '#f3f5f9', codeBg: '#f6f8fa', accent: '#10a37f' },
    sepia: { page: '#fbf7ef', ink: '#2a2622', muted: '#7a6f61', rule: '#e6dccb', userBg: '#f3ebdd', codeBg: '#f5eee1', accent: '#a2704a' },
    mono:  { page: '#ffffff', ink: '#000000', muted: '#555555', rule: '#d0d0d0', userBg: '#f2f2f2', codeBg: '#f4f4f4', accent: '#000000' },
  };
  const t = themes[theme] || themes.light;
  return `
${KATEX_CSS}
:root {
  --page:${t.page}; --ink:${t.ink}; --muted:${t.muted}; --rule:${t.rule};
  --user-bg:${t.userBg}; --code-bg:${t.codeBg}; --accent:${t.accent};
  --sans: "Segoe UI", Inter, -apple-system, system-ui, Roboto, Helvetica, Arial, sans-serif;
  --mono: "Cascadia Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
}
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body {
  margin: 0; background: var(--page); color: var(--ink);
  font: 10.5pt/1.62 var(--sans);
  overflow-wrap: break-word; word-break: break-word;
}
.doc { max-width: 46rem; margin: 0 auto; padding: 0 0 2rem; }

.cover { border-bottom: 2px solid var(--accent); padding-bottom: 1rem; margin-bottom: 1.6rem; }
.cover h1 { font-size: 20pt; line-height: 1.25; margin: 0 0 .5rem; letter-spacing: -0.01em; }
.cover dl { display: grid; grid-template-columns: max-content 1fr; gap: .18rem .8rem; margin: 0; font-size: 8.5pt; color: var(--muted); }
.cover dt { text-transform: uppercase; letter-spacing: .06em; font-size: 7.5pt; padding-top: .1rem; }
.cover dd { margin: 0; word-break: break-all; }

.msg { margin: 0 0 1.15rem; padding-bottom: .3rem; }
.msg header { display: flex; align-items: baseline; gap: .5rem; margin-bottom: .3rem; break-after: avoid; }
.msg .who { font-size: 8pt; font-weight: 700; text-transform: uppercase; letter-spacing: .09em; color: var(--accent); }
.msg.user .who { color: var(--muted); }
.msg.tool .who { color: var(--muted); }
.msg time { font-size: 7.5pt; color: var(--muted); }
.msg .body > *:first-child { margin-top: 0; }
.msg .body > *:last-child { margin-bottom: 0; }

.msg.user .body {
  background: var(--user-bg); border-left: 3px solid var(--rule);
  padding: .55rem .8rem; border-radius: 0 4px 4px 0;
}
.msg.assistant { border-bottom: 1px solid var(--rule); }
.msg.tool .body { font-size: 9.5pt; color: var(--muted); border-left: 2px dotted var(--rule); padding-left: .8rem; }

p { margin: 0 0 .62rem; }
h1, h2, h3, h4, h5 { line-height: 1.3; margin: 1rem 0 .45rem; break-after: avoid; }
h1 { font-size: 15pt; } h2 { font-size: 13pt; } h3 { font-size: 11.5pt; } h4 { font-size: 10.5pt; }
ul, ol { margin: 0 0 .62rem; padding-left: 1.35rem; }
li { margin: .12rem 0; }
li > p { margin: 0 0 .3rem; }
hr { border: none; border-top: 1px solid var(--rule); margin: 1rem 0; }
a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
strong { font-weight: 650; }

code { font: 9pt/1.5 var(--mono); background: var(--code-bg); padding: .1em .32em; border-radius: 3px; }
figure.code {
  margin: .45rem 0; background: var(--code-bg); border: 1px solid var(--rule);
  border-radius: 5px; overflow: hidden; break-inside: avoid;
}
/* Chats fence single words constantly; those must not cost a full block. */
figure.code.oneline { margin: .3rem 0; }
figure.code.tall { break-inside: auto; }
figure.code.oneline pre { padding: .2rem .5rem; }
figure.code[data-lang]::before {
  content: attr(data-lang); display: block; font: 7pt var(--mono); letter-spacing: .08em;
  text-transform: uppercase; color: var(--muted); padding: .25rem .6rem;
  border-bottom: 1px solid var(--rule);
}
figure.code pre { margin: 0; padding: .45rem .65rem; overflow: visible; white-space: pre-wrap; }
figure.code code { background: none; padding: 0; font-size: 8.6pt; }
figure.code.output pre { color: var(--muted); }

blockquote { margin: .6rem 0; padding-left: .85rem; border-left: 3px solid var(--rule); color: var(--muted); }
blockquote cite { display: block; font-size: 8pt; font-style: normal; word-break: break-all; margin-top: .3rem; }
.reasoning {
  margin: .6rem 0; padding: .5rem .75rem; border: 1px dashed var(--rule);
  border-radius: 5px; font-size: 9.5pt; color: var(--muted); break-inside: avoid;
}
.reasoning .tag { display: block; font-size: 7pt; font-weight: 700; letter-spacing: .09em; text-transform: uppercase; margin-bottom: .25rem; }
.attachment { display: inline-block; font-size: 8.5pt; color: var(--muted); border: 1px solid var(--rule); border-radius: 4px; padding: .1rem .45rem; }

table { border-collapse: collapse; width: 100%; margin: .6rem 0; font-size: 9pt; break-inside: avoid; }
th, td { border: 1px solid var(--rule); padding: .3rem .5rem; text-align: left; vertical-align: top; }
th { background: var(--code-bg); font-weight: 650; }
img { max-width: 100%; height: auto; }
.katex-display { margin: .6rem 0; overflow-x: auto; }

/* hand-rolled highlight palette: readable in color and in grayscale print */
.hljs-comment, .hljs-quote { color: #6a737d; font-style: italic; }
.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-doctag, .hljs-name { color: #cf222e; }
.hljs-string, .hljs-regexp, .hljs-addition, .hljs-attribute, .hljs-meta .hljs-string { color: #0a6640; }
.hljs-number, .hljs-symbol, .hljs-bullet, .hljs-variable, .hljs-template-variable, .hljs-literal { color: #953800; }
.hljs-title, .hljs-section, .hljs-title.function_ { color: #6639ba; }
.hljs-type, .hljs-class .hljs-title, .hljs-built_in { color: #0550ae; }
.hljs-attr, .hljs-property, .hljs-selector-attr, .hljs-selector-class { color: #0550ae; }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 700; }
.hljs-deletion { color: #82071e; }

@page { size: __PAGE_SIZE__; margin: 16mm 14mm 18mm; }
@media print {
  .doc { max-width: none; padding: 0; }
  .msg { break-inside: auto; }
  .msg header { break-after: avoid; }
  h1, h2, h3 { break-after: avoid; }
  figure.code, table, .reasoning { break-inside: avoid; }
  figure.code.tall { break-inside: auto; }
}
@media screen { body { padding: 2rem 1.25rem; } }
`;
}

/**
 * @param {object} conv    output of extractConversation()
 * @param {object} options { theme, pageSize, timestamps, includeTools }
 */
export function renderDocument(conv, options = {}) {
  const opts = {
    theme: 'light',
    pageSize: 'A4',
    timestamps: true,
    includeTools: false,
    reasoning: true,
    ...options,
  };
  const shown = conv.messages
    .filter((m) => opts.includeTools || (!m.isTool && m.role !== 'tool'))
    .map((m) => (opts.reasoning ? m : { ...m, parts: m.parts.filter((p) => p.kind !== 'reasoning') }))
    .filter((m) => m.parts.length);

  const meta = [
    ['Source', conv.url],
    conv.model ? ['Model', conv.model] : null,
    conv.createTime ? ['Started', fmtTime(conv.createTime)] : null,
    ['Messages', String(shown.length)],
    ['Exported', new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })],
  ].filter(Boolean);

  const body = shown.map((m, i) => renderMessage(m, i, opts)).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(conv.title)}</title>
<style>${styles(opts.theme).replace('__PAGE_SIZE__', esc(opts.pageSize))}</style>
</head>
<body>
<main class="doc">
  <header class="cover">
    <h1>${esc(conv.title)}</h1>
    <dl>${meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
  </header>
${body}
</main>
</body>
</html>`;
}

export { esc };

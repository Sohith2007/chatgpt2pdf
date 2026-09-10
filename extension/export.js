/**
 * ChatGPT2PDF — Export Page Renderer
 *
 * Paper & Ink editorial aesthetic. Reads conversation data from chrome.storage.local,
 * applies typographic rules, renders markdown/code/math, and provides an interactive
 * preview toolbar with live theme switching before printing.
 */

(function () {
  'use strict';

  /* ────────────────────────── utilities ─────────────────────────────── */

  const esc = (s) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  /* ────────────────────────── themes ────────────────────────────────── */

  const THEMES = ['light', 'sepia', 'dark', 'mono'];
  const resolveTheme = (name) => (THEMES.includes(name) ? name : 'light');

  const HL_LIGHT = {
    comment: '#7a7067', keyword: '#b34728', string: '#2d6d4b',
    number: '#964816', title: '#5e439b', type: '#185699',
    attr: '#185699', deletion: '#8a2323',
  };
  const HL_DARK = {
    comment: '#8f8377', keyword: '#e67355', string: '#7ebc9a',
    number: '#e29056', title: '#bda3eb', type: '#72a9e3',
    attr: '#72a9e3', deletion: '#e0766e',
  };

  const THEME_TOKENS = {
    light: {
      page: '#fdfbf7', ink: '#24201d', muted: '#766b62', rule: '#e6ded4',
      userBg: '#f5efe4', codeBg: '#f2ece1', accent: '#c45d3e',
      tbBg: 'rgba(253, 251, 247, 0.92)', tbBorder: '#e6ded4',
      hl: HL_LIGHT,
    },
    sepia: {
      page: '#f6f0e2', ink: '#2d251e', muted: '#7d6f5f', rule: '#e2d6c2',
      userBg: '#ece0cc', codeBg: '#e9dcbe', accent: '#a64f33',
      tbBg: 'rgba(246, 240, 226, 0.92)', tbBorder: '#e2d6c2',
      hl: HL_LIGHT,
    },
    dark: {
      page: '#1e1a17', ink: '#ece2d7', muted: '#9a8d81', rule: '#38302a',
      userBg: '#29231f', codeBg: '#26201c', accent: '#d96a4a',
      tbBg: 'rgba(30, 26, 23, 0.92)', tbBorder: '#38302a',
      hl: HL_DARK,
    },
    mono: {
      page: '#ffffff', ink: '#111111', muted: '#555555', rule: '#d8d8d8',
      userBg: '#f5f5f5', codeBg: '#f4f4f4', accent: '#222222',
      tbBg: 'rgba(255, 255, 255, 0.94)', tbBorder: '#d8d8d8',
      hl: HL_LIGHT,
    },
  };

  function buildThemeCSS(theme, pageSize) {
    const t = THEME_TOKENS[resolveTheme(theme)];
    const h = t.hl;
    return `
:root {
  --page: ${t.page}; --ink: ${t.ink}; --muted: ${t.muted}; --rule: ${t.rule};
  --user-bg: ${t.userBg}; --code-bg: ${t.codeBg}; --accent: ${t.accent};
  --tb-bg: ${t.tbBg}; --tb-border: ${t.tbBorder};
  --hl-comment: ${h.comment}; --hl-keyword: ${h.keyword}; --hl-string: ${h.string};
  --hl-number: ${h.number}; --hl-title: ${h.title}; --hl-type: ${h.type};
  --hl-attr: ${h.attr}; --hl-deletion: ${h.deletion};
  --serif: "Copernicus", "Tiempos Headline", "Tiempos Text", "Tiempos", "Source Serif 4", "Iowan Old Style", "Palatino Linotype", "Palatino", Georgia, serif;
  --sans: "Styrene B", "Styrene A", "Styrene", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --mono: "Fira Code", "Cascadia Code", Consolas, "Liberation Mono", Menlo, monospace;
}

* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; background: var(--page); }
body {
  margin: 0; background: var(--page); color: var(--ink);
  font: 11pt/1.65 var(--sans);
  overflow-wrap: break-word; word-break: break-word;
}

/* ── Top Toolbar ── */
.print-toolbar {
  position: sticky;
  top: 0;
  z-index: 1000;
  background: var(--tb-bg);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--tb-border);
  padding: 10px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  box-shadow: 0 2px 10px rgba(0,0,0,0.03);
}
.toolbar-left {
  display: flex;
  align-items: center;
  gap: 14px;
}
.tb-btn-primary {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 8px 18px;
  font: italic 600 13px/1 var(--serif);
  letter-spacing: 0.01em;
  color: #fdf6f0;
  background: var(--accent);
  border: none;
  border-radius: 7px;
  cursor: pointer;
  box-shadow: 0 1px 4px rgba(0,0,0,0.15);
  transition: transform 0.15s ease, filter 0.15s ease, box-shadow 0.15s ease;
}
.tb-btn-primary:hover {
  filter: brightness(1.08);
  transform: translateY(-1px);
  box-shadow: 0 3px 10px rgba(0,0,0,0.2);
}
.tb-btn-primary:active {
  transform: translateY(1px);
}
.tb-divider {
  width: 1px;
  height: 20px;
  background: var(--rule);
}
.theme-switcher {
  display: flex;
  background: rgba(120, 100, 80, 0.07);
  border: 1px solid var(--rule);
  border-radius: 6px;
  padding: 2px;
}
.theme-btn {
  background: none;
  border: none;
  padding: 5px 12px;
  font: 500 11px/1.2 var(--sans);
  color: var(--muted);
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.15s ease;
}
.theme-btn:hover {
  color: var(--ink);
}
.theme-btn.active {
  background: var(--accent);
  color: #fff;
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(0,0,0,0.15);
}
.toolbar-right .info {
  font: italic 11.5px/1.3 var(--serif);
  color: var(--muted);
}

/* ── Main Manuscript Document ── */
.doc {
  max-width: 46rem;
  margin: 0 auto;
  padding: 2.5rem 1.5rem 4rem;
}

/* Loading state */
.doc-loading {
  text-align: center;
  padding: 4rem 1rem;
  color: var(--muted);
  font-style: italic;
  font-family: var(--serif);
}

/* Cover / Header */
.cover {
  border-bottom: 2px solid var(--accent);
  padding-bottom: 1.2rem;
  margin-bottom: 2rem;
}
.cover .kicker {
  display: block;
  font: 600 8.5pt/1 var(--sans);
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--accent);
  margin-bottom: 0.5rem;
}
.cover h1 {
  font: italic 700 22pt/1.2 var(--serif);
  margin: 0 0 0.8rem;
  letter-spacing: -0.015em;
  color: var(--ink);
}
.cover dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.25rem 1rem;
  margin: 0;
  font: 8.5pt/1.4 var(--sans);
  color: var(--muted);
}
.cover dt {
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 7.5pt;
  padding-top: 0.1rem;
  font-weight: 600;
}
.cover dd {
  margin: 0;
  word-break: break-all;
}
.cover dd a {
  color: inherit;
  text-decoration: none;
}
.cover dd a:hover {
  text-decoration: underline;
}

/* Messages */
.msg {
  margin: 0 0 1.4rem;
  padding-bottom: 0.4rem;
}
.msg header {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  margin-bottom: 0.4rem;
  break-after: avoid;
}
.msg .who {
  font: 700 8pt/1 var(--sans);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--accent);
}
.msg.user .who {
  color: var(--muted);
}
.msg.tool .who {
  color: var(--muted);
}
.msg time {
  font-size: 7.5pt;
  color: var(--muted);
}
.msg .body > *:first-child { margin-top: 0; }
.msg .body > *:last-child { margin-bottom: 0; }

.msg.user .body {
  background: var(--user-bg);
  border-left: 3px solid var(--accent);
  padding: 0.75rem 1rem;
  border-radius: 0 6px 6px 0;
  font: 10pt/1.55 var(--sans);
}
.msg.assistant .body {
  font: 11pt/1.7 var(--serif);
}
.msg.assistant {
  border-bottom: 1px solid var(--rule);
  padding-bottom: 1.2rem;
}
.msg.tool .body {
  font-size: 9.5pt;
  color: var(--muted);
  border-left: 2px dashed var(--rule);
  padding-left: 0.9rem;
}

/* Typography elements */
p { margin: 0 0 0.75rem; }
h1, h2, h3, h4, h5 {
  font-family: var(--serif);
  line-height: 1.25;
  margin: 1.2rem 0 0.5rem;
  break-after: avoid;
  color: var(--ink);
}
h1 { font-size: 16pt; }
h2 { font-size: 13.5pt; }
h3 { font-size: 12pt; }
h4 { font-size: 11pt; }
ul, ol { margin: 0 0 0.75rem; padding-left: 1.4rem; }
li { margin: 0.15rem 0; }
li > p { margin: 0 0 0.35rem; }
hr { border: none; border-top: 1px solid var(--rule); margin: 1.2rem 0; }
a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
strong { font-weight: 650; }

/* Inline Code & Code Blocks */
code {
  font: 9pt/1.5 var(--mono);
  background: var(--code-bg);
  padding: 0.12em 0.36em;
  border-radius: 4px;
}
figure.code {
  margin: 0.6rem 0;
  background: var(--code-bg);
  border: 1px solid var(--rule);
  border-radius: 6px;
  overflow: hidden;
  break-inside: avoid;
}
figure.code.oneline { margin: 0.35rem 0; }
figure.code.tall { break-inside: auto; }
figure.code.oneline pre { padding: 0.3rem 0.6rem; }
figure.code[data-lang]::before {
  content: attr(data-lang);
  display: block;
  font: 600 7pt/1 var(--mono);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
  padding: 0.35rem 0.75rem;
  border-bottom: 1px solid var(--rule);
  background: rgba(120, 100, 80, 0.03);
}
figure.code pre {
  margin: 0;
  padding: 0.6rem 0.8rem;
  overflow: visible;
  white-space: pre-wrap;
}
figure.code code {
  background: none;
  padding: 0;
  font-size: 8.8pt;
}
figure.code.output pre { color: var(--muted); }

/* Blockquotes & Citations */
blockquote {
  margin: 0.8rem 0;
  padding: 0.2rem 0 0.2rem 1rem;
  border-left: 3px solid var(--rule);
  color: var(--muted);
  font-style: italic;
}
blockquote cite {
  display: block;
  font-size: 8pt;
  font-style: normal;
  word-break: break-all;
  margin-top: 0.4rem;
}

/* Reasoning blocks */
.reasoning {
  margin: 0.8rem 0;
  padding: 0.65rem 0.9rem;
  border: 1px dashed var(--rule);
  border-radius: 6px;
  font-size: 9.5pt;
  color: var(--muted);
  background: rgba(120, 100, 80, 0.02);
  break-inside: avoid;
}
.reasoning .tag {
  display: block;
  font: 700 7pt/1 var(--sans);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--accent);
  margin-bottom: 0.35rem;
}

/* Attachments */
.attachment {
  display: inline-block;
  font-size: 8.5pt;
  color: var(--muted);
  border: 1px solid var(--rule);
  border-radius: 4px;
  padding: 0.15rem 0.5rem;
  background: var(--code-bg);
}

/* Tables */
table {
  border-collapse: collapse;
  width: 100%;
  margin: 0.8rem 0;
  font-size: 9pt;
  break-inside: avoid;
}
th, td {
  border: 1px solid var(--rule);
  padding: 0.4rem 0.6rem;
  text-align: left;
  vertical-align: top;
}
th {
  background: var(--code-bg);
  font-weight: 650;
  font-family: var(--sans);
}
img { max-width: 100%; height: auto; border-radius: 4px; }
.katex-display { margin: 0.8rem 0; overflow-x: auto; }

/* Syntax Highlighting */
.hljs-comment,.hljs-quote{color:var(--hl-comment);font-style:italic}
.hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-doctag,.hljs-name{color:var(--hl-keyword);font-weight:600}
.hljs-string,.hljs-regexp,.hljs-addition,.hljs-attribute,.hljs-meta .hljs-string{color:var(--hl-string)}
.hljs-number,.hljs-symbol,.hljs-bullet,.hljs-variable,.hljs-template-variable,.hljs-literal{color:var(--hl-number)}
.hljs-title,.hljs-section,.hljs-title.function_{color:var(--hl-title)}
.hljs-type,.hljs-class .hljs-title,.hljs-built_in{color:var(--hl-type)}
.hljs-attr,.hljs-property,.hljs-selector-attr,.hljs-selector-class{color:var(--hl-attr)}
.hljs-emphasis{font-style:italic}
.hljs-strong{font-weight:700}
.hljs-deletion{color:var(--hl-deletion)}

/* Print Page Rules */
@page {
  size: ${esc(pageSize)};
  margin: 16mm 14mm 18mm;
}
@media print {
  .doc { max-width: none; padding: 0; }
  .msg { break-inside: auto; }
  .msg header { break-after: avoid; }
  h1, h2, h3 { break-after: avoid; }
  figure.code, table, .reasoning { break-inside: avoid; }
  figure.code.tall { break-inside: auto; }
  .print-toolbar { display: none !important; }
}
`;
  }

  /* ────────────────────────── markdown + math ───────────────────────── */

  const GENERIC_LANGS = new Set([
    'text','txt','plaintext','plain','none','nohighlight','markdown','md',
  ]);

  function doHighlight(code, lang) {
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
      try {
        body = hljs.highlightAuto(text).value;
      } catch {
        body = esc(text);
      }
    } else {
      body = esc(text);
    }
    const label =
      lang && !GENERIC_LANGS.has(lang.toLowerCase()) ? esc(lang) : '';
    const lines = text.split('\n').length;
    const shape = lines === 1 ? ' oneline' : lines > 12 ? ' tall' : '';
    return (
      '<figure class="code' + shape + '"' +
      (label ? ' data-lang="' + label + '"' : '') +
      '><pre><code class="hljs">' + body + '</code></pre></figure>'
    );
  }

  function renderMathSegment(tex, display) {
    try {
      return katex.renderToString(tex, {
        displayMode: display,
        throwOnError: false,
        output: 'html',
      });
    } catch {
      return '<code>' + esc(tex) + '</code>';
    }
  }

  function renderMarkdown(md) {
    const codeStash = [];
    let text = String(md).replace(
      /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`/g,
      (m) => {
        codeStash.push(m);
        return 'q7xC' + (codeStash.length - 1) + 'q7x';
      }
    );

    const mathStash = [];
    const stashMath = (tex, display) => {
      mathStash.push(renderMathSegment(tex, display));
      return 'q7xM' + (mathStash.length - 1) + 'q7x';
    };
    text = text
      .replace(/\\\[([^]*?)\\\]/g, (_, tex) => stashMath(tex, true))
      .replace(/\$\$([^]*?)\$\$/g, (_, tex) => stashMath(tex, true))
      .replace(/\\\(([^]*?)\\\)/g, (_, tex) => stashMath(tex, false))
      .replace(/(?<![\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\w)/g, (_, tex) =>
        stashMath(tex, false)
      );

    text = text.replace(/q7xC(\d+)q7x/g, (_, i) => codeStash[Number(i)]);
    let html = marked.parse(text, { renderer: mdRenderer });
    html = html.replace(/q7xM(\d+)q7x/g, (_, i) => mathStash[Number(i)]);
    // Lift display math out of <p> tags
    return html.replace(
      /<p>(\s*<span class="katex-display">[\s\S]*?<\/span>\s*)<\/p>/g,
      '$1'
    );
  }

  /* ────────────────────────── marked config ─────────────────────────── */

  marked.setOptions({ gfm: true, breaks: false });
  const mdRenderer = new marked.Renderer();

  mdRenderer.code = function (code, infostring) {
    const [text, lang] =
      code && typeof code === 'object'
        ? [code.text, code.lang]
        : [code, infostring];
    return doHighlight(text || '', String(lang || '').split(/\s+/)[0]);
  };

  mdRenderer.link = function (href, title, text) {
    let label = text;
    if (href && typeof href === 'object') {
      label = href.tokens
        ? this.parser.parseInline(href.tokens)
        : href.text;
      title = href.title;
      href = href.href;
    }
    const safe = /^(https?:|mailto:|#)/i.test(href || '') ? href : '#';
    return (
      '<a href="' + esc(safe) + '"' +
      (title ? ' title="' + esc(title) + '"' : '') + '>' +
      (label || esc(href)) + '</a>'
    );
  };

  mdRenderer.image = function (href, title, text) {
    if (href && typeof href === 'object') ({ href, title, text } = href);
    return /^(https?:|data:)/i.test(href || '')
      ? '<img src="' + esc(href) + '" alt="' + esc(text) + '">'
      : '<span class="attachment">Image: ' +
          esc(text || href || 'attachment') + '</span>';
  };

  /* ────────────────────────── message rendering ─────────────────────── */

  const ROLE_LABELS = {
    user: 'You',
    assistant: 'ChatGPT',
    tool: 'Tool',
    system: 'System',
  };

  const fmtTime = (unix) => {
    if (!unix) return '';
    const d = new Date(unix * 1000);
    return Number.isNaN(d.getTime())
      ? ''
      : d.toLocaleString('en-US', {
          dateStyle: 'medium',
          timeStyle: 'short',
        });
  };

  function renderPart(part) {
    switch (part.kind) {
      case 'markdown':
        return renderMarkdown(part.text);
      case 'html':
        return '<div class="raw">' + part.html + '</div>';
      case 'code':
        return doHighlight(part.text, part.language);
      case 'output':
        return (
          '<figure class="code output" data-lang="output"><pre><code>' +
          esc(part.text) + '</code></pre></figure>'
        );
      case 'reasoning':
        return (
          '<aside class="reasoning"><span class="tag">Reasoning</span>' +
          renderMarkdown(part.text) + '</aside>'
        );
      case 'quote':
        return (
          '<blockquote class="cited">' + renderMarkdown(part.text) +
          (part.url ? '<cite>' + esc(part.url) + '</cite>' : '') +
          '</blockquote>'
        );
      case 'attachment':
        return (
          '<p class="attachment">' + esc(part.label) +
          (part.detail ? ' (' + esc(part.detail) + ')' : '') + '</p>'
        );
      default:
        return '';
    }
  }

  function renderMessage(msg, index, opts) {
    const role =
      msg.role === 'user' ? 'user' : msg.isTool ? 'tool' : msg.role;
    const label =
      msg.isTool && msg.name
        ? 'Tool \u00b7 ' + esc(msg.name)
        : ROLE_LABELS[role] || esc(role);
    const stamp = opts.timestamps ? fmtTime(msg.createTime) : '';
    const body = msg.parts.map(renderPart).join('\n');
    return (
      '<article class="msg ' + esc(role) + '" id="m' + index + '">' +
      '<header><span class="who">' + label + '</span>' +
      (stamp ? '<time>' + esc(stamp) + '</time>' : '') + '</header>' +
      '<div class="body">' + body + '</div></article>'
    );
  }

  /* ────────────────────────── main controller ───────────────────────── */

  let currentTheme = 'light';
  let currentPageSize = 'A4';

  function applyTheme(theme, pageSize) {
    currentTheme = resolveTheme(theme);
    if (pageSize) currentPageSize = pageSize;

    document.getElementById('theme-css').textContent = buildThemeCSS(currentTheme, currentPageSize);
    document.documentElement.setAttribute('data-theme', currentTheme);
    document.querySelector('meta[name="color-scheme"]')?.setAttribute(
      'content',
      currentTheme === 'dark' ? 'dark' : 'light'
    );

    // Update active state in theme buttons
    document.querySelectorAll('.theme-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-theme') === currentTheme);
    });
  }

  // Print button click
  document.getElementById('print-btn').addEventListener('click', () => {
    window.print();
  });

  // Theme switcher buttons
  document.getElementById('theme-switcher').addEventListener('click', (e) => {
    const btn = e.target.closest('.theme-btn');
    if (!btn) return;
    const newTheme = btn.getAttribute('data-theme');
    applyTheme(newTheme);
    chrome.storage.local.set({ theme: newTheme });
  });

  // Read stored data
  chrome.storage.local.get(['_exportConv', '_exportOpts'], (data) => {
    const conv = data._exportConv;
    const opts = {
      theme: 'light',
      pageSize: 'A4',
      timestamps: true,
      includeTools: false,
      reasoning: true,
      ...(data._exportOpts || {}),
    };

    if (!conv || !conv.messages) {
      document.getElementById('doc').innerHTML =
        '<div class="doc-loading"><p style="color:#d96a4a;">No conversation data found. Please return to your ChatGPT page and click the export button.</p></div>';
      document.getElementById('info').textContent = 'No data';
      return;
    }

    currentPageSize = opts.pageSize || 'A4';
    applyTheme(opts.theme || 'light', currentPageSize);

    // Document title
    document.title = conv.title ? `${conv.title} — Manuscript PDF` : 'ChatGPT Conversation — PDF';

    // Filter messages
    const shown = conv.messages
      .filter((m) => opts.includeTools || (!m.isTool && m.role !== 'tool'))
      .map((m) =>
        opts.reasoning
          ? m
          : { ...m, parts: m.parts.filter((p) => p.kind !== 'reasoning') }
      )
      .filter((m) => m.parts.length);

    // Build metadata list
    const meta = [
      conv.url ? ['Source', `<a href="${esc(conv.url)}" target="_blank">${esc(conv.url)}</a>`] : null,
      conv.model ? ['Model', esc(conv.model)] : null,
      conv.createTime ? ['Started', esc(fmtTime(conv.createTime))] : null,
      ['Messages', String(shown.length)],
      [
        'Printed',
        esc(new Date().toLocaleString('en-US', {
          dateStyle: 'medium',
          timeStyle: 'short',
        })),
      ],
    ].filter(Boolean);

    // Render cover header & messages
    const html =
      '<header class="cover">' +
      '<span class="kicker">Conversation Manuscript</span>' +
      '<h1>' + esc(conv.title || 'ChatGPT Conversation') + '</h1>' +
      '<dl>' +
      meta
        .map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + v + '</dd>')
        .join('') +
      '</dl></header>' +
      shown.map((m, i) => renderMessage(m, i, opts)).join('\n');

    document.getElementById('doc').innerHTML = html;

    // Update toolbar info badge
    document.getElementById('info').textContent =
      `${shown.length} messages · ${currentPageSize}`;
  });
})();

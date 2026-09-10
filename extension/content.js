/**
 * ChatGPT2PDF — Content Script
 *
 * Injected into chatgpt.com pages. Adds a floating "Export to PDF" button
 * and handles conversation extraction. Rendering happens in export.html.
 */

(function () {
  'use strict';
  if (document.getElementById('chatgpt2pdf-fab')) return;

  /* ────────────────────────────── FAB button ──────────────────────────── */

  const fab = document.createElement('button');
  fab.id = 'chatgpt2pdf-fab';
  fab.title = 'Export to PDF';
  const ICON_DEFAULT =
    '<svg viewBox="0 0 24 24"><path d="M12 3v12m0 0l-4-4m4 4l4-4"/>' +
    '<path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg>';
  const ICON_SPINNER =
    '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 0110 10" stroke-width="2.5" fill="none" stroke="#fff" stroke-linecap="round"/></svg>';
  const ICON_CHECK =
    '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" stroke-width="2.5"/></svg>';
  fab.innerHTML = ICON_DEFAULT;
  document.body.appendChild(fab);

  /* ────────────────────────── extraction helpers ──────────────────────── */

  function getConversationId() {
    const m = location.pathname.match(
      /\/(?:c|share)\/(?:e\/)?([0-9a-zA-Z-]{16,})/
    );
    return m ? m[1] : null;
  }

  /** Strategy 1: fetch the backend API using the user's session cookies. */
  async function tryApi(convId) {
    const isShare = location.pathname.includes('/share/');
    const endpoint = isShare
      ? `/backend-api/share/${convId}`
      : `/backend-api/conversation/${convId}`;
    const res = await fetch(endpoint, {
      headers: { accept: 'application/json' },
      credentials: 'include',
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    return await res.json();
  }

  /** Strategy 2: scrape the rendered DOM. */
  function tryScrape() {
    const els = document.querySelectorAll('[data-message-author-role]');
    if (!els.length) throw new Error('no messages found in DOM');
    const messages = [];
    els.forEach((el) => {
      const role = el.getAttribute('data-message-author-role');
      const md = el.querySelector('.markdown, .whitespace-pre-wrap');
      messages.push({
        role: role || 'assistant',
        html: (md || el).innerHTML,
        text: el.innerText,
      });
    });
    const title = document.title
      .replace(/\s*[-|]\s*ChatGPT\s*$/i, '')
      .trim();
    return { scraped: messages, title };
  }

  /* ────────────────────────── normalization ───────────────────────────── */

  const HIDDEN_TYPES = new Set([
    'user_editable_context',
    'model_editable_context',
    'system_error',
  ]);

  function unwrap(obj) {
    if (!obj || typeof obj !== 'object') return null;
    if (obj.mapping || obj.linear_conversation) return obj;
    return (
      unwrap(obj.data) ||
      unwrap(obj.serverResponse) ||
      unwrap(
        obj.props &&
          obj.props.pageProps &&
          obj.props.pageProps.serverResponse
      ) ||
      null
    );
  }

  function linearize(payload) {
    const mapping = payload.mapping || {};
    if (
      Array.isArray(payload.linear_conversation) &&
      payload.linear_conversation.length
    )
      return payload.linear_conversation;

    const nodes = Object.values(mapping);
    if (!nodes.length) return [];

    let leafId = payload.current_node;
    if (!leafId || !mapping[leafId]) {
      let best = null;
      for (const n of nodes) {
        if (n.children && n.children.length) continue;
        const t = (n.message && n.message.create_time) || 0;
        if (!best || t >= ((best.message && best.message.create_time) || 0))
          best = n;
      }
      leafId = best && best.id;
    }
    const chain = [];
    const seen = new Set();
    let cur = mapping[leafId];
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      chain.unshift(cur);
      cur = cur.parent ? mapping[cur.parent] : null;
    }
    return chain;
  }

  const dims = (p) =>
    p.width && p.height ? `${p.width}\u00d7${p.height}` : '';
  const prettyType = (t) => String(t).replace(/_/g, ' ');

  function contentToParts(content) {
    if (!content) return [];
    const type = content.content_type;

    if (type === 'text') {
      const text = (content.parts || [])
        .filter((p) => typeof p === 'string')
        .join('\n\n');
      return text.trim() ? [{ kind: 'markdown', text }] : [];
    }

    if (type === 'multimodal_text') {
      const out = [];
      for (const part of content.parts || []) {
        if (typeof part === 'string') {
          if (part.trim()) out.push({ kind: 'markdown', text: part });
        } else if (part && part.content_type === 'image_asset_pointer') {
          out.push({
            kind: 'attachment',
            label: 'Image',
            detail: dims(part),
          });
        } else if (
          part &&
          part.content_type === 'audio_transcription' &&
          part.text
        ) {
          out.push({ kind: 'markdown', text: part.text });
        } else if (part && part.content_type) {
          out.push({
            kind: 'attachment',
            label: prettyType(part.content_type),
            detail: '',
          });
        }
      }
      return out;
    }

    if (type === 'code') {
      const text = content.text || '';
      return text.trim()
        ? [{ kind: 'code', text, language: content.language || '' }]
        : [];
    }

    if (type === 'execution_output') {
      const text = content.text || '';
      return text.trim() ? [{ kind: 'output', text }] : [];
    }

    if (type === 'thoughts') {
      const chunks = (content.thoughts || [])
        .map((t) => [t.summary, t.content].filter(Boolean).join('\n\n'))
        .filter(Boolean);
      return chunks.length
        ? [{ kind: 'reasoning', text: chunks.join('\n\n') }]
        : [];
    }

    if (type === 'reasoning_recap') {
      return content.content && content.content.trim()
        ? [{ kind: 'reasoning', text: content.content }]
        : [];
    }

    if (type === 'tether_quote') {
      const text = [content.title, content.text]
        .filter(Boolean)
        .join('\n\n');
      return text.trim()
        ? [{ kind: 'quote', text, url: content.url }]
        : [];
    }

    if (type === 'tether_browsing_display') {
      const text = content.result || '';
      return text.trim() ? [{ kind: 'quote', text }] : [];
    }

    if (HIDDEN_TYPES.has(type)) return [];

    const text =
      content.text ||
      (content.parts || [])
        .filter((p) => typeof p === 'string')
        .join('\n\n');
    return text.trim() ? [{ kind: 'markdown', text }] : [];
  }

  function normalizePayload(payload, url) {
    const data = unwrap(payload);
    if (!data) return null;
    const messages = [];
    for (const node of linearize(data)) {
      const msg = node && node.message;
      if (!msg) continue;
      const meta = msg.metadata || {};
      if (meta.is_visually_hidden_from_conversation) continue;
      const role = msg.author && msg.author.role;
      if (role === 'system') continue;
      const parts = contentToParts(msg.content);
      if (!parts.length) continue;
      const isToolCall =
        role === 'assistant' && msg.recipient && msg.recipient !== 'all';
      messages.push({
        role: role || 'assistant',
        name:
          (msg.author && msg.author.name) ||
          (isToolCall ? msg.recipient : ''),
        createTime: msg.create_time || null,
        model: meta.model_slug || '',
        isTool: role === 'tool' || Boolean(isToolCall),
        parts,
      });
    }
    const firstModel = messages.find((m) => m.model);
    return {
      title: data.title || 'ChatGPT conversation',
      url,
      model:
        (data.model && data.model.slug) ||
        data.default_model_slug ||
        (firstModel && firstModel.model) ||
        '',
      createTime: data.create_time || null,
      messages,
    };
  }

  function cleanHtml(html) {
    return String(html)
      .replace(/<(script|style|svg|button|form)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<(script|style|svg|button|form)\b[^>]*\/?>/gi, '')
      .replace(/\son[a-z]+=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(
        /\shref\s*=\s*("javascript:[^"]*"|'javascript:[^']*')/gi,
        ''
      );
  }

  function normalizeScraped(rows, title, url) {
    const messages = rows
      .filter((r) => (r.html || r.text || '').trim())
      .map((r) => ({
        role: r.role || 'assistant',
        name: '',
        createTime: null,
        model: '',
        isTool: r.role === 'tool',
        parts: [{ kind: 'html', html: cleanHtml(r.html || '') }],
      }));
    return {
      title: title || 'ChatGPT conversation',
      url,
      model: '',
      createTime: null,
      messages,
    };
  }

  /* ────────────────────────── extract conversation ────────────────────── */

  async function extractConversation() {
    const convId = getConversationId();
    if (!convId) {
      throw new Error(
        'Could not find a conversation ID in the URL.\nNavigate to a ChatGPT chat first.'
      );
    }

    const url = location.href;
    const problems = [];

    // Strategy 1: API
    try {
      const raw = await tryApi(convId);
      const conv = normalizePayload(raw, url);
      if (conv && conv.messages.length) {
        return { ...conv, source: 'API' };
      }
      problems.push('API: no visible messages in payload');
    } catch (err) {
      problems.push(`API: ${err.message}`);
    }

    // Strategy 2: DOM scrape
    try {
      const { scraped, title } = tryScrape();
      const conv = normalizeScraped(scraped, title, url);
      if (conv.messages.length) {
        return { ...conv, source: 'DOM scrape' };
      }
      problems.push('DOM: nothing scrapeable');
    } catch (err) {
      problems.push(`DOM: ${err.message}`);
    }

    throw new Error(
      `Could not read this conversation.\n  - ${problems.join('\n  - ')}`
    );
  }

  /* ────────────────────── open export page ────────────────────────────── */

  function openExportTab(conv, options) {
    chrome.storage.local.set(
      { _exportConv: conv, _exportOpts: options },
      () => {
        const exportUrl = chrome.runtime.getURL('export.html');
        window.open(exportUrl, '_blank');
      }
    );
  }

  /* ════════════════════════════════════════════════════════════════════════
   *  OPTIONS PANEL — shown on FAB click, lets user pick settings first
   * ════════════════════════════════════════════════════════════════════════ */

  /* ── scrim (click-outside-to-close) ── */
  const scrim = document.createElement('div');
  scrim.id = 'chatgpt2pdf-scrim';
  document.body.appendChild(scrim);

  /* ── panel DOM ── */
  const panel = document.createElement('div');
  panel.id = 'chatgpt2pdf-panel';
  panel.innerHTML = `
    <div class="p-header">
      <span class="p-title">Save as PDF</span>
      <button class="p-close" id="chatgpt2pdf-panel-close" title="Close">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 2l8 8M10 2L2 10"/></svg>
      </button>
    </div>
    <div class="p-body">
      <span class="p-section">Appearance</span>
      <div class="p-seg" id="chatgpt2pdf-seg-theme">
        <input type="radio" name="c2p-theme" value="light" id="c2p-t-light" checked>
        <label for="c2p-t-light">Light</label>
        <input type="radio" name="c2p-theme" value="dark" id="c2p-t-dark">
        <label for="c2p-t-dark">Dark</label>
        <input type="radio" name="c2p-theme" value="sepia" id="c2p-t-sepia">
        <label for="c2p-t-sepia">Sepia</label>
        <input type="radio" name="c2p-theme" value="mono" id="c2p-t-mono">
        <label for="c2p-t-mono">Mono</label>
      </div>

      <span class="p-section">Paper</span>
      <div class="p-chips" id="chatgpt2pdf-seg-page">
        <input type="radio" name="c2p-page" value="A4" id="c2p-pg-a4" checked>
        <label for="c2p-pg-a4">A4</label>
        <input type="radio" name="c2p-page" value="Letter" id="c2p-pg-letter">
        <label for="c2p-pg-letter">Letter</label>
        <input type="radio" name="c2p-page" value="Legal" id="c2p-pg-legal">
        <label for="c2p-pg-legal">Legal</label>
      </div>

      <hr class="p-rule">

      <span class="p-section">Include</span>
      <label class="p-check">
        <input type="checkbox" id="chatgpt2pdf-p-timestamps" checked>
        <span class="p-box"><svg viewBox="0 0 10 8"><path d="M1 4l3 3 5-6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        <span class="p-check-label">Message timestamps</span>
      </label>
      <label class="p-check">
        <input type="checkbox" id="chatgpt2pdf-p-reasoning" checked>
        <span class="p-box"><svg viewBox="0 0 10 8"><path d="M1 4l3 3 5-6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        <span class="p-check-label">Reasoning traces</span>
      </label>
      <label class="p-check">
        <input type="checkbox" id="chatgpt2pdf-p-tools">
        <span class="p-box"><svg viewBox="0 0 10 8"><path d="M1 4l3 3 5-6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        <span class="p-check-label">Tool &amp; code output</span>
      </label>
    </div>
    <div class="p-footer">
      <button class="p-export-btn" id="chatgpt2pdf-p-export">Export this conversation &rarr;</button>
    </div>
  `;
  document.body.appendChild(panel);

  /* ── panel helpers ── */
  const p$ = (id) => document.getElementById(id);
  let panelOpen = false;

  function showPanel() {
    panelOpen = true;
    panel.classList.add('open');
    scrim.classList.add('open');
    fab.classList.add('panel-open');
  }

  function hidePanel() {
    panelOpen = false;
    panel.classList.remove('open');
    scrim.classList.remove('open');
    fab.classList.remove('panel-open');
  }

  /* load saved settings into the panel */
  chrome.storage.local.get(
    { theme: 'light', pageSize: 'A4', timestamps: true, reasoning: true, includeTools: false },
    (opts) => {
      const themeRadio = document.querySelector(`input[name="c2p-theme"][value="${opts.theme}"]`);
      if (themeRadio) themeRadio.checked = true;
      const pageRadio = document.querySelector(`input[name="c2p-page"][value="${opts.pageSize}"]`);
      if (pageRadio) pageRadio.checked = true;
      p$('chatgpt2pdf-p-timestamps').checked = opts.timestamps;
      p$('chatgpt2pdf-p-reasoning').checked = opts.reasoning;
      p$('chatgpt2pdf-p-tools').checked = opts.includeTools;
    }
  );

  /* auto-detect OS dark mode for first-time default */
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    chrome.storage.local.get({ _themeSet: false }, (r) => {
      if (!r._themeSet) {
        const darkRadio = document.getElementById('c2p-t-dark');
        if (darkRadio) darkRadio.checked = true;
        chrome.storage.local.set({ theme: 'dark', _themeSet: true });
      }
    });
  }

  /** Read current panel values & persist them. */
  function readAndSaveSettings() {
    const themeEl = document.querySelector('input[name="c2p-theme"]:checked');
    const pageEl = document.querySelector('input[name="c2p-page"]:checked');
    const opts = {
      theme: themeEl ? themeEl.value : 'light',
      pageSize: pageEl ? pageEl.value : 'A4',
      timestamps: p$('chatgpt2pdf-p-timestamps').checked,
      reasoning: p$('chatgpt2pdf-p-reasoning').checked,
      includeTools: p$('chatgpt2pdf-p-tools').checked,
    };
    chrome.storage.local.set(opts);
    return opts;
  }

  /* save on every change — radios + checkboxes */
  panel.addEventListener('change', readAndSaveSettings);

  /* ────────────────────── export flow ─────────────────────────────────── */

  async function doExport(options) {
    if (fab.classList.contains('loading')) return;
    hidePanel();
    fab.classList.add('loading');
    fab.innerHTML = ICON_SPINNER;

    try {
      const conv = await extractConversation();
      openExportTab(conv, options);

      fab.classList.remove('loading');
      fab.classList.add('done');
      fab.innerHTML = ICON_CHECK;
      setTimeout(() => {
        fab.classList.remove('done');
        fab.innerHTML = ICON_DEFAULT;
      }, 1800);
    } catch (err) {
      fab.classList.remove('loading');
      fab.innerHTML = ICON_DEFAULT;
      alert(`ChatGPT2PDF: ${err.message}`);
    }
  }

  /* ────────────────────── event wiring ────────────────────────────────── */

  /* FAB click → toggle panel */
  fab.addEventListener('click', (e) => {
    e.stopPropagation();
    if (panelOpen) hidePanel();
    else showPanel();
  });

  /* panel close button */
  p$('chatgpt2pdf-panel-close').addEventListener('click', hidePanel);

  /* click outside → close */
  scrim.addEventListener('click', hidePanel);

  /* Export button inside panel */
  p$('chatgpt2pdf-p-export').addEventListener('click', () => {
    const opts = readAndSaveSettings();
    doExport(opts);
  });

  /* ────────────────────── listen for popup messages ───────────────────── */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'export') {
      doExport(msg.options || {})
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    if (msg.action === 'ping') {
      sendResponse({ ok: true, hasConversation: !!getConversationId() });
      return false;
    }
  });
})();


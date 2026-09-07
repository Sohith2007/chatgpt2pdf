/**
 * Extraction layer: turn a ChatGPT share link into a normalized conversation.
 *
 * Share pages sit behind Cloudflare and render client-side, so we try a ladder
 * of strategies, cheapest first:
 *   1. plain HTTPS call to the public share endpoint
 *   2. JSON embedded in the server-rendered HTML
 *   3. same-origin fetch of the share endpoint from inside a real browser
 *   4. scraping the rendered DOM
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Pull the share id out of any of the link shapes OpenAI hands out. */
export function parseShareId(input) {
  const raw = String(input || '').trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    return { id: raw, url: `https://chatgpt.com/share/${raw}` };
  }

  let u;
  try {
    u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  } catch {
    throw new Error(`Not a URL: ${input}`);
  }
  if (!/(^|\.)(chatgpt\.com|chat\.openai\.com|openai\.com)$/i.test(u.hostname)) {
    throw new Error(`Not a ChatGPT link: ${u.hostname}`);
  }
  // /share/<id>, /share/e/<id>, /c/<id>
  const m = u.pathname.match(/\/(?:share|c)\/(?:e\/)?([0-9a-zA-Z-]{16,})/);
  if (!m) {
    throw new Error('Could not find a share id in that link. Expected https://chatgpt.com/share/<id>');
  }
  return { id: m[1], url: `https://chatgpt.com/share/${m[1]}` };
}

async function tryDirectApi(id, shareUrl) {
  const res = await fetch(`https://chatgpt.com/backend-api/share/${id}`, {
    headers: {
      'user-agent': UA,
      accept: 'application/json',
      'accept-language': 'en-US,en;q=0.9',
      referer: shareUrl,
    },
  });
  if (!res.ok) throw new Error(`share API responded ${res.status}`);
  return await res.json();
}

/** Walk outward from a known-good index to the enclosing balanced JSON object. */
function jsonAround(text, hitIndex) {
  for (let start = hitIndex; start >= 0; start--) {
    if (text[start] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') {
        depth++;
      } else if (c === '}') {
        depth--;
        if (depth === 0) {
          if (i < hitIndex) break; // closed before our hit, so this brace is too early
          try {
            return JSON.parse(text.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

function unwrap(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.mapping || obj.linear_conversation) return obj;
  return (
    unwrap(obj.data) ||
    unwrap(obj.serverResponse) ||
    unwrap(obj.props && obj.props.pageProps && obj.props.pageProps.serverResponse) ||
    null
  );
}

/** Find a conversation payload embedded anywhere in an HTML document. */
function scanHtmlForPayload(html) {
  const candidates = [html];
  // React Router / Remix stream chunks arrive as escaped JS string literals.
  if (html.includes('\\"mapping\\"') || html.includes('\\"linear_conversation\\"')) {
    candidates.push(html.replace(/\\"/g, '"').replace(/\\n/g, '\n'));
  }
  for (const text of candidates) {
    for (const key of ['"linear_conversation"', '"mapping"']) {
      let from = 0;
      for (let n = 0; n < 8; n++) {
        const hit = text.indexOf(key, from);
        if (hit === -1) break;
        from = hit + key.length;
        const payload = unwrap(jsonAround(text, hit));
        if (payload) return payload;
      }
    }
  }
  return null;
}

async function tryEmbeddedHtml(shareUrl) {
  const res = await fetch(shareUrl, {
    headers: { 'user-agent': UA, accept: 'text/html', 'accept-language': 'en-US,en;q=0.9' },
  });
  if (!res.ok) throw new Error(`share page responded ${res.status}`);
  const payload = scanHtmlForPayload(await res.text());
  if (!payload) throw new Error('no conversation JSON embedded in the page');
  return payload;
}

async function tryBrowser(id, shareUrl, getBrowser) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(UA);
    await page.goto(shareUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // (3) same-origin API call, which inherits the browser's Cloudflare clearance
    const viaApi = await page.evaluate(async (shareId) => {
      try {
        const r = await fetch(`/backend-api/share/${shareId}`, { headers: { accept: 'application/json' } });
        return r.ok ? await r.json() : null;
      } catch {
        return null;
      }
    }, id);
    const payload = unwrap(viaApi);
    if (payload) return { payload };

    // (4) last resort: read what the page actually rendered
    await page.waitForSelector('[data-message-author-role]', { timeout: 30000 });
    const scraped = await page.$$eval('[data-message-author-role]', (els) =>
      els.map((el) => ({
        role: el.getAttribute('data-message-author-role'),
        html: (el.querySelector('.markdown') || el).innerHTML,
        text: el.innerText,
      })),
    );
    if (!scraped.length) throw new Error('page rendered no messages');
    const title = await page.title();
    return { scraped, title: title.replace(/\s*[-|]\s*ChatGPT\s*$/i, '').trim() };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * @param {string} input  share link (or bare share id)
 * @param {{getBrowser?: Function, onProgress?: Function}} opts
 * @returns {Promise<{title, url, model, createTime, messages, source}>}
 */
export async function extractConversation(input, opts = {}) {
  const { getBrowser, onProgress = () => {} } = opts;
  const { id, url } = parseShareId(input);
  const problems = [];

  const attempts = [
    ['share API', async () => ({ payload: unwrap(await tryDirectApi(id, url)) })],
    ['embedded page data', async () => ({ payload: await tryEmbeddedHtml(url) })],
  ];
  if (getBrowser) attempts.push(['headless browser', () => tryBrowser(id, url, getBrowser)]);

  for (const [name, run] of attempts) {
    try {
      onProgress(`trying ${name}...`);
      const out = await run();
      if (out.payload) {
        const conv = normalizePayload(out.payload, url);
        if (conv.messages.length) return { ...conv, source: name };
        problems.push(`${name}: payload had no visible messages`);
      } else if (out.scraped) {
        const conv = normalizeScraped(out.scraped, out.title, url);
        if (conv.messages.length) return { ...conv, source: 'rendered page' };
        problems.push(`${name}: nothing scrapeable`);
      } else {
        problems.push(`${name}: no conversation data in the response`);
      }
    } catch (err) {
      problems.push(`${name}: ${err.message}`);
    }
  }
  throw new Error(
    `Could not read that conversation.\n  - ${problems.join('\n  - ')}\n` +
      'Check that the link is a public share link (Share > Create link) and is still live.',
  );
}

/* --------------------------------------------------------------- normalize */

function linearize(payload) {
  const mapping = payload.mapping || {};
  if (Array.isArray(payload.linear_conversation) && payload.linear_conversation.length) {
    return payload.linear_conversation;
  }
  const nodes = Object.values(mapping);
  if (!nodes.length) return [];

  // Prefer walking up from the recorded leaf; otherwise take the newest leaf.
  let leafId = payload.current_node;
  if (!leafId || !mapping[leafId]) {
    let best = null;
    for (const n of nodes) {
      if (n.children && n.children.length) continue;
      const t = (n.message && n.message.create_time) || 0;
      if (!best || t >= ((best.message && best.message.create_time) || 0)) best = n;
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

const HIDDEN_TYPES = new Set(['user_editable_context', 'model_editable_context', 'system_error']);
const dims = (p) => (p.width && p.height ? `${p.width}×${p.height}` : '');
const prettyType = (t) => String(t).replace(/_/g, ' ');

function contentToParts(content) {
  if (!content) return [];
  const type = content.content_type;

  if (type === 'text') {
    const text = (content.parts || []).filter((p) => typeof p === 'string').join('\n\n');
    return text.trim() ? [{ kind: 'markdown', text }] : [];
  }

  if (type === 'multimodal_text') {
    const out = [];
    for (const part of content.parts || []) {
      if (typeof part === 'string') {
        if (part.trim()) out.push({ kind: 'markdown', text: part });
      } else if (part && part.content_type === 'image_asset_pointer') {
        out.push({ kind: 'attachment', label: 'Image', detail: dims(part) });
      } else if (part && part.content_type === 'audio_transcription' && part.text) {
        out.push({ kind: 'markdown', text: part.text });
      } else if (part && part.content_type) {
        out.push({ kind: 'attachment', label: prettyType(part.content_type), detail: '' });
      }
    }
    return out;
  }

  if (type === 'code') {
    const text = content.text || '';
    return text.trim() ? [{ kind: 'code', text, language: content.language || '' }] : [];
  }

  if (type === 'execution_output') {
    const text = content.text || '';
    return text.trim() ? [{ kind: 'output', text }] : [];
  }

  if (type === 'thoughts') {
    const chunks = (content.thoughts || [])
      .map((t) => [t.summary, t.content].filter(Boolean).join('\n\n'))
      .filter(Boolean);
    return chunks.length ? [{ kind: 'reasoning', text: chunks.join('\n\n') }] : [];
  }

  if (type === 'reasoning_recap') {
    return content.content && content.content.trim() ? [{ kind: 'reasoning', text: content.content }] : [];
  }

  if (type === 'tether_quote') {
    const text = [content.title, content.text].filter(Boolean).join('\n\n');
    return text.trim() ? [{ kind: 'quote', text, url: content.url }] : [];
  }

  if (type === 'tether_browsing_display') {
    const text = content.result || '';
    return text.trim() ? [{ kind: 'quote', text }] : [];
  }

  if (HIDDEN_TYPES.has(type)) return [];

  // Unknown but textual: better to show it than to silently drop content.
  const text = content.text || (content.parts || []).filter((p) => typeof p === 'string').join('\n\n');
  return text.trim() ? [{ kind: 'markdown', text }] : [];
}

export function normalizePayload(payload, url) {
  const messages = [];
  for (const node of linearize(payload)) {
    const msg = node && node.message;
    if (!msg) continue;
    const meta = msg.metadata || {};
    if (meta.is_visually_hidden_from_conversation) continue;

    const role = msg.author && msg.author.role;
    if (role === 'system') continue;

    const parts = contentToParts(msg.content);
    if (!parts.length) continue;

    const isToolCall = role === 'assistant' && msg.recipient && msg.recipient !== 'all';
    messages.push({
      role: role || 'assistant',
      name: (msg.author && msg.author.name) || (isToolCall ? msg.recipient : ''),
      createTime: msg.create_time || null,
      model: meta.model_slug || '',
      isTool: role === 'tool' || Boolean(isToolCall),
      parts,
    });
  }

  const firstModel = messages.find((m) => m.model);
  return {
    title: payload.title || 'ChatGPT conversation',
    url,
    model: (payload.model && payload.model.slug) || payload.default_model_slug || (firstModel && firstModel.model) || '',
    createTime: payload.create_time || null,
    messages,
  };
}

/** Strip anything active out of scraped markup; it only needs to print. */
function cleanHtml(html) {
  return String(html)
    .replace(/<(script|style|svg|button|form)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|style|svg|button|form)\b[^>]*\/?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\shref\s*=\s*("javascript:[^"]*"|'javascript:[^']*')/gi, '');
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
  return { title: title || 'ChatGPT conversation', url, model: '', createTime: null, messages };
}

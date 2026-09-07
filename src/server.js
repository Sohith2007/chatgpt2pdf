/** Local web app: paste a share link, preview the render, download the PDF. */

import express from 'express';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractConversation } from './extract.js';
import { renderDocument } from './render.js';
import { htmlToPdf, getBrowser, closeBrowser } from './pdf.js';

const here = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 5178);

app.use(express.json({ limit: '1mb' }));
app.use(express.static(join(here, '..', 'public')));

/** Rendered PDFs waiting to be downloaded. */
const cache = new Map();
const TTL_MS = 30 * 60 * 1000;

const sweep = () => {
  const now = Date.now();
  for (const [id, item] of cache) if (now - item.at > TTL_MS) cache.delete(id);
};

const slug = (s) =>
  String(s || 'chatgpt-conversation')
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80) || 'chatgpt-conversation';

app.post('/api/convert', async (req, res) => {
  const { url, theme, pageSize, includeTools, reasoning, timestamps } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Paste a ChatGPT share link first.' });

  try {
    const conv = await extractConversation(url, { getBrowser });
    const options = {
      theme: ['light', 'sepia', 'mono'].includes(theme) ? theme : 'light',
      pageSize: ['A4', 'Letter', 'Legal'].includes(pageSize) ? pageSize : 'A4',
      includeTools: Boolean(includeTools),
      reasoning: reasoning !== false,
      timestamps: timestamps !== false,
    };
    const html = renderDocument(conv, options);
    const pdf = await htmlToPdf(html, {
      pageSize: options.pageSize,
      title: conv.title,
    });

    sweep();
    const id = randomUUID();
    cache.set(id, { pdf: Buffer.from(pdf), name: `${slug(conv.title)}.pdf`, at: Date.now() });

    res.json({
      id,
      title: conv.title,
      source: conv.source,
      messages: conv.messages.length,
      bytes: pdf.length,
      html,
    });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

app.get('/api/pdf/:id', (req, res) => {
  const item = cache.get(req.params.id);
  if (!item) return res.status(404).send('That render expired. Convert the link again.');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${item.name}"`);
  res.send(item.pdf);
});

const server = app.listen(PORT, () => {
  console.log(`chatgpt2pdf running at http://localhost:${PORT}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    server.close();
    await closeBrowser();
    process.exit(0);
  });
}

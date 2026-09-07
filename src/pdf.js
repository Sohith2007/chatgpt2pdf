/**
 * PDF layer: print a self-contained HTML document with headless Chrome.
 * The browser is a lazily created singleton so the extractor and the printer
 * share one instance (and one Cloudflare clearance).
 */

import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer';
import chromium from '@sparticuz/chromium';

const WINDOWS_FALLBACKS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

const LAUNCH_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'];

let browserPromise = null;

async function launch() {
  const isVercel = process.env.VERCEL === '1' || process.env.AWS_LAMBDA_FUNCTION_VERSION || process.env.AWS_EXECUTION_ENV;
  
  if (isVercel) {
    return await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });
  }

  const explicit = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
  const opts = { headless: true, args: LAUNCH_ARGS };
  if (explicit) opts.executablePath = explicit;

  try {
    return await puppeteer.launch(opts);
  } catch (err) {
    // No bundled Chromium (common when install ran with a download skip): fall
    // back to a browser already on the machine.
    const found = WINDOWS_FALLBACKS.find((p) => existsSync(p));
    if (!found || explicit) {
      throw new Error(
        `Could not start Chrome: ${err.message}\n` +
          'Fix with "npx puppeteer browsers install chrome", or point CHROME_PATH at an existing Chrome/Edge binary.',
      );
    }
    return await puppeteer.launch({ ...opts, executablePath: found });
  }
}

/** Shared headless browser; started on first use. */
export function getBrowser() {
  if (!browserPromise) {
    browserPromise = launch().catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

export async function closeBrowser() {
  if (!browserPromise) return;
  const b = await browserPromise.catch(() => null);
  browserPromise = null;
  if (b) await b.close().catch(() => {});
}

const escAttr = (s) =>
  String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/**
 * @param {string} html   complete HTML document
 * @param {object} opts   { path, pageSize, title, footer, timeout }
 * @returns {Promise<Buffer>}
 */
export async function htmlToPdf(html, opts = {}) {
  // Long transcripts take real time to lay out, so the default budget is
  // generous compared with Chrome's own 30s.
  const { path, pageSize = 'A4', title = '', footer = true, timeout = 300000 } = opts;
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    // Nothing external is referenced, so this resolves without network access.
    await page.setContent(html, { waitUntil: 'load', timeout });
    await page.emulateMediaType('print');

    const style =
      'font-family: -apple-system, "Segoe UI", system-ui, sans-serif; font-size: 7pt; ' +
      'color: #9099a8; width: 100%; padding: 0 14mm; display: flex; justify-content: space-between;';

    return await page.pdf({
      path,
      timeout,
      format: pageSize,
      printBackground: true,
      preferCSSPageSize: false,
      displayHeaderFooter: footer,
      headerTemplate: '<div></div>',
      footerTemplate: footer
        ? `<div style="${style}"><span>${escAttr(title).slice(0, 90)}</span>` +
          '<span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>'
        : '<div></div>',
      margin: { top: '14mm', bottom: '16mm', left: '14mm', right: '14mm' },
    });
  } finally {
    await page.close().catch(() => {});
  }
}

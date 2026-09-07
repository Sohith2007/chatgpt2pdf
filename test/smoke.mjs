/**
 * Offline smoke test: fixture payload -> normalize -> HTML -> PDF.
 * Run with: node test/smoke.mjs [outDir]
 */
import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { payload } from './fixture.js';
import { normalizePayload, parseShareId } from '../src/extract.js';
import { renderDocument } from '../src/render.js';
import { htmlToPdf, closeBrowser } from '../src/pdf.js';

const out = process.argv[2] || 'test-output';
mkdirSync(out, { recursive: true });

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
};

/* link parsing */
const cases = [
  ['https://chatgpt.com/share/68c1a0f4-1111-4222-8333-444455556666', '68c1a0f4-1111-4222-8333-444455556666'],
  ['https://chat.openai.com/share/68c1a0f4-1111-4222-8333-444455556666', '68c1a0f4-1111-4222-8333-444455556666'],
  ['https://chatgpt.com/share/e/68c1a0f4-1111-4222-8333-444455556666?utm=x', '68c1a0f4-1111-4222-8333-444455556666'],
  ['68c1a0f4-1111-4222-8333-444455556666', '68c1a0f4-1111-4222-8333-444455556666'],
];
for (const [input, want] of cases) {
  check(`parse ${input.slice(0, 46)}`, parseShareId(input).id === want);
}
let rejected = false;
try { parseShareId('https://example.com/share/abc'); } catch { rejected = true; }
check('rejects non-ChatGPT hosts', rejected);

/* normalization */
const conv = normalizePayload(payload, 'https://chatgpt.com/share/test');
check('drops system + hidden messages', conv.messages.length === 7, `${conv.messages.length} kept`);
check('keeps title', conv.title === payload.title);
check('picks up model', conv.model === 'gpt-5', conv.model);
check('marks tool traffic', conv.messages.filter((m) => m.isTool).length === 2);
check('notes image attachment', JSON.stringify(conv.messages).includes('"kind":"attachment"'));

/* rendering */
const html = renderDocument(conv, { theme: 'light', pageSize: 'A4', timestamps: true, includeTools: true });
writeFileSync(join(out, 'smoke.html'), html);
check('renders display math', html.includes('katex-display'));
check('renders inline math', html.includes('class="katex"'));
check('highlights python', html.includes('hljs-keyword'));
check('renders the table', html.includes('<table>'));
check('keeps $ inside code literal', html.includes('$b^2$'));
check('renders reasoning block', html.includes('class="reasoning"'));
check('renders execution output', html.includes('Figure size 640x480'));
check('links survive', html.includes('href="https://docs.python.org/3/library/cmath.html"'));
check('escapes stray angle brackets', !html.includes('<Figure size'));

const noTools = renderDocument(conv, { includeTools: false });
check('--no-tools hides tool traffic', !noTools.includes('Figure size 640x480'));

/* pdf */
const pdfPath = join(out, 'smoke.pdf');
await htmlToPdf(html, { path: pdfPath, pageSize: 'A4', title: conv.title });
await closeBrowser();
const size = statSync(pdfPath).size;
check('writes a real PDF', size > 5000, `${(size / 1024).toFixed(0)} KB`);

console.log(failures ? `\n${failures} check(s) failed` : `\nall checks passed -> ${out}/`);
process.exit(failures ? 1 : 0);

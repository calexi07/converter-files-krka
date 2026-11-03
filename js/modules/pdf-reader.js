// PDF.js wrapper: open documents, inspect pages, extract positioned words,
// read drawn lines, and render pages to images for OCR.
import * as pdfjsLib from '../../libraries/pdfjs/pdf.min.mjs';
import { linesFromOperatorList } from './geometry.js';

const BASE = new URL('../../libraries/pdfjs/', import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = BASE + 'pdf.worker.min.mjs';

export const OPS = pdfjsLib.OPS;

export class PdfPasswordError extends Error {
  constructor(incorrect) { super(incorrect ? 'Incorrect password' : 'Password required'); this.name = 'PdfPasswordError'; this.incorrect = incorrect; }
}
export class PdfInvalidError extends Error { constructor(msg) { super(msg); this.name = 'PdfInvalidError'; } }

export async function openPdf(arrayBuffer, password) {
  const task = pdfjsLib.getDocument({
    data: new Uint8Array(arrayBuffer.slice(0)),
    password: password || undefined,
    cMapUrl: BASE + 'cmaps/', cMapPacked: true,
    standardFontDataUrl: BASE + 'standard_fonts/',
    wasmUrl: BASE + 'wasm/', iccUrl: BASE + 'iccs/',
    isEvalSupported: false, enableXfa: false, verbosity: 0,
  });
  try {
    const doc = await task.promise;
    doc._task = task;
    return doc;
  } catch (e) {
    if (e?.name === 'PasswordException') throw new PdfPasswordError(e.code === 2);
    if (e?.name === 'InvalidPDFException') throw new PdfInvalidError('The file is damaged or is not a valid PDF.');
    throw new PdfInvalidError(e?.message || 'The PDF could not be opened.');
  }
}

// PDF.js v6: documents are released through their loading task
export async function closePdf(doc) {
  try { await (doc?._task ? doc._task.destroy() : doc?.destroy?.()); } catch { /* already closed */ }
}

export async function readMetadata(doc) {
  try { const m = await doc.getMetadata(); return { title: m.info?.Title || '', producer: m.info?.Producer || '', creator: m.info?.Creator || '' }; }
  catch { return {}; }
}

// Read one page: words with positions, drawing lines, image coverage.
export async function readPage(doc, n) {
  const page = await doc.getPage(n);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent({ includeMarkedContent: false });
  const words = [];
  let chars = 0, rotated = 0;
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const tx = pdfjsLib.Util.transform(vp.transform, it.transform);
    const fh = Math.hypot(tx[2], tx[3]) || Math.abs(it.height) || 8;
    if (Math.abs(tx[1]) > Math.abs(tx[0]) + 0.01) { rotated++; }
    const x = tx[4], base = tx[5];
    const w = it.width;
    const len = it.str.length;
    const cw = len ? w / len : 0;
    const re = /\S+/g; let m;
    while ((m = re.exec(it.str))) {
      chars += m[0].length;
      const x0 = x + m.index * cw;
      words.push({ t: m[0], x0, x1: x0 + m[0].length * cw, y0: base - fh * 0.85, y1: base + fh * 0.15, h: fh, c: null });
    }
  }
  const opList = await page.getOperatorList();
  const { H, V } = linesFromOperatorList(opList, OPS, vp.transform);
  const imageCoverage = imageArea(opList, vp) / (vp.width * vp.height);
  return { page, n, width: vp.width, height: vp.height, words, H, V, chars, imageCoverage, rotatedText: rotated };
}

function imageArea(opList, vp) {
  const fn = opList.fnArray, args = opList.argsArray;
  let ctm = vp.transform.slice(); const stack = []; let area = 0;
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  for (let i = 0; i < fn.length; i++) {
    const op = fn[i];
    if (op === OPS.save) stack.push(ctm.slice());
    else if (op === OPS.restore) ctm = stack.pop() || ctm;
    else if (op === OPS.transform) ctm = mul(ctm, args[i]);
    else if (op === OPS.paintFormXObjectBegin) { stack.push(ctm.slice()); const m = args[i][0]; if (m && m.length === 6) ctm = mul(ctm, Array.from(m)); }
    else if (op === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (op === OPS.paintImageXObject || op === OPS.paintInlineImageXObject || op === OPS.paintImageXObjectRepeat) {
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]);
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      const w = Math.min(vp.width, Math.max(...xs)) - Math.max(0, Math.min(...xs));
      const h = Math.min(vp.height, Math.max(...ys)) - Math.max(0, Math.min(...ys));
      if (w > 0 && h > 0) area += w * h;
    }
  }
  return Math.min(area, vp.width * vp.height);
}

// Render a page into a canvas for OCR (about 300 DPI, capped for memory).
export async function renderPage(page, targetDpi = 300, maxSide = 5200) {
  const vp1 = page.getViewport({ scale: 1 });
  const scale = Math.min(targetDpi / 72, maxSide / Math.max(vp1.width, vp1.height));
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport: vp, background: '#ffffff' }).promise;
  return { canvas, ctx, scale };
}

// Converts one PDF: inspect every page, extract text directly where possible,
// OCR only the pages that need it, then rebuild tables in a background worker.
import { openPdf, closePdf, readPage, readMetadata, renderPage, PdfPasswordError } from './pdf-reader.js';
import { linesFromImage, eraseLines, estimateSkew, despeckle } from './geometry.js';
import { latticeCells, groupCells } from './table-engine.js';
import { ensureOcr, ocrCanvas, ocrWorkerCount } from './ocr.js';
import { processDocument } from './doc-processor.js';
import { documentStatus } from './validator.js';

export class CancelledError extends Error { constructor() { super('Cancelled'); this.name = 'CancelledError'; } }

// ---- table worker (module worker with main-thread fallback) ----
let tableWorker = null, reqId = 0;
const pending = new Map();
function getWorker() {
  if (tableWorker !== null) return tableWorker;
  try {
    tableWorker = new Worker(new URL('../workers/table-worker.js', import.meta.url), { type: 'module' });
    tableWorker.onmessage = (e) => { const p = pending.get(e.data.id); if (p) { pending.delete(e.data.id); e.data.ok ? p.resolve(e.data.result) : p.reject(new Error(e.data.error)); } };
    tableWorker.onerror = () => { for (const p of pending.values()) p.reject(new Error('worker-failed')); pending.clear(); tableWorker = false; };
  } catch { tableWorker = false; }
  return tableWorker;
}
async function buildTables(pages, opts) {
  const w = getWorker();
  if (w) {
    try {
      return await new Promise((resolve, reject) => { const id = ++reqId; pending.set(id, { resolve, reject }); w.postMessage({ id, pages, opts }); });
    } catch (e) { if (e.message !== 'worker-failed') throw e; }
  }
  return processDocument(pages, opts); // fallback
}

// OCR one rendered page. Bordered tables are read cell by cell (borders
// excluded), everything else is read in one pass with table areas masked.
async function ocrPage(canvas, ctx, scale, lines, status, hooks) {
  const cells = latticeCells(lines.H, lines.V);
  const groups = groupCells(cells).filter(g => g.length >= 3);
  if (!groups.length) return ocrCanvas(canvas, scale, { psm: '11' });

  const words = []; const confs = [];
  const tableCells = groups.flat();
  // crop every cell first, then mask table areas on the page image
  const crops = tableCells.map(c => {
    const inset = 5;
    const x = Math.floor(c[0] * scale) + inset, y = Math.floor(c[1] * scale) + inset;
    const w = Math.floor((c[2] - c[0]) * scale) - inset * 2, h = Math.floor((c[3] - c[1]) * scale) - inset * 2;
    if (w < 6 || h < 6) return null;
    const pad = 12, up = h < 48 ? 2 : 1;
    const cv = document.createElement('canvas');
    cv.width = (w + pad * 2) * up; cv.height = (h + pad * 2) * up;
    const cx = cv.getContext('2d');
    cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(canvas, x, y, w, h, pad * up, pad * up, w * up, h * up);
    // skip empty cells (no dark pixels)
    const d = cx.getImageData(0, 0, cv.width, cv.height).data;
    let dark = 0; for (let i = 0; i < d.length; i += 16) if (d[i] < 140) { dark++; if (dark > 3) break; }
    if (dark <= 3) return null;
    return { cv, ox: x - pad, oy: y - pad, up };
  }).filter(Boolean);
  ctx.fillStyle = '#fff';
  for (const g of groups) {
    const x0 = Math.min(...g.map(c => c[0])), y0 = Math.min(...g.map(c => c[1])), x1 = Math.max(...g.map(c => c[2])), y1 = Math.max(...g.map(c => c[3]));
    ctx.fillRect(x0 * scale - 2, y0 * scale - 2, (x1 - x0) * scale + 4, (y1 - y0) * scale + 4);
  }
  const rest = await ocrCanvas(canvas, scale, { psm: '11' });
  words.push(...rest.words); if (rest.avgConf != null) confs.push(rest.avgConf);
  let done = 0;
  await pool(crops, ocrWorkerCount(), async (cr) => {
    if (hooks.isCancelled?.()) throw new CancelledError();
    const r = await ocrCanvas(cr.cv, scale, { psm: '6', offsetX: cr.ox, offsetY: cr.oy, upscale: cr.up });
    cr.cv.width = cr.cv.height = 0;
    words.push(...dropEdgeFragments(r.words)); if (r.avgConf != null) confs.push(r.avgConf);
    done++;
    if (done % 10 === 0) status(`Reading table cells… ${done} of ${crops.length}`);
  });
  return { words, avgConf: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null };
}

// Inside one table cell: a separate text line made of a single short,
// low-confidence token is almost always a fragment of an erased border.
let fragmentsDropped = 0;
function dropEdgeFragments(ws) {
  if (ws.length < 2) return ws;
  const lines = [];
  for (const w of [...ws].sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1))) {
    const L = lines.find(l => Math.abs((l.y0 + l.y1) / 2 - (w.y0 + w.y1) / 2) < Math.max(3, (w.y1 - w.y0) * 0.5));
    if (L) { L.ws.push(w); L.y0 = Math.min(L.y0, w.y0); L.y1 = Math.max(L.y1, w.y1); } else lines.push({ ws: [w], y0: w.y0, y1: w.y1 });
  }
  if (lines.length < 2) return ws;
  const keep = [];
  for (const L of lines) {
    const frag = L.ws.length === 1 && ((L.ws[0].t.length <= 3 && (L.ws[0].c ?? 100) < 60) || (L.ws[0].t.length <= 2 && !/\d/.test(L.ws[0].t) && (L.ws[0].c ?? 100) < 80));
    if (frag) fragmentsDropped++; else keep.push(...L.ws);
  }
  return keep;
}

async function pool(items, n, fn) {
  let i = 0;
  const run = async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.max(1, n) }, run));
}

// settings: {mode:'auto'|'digital'|'ocr', langs:['ron','eng'], preserveLayout, locale}
// hooks: {onProgress(info), isCancelled(), getPassword(incorrect) -> Promise<string|null>}
export async function convertPdf(file, buffer, settings, hooks) {
  const t0 = performance.now();
  fragmentsDropped = 0;
  const doc = { fileName: file.name, size: file.size, pageCount: 0, pages: [], tables: [], notes: [], outside: [], runningLines: [], status: null, error: null, ocrPages: 0, settings: { ...settings } };
  let pdf;
  // open (with password retry)
  let password = null, incorrect = false;
  for (;;) {
    try { pdf = await openPdf(buffer, password); break; }
    catch (e) {
      if (e instanceof PdfPasswordError) {
        password = await hooks.getPassword?.(e.incorrect || incorrect);
        incorrect = true;
        if (!password) { doc.fatal = true; doc.error = 'Password-protected PDF — no password was entered.'; doc.status = 'FAILED'; return doc; }
        continue;
      }
      doc.fatal = true; doc.error = e.message; doc.status = 'FAILED'; return doc;
    }
  }

  try {
    doc.pageCount = pdf.numPages;
    doc.meta = await readMetadata(pdf);
    const pageData = new Array(pdf.numPages);
    let done = 0;
    const ocrTimes = [];
    const report = (n, method, ocrStatus) => {
      const remainingOcr = doc.pages.filter(p => p.method === 'ocr' && p.status === 'queued').length;
      const avg = ocrTimes.length ? ocrTimes.reduce((a, b) => a + b, 0) / ocrTimes.length : null;
      const eta = avg ? (remainingOcr * avg / Math.max(1, ocrWorkerCount())) * 1.25 : null;
      hooks.onProgress?.({ fileName: file.name, page: n, done, total: pdf.numPages, method, ocrStatus, etaSec: eta });
    };

    // 1) inspect every page, extract text directly where possible
    const needOcr = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      if (hooks.isCancelled?.()) throw new CancelledError();
      const info = { n, method: 'digital', status: 'ok', chars: 0, words: 0 };
      doc.pages.push(info);
      try {
        const rp = await readPage(pdf, n);
        info.chars = rp.chars;
        const scanned = (rp.chars < 20 && rp.imageCoverage > 0.05) || (rp.imageCoverage > 0.5 && rp.chars < 200);
        const wantOcr = settings.mode === 'ocr' ? true : settings.mode === 'auto' ? scanned : false;
        if (settings.mode === 'digital' && scanned) {
          info.status = 'skipped'; info.method = 'none';
          info.error = 'This page is a scanned image. Digital mode does not use OCR, so it was not converted.';
          pageData[n - 1] = { n, width: rp.width, height: rp.height, words: [], H: [], V: [] };
        } else if (wantOcr) {
          info.method = 'ocr'; info.status = 'queued';
          needOcr.push({ n, rp });
          pageData[n - 1] = { n, width: rp.width, height: rp.height, words: [], H: rp.H, V: rp.V, ocr: true };
        } else if (rp.chars === 0) {
          info.method = 'none'; info.status = 'empty';
          pageData[n - 1] = { n, width: rp.width, height: rp.height, words: [], H: [], V: [] };
          rp.page.cleanup();
        } else {
          info.words = rp.words.length;
          pageData[n - 1] = { n, width: rp.width, height: rp.height, words: rp.words, H: rp.H, V: rp.V };
          if (rp.rotatedText > rp.words.length * 0.3) doc.notes.push({ sev: 'warn', msg: `Page ${n} contains rotated text — tables on this page may be incomplete` });
          rp.page.cleanup();
        }
        if (info.method !== 'ocr') done++;
      } catch (e) {
        if (e instanceof CancelledError) throw e;
        info.status = 'failed'; info.error = 'This page could not be read: ' + (e?.message || 'unknown error');
        pageData[n - 1] = { n, width: 595, height: 842, words: [], H: [], V: [] };
        done++;
      }
      report(n, info.method === 'ocr' ? 'OCR (queued)' : 'Digital text', null);
    }

    // 2) OCR pages that need it
    if (needOcr.length) {
      try {
        await ensureOcr(settings.langs, s => hooks.onProgress?.({ fileName: file.name, page: needOcr[0].n, done, total: pdf.numPages, method: 'OCR', ocrStatus: s }));
      } catch (e) {
        if (hooks.isCancelled?.()) throw new CancelledError();
        for (const { n } of needOcr) { const p = doc.pages[n - 1]; p.status = 'failed'; p.error = 'OCR could not start: ' + (e?.message || 'the OCR files did not load'); }
        doc.notes.push({ sev: 'warn', msg: `OCR could not start, so ${needOcr.length} scanned page(s) were not converted` });
        needOcr.length = 0;
      }
      await pool(needOcr, ocrWorkerCount(), async ({ n, rp }) => {
        if (hooks.isCancelled?.()) throw new CancelledError();
        const info = doc.pages[n - 1];
        const t1 = performance.now();
        report(n, 'OCR (scanned page)', 'Rendering page image…');
        try {
          let { canvas, ctx, scale } = await renderPage(rp.page);
          let img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          // straighten tilted scans so table borders become horizontal/vertical
          const skew = estimateSkew(img);
          if (Math.abs(skew) >= 0.1) {
            const cv2 = document.createElement('canvas'); cv2.width = canvas.width; cv2.height = canvas.height;
            const c2 = cv2.getContext('2d', { willReadFrequently: true });
            c2.fillStyle = '#fff'; c2.fillRect(0, 0, cv2.width, cv2.height);
            c2.translate(cv2.width / 2, cv2.height / 2); c2.rotate(-skew * Math.PI / 180); c2.translate(-cv2.width / 2, -cv2.height / 2);
            c2.imageSmoothingQuality = 'high';
            c2.drawImage(canvas, 0, 0);
            c2.setTransform(1, 0, 0, 1, 0, 0);
            canvas.width = canvas.height = 0;
            canvas = cv2; ctx = c2;
            img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            info.skew = skew;
          }
          const lines = linesFromImage(img, scale);   // borders first (before despeckle can break thin lines)
          eraseLines(img, lines);
          const specks = despeckle(img);
          if (specks > 500) info.noisy = specks;
          ctx.putImageData(img, 0, 0);
          if (hooks.isCancelled?.()) throw new CancelledError();
          report(n, 'OCR (scanned page)', 'Recognizing text…');
          const { words, avgConf } = await ocrPage(canvas, ctx, scale, lines, (s) => report(n, 'OCR (scanned page)', s), hooks);
          canvas.width = canvas.height = 0; // free memory
          pageData[n - 1].words = words;
          // vector lines (if any) plus lines found in the image
          pageData[n - 1].H = [...(rp.H || []), ...lines.H];
          pageData[n - 1].V = [...(rp.V || []), ...lines.V];
          info.status = words.length ? 'ok' : 'empty';
          info.words = words.length; info.ocrConf = avgConf;
          doc.ocrPages++;
        } catch (e) {
          if (e instanceof CancelledError || hooks.isCancelled?.()) throw new CancelledError();
          info.status = 'failed'; info.error = 'OCR failed on this page: ' + (e?.message || 'unknown error');
        } finally {
          rp.page.cleanup();
          ocrTimes.push((performance.now() - t1) / 1000);
          done++;
          report(n, 'OCR (scanned page)', info.status === 'ok' ? 'Done' : info.status);
        }
      });
    }

    if (hooks.isCancelled?.()) throw new CancelledError();
    hooks.onProgress?.({ fileName: file.name, page: pdf.numPages, done: pdf.numPages, total: pdf.numPages, method: 'Rebuilding tables', ocrStatus: null });

    // 3) rebuild tables (background worker)
    const plain = pageData.map(p => ({ n: p.n, page: p.n, width: p.width, height: p.height, words: p.words, H: p.H, V: p.V, ocr: !!p.ocr }));
    const res = await buildTables(plain, { preserveLayout: settings.preserveLayout, locale: settings.locale || 'ro' });
    doc.tables = res.tables;
    doc.outside = res.outside;
    doc.runningLines = res.runningLines;
    doc.tables.forEach(t => { t.fileName = file.name; });

    // notes
    for (const p of doc.pages) if (p.status === 'failed' || p.status === 'skipped') doc.notes.push({ sev: 'warn', msg: `Page ${p.n}: ${p.error}` });
    const emptyPages = doc.pages.filter(p => p.status === 'empty').map(p => p.n);
    if (emptyPages.length) doc.notes.push({ sev: 'info', msg: `No text found on page(s) ${emptyPages.join(', ')}` });
    if (!doc.tables.length && doc.outside.length) doc.notes.push({ sev: 'warn', msg: 'No table structure was detected. The text was exported line by line to the "Other text" sheet.' });
    else if (doc.outside.length) doc.notes.push({ sev: 'info', msg: `${doc.outside.reduce((a, o) => a + o.lines.length, 0)} line(s) of text outside tables (titles, notes) were exported to the "Other text" sheet` });
    if (doc.runningLines.length) doc.notes.push({ sev: 'info', msg: `Repeated page headers/footers were not treated as data (e.g. "${doc.runningLines[0].slice(0, 60)}")` });
    for (const t of doc.tables) for (const r of t.removed || []) doc.notes.push({ sev: 'info', msg: `Table ${t.index}: ${r.reason}` });
    if (doc.ocrPages) {
      const skewed = doc.pages.filter(p => p.skew).map(p => `${p.n} (${p.skew}°)`);
      doc.notes.unshift({ sev: 'warn', msg: `${doc.ocrPages} scanned page(s) were read with OCR. OCR text is not verified: compare it with the original before use. Low-confidence cells are highlighted, but OCR can also be confidently wrong (e.g. "×" read as "x", missing diacritics).` });
      if (skewed.length) doc.notes.push({ sev: 'info', msg: `Tilted scan straightened before reading: page ${skewed.join(', ')}` });
      if (fragmentsDropped) doc.notes.push({ sev: 'info', msg: `${fragmentsDropped} tiny low-confidence fragment(s) next to cell borders were ignored (border remains, not data)` });
      const noisy = doc.pages.filter(p => p.noisy).map(p => p.n);
      if (noisy.length) doc.notes.push({ sev: 'info', msg: `Scan noise (specks) removed before reading on page ${noisy.join(', ')}` });
    }
  } catch (e) {
    if (e instanceof CancelledError || hooks.isCancelled?.()) { doc.cancelled = true; doc.status = 'CANCELLED'; await closePdf(pdf); return doc; }
    doc.fatal = true; doc.error = 'Processing failed: ' + (e?.message || 'unknown error');
  }
  await closePdf(pdf);
  doc.status = documentStatus(doc);
  doc.seconds = (performance.now() - t0) / 1000;
  return doc;
}

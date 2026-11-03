// Converts one PDF: inspect every page, extract text directly where possible,
// OCR only the pages that need it, then rebuild tables in a background worker.
import { openPdf, closePdf, readPage, readMetadata, renderPage, PdfPasswordError } from './pdf-reader.js';
import { linesFromImage, eraseLines, estimateSkew, despeckle } from './geometry.js';
import { latticeCells, groupCells } from './table-engine.js';
import { ensureOcr, ocrCanvas, ocrWorkerCount } from './ocr.js';
import { runningLines, processPage, finishDocument, EMPTY_PAGE_RESULT } from './doc-processor.js';
import { documentStatus } from './validator.js';

export class CancelledError extends Error { constructor() { super('Cancelled'); this.name = 'CancelledError'; } }

// ---- table worker: one page per message; restarted if it ever fails ----
let tableWorker = null, reqId = 0;
const pending = new Map();
function getWorker() {
  if (tableWorker) return tableWorker;
  if (tableWorker === false) return null;
  try {
    const w = new Worker(new URL('../workers/table-worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => { const p = pending.get(e.data.id); if (p) { pending.delete(e.data.id); e.data.ok ? p.resolve(e.data.result) : p.reject(new Error(e.data.error)); } };
    w.onerror = (ev) => { ev.preventDefault?.(); for (const p of pending.values()) p.reject(new Error('The page could not be processed (background worker stopped).')); pending.clear(); try { w.terminate(); } catch {} tableWorker = null; };
    tableWorker = w;
  } catch { tableWorker = false; }
  return tableWorker;
}
function restartWorker() { try { tableWorker?.terminate(); } catch {} tableWorker = null; for (const p of pending.values()) p.reject(new Error('restarted')); pending.clear(); }

async function processPageInWorker(page, opts, running) {
  const w = getWorker();
  if (!w) return processPage(page, opts, running); // browsers without module workers
  return new Promise((resolve, reject) => { const id = ++reqId; pending.set(id, { resolve, reject }); w.postMessage({ id, page, opts, running }); });
}

function pageList(ns) {
  const out = []; let a = ns[0], b = ns[0];
  for (const n of ns.slice(1).concat([null])) { if (n === b + 1) b = n; else { out.push(a === b ? `${a}` : `${a}–${b}`); a = b = n; } }
  return out.join(', ');
}

function friendlyError(e) {
  const m = String(e?.message || e || 'unknown error');
  if (/out of memory|allocation failed|cannot be cloned/i.test(m)) return 'not enough browser memory for this page';
  return m;
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
    const N = pdf.numPages;
    let done = 0;
    const ocrTimes = [];
    const t1 = performance.now();
    const report = (n, method, ocrStatus) => {
      const remainingOcr = doc.pages.filter(p => p.method === 'ocr' && p.status === 'queued').length;
      const avg = ocrTimes.length ? ocrTimes.reduce((a, b) => a + b, 0) / ocrTimes.length : null;
      let eta = avg ? (remainingOcr * avg / Math.max(1, ocrWorkerCount())) * 1.25 : null;
      // for long digital documents: measured seconds per page x remaining pages, +25% margin
      if (eta == null && done >= 30 && done < N) eta = ((performance.now() - t1) / 1000 / done) * (N - done) * 1.25;
      hooks.onProgress?.({ fileName: file.name, page: n, done, total: N, method, ocrStatus, etaSec: eta });
    };
    const opts = { preserveLayout: settings.preserveLayout, locale: settings.locale || 'ro' };

    // 0) page headers/footers: learn them from a sample of pages (all pages for short documents)
    const sampleNs = N <= 40 ? Array.from({ length: N }, (_, i) => i + 1)
      : [...new Set([...Array.from({ length: 20 }, (_, i) => i + 1), ...Array.from({ length: 20 }, (_, i) => Math.round(21 + i * (N - 21) / 19))])].filter(n => n <= N);
    const sample = [];
    for (const n of sampleNs) {
      if (hooks.isCancelled?.()) throw new CancelledError();
      try { const rp = await readPage(pdf, n, { lines: false }); sample.push({ n, width: rp.width, height: rp.height, words: rp.words }); rp.page.cleanup(); } catch { /* page errors are reported in the main pass */ }
    }
    const running = runningLines(sample);
    const runningArr = [...running];
    const runningSample = finishDocument(sample, sample.map(() => EMPTY_PAGE_RESULT), opts, running).runningLines;
    sample.length = 0;

    // 1) main pass in batches: read -> (OCR if needed) -> rebuild tables -> discard page text
    const pageResults = new Array(N);
    const BATCH = 16;
    let ocrReady = null; // null = not tried yet, true/false after first attempt
    let ocrStartError = null;
    doc.diagnostics = [];
    for (let b0 = 1; b0 <= N; b0 += BATCH) {
      const batch = [];
      const needOcr = [];
      for (let n = b0; n < Math.min(N + 1, b0 + BATCH); n++) {
        if (hooks.isCancelled?.()) throw new CancelledError();
        const info = { n, method: 'digital', status: 'ok', chars: 0, words: 0 };
        doc.pages.push(info);
        let pd = { n, page: n, width: 595, height: 842, words: [], H: [], V: [], ocr: false };
        try {
          const rp = await readPage(pdf, n);
          pd = { n, page: n, width: rp.width, height: rp.height, words: [], H: rp.H, V: rp.V, ocr: false };
          info.chars = rp.chars; info.offPage = rp.offPage; info.ops = rp.ops;
          if (rp.linesError) doc.notes.push({ sev: 'warn', msg: `Page ${n}: the drawing (table borders) could not be read, so tables were rebuilt from text alignment only` });
          const scanned = (rp.chars < 20 && rp.imageCoverage > 0.05) || (rp.imageCoverage > 0.5 && rp.chars < 200);
          const wantOcr = settings.mode === 'ocr' ? true : settings.mode === 'auto' ? scanned : false;
          if (settings.mode === 'digital' && scanned) {
            info.status = 'skipped'; info.method = 'none';
            info.error = 'This page is a scanned image. Digital mode does not use OCR, so it was not converted.';
            pd.H = []; pd.V = []; rp.page.cleanup();
          } else if (wantOcr) {
            info.method = 'ocr'; info.status = 'queued'; pd.ocr = true;
            needOcr.push({ n, rp, pd });
          } else if (rp.chars === 0) {
            info.method = 'none'; info.status = 'empty'; rp.page.cleanup();
          } else {
            pd.words = rp.words; info.words = rp.words.length;
            if (rp.rotatedText > rp.words.length * 0.3) doc.notes.push({ sev: 'warn', msg: `Page ${n} contains rotated text — tables on this page may be incomplete` });
            rp.page.cleanup();
          }
          if (info.method !== 'ocr') done++;
        } catch (e) {
          if (e instanceof CancelledError) throw e;
          info.status = 'failed'; info.error = 'This page could not be read: ' + friendlyError(e);
          done++;
        }
        batch.push(pd);
        if (n % 4 === 0 || n === N) report(n, info.method === 'ocr' ? 'OCR (queued)' : 'Digital text', null);
      }

      // OCR for the scanned pages of this batch
      if (needOcr.length && ocrReady !== false) {
        if (ocrReady === null) {
          try {
            await ensureOcr(settings.langs, s => hooks.onProgress?.({ fileName: file.name, page: needOcr[0].n, done, total: N, method: 'OCR', ocrStatus: s }));
            ocrReady = true;
          } catch (e) {
            if (hooks.isCancelled?.()) throw new CancelledError();
            ocrReady = false; ocrStartError = e?.message || 'the OCR files did not load';
          }
        }
      }
      if (needOcr.length && ocrReady === false) {
        for (const { n, rp } of needOcr) { const p = doc.pages[n - 1]; p.status = 'failed'; p.error = 'OCR could not start: ' + ocrStartError; rp.page.cleanup(); done++; }
      } else if (needOcr.length) {
        await pool(needOcr, ocrWorkerCount(), async ({ n, rp, pd }) => {
          if (hooks.isCancelled?.()) throw new CancelledError();
          const info = doc.pages[n - 1];
          const tp = performance.now();
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
            img = null;
            if (hooks.isCancelled?.()) throw new CancelledError();
            report(n, 'OCR (scanned page)', 'Recognizing text…');
            const { words, avgConf } = await ocrPage(canvas, ctx, scale, lines, (s) => report(n, 'OCR (scanned page)', s), hooks);
            canvas.width = canvas.height = 0; // free memory
            pd.words = words;
            pd.H = [...(rp.H || []), ...lines.H];
            pd.V = [...(rp.V || []), ...lines.V];
            info.status = words.length ? 'ok' : 'empty';
            info.words = words.length; info.ocrConf = avgConf;
            doc.ocrPages++;
          } catch (e) {
            if (e instanceof CancelledError || hooks.isCancelled?.()) throw new CancelledError();
            info.status = 'failed'; info.error = 'OCR failed on this page: ' + friendlyError(e);
          } finally {
            rp.page.cleanup();
            ocrTimes.push((performance.now() - tp) / 1000);
            done++;
            report(n, 'OCR (scanned page)', info.status === 'ok' ? 'Done' : info.status);
          }
        });
      }

      // rebuild the tables of this batch, then drop the page text
      for (const pd of batch) {
        if (hooks.isCancelled?.()) throw new CancelledError();
        const info = doc.pages[pd.n - 1];
        doc.diagnostics.push({ page: pd.n, method: info.method, status: info.status, chars: info.chars, words: pd.words.length, hLines: pd.H.length, vLines: pd.V.length, offPage: info.offPage || 0, ops: info.ops || 0 });
        try {
          pageResults[pd.n - 1] = pd.words.length ? await processPageInWorker(pd, opts, runningArr) : EMPTY_PAGE_RESULT;
        } catch (e) {
          restartWorker();
          info.status = 'failed'; info.error = 'Tables on this page could not be rebuilt: ' + friendlyError(e);
          pageResults[pd.n - 1] = EMPTY_PAGE_RESULT;
        }
        pd.words = null; pd.H = null; pd.V = null;
      }
      report(Math.min(N, b0 + BATCH - 1), 'Digital text + rebuilding tables', null);
      await new Promise(r => setTimeout(r)); // let the browser breathe / collect memory
    }

    if (hooks.isCancelled?.()) throw new CancelledError();
    hooks.onProgress?.({ fileName: file.name, page: N, done: N, total: N, method: 'Joining pages and checking values', ocrStatus: null });
    await new Promise(r => setTimeout(r, 30));
    const res = finishDocument(doc.pages.map(p => ({ n: p.n })), pageResults, opts, new Set());
    doc.tables = res.tables;
    doc.outside = res.outside;
    doc.runningLines = runningSample;
    doc.tables.forEach(t => { t.fileName = file.name; });

    // notes
    const bad = doc.pages.filter(p => p.status === 'failed' || p.status === 'skipped');
    if (bad.length <= 15) for (const p of bad) doc.notes.push({ sev: 'warn', msg: `Page ${p.n}: ${p.error}` });
    else {
      const byErr = new Map();
      for (const p of bad) { const k = p.error.replace(/\d+/g, '#'); if (!byErr.has(k)) byErr.set(k, { msg: p.error, pages: [] }); byErr.get(k).pages.push(p.n); }
      for (const { msg, pages } of byErr.values()) doc.notes.push({ sev: 'warn', msg: `${pages.length} page(s) (${pageList(pages)}): ${msg}` });
    }
    const offTotal = doc.pages.reduce((a, p) => a + (p.offPage || 0), 0);
    if (offTotal) doc.notes.push({ sev: 'info', msg: `${offTotal} hidden text fragment(s) positioned outside the visible page were ignored` });
    const emptyPages = doc.pages.filter(p => p.status === 'empty').map(p => p.n);
    if (emptyPages.length) doc.notes.push({ sev: 'info', msg: `No text found on page(s) ${pageList(emptyPages)}` });
    if (!doc.tables.length && doc.outside.length) doc.notes.push({ sev: 'warn', msg: 'No table structure was detected. The text was exported line by line to the "Other text" sheet.' });
    else if (doc.outside.length) doc.notes.push({ sev: 'info', msg: `${doc.outside.reduce((a, o) => a + o.lines.length, 0)} line(s) of text outside tables (titles, notes) were exported to the "Other text" sheet` });
    if (doc.runningLines.length) doc.notes.push({ sev: 'info', msg: `Repeated page headers/footers were not treated as data (e.g. "${doc.runningLines[0].slice(0, 60)}")` });
    for (const t of doc.tables) {
      const rem = t.removed || [];
      if (rem.length === 1) doc.notes.push({ sev: 'info', msg: `Table ${t.index}: ${rem[0].reason}` });
      else if (rem.length > 1) doc.notes.push({ sev: 'info', msg: `Table ${t.index}: repeated header row removed on ${rem.length} pages (${pageList(rem.map(r => r.page))}) — can be restored in Preview` });
    }
    if (doc.ocrPages) {
      const skewed = doc.pages.filter(p => p.skew).slice(0, 30).map(p => `${p.n} (${p.skew}°)`);
      doc.notes.unshift({ sev: 'warn', msg: `${doc.ocrPages} scanned page(s) were read with OCR. OCR text is not verified: compare it with the original before use. Low-confidence cells are highlighted, but OCR can also be confidently wrong (e.g. "×" read as "x", missing diacritics).` });
      if (skewed.length) doc.notes.push({ sev: 'info', msg: `Tilted scan straightened before reading: page ${skewed.join(', ')}` });
      if (fragmentsDropped) doc.notes.push({ sev: 'info', msg: `${fragmentsDropped} tiny low-confidence fragment(s) next to cell borders were ignored (border remains, not data)` });
      const noisy = doc.pages.filter(p => p.noisy).map(p => p.n);
      if (noisy.length) doc.notes.push({ sev: 'info', msg: `Scan noise (specks) removed before reading on page ${pageList(noisy)}` });
    }
  } catch (e) {
    if (e instanceof CancelledError || hooks.isCancelled?.()) { doc.cancelled = true; doc.status = 'CANCELLED'; await closePdf(pdf); return doc; }
    doc.fatal = true; doc.error = 'Processing failed: ' + friendlyError(e);
  }
  await closePdf(pdf);
  doc.status = documentStatus(doc);
  doc.seconds = (performance.now() - t0) / 1000;
  return doc;
}

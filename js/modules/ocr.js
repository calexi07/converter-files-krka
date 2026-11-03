// OCR with Tesseract.js. Everything (engine, worker, language data) is
// served from this site's own /libraries folder — nothing is fetched elsewhere.

const ROOT = new URL('../../libraries/tesseract/', import.meta.url).href;
const PATHS = {
  workerPath: ROOT + 'worker.min.js',
  corePath: ROOT + 'core',
  langPath: ROOT + 'lang',
};

let pool = [];          // [{worker, busy}]
let poolLangs = '';
let initPromise = null;
let generation = 0; // bumped on terminate so a cancelled start-up stops cleanly

export function ocrWorkerCount() {
  const hc = navigator.hardwareConcurrency || 4;
  return Math.max(1, Math.min(3, Math.floor(hc / 2)));
}

export async function ensureOcr(langs, onStatus) {
  const key = langs.join('+');
  if (pool.length && poolLangs === key) return;
  if (initPromise && poolLangs === key) return initPromise;
  await terminateOcr();
  poolLangs = key;
  const n = ocrWorkerCount();
  const gen = ++generation;
  initPromise = (async () => {
    if (typeof Tesseract === 'undefined') throw new Error('The OCR engine file could not be loaded.');
    onStatus?.(`Loading OCR engine and language data (${langs.map(l => l === 'ron' ? 'Romanian' : 'English').join(' + ')})…`);
    const made = [];
    for (let i = 0; i < n; i++) {
      // eslint-disable-next-line no-undef
      const w = await Tesseract.createWorker(langs, 1, { ...PATHS, workerBlobURL: false, gzip: true, cacheMethod: 'write' });
      if (gen !== generation) { await w.terminate().catch(() => {}); for (const m of made) await m.worker.terminate().catch(() => {}); throw new OcrStoppedError(); }
      await w.setParameters({ preserve_interword_spaces: '1', tessedit_pageseg_mode: '11' });
      made.push({ worker: w, busy: false, psm: '11' });
      onStatus?.(`OCR engine ready (${i + 1}/${n} workers)`);
    }
    if (gen !== generation) { for (const m of made) await m.worker.terminate().catch(() => {}); throw new OcrStoppedError(); }
    pool = made;
  })();
  initPromise.catch(() => {}); // errors are handled by the caller below
  try { await stoppable(initPromise); } catch (e) { if (!(e instanceof OcrStoppedError)) { pool = []; poolLangs = ''; initPromise = null; } throw e; }
}

// Pending OCR calls are tracked so that Cancel can stop them immediately.
const pendingRejects = new Set();
export class OcrStoppedError extends Error { constructor() { super('OCR stopped'); this.name = 'OcrStoppedError'; } }

function acquire() {
  return new Promise((resolve, reject) => {
    pendingRejects.add(reject);
    const tryGet = () => {
      if (!pendingRejects.has(reject)) return; // cancelled meanwhile
      if (!pool.length) { pendingRejects.delete(reject); reject(new OcrStoppedError()); return; }
      const free = pool.find(p => !p.busy);
      if (free) { pendingRejects.delete(reject); free.busy = true; resolve(free); } else setTimeout(tryGet, 40);
    };
    tryGet();
  });
}

function stoppable(promise) {
  return new Promise((resolve, reject) => {
    pendingRejects.add(reject);
    promise.then(v => { pendingRejects.delete(reject); resolve(v); }, e => { pendingRejects.delete(reject); reject(e); });
  });
}

// Returns words in PDF points: [{t,x0,y0,x1,y1,h,c}]
// opts: {psm: '6'|'7'|'11', offsetX, offsetY} — offsets in canvas pixels
export async function ocrCanvas(canvas, scale, opts = {}) {
  const slot = await acquire();
  const ox = opts.offsetX || 0, oy = opts.offsetY || 0, k = opts.upscale || 1;
  try {
    if (opts.psm && opts.psm !== slot.psm) { await stoppable(slot.worker.setParameters({ tessedit_pageseg_mode: opts.psm })); slot.psm = opts.psm; }
    const { data } = await stoppable(slot.worker.recognize(canvas, {}, { blocks: true, text: false }));
    const words = [];
    const confs = [];
    let dropped = 0;
    for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const w of l.words || []) {
      const t = (w.text || '').trim();
      if (!t) continue;
      // stray marks: only symbols (no letters/digits) and low confidence
      if (/^[^\p{L}\p{N}%€$]+$/u.test(t) && w.confidence < 75) { dropped++; continue; }
      const bb = w.bbox;
      words.push({ t, x0: (bb.x0 / k + ox) / scale, x1: (bb.x1 / k + ox) / scale, y0: (bb.y0 / k + oy) / scale, y1: (bb.y1 / k + oy) / scale, h: Math.max(4, (l.bbox.y1 - l.bbox.y0) / k / scale), c: w.confidence });
      confs.push(w.confidence);
    }
    const avg = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null;
    return { words, avgConf: avg, dropped };
  } finally { slot.busy = false; }
}

export async function terminateOcr() {
  for (const rej of pendingRejects) rej(new OcrStoppedError());
  pendingRejects.clear();
  generation++;
  const old = pool; pool = []; poolLangs = ''; initPromise = null;
  await Promise.all(old.map(p => p.worker.terminate().catch(() => {})));
}

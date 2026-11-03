// Table reconstruction engine.
// Input: per-page words with positions (from PDF text or OCR) and ruling lines.
// Output: tables with rows/cells of RAW text plus flags. Typing happens later.
//
// Two strategies, like professional tools (Tabula/Camelot/pdfplumber):
//  - LATTICE: tables drawn with grid lines -> exact cells from the lines.
//  - STREAM:  tables without lines -> columns from vertical white gaps.

import { TOL } from './geometry.js';

const OCR_CONF_WARN = 90; // OCR words below this confidence are flagged for review

// ---------------- basic helpers ----------------
const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const yc = w => (w.y0 + w.y1) / 2;
const xc = w => (w.x0 + w.x1) / 2;
const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

export function lineify(words) {
  const sorted = [...words].sort((a, b) => yc(a) - yc(b) || a.x0 - b.x0);
  const lines = [];
  for (const w of sorted) {
    let best = null;
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i--) {
      const L = lines[i];
      if (Math.abs(yc(w) - L.yc) <= 0.45 * Math.max(Math.min(w.h, L.h), 1)) { best = L; break; }
    }
    if (best) {
      best.words.push(w);
      best.yc = (best.yc * (best.words.length - 1) + yc(w)) / best.words.length;
      best.h = Math.max(best.h, w.h);
    } else lines.push({ words: [w], yc: yc(w), h: w.h });
  }
  for (const L of lines) {
    L.words.sort((a, b) => a.x0 - b.x0);
    L.words = glueFragments(L.words);
    L.x0 = Math.min(...L.words.map(w => w.x0)); L.x1 = Math.max(...L.words.map(w => w.x1));
    L.y0 = Math.min(...L.words.map(w => w.y0)); L.y1 = Math.max(...L.words.map(w => w.y1));
  }
  return lines;
}

// Some PDFs place each character separately. Glue touching fragments into words.
function glueFragments(ws) {
  const out = [];
  for (const w of ws) {
    const p = out[out.length - 1];
    if (p && w.x0 - p.x1 < 0.1 * Math.min(p.h, w.h) && w.x0 >= p.x0) {
      out[out.length - 1] = { ...p, t: p.t + w.t, x1: Math.max(p.x1, w.x1), y0: Math.min(p.y0, w.y0), y1: Math.max(p.y1, w.y1), c: minConf(p.c, w.c) };
    } else out.push(w);
  }
  return out;
}
function minConf(a, b) { if (a == null) return b; if (b == null) return a; return Math.min(a, b); }

export function joinWords(ws) {
  const s = [...ws].sort((a, b) => a.x0 - b.x0);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i && s[i].x0 - s[i - 1].x1 > 0.12 * s[i].h) out += ' ';
    out += s[i].t;
  }
  return out.trim();
}

function cellFromWords(ws, multiline) {
  if (!ws.length) return { raw: '', conf: null, flags: [] };
  const lines = lineify(ws);
  const text = lines.map(L => joinWords(L.words)).filter(Boolean).join(multiline ? '\n' : ' ');
  let conf = null;
  for (const w of ws) conf = minConf(conf, w.c);
  const flags = [];
  if (conf != null && conf < OCR_CONF_WARN) flags.push({ kind: 'ocr', sev: 'warn', msg: `Low OCR confidence (${Math.round(conf)}%) — check against the PDF` });
  return { raw: text, conf, flags };
}

const NUMLIKE = /^[-+−(]?\s*[\d][\d\s.,]*\s*%?\)?$|^[-+−(]?[\d.,]+\s*(lei|ron|eur|€|\$)?$/i;
const DATELIKE = /^\d{1,4}[./-]\d{1,2}[./-]\d{2,4}$/;
const YEARLIKE = /^(19|20)\d{2}$/;
function kindOf(t) {
  const s = String(t || '').trim();
  if (!s) return 'empty';
  if (DATELIKE.test(s)) return 'num';
  if (NUMLIKE.test(s)) return YEARLIKE.test(s) ? 'year' : 'num';
  return 'text';
}

// ---------------- running headers / footers ----------------
export function findRunningLines(pages) {
  if (pages.length < 2) return new Set();
  const seen = new Map();
  pages.forEach((p, pi) => {
    for (const L of lineify(p.words)) {
      const rel = L.yc / p.height;
      if (rel > 0.12 && rel < 0.88) continue;
      if (phrases(L).length >= 3) continue; // looks like a table row (e.g. repeated table header)
      const key = norm(joinWords(L.words)).replace(/\d+/g, '#') + '@' + Math.round(L.yc / 8);
      if (!seen.has(key)) seen.set(key, new Set());
      seen.get(key).add(pi);
    }
  });
  const need = Math.max(2, Math.ceil(pages.length * 0.6));
  const keys = new Set();
  for (const [k, s] of seen) if (s.size >= need) keys.add(k);
  return keys;
}
function runningKey(L) { return norm(joinWords(L.words)).replace(/\d+/g, '#') + '@' + Math.round(L.yc / 8); }

// ---------------- LATTICE ----------------
function clusterVals(vals, tol) {
  const s = [...vals].sort((a, b) => a - b);
  const groups = [];
  for (const v of s) {
    const g = groups[groups.length - 1];
    if (g && v - g[g.length - 1] <= tol) g.push(v); else groups.push([v]);
  }
  return groups.map(g => g.reduce((a, b) => a + b, 0) / g.length);
}
const snap = (v, arr) => arr.reduce((best, a) => Math.abs(a - v) < Math.abs(best - v) ? a : best, arr[0]);

export const MAX_GRID_LINES = 600; // per direction, per page — protects memory on unusual drawings
export function latticeCells(H, V) {
  if (H.length > MAX_GRID_LINES || V.length > MAX_GRID_LINES) return [];
  const pts = [];
  for (const h of H) for (const v of V) {
    if (v.x >= h.x0 - TOL && v.x <= h.x1 + TOL && h.y >= v.y0 - TOL && h.y <= v.y1 + TOL) pts.push([v.x, h.y]);
  }
  if (pts.length < 4) return [];
  const xs = clusterVals(pts.map(p => p[0]), TOL), ys = clusterVals(pts.map(p => p[1]), TOL);
  const set = new Set(pts.map(([x, y]) => snap(x, xs) + ',' + snap(y, ys)));
  const has = (x, y) => set.has(x + ',' + y);
  const hasH = (y, a, b) => H.some(h => Math.abs(h.y - y) <= TOL && h.x0 <= a + TOL && h.x1 >= b - TOL);
  const hasV = (x, a, b) => V.some(v => Math.abs(v.x - x) <= TOL && v.y0 <= a + TOL && v.y1 >= b - TOL);
  const cells = [];
  for (const y of ys) for (const x of xs) {
    if (!has(x, y)) continue;
    const rights = xs.filter(x2 => x2 > x && has(x2, y));
    const downs = ys.filter(y2 => y2 > y && has(x, y2));
    let found = null;
    for (const x2 of rights) {
      if (!hasH(y, x, x2)) break;
      for (const y2 of downs) {
        if (!hasV(x, y, y2)) break;
        if (has(x2, y2) && hasH(y2, x, x2) && hasV(x2, y, y2)) { found = [x, y, x2, y2]; break; }
      }
      if (found) break;
    }
    if (found) cells.push(found);
  }
  return cells;
}

export function groupCells(cells) {
  const parent = cells.map((_, i) => i);
  const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
  const corner = new Map();
  cells.forEach((c, i) => {
    for (const k of [[c[0], c[1]], [c[2], c[1]], [c[0], c[3]], [c[2], c[3]]].map(p => p.join(','))) {
      if (corner.has(k)) parent[find(i)] = find(corner.get(k)); else corner.set(k, i);
    }
  });
  const groups = new Map();
  cells.forEach((c, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(c); });
  return [...groups.values()];
}

function latticeTables(page, words, opts) {
  const cells = latticeCells(page.H || [], page.V || []);
  const used = new Set();
  const tables = [];
  for (const group of groupCells(cells)) {
    const xs = clusterVals(group.flatMap(c => [c[0], c[2]]), 1), ys = clusterVals(group.flatMap(c => [c[1], c[3]]), 1);
    const nr = ys.length - 1, nc = xs.length - 1;
    if (group.length < 3 || nr * nc < 4) continue;
    const bbox = [xs[0], ys[0], xs[nc], ys[nr]];
    const idx = (arr, v) => arr.indexOf(snap(v, arr));
    const placed = group.map(c => ({ c, r0: idx(ys, c[1]), r1: idx(ys, c[3]), c0: idx(xs, c[0]), c1: idx(xs, c[2]), words: [] }));
    const misplaced = [];
    words.forEach((w, wi) => {
      if (used.has(wi)) return;
      const x = xc(w), y = yc(w);
      if (x < bbox[0] - TOL || x > bbox[2] + TOL || y < bbox[1] - TOL || y > bbox[3] + TOL) return;
      let cell = placed.find(p => x >= p.c[0] - 1 && x <= p.c[2] + 1 && y >= p.c[1] - 1 && y <= p.c[3] + 1);
      if (!cell) {
        cell = placed.reduce((b, p) => {
          const d = Math.hypot(x - (p.c[0] + p.c[2]) / 2, y - (p.c[1] + p.c[3]) / 2);
          return !b || d < b.d ? { p, d } : b;
        }, null).p;
        misplaced.push(cell);
      }
      cell.words.push(w); used.add(wi);
    });
    const grid = Array.from({ length: nr }, () => Array.from({ length: nc }, () => ({ raw: '', conf: null, flags: [] })));
    const spans = [];
    for (const p of placed) {
      const cell = cellFromWords(p.words, opts.preserveLayout);
      if (misplaced.includes(p)) cell.flags.push({ kind: 'structure', sev: 'warn', msg: 'Some text was outside the drawn cell borders and was placed in the nearest cell' });
      grid[p.r0][p.c0] = cell;
      if (p.r1 - p.r0 > 1 || p.c1 - p.c0 > 1) {
        spans.push({ r0: p.r0, r1: p.r1, c0: p.c0, c1: p.c1 });
        for (let r = p.r0; r < p.r1; r++) for (let c = p.c0; c < p.c1; c++) if (r !== p.r0 || c !== p.c0) grid[r][c] = { raw: '', conf: null, flags: [], covered: true };
      }
    }
    tables.push({ method: 'lattice', bbox, grid, spans, colX: xs, rowY: ys.slice(0, -1).map((y, i) => [y, ys[i + 1]]), page: page.page });
  }
  return { tables, used };
}

// ---------------- STREAM ----------------
function phrases(L, gapFactor = 0.8) {
  const out = [];
  for (const w of L.words) {
    const p = out[out.length - 1];
    if (p && w.x0 - p.x1 < gapFactor * Math.max(w.h, p.h)) { p.words.push(w); p.x1 = Math.max(p.x1, w.x1); }
    else out.push({ words: [w], x0: w.x0, x1: w.x1, h: w.h });
  }
  return out;
}
function isProse(L, textWidth) {
  if (L.words.length < 6) return false;
  if (L.x1 - L.x0 < 0.5 * textWidth) return false;
  for (let i = 1; i < L.words.length; i++) if (L.words[i].x0 - L.words[i - 1].x1 > 0.8 * L.h) return false;
  return true;
}

function columnsFromCoverage(lines, x0, x1, h) {
  const res = 0.5; const n = Math.min(40000, Math.ceil((x1 - x0) / res) + 2);
  const cov = new Uint16Array(n);
  for (const L of lines) for (const w of L.words) {
    const a = Math.max(0, Math.floor((w.x0 - x0) / res)), b = Math.min(n - 1, Math.ceil((w.x1 - x0) / res));
    if (!(b >= a)) continue;
    for (let i = a; i <= b; i++) cov[i]++;
  }
  const gaps = [];
  let start = -1;
  for (let i = 0; i < n; i++) {
    if (cov[i] === 0) { if (start < 0) start = i; }
    else if (start >= 0) { gaps.push([start, i]); start = -1; }
  }
  const minGap = Math.max(0.4 * h, 2.5);
  const cuts = gaps.filter(([a, b]) => a > 0 && (b - a) * res >= minGap).map(([a, b]) => x0 + ((a + b) / 2) * res);
  return cuts;
}

function streamTables(page, words, opts, runningKeys) {
  const lines = lineify(words).filter(L => !runningKeys.has(runningKey(L)));
  const outside = [];
  if (!lines.length) return { tables: [], outside };
  const textW = Math.max(...lines.map(L => L.x1)) - Math.min(...lines.map(L => L.x0));
  const medH = median(lines.map(L => L.h)) || 10;

  // split into blocks
  const blocks = []; let cur = [];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (isProse(L, textW)) { if (cur.length) blocks.push(cur); cur = []; outside.push(L); continue; }
    const prev = cur[cur.length - 1];
    if (prev && L.y0 - prev.y1 > 2.0 * Math.max(prev.h, L.h, medH * 0.8)) { blocks.push(cur); cur = []; }
    cur.push(L);
  }
  if (cur.length) blocks.push(cur);

  const tables = [];
  for (const block of blocks) {
    const t = blockToTable(block, opts, page.page);
    if (t) { tables.push(t); outside.push(...(t._outside || [])); delete t._outside; }
    else outside.push(...block);
  }
  return { tables, outside };
}

// A column cut is weak when it only splits ordinary word spacing inside a
// phrase (e.g. a long header over an empty area) and the new column would be
// almost empty. Such cuts are removed.
function dropWeakCuts(cuts, block, h) {
  let changed = true;
  while (changed && cuts.length) {
    changed = false;
    for (let k = 0; k < cuts.length; k++) {
      const left = k > 0 ? cuts[k - 1] : -Infinity, cut = cuts[k], right = k + 1 < cuts.length ? cuts[k + 1] : Infinity;
      let wide = 0, narrow = 0, fillL = 0, fillR = 0;
      for (const L of block) {
        const lw = L.words.filter(w => xc(w) > left && xc(w) <= cut);
        const rw = L.words.filter(w => xc(w) > cut && xc(w) <= right);
        if (lw.length) fillL++;
        if (rw.length) fillR++;
        if (lw.length && rw.length) {
          const gap = Math.min(...rw.map(w => w.x0)) - Math.max(...lw.map(w => w.x1));
          if (gap >= 0.8 * Math.max(h, 1)) wide++; else narrow++;
        }
      }
      const minFill = Math.min(fillL, fillR);
      if (!wide && narrow && minFill <= Math.max(1, Math.floor(block.length * 0.3))) { cuts = cuts.filter((_, i) => i !== k); changed = true; break; }
    }
  }
  return cuts;
}

function blockToTable(block, opts, pageNo) {
  const multi = block.filter(L => phrases(L).length >= 2);
  if (multi.length < 2) return null;
  const x0 = Math.min(...block.map(L => L.x0)), x1 = Math.max(...block.map(L => L.x1));
  const h = median(block.map(L => L.h)) || 10;
  let cuts = columnsFromCoverage(multi, x0 - 1, x1 + 1, h);
  cuts = dropWeakCuts(cuts, block, h);
  const nc = cuts.length + 1;
  if (nc < 2) return null;
  const colOf = x => { let c = 0; while (c < cuts.length && x > cuts[c]) c++; return c; };

  let rows = block.map(L => {
    const buckets = Array.from({ length: nc }, () => []);
    let spanning = false;
    for (const w of L.words) {
      const c = colOf(xc(w));
      buckets[c].push(w);
      const cl = c > 0 ? cuts[c - 1] : -Infinity, cr = c < cuts.length ? cuts[c] : Infinity;
      if (w.x0 < cl - 0.3 * (w.x1 - w.x0) || w.x1 > cr + 0.3 * (w.x1 - w.x0)) spanning = true;
    }
    return { L, buckets, spanning, filled: buckets.filter(b => b.length).length };
  });

  // a block must look like a table: most lines with 2+ cells
  const multiRows = rows.filter(r => r.filled >= 2).length;
  if (multiRows < 2 || multiRows / rows.length < 0.5) return null;
  if (rows.length === 2 && nc < 3) return null;

  // trim leading caption lines (one long phrase over several columns)
  const outside = [];
  const isCaption = r => (phrases(r.L).length === 1 && r.L.h > h * 1.25) // larger font title
    || (r.filled === 1 && (r.spanning || (phrases(r.L).length === 1 && nc >= 3 && r.L.x1 - r.L.x0 > (x1 - x0) * 0.4)));
  while (rows.length > 2 && isCaption(rows[0])) outside.push(rows.shift().L);
  while (rows.length > 2 && rows[rows.length - 1].filled === 1 && rows[rows.length - 1].spanning) outside.push(rows.pop().L);

  // key column = leftmost column that is filled in most rows
  const fill = Array.from({ length: nc }, (_, c) => rows.filter(r => r.buckets[c].length).length);
  const maxFill = Math.max(...fill);
  const key = fill.findIndex(f => f >= maxFill * 0.8);
  const gaps = rows.map((r, i) => i ? r.L.y0 - rows[i - 1].L.y1 : 0);
  const half = Math.max(1, Math.floor(nc / 2));
  // spacing before "full" rows = normal row spacing
  const fullGaps = rows.map((r, i) => (i > 1 && r.filled > half) ? gaps[i] : null).filter(g => g != null);
  const typicalGap = median(fullGaps);

  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const prev = out[out.length - 1];
    const sparse = prev && i > 1 && r.filled <= half;
    const tight = sparse && typicalGap > 0 && gaps[i] < typicalGap * 0.6;
    const isCont = sparse && !r.buckets[key].length;
    if (tight) {
      // tighter spacing than normal rows -> wrapped text of the row above
      for (let c = 0; c < nc; c++) if (r.buckets[c].length) prev.buckets[c].push(...r.buckets[c]);
      prev.mergedLines = (prev.mergedLines || 0) + 1;
      continue;
    }
    out.push({ ...r, buckets: r.buckets.map(b => b.slice()), possibleCont: isCont });
  }

  const grid = out.map(r => r.buckets.map(b => cellFromWords(b, opts.preserveLayout)));
  out.forEach((r, i) => {
    if (r.spanning) grid[i].forEach(c => { if (c.raw) c.flags.push({ kind: 'structure', sev: 'warn', msg: 'Text in this row crosses column boundaries — check the column placement' }); });
    if (r.possibleCont) {
      const c = grid[i].find(c => c.raw);
      if (c) c.flags.push({ kind: 'structure', sev: 'warn', msg: 'This row has no value in the main column — it may belong to the row above (use "Merge with row above" if so)' });
    }
  });
  const colX = [x0, ...cuts, x1];
  const bbox = [x0, Math.min(...out.map(r => r.L.y0)), x1, Math.max(...out.map(r => r.L.y1))];
  return { method: 'stream', bbox, grid, spans: [], colX, page: pageNo, _outside: outside };
}

// ---------------- HEADER ----------------
function decideHeader(t) {
  const g = t.grid, nr = g.length, nc = g[0]?.length || 0;
  if (nr < 2) return 0;
  const kinds = g.map(r => r.map(c => kindOf(c.raw)));
  const numBelow = (c, from) => {
    const v = kinds.slice(from).map(r => r[c]).filter(k => k !== 'empty');
    return v.length && v.filter(k => k === 'num').length / v.length >= 0.6;
  };
  const anyNumCol = Array.from({ length: nc }, (_, c) => numBelow(c, 1)).some(Boolean);
  const headerLike = r => {
    const ks = kinds[r];
    const filled = ks.filter(k => k !== 'empty').length + (t.spans.filter(s => s.r0 === r).reduce((a, s) => a + (s.c1 - s.c0 - 1), 0));
    if (ks.some(k => k === 'num')) return false;
    return filled >= Math.max(1, Math.ceil(nc * 0.5));
  };
  if (!headerLike(0)) return 0;
  let hasHeader = false;
  if (anyNumCol) hasHeader = Array.from({ length: nc }, (_, c) => kinds[0][c] === 'text' && numBelow(c, 1)).some(Boolean)
    || Array.from({ length: nc }, (_, c) => kinds[0][c] !== 'empty' && numBelow(c, 1)).some(Boolean);
  else hasHeader = kinds[0].every(k => k !== 'empty') && nr >= 2;
  if (!hasHeader) return 0;
  // second header row (stacked headers under merged cells)
  if (nr >= 3 && headerLike(1)) {
    const row0HasSpan = t.spans.some(s => s.r0 === 0 && s.c1 - s.c0 > 1);
    const row0Gaps = kinds[0].some(k => k === 'empty');
    if ((row0HasSpan || row0Gaps) && Array.from({ length: nc }, (_, c) => numBelow(c, 2)).some(Boolean)) return 2;
  }
  return 1;
}

function headerNames(t, hn) {
  const nc = t.grid[0].length;
  const names = [];
  for (let c = 0; c < nc; c++) {
    const parts = [];
    for (let r = 0; r < hn; r++) {
      let txt = t.grid[r][c].raw;
      if (!txt) {
        const sp = t.spans.find(s => s.r0 <= r && s.r1 > r && s.c0 <= c && s.c1 > c);
        if (sp) txt = t.grid[sp.r0][sp.c0].raw;
      }
      if (txt && !parts.includes(txt)) parts.push(txt.replace(/\n/g, ' '));
    }
    names.push(parts.join(' – '));
  }
  return names;
}

export function uniqueNames(names) {
  const seen = new Map();
  return names.map((n, i) => {
    let base = String(n || '').trim() || `Column ${i + 1}`;
    let name = base, k = 2;
    while (seen.has(name.toLowerCase())) name = `${base} (${k++})`;
    seen.set(name.toLowerCase(), true);
    return name;
  });
}

// Memory-lean cell: no empty arrays / null fields (matters for 100k+ rows)
function compactCell(raw, conf, flags) {
  const c = { raw };
  if (conf != null) c.conf = conf;
  if (flags && flags.length) c.flags = flags.slice();
  return c;
}

function finalizeTable(t, ocr) {
  const hn = decideHeader(t);
  const nc = t.grid[0].length;
  const names = hn ? headerNames(t, hn) : Array.from({ length: nc }, (_, i) => '');
  const headerRaw = t.grid.slice(0, hn).map(r => r.map(c => c.raw));
  const headerFlags = t.grid.slice(0, hn).flatMap(r => r.flatMap(c => c.flags));
  const rows = t.grid.slice(hn).map((r, i) => ({
    cells: r.map(c => compactCell(c.raw, c.conf, c.flags)),
    page: t.page, src: ocr ? 'ocr' : 'text',
  }));
  // merged cells in data area: note them
  const dataSpans = t.spans.filter(s => s.r0 >= hn);
  for (const s of dataSpans) {
    const row = rows[s.r0 - hn];
    const cell = row?.cells[s.c0];
    if (cell) (cell.flags ||= []).push({ kind: 'merged', sev: 'info', msg: `Merged cell in the PDF (spans ${s.r1 - s.r0} row(s) × ${s.c1 - s.c0} column(s)) — value placed in the first cell only` });
  }
  return {
    method: t.method, ocr, bbox: t.bbox, colX: t.colX, page: t.page,
    hasHeader: hn > 0, headerRows: hn, headerRaw, headerFlags,
    columns: uniqueNames(names).map((n, i) => ({ name: n, auto: !names[i] })),
    rows, spans: t.spans,
  };
}

// drop rows/columns that are completely empty
function pruneEmpty(t, preserveLayout) {
  const before = t.rows.length;
  t.rows = t.rows.filter(r => r.cells.some(c => c.raw));
  t.emptyRowsRemoved = before - t.rows.length;
  if (!preserveLayout) {
    const keep = t.columns.map((col, c) => !col.auto || t.rows.some(r => r.cells[c].raw));
    if (keep.some(k => !k)) {
      t.columns = t.columns.filter((_, c) => keep[c]);
      t.rows.forEach(r => { r.cells = r.cells.filter((_, c) => keep[c]); });
      t.colX = null;
    }
  }
}

// ---------------- PAGE / DOCUMENT ----------------
export function extractPageTables(page, opts, runningKeys) {
  const words = page.words.filter(w => w.t && w.t.trim());
  const lat = latticeTables(page, words, opts);
  const rest = words.filter((_, i) => !lat.used.has(i));
  const str = streamTables(page, rest, opts, runningKeys);
  const tables = [...lat.tables, ...str.tables].map(t => finalizeTable(t, !!page.ocr));
  tables.forEach(t => pruneEmpty(t, opts.preserveLayout));
  const kept = tables.filter(t => t.rows.length && t.columns.length);
  kept.sort((a, b) => a.bbox[1] - b.bbox[1]);
  const outside = str.outside.filter(L => joinWords(L.words));
  const outsideText = outside.map(L => joinWords(L.words));
  let outsideAfterLast = 0, outsideBeforeFirst = 0;
  if (kept.length) {
    const lastBottom = kept[kept.length - 1].bbox[3], firstTop = kept[0].bbox[1];
    outsideAfterLast = outside.filter(L => L.y0 > lastBottom).length;
    outsideBeforeFirst = outside.filter(L => L.y1 < firstTop).length;
  }
  return { tables: kept, outsideText, outsideAfterLast, outsideBeforeFirst };
}

function sameGeometry(a, b) {
  if (a.columns.length !== b.columns.length) return false;
  if (!a.colX || !b.colX || a.colX.length !== b.colX.length) return a.method === b.method && a.columns.length >= 2;
  // inner boundaries must line up (outer edges can differ with content width)
  const inner = (x) => x.slice(1, -1);
  const ia = inner(a.colX), ib = inner(b.colX);
  return ia.every((x, i) => Math.abs(x - ib[i]) <= 12);
}

// Join tables that continue onto the next page.
export function mergeAcrossPages(pageResults, pageSizes) {
  const all = [];
  let last = null;
  pageResults.forEach((pr, pi) => {
    pr.tables.forEach((t, ti) => {
      const first = ti === 0;
      const prevPageNo = pi - 1;
      const prevEndsLow = last && last._pi === prevPageNo && last._isLastOnPage;
      const outsideBetween = first && last ? (pageResults[prevPageNo]?.outsideAfterLast || 0) + (pr.outsideBeforeFirst || 0) : 99;
      if (first && prevEndsLow && outsideBetween <= 1 && sameGeometry(last, t)) {
        const same = t.hasHeader && last.hasHeader && t.columns.every((c, i) => norm(c.name) === norm(last.columns[i].name));
        if (t.hasHeader && same) {
          last.removed.push({ reason: `Repeated header row on page ${t.page} removed`, rawRow: t.headerRaw[t.headerRaw.length - 1], at: last.rows.length, page: t.page });
        } else if (t.hasHeader && !same) {
          // header on the continuation page did not match: keep it as data rows
          t.headerRaw.forEach(raw => last.rows.push({ cells: raw.map(r => ({ raw: r, conf: null, flags: [{ kind: 'structure', sev: 'warn', msg: 'This row was detected as a header on its page but does not match the table header — kept as data' }] })), page: t.page, src: t.ocr ? 'ocr' : 'text' }));
        }
        last.rows.push(...t.rows);
        last.pages.push(t.page);
        last.ocr = last.ocr || t.ocr;
        last.continued = true;
        last._pi = pi;
        last._isLastOnPage = ti === pr.tables.length - 1;
        last.colX = t.colX || last.colX;
        return;
      }
      const T = { ...t, pages: [t.page], removed: [], _pi: pi, _isLastOnPage: ti === pr.tables.length - 1 };
      all.push(T);
      last = T;
    });
    if (!pr.tables.length) last = null;
  });
  all.forEach(t => { delete t._pi; delete t._isLastOnPage; });
  return all;
}

// Geometry helpers: ruling lines (table borders) from vector drawings and
// from scanned images. All coordinates are in PDF points, origin top-left.

export const TOL = 2.5;

function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
function apply(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }

// Reads the page's drawing instructions and returns horizontal and vertical
// segments that could be table borders.
// OPS: the pdfjsLib.OPS map. viewportTransform: viewport.transform at scale 1.
export function linesFromOperatorList(opList, OPS, viewportTransform) {
  const H = [], V = [];
  let ctm = viewportTransform.slice();
  const stack = [];
  const fn = opList.fnArray, args = opList.argsArray;
  const strokeOps = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const fillOps = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  let lineWidth = 1;

  for (let i = 0; i < fn.length; i++) {
    const op = fn[i];
    if (op === OPS.save) stack.push({ ctm: ctm.slice(), lineWidth });
    else if (op === OPS.restore) { const s = stack.pop(); if (s) { ctm = s.ctm; lineWidth = s.lineWidth; } }
    else if (op === OPS.transform) ctm = mul(ctm, args[i]);
    else if (op === OPS.paintFormXObjectBegin) {
      stack.push({ ctm: ctm.slice(), lineWidth });
      const m = args[i][0];
      if (Array.isArray(m) || (m && m.length === 6)) ctm = mul(ctm, Array.from(m));
    }
    else if (op === OPS.paintFormXObjectEnd) { const s = stack.pop(); if (s) { ctm = s.ctm; lineWidth = s.lineWidth; } }
    else if (op === OPS.setLineWidth) lineWidth = args[i][0];
    else if (op === OPS.constructPath) {
      const a = args[i];
      const paintOp = a[0];
      const data = a[1] && a[1][0];
      if (!data || !data.length) continue;
      const stroke = strokeOps.has(paintOp), fill = fillOps.has(paintOp);
      if (!stroke && !fill) continue; // clipping paths etc.
      const subpaths = parsePath(data);
      for (const pts of subpaths) {
        const tp = pts.map(([x, y]) => apply(ctm, x, y));
        if (fill && isRect(tp)) {
          const xs = tp.map(p => p[0]), ys = tp.map(p => p[1]);
          const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
          const w = x1 - x0, h = y1 - y0;
          if (h <= 3 && w > 4) H.push({ y: (y0 + y1) / 2, x0, x1 });
          else if (w <= 3 && h > 4) V.push({ x: (x0 + x1) / 2, y0, y1 });
          else if (stroke) addRectEdges(H, V, x0, y0, x1, y1);
          // large filled rectangles (cell shading) are ignored on purpose
        } else if (stroke) {
          for (let k = 1; k < tp.length; k++) addSeg(H, V, tp[k - 1], tp[k]);
        }
      }
    }
  }
  return { H: mergeH(H), V: mergeV(V) };
}

function addRectEdges(H, V, x0, y0, x1, y1) {
  H.push({ y: y0, x0, x1 }, { y: y1, x0, x1 });
  V.push({ x: x0, y0, y1 }, { x: x1, y0, y1 });
}
function addSeg(H, V, a, b) {
  const dx = Math.abs(a[0] - b[0]), dy = Math.abs(a[1] - b[1]);
  if (dy < 1 && dx > 4) H.push({ y: (a[1] + b[1]) / 2, x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]) });
  else if (dx < 1 && dy > 4) V.push({ x: (a[0] + b[0]) / 2, y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]) });
}

// pdf.js path format: [op, coords..., op, coords...] with DrawOPS codes
// moveTo 0, lineTo 1, curveTo 2, quadraticCurveTo 3, closePath 4
function parsePath(d) {
  const out = []; let cur = null; let i = 0;
  while (i < d.length) {
    const op = d[i++];
    if (op === 0) { cur = [[d[i], d[i + 1]]]; out.push(cur); i += 2; }
    else if (op === 1) { if (!cur) { cur = []; out.push(cur); } cur.push([d[i], d[i + 1]]); i += 2; }
    else if (op === 2) { cur = null; i += 6; } // curves are not table borders
    else if (op === 3) { cur = null; i += 4; }
    else if (op === 4) { if (cur && cur.length) cur.push(cur[0].slice()); }
    else break; // unknown op, stop safely
  }
  return out.filter(p => p.length > 1);
}
function isRect(p) {
  if (p.length < 4 || p.length > 5) return false;
  for (let k = 1; k < Math.min(p.length, 5); k++) {
    const a = p[k - 1], b = p[k];
    if (Math.abs(a[0] - b[0]) > 0.5 && Math.abs(a[1] - b[1]) > 0.5) return false;
  }
  return true;
}

export function mergeH(H) {
  // group segments lying on (almost) the same y, then join overlapping ones — O(n log n)
  const segs = H.filter(s => [s.y, s.x0, s.x1].every(Number.isFinite)).sort((a, b) => a.y - b.y);
  const out = [];
  let band = [];
  const flush = () => {
    if (!band.length) return;
    const y = band.reduce((a, s) => a + s.y, 0) / band.length;
    band.sort((a, b) => a.x0 - b.x0);
    let cur = { y, x0: band[0].x0, x1: band[0].x1 };
    for (const s of band.slice(1)) {
      if (s.x0 <= cur.x1 + TOL) cur.x1 = Math.max(cur.x1, s.x1);
      else { out.push(cur); cur = { y, x0: s.x0, x1: s.x1 }; }
    }
    out.push(cur); band = [];
  };
  for (const s of segs) { if (band.length && s.y - band[0].y > TOL) flush(); band.push(s); }
  flush();
  return out.filter(s => s.x1 - s.x0 > 6);
}
export function mergeV(V) {
  const t = mergeH(V.map(v => ({ y: v.x, x0: v.y0, x1: v.y1 })));
  return t.map(s => ({ x: s.y, y0: s.x0, y1: s.x1 }));
}

// Detects long straight dark lines in a rendered (scanned) page image.
// imageData: ImageData of the page; scale: pixels per PDF point.
// Returns segments in PDF points and a mask of line pixels (to erase before OCR).
export function linesFromImage(imageData, scale) {
  const { width: W, height: Hh, data } = imageData;
  const dark = new Uint8Array(W * Hh);
  for (let i = 0, p = 0; p < W * Hh; p++, i += 4) {
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    dark[p] = lum < 195 ? 1 : 0; // thin scanned borders turn grey; long runs are still lines
  }
  const minH = Math.max(80, Math.round(W * 0.06));
  const minV = Math.max(60, Math.round(Hh * 0.025));
  const H = [], V = [];
  for (let y = 0; y < Hh; y++) {
    let run = 0, gap = 0, start = 0;
    for (let x = 0; x <= W; x++) {
      const d = x < W && dark[y * W + x];
      if (d) { if (run === 0) start = x; run = x - start + 1; gap = 0; }
      else if (run) {
        gap++;
        if (gap > 4 || x === W) {
          if (run >= minH) H.push({ y: y / scale, x0: start / scale, x1: (start + run) / scale, py: y, px0: start, px1: start + run });
          run = 0; gap = 0;
        }
      }
    }
  }
  for (let x = 0; x < W; x++) {
    let run = 0, gap = 0, start = 0;
    for (let y = 0; y <= Hh; y++) {
      const d = y < Hh && dark[y * W + x];
      if (d) { if (run === 0) start = y; run = y - start + 1; gap = 0; }
      else if (run) {
        gap++;
        if (gap > 4 || y === Hh) {
          if (run >= minV) V.push({ x: x / scale, y0: start / scale, y1: (start + run) / scale, px: x, py0: start, py1: start + run });
          run = 0; gap = 0;
        }
      }
    }
  }
  return { H: mergeH(H), V: mergeV(V), rawH: H, rawV: V };
}

// Paints detected line pixels white so OCR does not read them as characters.
export function eraseLines(imageData, raw) {
  const { width: W, data } = imageData;
  const pad = 3;
  for (const s of raw.rawH) for (let y = s.py - pad; y <= s.py + pad; y++) for (let x = s.px0; x < s.px1; x++) whiten(data, W, x, y, imageData.height);
  for (const s of raw.rawV) for (let x = s.px - pad; x <= s.px + pad; x++) for (let y = s.py0; y < s.py1; y++) whiten(data, W, x, y, imageData.height);
}
function whiten(d, W, x, y, Hh) {
  if (x < 0 || y < 0 || x >= W || y >= Hh) return;
  const i = (y * W + x) * 4; d[i] = d[i + 1] = d[i + 2] = 255;
}

// Estimates how many degrees a scanned page is tilted (−3°…+3°), using the
// projection profile of dark pixels on a reduced copy of the image.
export function estimateSkew(imageData) {
  const { width: W, height: H, data } = imageData;
  const f = Math.max(1, Math.round(Math.max(W, H) / 1100));
  const w = Math.floor(W / f), h = Math.floor(H / f);
  const pts = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = ((y * f) * W + x * f) * 4;
    if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] < 140) pts.push(x, y);
  }
  if (pts.length < 200) return 0;
  const score = (deg) => {
    const t = Math.tan(deg * Math.PI / 180);
    const hist = new Float64Array(h * 2 + 10);
    for (let k = 0; k < pts.length; k += 2) {
      const yy = Math.round(pts[k + 1] - pts[k] * t) + h;
      if (yy >= 0 && yy < hist.length) hist[yy]++;
    }
    let s = 0; for (let i = 1; i < hist.length; i++) { const d = hist[i] - hist[i - 1]; s += d * d; }
    return s;
  };
  let best = 0, bestS = -1;
  for (let a = -3; a <= 3.0001; a += 0.2) { const s = score(a); if (s > bestS) { bestS = s; best = a; } }
  const base = best;
  for (let a = base - 0.2; a <= base + 0.2001; a += 0.02) { const s = score(a); if (s > bestS) { bestS = s; best = a; } }
  return Math.round(best * 100) / 100;
}

// Removes isolated specks (tiny dark dots from scanning/photocopying).
// Components up to maxArea pixels and maxSide wide/high are whitened.
// Real punctuation (periods, commas, i-dots) is larger at 300 DPI and is kept.
export function despeckle(imageData, maxArea = 9, maxSide = 3) {
  const { width: W, height: H, data } = imageData;
  const N = W * H;
  const dark = new Uint8Array(N);
  for (let p = 0, i = 0; p < N; p++, i += 4) dark[p] = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) < 170 ? 1 : 0;
  const seen = new Uint8Array(N);
  const stack = new Int32Array(64);
  const comp = new Int32Array(maxArea + 1);
  let removed = 0;
  for (let p = 0; p < N; p++) {
    if (!dark[p] || seen[p]) continue;
    // flood fill, but stop counting once the component is clearly too big
    let sp = 0, n = 0, big = false, minX = W, maxX = 0, minY = H, maxY = 0;
    stack[sp++] = p; seen[p] = 1;
    const overflow = [];
    while (sp || overflow.length) {
      const q = sp ? stack[--sp] : overflow.pop();
      const x = q % W, y = (q - x) / W;
      if (!big) { if (n <= maxArea) comp[n] = q; n++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; if (n > maxArea || maxX - minX >= maxSide || maxY - minY >= maxSide) big = true; }
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const r = ny * W + nx;
        if (dark[r] && !seen[r]) { seen[r] = 1; if (sp < stack.length) stack[sp++] = r; else overflow.push(r); }
      }
    }
    if (!big) {
      for (let k = 0; k < n; k++) { const i = comp[k] * 4; data[i] = data[i + 1] = data[i + 2] = 255; }
      removed++;
    }
  }
  return removed;
}

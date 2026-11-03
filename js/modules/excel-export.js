// Builds real .xlsx files with ExcelJS (loaded from /libraries).
/* global ExcelJS */
import { writeXlsx, EXCEL_MAX_ROWS } from './xlsx-stream.js';

const GREEN = 'FF006B32';
const FLAG_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
const STATUS_LABEL = { SUCCESS: 'Success', WARNINGS: 'Success with warnings', PARTIAL: 'Partial conversion', FAILED: 'Failed', CANCELLED: 'Cancelled' };
export const statusLabel = s => STATUS_LABEL[s] || s;

function sheetNamer() {
  const used = new Set(['history']);
  return (name) => {
    let base = String(name).replace(/[\[\]:*?/\\]/g, '_').replace(/^'+|'+$/g, '').trim() || 'Sheet';
    base = base.slice(0, 31);
    let n = base, k = 2;
    while (used.has(n.toLowerCase())) { const suf = ` (${k++})`; n = base.slice(0, 31 - suf.length) + suf; }
    used.add(n.toLowerCase());
    return n;
  };
}
const stem = f => f.replace(/\.pdf$/i, '');
const pagesLabel = t => t.pages.length > 1 ? `p.${t.pages[0]}–${t.pages[t.pages.length - 1]}` : `p.${t.pages[0]}`;

function uniq(names) {
  const seen = new Set();
  return names.map(n => { let b = n, k = 2, x = b; while (seen.has(x.toLowerCase())) x = `${b} (${k++})`; seen.add(x.toLowerCase()); return x; });
}

let tableCounter = 0;

// Writes one table starting at startRow. Returns {endRow, issues:[]}
function writeTable(ws, t, startRow, opts, ctx) {
  const extra = [];
  if (opts.includeFile) extra.push({ name: 'Source file', get: (r) => t.fileName });
  if (opts.includePage) extra.push({ name: 'Page', get: (r) => r.page });
  if (opts.includeTableNo) extra.push({ name: 'Table no.', get: () => t.index });
  const names = uniq([...t.columns.map(c => c.name.replace(/\n/g, ' ')), ...extra.map(e => e.name)]);
  const nData = t.columns.length;
  const rows = t.rows.map(r => [
    ...r.cells.map(c => (c.t === 'empty' || c.v == null) ? null : c.v),
    ...extra.map(e => e.get(r)),
  ]);
  const issues = [];

  if (rows.length) {
    ws.addTable({
      name: `T${++tableCounter}`,
      ref: ws.getCell(startRow, 1).address,
      headerRow: true, totalsRow: false,
      style: { theme: 'TableStyleLight1', showRowStripes: true },
      columns: names.map(n => ({ name: n, filterButton: true })),
      rows,
    });
  } else {
    names.forEach((n, i) => { ws.getCell(startRow, i + 1).value = n; });
  }

  // header styling
  names.forEach((_, i) => {
    const c = ws.getCell(startRow, i + 1);
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } };
    c.alignment = { vertical: 'middle', wrapText: true };
  });

  // cell formats + flags
  t.rows.forEach((r, ri) => {
    const er = startRow + 1 + ri;
    r.cells.forEach((cell, ci) => {
      const xc = ws.getCell(er, ci + 1);
      if (cell.fmt && cell.t !== 'empty') xc.numFmt = cell.fmt;
      if (typeof cell.v === 'string' && cell.v.includes('\n')) xc.alignment = { wrapText: true, vertical: 'top' };
      const open = cell.verified ? [] : (cell.flags || []).filter(f => f.sev === 'warn');
      if (open.length) {
        xc.fill = FLAG_FILL;
        xc.note = { texts: [{ text: 'Check: ' + open.map(f => f.msg).join(' | ') }] };
        issues.push({ file: t.fileName, table: t.index, sheet: ws.name, cell: xc.address, column: names[ci], value: cell.raw, issue: open.map(f => f.msg).join(' | '), page: r.page });
      }
    });
  });

  // sheets with OCR data get an amber tab as a visual reminder
  if (t.ocr) ws.properties.tabColor = { argb: 'FFE0A100' };

  // widths
  names.forEach((n, i) => {
    let w = String(n).length + 4;
    for (const row of rows.slice(0, 500)) {
      const v = row[i];
      const len = v == null ? 0 : v instanceof Date ? 10 : String(v).split('\n').reduce((a, s) => Math.max(a, s.length), 0) + (typeof v === 'number' ? 3 : 0);
      if (len > w) w = len;
    }
    const col = ws.getColumn(i + 1);
    col.width = Math.max(col.width || 0, Math.min(Math.max(8, w + 1), 60));
  });
  ctx.dataCols = Math.max(ctx.dataCols || 0, nData);
  return { endRow: startRow + rows.length, issues };
}

function tableSignature(t) {
  if (t.columns.every(c => c.auto)) return null;
  return t.columns.map(c => c.name.toLowerCase().replace(/\s+/g, ' ').trim()).join('|');
}

// Above this many cells the streaming writer is used (keeps browser memory low).
export const LARGE_CELLS = 150000;
export function totalCells(docs) { return docs.reduce((a, d) => a + (d.tables || []).reduce((b, t) => b + t.rows.length * t.columns.length, 0), 0); }

export async function buildWorkbook(docs, opts, onProgress) {
  if (totalCells(docs) > LARGE_CELLS) return buildLargeWorkbook(docs, opts, onProgress);
  tableCounter = 0;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'KRKA PDF to Excel Converter';
  wb.created = new Date();
  const name = sheetNamer();
  const allIssues = [];
  const tablesOk = docs.filter(d => !d.fatal);

  const summaryWs = opts.includeSummary ? wb.addWorksheet('Conversion Summary') : null;
  const sheetOf = new Map();

  if (opts.structure === 'per-pdf') {
    for (const d of tablesOk) {
      if (!d.tables.length) continue;
      const ws = wb.addWorksheet(name(stem(d.fileName)));
      let row = 1;
      for (const t of d.tables) {
        ws.getCell(row, 1).value = `Table ${t.index} · ${pagesLabel(t)}`;
        ws.getCell(row, 1).font = { bold: true, size: 12, color: { argb: GREEN } };
        const res = writeTable(ws, t, row + 1, opts, {});
        allIssues.push(...res.issues);
        sheetOf.set(t, ws.name);
        row = res.endRow + 3;
      }
    }
  } else if (opts.structure === 'combine') {
    const groups = new Map();
    for (const d of tablesOk) for (const t of d.tables) {
      const sig = tableSignature(t) || `__single_${d.fileName}_${t.index}`;
      if (!groups.has(sig)) groups.set(sig, []);
      groups.get(sig).push(t);
    }
    let gi = 0;
    for (const [sig, ts] of groups) {
      gi++;
      if (ts.length === 1) {
        const t = ts[0];
        const ws = wb.addWorksheet(name(`${stem(t.fileName)} T${t.index}`));
        const res = writeTable(ws, t, 1, opts, {});
        ws.views = [{ state: 'frozen', ySplit: 1 }];
        allIssues.push(...res.issues); sheetOf.set(t, ws.name);
      } else {
        // stack compatible tables into one, always keeping the source
        const merged = { ...ts[0], fileName: '', index: '', rows: [], pages: [] };
        const ws = wb.addWorksheet(name(`Combined ${gi}`));
        const combinedRows = [];
        for (const t of ts) for (const r of t.rows) combinedRows.push({ ...r, _file: t.fileName, _table: t.index });
        merged.rows = combinedRows;
        const o = { ...opts, includeFile: false, includePage: false, includeTableNo: false };
        const extraT = { ...merged, columns: [...merged.columns, { name: 'Source file' }, { name: 'Page' }, { name: 'Table no.' }],
          rows: combinedRows.map(r => ({ ...r, cells: [...r.cells, { raw: r._file, v: r._file, t: 'text' }, { raw: String(r.page), v: r.page, t: 'number', fmt: '0' }, { raw: String(r._table), v: r._table, t: 'number', fmt: '0' }] })) };
        const res = writeTable(ws, extraT, 1, o, {});
        ws.views = [{ state: 'frozen', ySplit: 1 }];
        allIssues.push(...res.issues);
        ts.forEach(t => sheetOf.set(t, ws.name));
      }
    }
  } else { // per-table (default)
    const multi = tablesOk.length > 1;
    for (const d of tablesOk) for (const t of d.tables) {
      const label = multi ? `${stem(d.fileName).slice(0, 18)} T${t.index}` : `Table ${t.index} (${pagesLabel(t)})`;
      const ws = wb.addWorksheet(name(label));
      const res = writeTable(ws, t, 1, opts, {});
      ws.views = [{ state: 'frozen', ySplit: 1 }];
      allIssues.push(...res.issues); sheetOf.set(t, ws.name);
    }
  }

  // Other text (never silently drop content)
  const otherRows = [];
  for (const d of tablesOk) for (const o of d.outside || []) for (const line of o.lines) otherRows.push([d.fileName, o.page, line]);
  if (otherRows.length) {
    const ws = wb.addWorksheet(name('Other text'));
    ws.addTable({ name: 'OtherText', ref: 'A1', headerRow: true, style: { theme: 'TableStyleLight1', showRowStripes: true }, columns: [{ name: 'Source file' }, { name: 'Page' }, { name: 'Text outside tables' }], rows: otherRows });
    ['A1', 'B1', 'C1'].forEach(a => { const c = ws.getCell(a); c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } }; });
    ws.getColumn(1).width = 34; ws.getColumn(2).width = 8; ws.getColumn(3).width = 100;
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }

  if (summaryWs) writeSummary(summaryWs, docs, allIssues, sheetOf);
  if (!wb.worksheets.length || (wb.worksheets.length === 1 && summaryWs && !docs.some(d => d.tables?.length))) {
    if (!summaryWs) { const ws = wb.addWorksheet('Result'); ws.getCell('A1').value = 'No tables could be extracted from the selected document(s).'; }
  }
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

function writeSummary(ws, docs, issues, sheetOf) {
  const head = (cells, row) => cells.forEach((v, i) => { const c = ws.getCell(row, i + 1); c.value = v; c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } }; c.alignment = { vertical: 'middle', wrapText: true }; });
  ws.getCell('A1').value = 'Conversion Summary';
  ws.getCell('A1').font = { bold: true, size: 14, color: { argb: GREEN } };
  ws.getCell('A2').value = 'Generated by KRKA PDF to Excel Converter. Documents were processed locally in the browser.';
  ws.getCell('A2').font = { italic: true, color: { argb: 'FF5E6B64' } };
  ws.getCell('A3').value = '"Success" means the file was processed without detected problems. It is not a guarantee that every value is correct — highlighted cells must be checked.';
  ws.getCell('A3').font = { italic: true, color: { argb: 'FF5E6B64' } };

  let r = 5;
  head(['Original PDF', 'Conversion date', 'Pages', 'Tables detected', 'Rows extracted', 'Processing method', 'OCR used', 'Open warnings', 'User corrections', 'Status'], r);
  const now = new Date();
  for (const d of docs) {
    r++;
    const ocrN = d.pages?.filter(p => p.method === 'ocr').length || 0;
    const method = d.fatal ? '—' : ocrN === 0 ? 'Digital text extraction' : ocrN === d.pageCount ? 'OCR' : `Mixed (OCR on ${ocrN} of ${d.pageCount} pages)`;
    const warn = (d.tables || []).reduce((a, t) => a + t.rows.reduce((b, row) => b + row.cells.reduce((c2, c) => c2 + (c.verified ? 0 : (c.flags || []).filter(f => f.sev === 'warn').length), 0), 0), 0);
    const edits = (d.tables || []).reduce((a, t) => a + (t.edits || 0), 0);
    const vals = [d.fileName, now, d.pageCount || 0, d.tables?.length || 0, (d.tables || []).reduce((a, t) => a + t.rows.length, 0), method, ocrN ? `Yes (${ocrN} page${ocrN > 1 ? 's' : ''})` : 'No', warn, edits, statusLabel(d.status)];
    vals.forEach((v, i) => { ws.getCell(r, i + 1).value = v; });
    ws.getCell(r, 2).numFmt = 'dd.mm.yyyy hh:mm';
  }
  r += 2;
  ws.getCell(r, 1).value = 'Notes'; ws.getCell(r, 1).font = { bold: true, size: 12, color: { argb: GREEN } };
  r++;
  head(['Original PDF', 'Type', 'Message'], r);
  for (const d of docs) {
    const notes = [...(d.error ? [{ sev: 'warn', msg: d.error }] : []), ...(d.notes || [])];
    for (const t of d.tables || []) for (const n of t.notes || []) notes.push({ sev: n.sev, msg: `Table ${t.index} (${sheetOf.get(t) || ''}): ${n.msg}` });
    for (const n of notes) { r++; ws.getCell(r, 1).value = d.fileName; ws.getCell(r, 2).value = n.sev === 'warn' ? 'Warning' : 'Info'; ws.getCell(r, 3).value = n.msg; }
  }
  r += 2;
  ws.getCell(r, 1).value = `Cells to verify (${issues.length})`; ws.getCell(r, 1).font = { bold: true, size: 12, color: { argb: GREEN } };
  r++;
  head(['Original PDF', 'Sheet', 'Cell', 'Column', 'PDF page', 'Value as read', 'Reason'], r);
  for (const it of issues) {
    r++;
    [it.file, it.sheet, it.cell, it.column, it.page, it.value, it.issue].forEach((v, i) => { ws.getCell(r, i + 1).value = v; });
  }
  [34, 22, 16, 22, 18, 26, 14, 14, 14, 22].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.getColumn(3).width = Math.max(ws.getColumn(3).width, 16);
}

export async function zipFiles(files) {
  /* global JSZip */
  const zip = new JSZip();
  for (const f of files) zip.file(f.name, f.blob);
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}


// ---------------- large documents: streaming writer ----------------
const openWarn = c => !c.verified && (c.flags || []).some(f => f.sev === 'warn');
const MAX_ISSUES_LISTED = 20000;

function cellSpec(c) {
  if (!c || c.t === 'empty' || c.v == null) return openWarn(c || {}) ? { v: null, t: 'empty', flag: true } : null;
  return { v: c.v, t: c.t, fmt: c.fmt && c.t !== 'text' ? c.fmt : (c.fmt === '@' ? '@' : null), flag: openWarn(c), wrap: typeof c.v === 'string' && c.v.includes('\n') };
}

function widthsFor(names, sampleRows, getCells) {
  return names.map((n, i) => {
    let w = String(n).length + 4;
    for (const r of sampleRows) {
      const c = getCells(r)[i];
      const v = c?.v;
      const len = v == null ? 0 : v instanceof Date ? 10 : String(v).split('\n').reduce((a, x) => Math.max(a, x.length), 0) + (typeof v === 'number' ? 3 : 0);
      if (len > w) w = len;
    }
    return Math.min(Math.max(8, w + 1), 60);
  });
}

async function buildLargeWorkbook(docs, opts, onProgress) {
  const name = sheetNamer();
  const ok = docs.filter(d => !d.fatal && !d.cancelled);
  const sheets = [];
  const issues = [];
  const sheetOf = new Map();
  const limit = EXCEL_MAX_ROWS - 1;

  // build table sheet specs
  const groups = [];
  if (opts.structure === 'combine') {
    const bySig = new Map();
    for (const d of ok) for (const t of d.tables) {
      const sig = tableSignature(t) || `__single_${d.fileName}_${t.index}`;
      if (!bySig.has(sig)) { bySig.set(sig, []); groups.push(bySig.get(sig)); }
      bySig.get(sig).push(t);
    }
  } else {
    for (const d of ok) for (const t of d.tables) groups.push([t]);
  }
  const multi = ok.length > 1;
  let gi = 0;
  for (const ts of groups) {
    gi++;
    const combined = ts.length > 1;
    const first = ts[0];
    const extra = [];
    if (combined || opts.includeFile) extra.push({ name: 'Source file', get: (t) => ({ v: t.fileName, t: 'text' }) });
    if (combined || opts.includePage) extra.push({ name: 'Page', get: (t, r) => ({ v: r.page, t: 'number', fmt: '0' }) });
    if (combined || opts.includeTableNo) extra.push({ name: 'Table no.', get: (t) => ({ v: t.index, t: 'number', fmt: '0' }) });
    const names = uniq([...first.columns.map(c => c.name.replace(/\n/g, ' ')), ...extra.map(e => e.name)]);
    // flat index over all tables of the group
    const offsets = []; let total = 0;
    for (const t of ts) { offsets.push(total); total += t.rows.length; }
    const locate = (i) => { let k = offsets.length - 1; while (offsets[k] > i) k--; return [ts[k], ts[k].rows[i - offsets[k]]]; };
    const getCells = (i) => { const [t, r] = locate(i); return [...r.cells.map(cellSpec), ...extra.map(e => e.get(t, r))]; };
    const sample = Array.from({ length: Math.min(total, 400) }, (_, i) => i);
    const widths = widthsFor(names, sample, getCells);
    const baseName = combined ? `Combined ${gi}` : (multi ? `${stem(first.fileName).slice(0, 18)} T${first.index}` : `Table ${first.index} (${pagesLabel(first)})`);
    const nParts = Math.max(1, Math.ceil(total / limit));
    for (let part = 0; part < nParts; part++) {
      const start = part * limit, count = Math.min(limit, total - start);
      const sheetName = name(nParts > 1 ? `${baseName.slice(0, 22)} part ${part + 1}` : baseName);
      sheets.push({ name: sheetName, header: names, widths, freeze: true, filter: true, tabColor: ts.some(t => t.ocr) ? 'FFE0A100' : null, rowCount: count, getRow: (i) => getCells(start + i) });
      ts.forEach(t => { if (!sheetOf.has(t)) sheetOf.set(t, sheetName); });
      // collect cells to verify (with their Excel address)
      if (issues.length < MAX_ISSUES_LISTED) {
        for (let i = start; i < start + count && issues.length < MAX_ISSUES_LISTED; i++) {
          const [t, r] = locate(i);
          r.cells.forEach((c, ci) => {
            if (openWarn(c) && issues.length < MAX_ISSUES_LISTED) issues.push({ file: t.fileName, sheet: sheetName, cell: `${colLetter(ci)}${i - start + 2}`, column: names[ci], value: c.raw, issue: c.flags.filter(f => f.sev === 'warn').map(f => f.msg).join(' | '), page: r.page });
          });
        }
      }
    }
  }
  const totalIssues = ok.reduce((a, d) => a + d.tables.reduce((b, t) => b + t.rows.reduce((x, r) => x + r.cells.filter(openWarn).length, 0), 0), 0);

  // other text
  const otherRows = [];
  for (const d of ok) for (const o of d.outside || []) for (const line of o.lines) otherRows.push([{ v: d.fileName, t: 'text' }, { v: o.page, t: 'number', fmt: '0' }, { v: line, t: 'text' }]);
  if (otherRows.length) sheets.push({ name: name('Other text'), header: ['Source file', 'Page', 'Text outside tables'], widths: [34, 8, 100], freeze: true, filter: true, rowCount: otherRows.length, getRow: i => otherRows[i] });

  // summary (first sheet)
  if (opts.includeSummary) {
    const rows = [];
    const T = (v, kind) => ({ v, t: 'text', kind });
    rows.push([T('Conversion Summary', 'title')]);
    rows.push([T('Generated by KRKA PDF to Excel Converter. Documents were processed locally in the browser.')]);
    rows.push([T('"Success" means the file was processed without detected problems. It is not a guarantee that every value is correct — highlighted cells must be checked.')]);
    if (opts.structure === 'per-pdf') rows.push([T('Note: for very large results each table is written to its own sheet (instead of one sheet per PDF).')]);
    rows.push([]);
    rows.push(['Original PDF', 'Conversion date', 'Pages', 'Tables detected', 'Rows extracted', 'Processing method', 'OCR used', 'Open warnings', 'User corrections', 'Status'].map(h => T(h, 'header')));
    const now = new Date();
    for (const d of docs) {
      const ocrN = d.pages?.filter(p => p.method === 'ocr').length || 0;
      const method = d.fatal ? '—' : ocrN === 0 ? 'Digital text extraction' : ocrN === d.pageCount ? 'OCR' : `Mixed (OCR on ${ocrN} of ${d.pageCount} pages)`;
      const warn = (d.tables || []).reduce((a, t) => a + t.rows.reduce((b, r) => b + r.cells.filter(openWarn).length, 0), 0);
      const edits = (d.tables || []).reduce((a, t) => a + (t.edits || 0), 0);
      rows.push([T(d.fileName), { v: now, t: 'date', fmt: 'dd.mm.yyyy hh:mm' }, { v: d.pageCount || 0, t: 'number' }, { v: d.tables?.length || 0, t: 'number' }, { v: (d.tables || []).reduce((a, t) => a + t.rows.length, 0), t: 'number', fmt: '#,##0' }, T(method), T(ocrN ? `Yes (${ocrN} pages)` : 'No'), { v: warn, t: 'number' }, { v: edits, t: 'number' }, T(statusLabel(d.status))]);
    }
    rows.push([]);
    rows.push([T('Notes', 'title')]);
    rows.push(['Original PDF', 'Type', 'Message'].map(h => T(h, 'header')));
    for (const d of docs) {
      const notes = [...(d.error ? [{ sev: 'warn', msg: d.error }] : []), ...(d.notes || [])];
      for (const t of d.tables || []) for (const n of t.notes || []) notes.push({ sev: n.sev, msg: `Table ${t.index} (${sheetOf.get(t) || ''}): ${n.msg}` });
      for (const n of notes) rows.push([T(d.fileName), T(n.sev === 'warn' ? 'Warning' : 'Info'), T(n.msg)]);
    }
    rows.push([]);
    rows.push([T(`Cells to verify (${totalIssues.toLocaleString('en-US')}${totalIssues > issues.length ? `, first ${issues.length.toLocaleString('en-US')} listed — all are highlighted in yellow in the sheets` : ''})`, 'title')]);
    rows.push(['Original PDF', 'Sheet', 'Cell', 'Column', 'PDF page', 'Value as read', 'Reason'].map(h => T(h, 'header')));
    for (const it of issues) rows.push([T(it.file), T(it.sheet), T(it.cell), T(it.column), { v: it.page, t: 'number' }, T(it.value), T(it.issue)]);
    sheets.unshift({ name: 'Conversion Summary', header: [], ncol: 10, widths: [34, 22, 16, 22, 18, 26, 14, 14, 14, 22], freeze: false, filter: false, rowCount: rows.length, getRow: i => rows[i] });
  }
  if (!sheets.length) sheets.push({ name: 'Result', header: [], ncol: 1, rowCount: 1, getRow: () => [{ v: 'No tables could be extracted from the selected document(s).', t: 'text' }] });
  return writeXlsx(sheets, onProgress);
}

function colLetter(i) { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }

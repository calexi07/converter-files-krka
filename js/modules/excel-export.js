// Builds real .xlsx files with ExcelJS (loaded from /libraries).
/* global ExcelJS */

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

export async function buildWorkbook(docs, opts) {
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

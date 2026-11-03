// Quality control. Adds flags; never changes values.

const norm = s => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

export function validateTable(t) {
  // reset validation flags (keep extraction / parse / ocr flags)
  for (const r of t.rows) for (const c of r.cells) c.flags = (c.flags || []).filter(f => !f.validation);
  t.notes = (t.notes || []).filter(n => !n.validation);
  const nc = t.columns.length, nr = t.rows.length;
  const add = (cell, sev, msg, kind = 'check') => { if (!cell.verified) cell.flags.push({ kind, sev, msg, validation: true }); };

  // 1. missing values in columns that are otherwise always filled
  if (nr >= 5) {
    for (let c = 0; c < nc; c++) {
      const filled = t.rows.filter(r => norm(r.cells[c]?.raw)).length;
      if (filled / nr >= 0.9 && filled < nr) {
        t.rows.forEach(r => { if (!norm(r.cells[c]?.raw)) add(r.cells[c], 'warn', 'Missing value in a column that is filled everywhere else', 'missing'); });
      }
    }
  }

  // 2. header text repeated inside the data
  if (t.columns.some(c => !c.auto)) {
    const h = t.columns.map(c => norm(c.name));
    t.rows.forEach(r => {
      const match = r.cells.filter((c, i) => norm(c.raw) && norm(c.raw) === h[i]).length;
      if (match >= Math.max(2, Math.ceil(nc * 0.6))) r.cells.forEach(c => add(c, 'warn', 'This row repeats the column headers — probably a page header, not data', 'header'));
    });
  }

  // 3. duplicate rows
  const seen = new Map();
  t.rows.forEach((r, i) => {
    const key = r.cells.map(c => norm(c.raw)).join('\u0001');
    if (!key.replace(/\u0001/g, '')) return;
    if (seen.has(key)) {
      const first = seen.get(key);
      add(r.cells[0], 'warn', `Identical to row ${first + 1} — check whether it is a real repeat or a duplicate`, 'duplicate');
    } else seen.set(key, i);
  });

  // 4. column type consistency and suspicious numbers
  for (let c = 0; c < nc; c++) {
    const cells = t.rows.map(r => r.cells[c]).filter(Boolean);
    const nonEmpty = cells.filter(x => x.t && x.t !== 'empty');
    if (nonEmpty.length < 4) continue;
    const counts = {};
    nonEmpty.forEach(x => { counts[x.t] = (counts[x.t] || 0) + 1; });
    const [domType, domN] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (domType !== 'text' && domN / nonEmpty.length >= 0.7) {
      nonEmpty.filter(x => x.t === 'text').forEach(x => add(x, 'warn', `Expected a ${domType} like the rest of the column`, 'type'));
    }
    if (domType === 'number') {
      const vals = nonEmpty.filter(x => x.t === 'number' && x.v !== 0).map(x => Math.abs(x.v)).sort((a, b) => a - b);
      if (vals.length >= 8) {
        const med = vals[vals.length >> 1];
        nonEmpty.filter(x => x.t === 'number' && x.v !== 0).forEach(x => {
          const ratio = Math.abs(x.v) / med;
          if (ratio > 1000 || ratio < 0.001) add(x, 'warn', 'Unusually large or small compared to the rest of the column — check the decimal separator', 'outlier');
        });
      }
    }
  }

  // 5. row numbering gaps -> possible missing rows
  for (let c = 0; c < Math.min(nc, 2); c++) {
    const nums = t.rows.map(r => r.cells[c]).map(x => (x?.t === 'number' && Number.isInteger(x.v)) ? x.v : null);
    const valid = nums.filter(v => v != null);
    if (valid.length < 5 || valid.length / nr < 0.8) continue;
    let seq = 0;
    for (let i = 1; i < nums.length; i++) if (nums[i] != null && nums[i - 1] != null && nums[i] === nums[i - 1] + 1) seq++;
    if (seq / (valid.length - 1) < 0.8) continue;
    for (let i = 1; i < nums.length; i++) {
      if (nums[i] != null && nums[i - 1] != null && nums[i] - nums[i - 1] > 1) {
        add(t.rows[i].cells[c], 'warn', `Numbering jumps from ${nums[i - 1]} to ${nums[i]} — rows may be missing`, 'gap');
      }
    }
  }

  // 6. table-level
  if (t.method === 'stream') t.notes.push({ sev: 'info', msg: 'Table detected from text alignment (no grid lines in the PDF)', validation: true });
  if (t.ocr) t.notes.push({ sev: 'info', msg: 'Contains text read with OCR — values are not verified; compare with the original document', validation: true });
  const hdrOcr = (t.headerFlags || []).filter(f => f.kind === 'ocr');
  if (hdrOcr.length) t.notes.push({ sev: 'warn', msg: 'Some column names were read with low OCR confidence — check the header row', validation: true });
  if (t.continued) t.notes.push({ sev: 'info', msg: `Joined across pages ${t.pages[0]}–${t.pages[t.pages.length - 1]}`, validation: true });
  if (!t.columns.some(c => !c.auto)) t.notes.push({ sev: 'info', msg: 'No header row detected — generic column names used', validation: true });
}

export function issueList(t) {
  const out = [];
  t.rows.forEach((r, ri) => r.cells.forEach((c, ci) => {
    for (const f of c.flags || []) if (!c.verified || f.kind === 'merged') out.push({ row: ri, col: ci, sev: f.sev, kind: f.kind, msg: f.msg, conf: c.conf, page: r.page });
  }));
  return out;
}

export function countIssues(t) {
  let warn = 0, info = 0;
  for (const r of t.rows) for (const c of r.cells) {
    if (c.verified) continue;
    for (const f of c.flags || []) f.sev === 'warn' ? warn++ : info++;
  }
  return { warn, info };
}

// Document status: SUCCESS | WARNINGS | PARTIAL | FAILED
export function documentStatus(doc) {
  if (doc.fatal) return 'FAILED';
  const pagesFailed = doc.pages.filter(p => p.status === 'failed' || p.status === 'skipped').length;
  if (pagesFailed && pagesFailed === doc.pages.length) return 'FAILED';
  if (pagesFailed) return 'PARTIAL';
  const warn = doc.tables.reduce((a, t) => a + countIssues(t).warn + (t.notes || []).filter(n => n.sev === 'warn').length, 0) + doc.notes.filter(n => n.sev === 'warn').length;
  if (!doc.tables.length) return 'WARNINGS';
  // OCR output is never presented as verified data
  if (doc.pages.some(p => p.method === 'ocr' && p.status === 'ok')) return 'WARNINGS';
  return warn ? 'WARNINGS' : 'SUCCESS';
}

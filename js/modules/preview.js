// Preview & manual correction. The Excel file is generated from this data,
// so every correction made here ends up in the download.
import { el, esc } from './ui.js';
import { applyParse, typeTable, analyzeColumn } from './value-parser.js';
import { validateTable, issueList, countIssues } from './validator.js';
import { uniqueNames } from './table-engine.js';

const ROW_H = 31;
const BUFFER = 20;

export function openPreview(root, doc, { onBack, onDownload }) {
  const st = { ti: 0, sel: null, selRow: null, issue: 0, undo: [] };
  root.innerHTML = '';

  const top = el('div', { style: 'display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap' });
  const back = el('button', { class: 'btn btn-sm', type: 'button', text: '← Back to results' });
  const title = el('div');
  const undoBtn = el('button', { class: 'btn btn-sm', type: 'button', text: 'Undo' });
  const dl = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: 'Download corrected Excel' });
  const right = el('div', { style: 'margin-left:auto;display:flex;gap:8px' }); right.append(undoBtn, dl);
  top.append(back, title, right);

  const layout = el('div', { class: 'ed-layout' });
  const main = el('div', { class: 'card', style: 'overflow:hidden' });
  const tabs = el('div', { class: 'tabs', role: 'tablist' });
  const toolbar = el('div', { class: 'toolbar' });
  const wrap = el('div', { class: 'gridwrap' });
  const grid = el('table', { class: 'g mono' });
  wrap.append(grid);
  main.append(tabs, toolbar, wrap);
  const side = el('aside', { class: 'card' });
  layout.append(main, side);
  const help = el('p', { class: 'fmeta', style: 'margin-top:10px', html: 'Click any cell or column header to edit it (<span class="kbd">Enter</span> saves, <span class="kbd">Esc</span> cancels). Click a row number to select the row. Corrections are used in the downloaded Excel file. The app never auto-corrects flagged values.' });
  root.append(top, layout, help);

  back.addEventListener('click', onBack);
  dl.addEventListener('click', onDownload);
  undoBtn.addEventListener('click', undo);

  const T = () => doc.tables[st.ti];

  function retype(t) { typeTable(t, 'ro'); validateTable(t); }

  function renderTitle() {
    const warn = doc.tables.reduce((a, t) => a + countIssues(t).warn, 0);
    title.innerHTML = `<b>${esc(doc.fileName)}</b> <span class="badge ${warn ? 'b-warn' : 'b-ok'}" style="margin-left:6px">${warn ? `${warn} issue${warn === 1 ? '' : 's'}` : 'No open issues'}</span>`;
    undoBtn.disabled = !st.undo.length;
  }

  function renderTabs() {
    tabs.innerHTML = '';
    doc.tables.forEach((t, i) => {
      const w = countIssues(t).warn;
      const b = el('button', { class: 'tab' + (i === st.ti ? ' on' : ''), type: 'button', role: 'tab', html: `Table ${t.index} · ${t.pages.length > 1 ? `p.${t.pages[0]}–${t.pages[t.pages.length - 1]}` : `p.${t.pages[0]}`}${w ? ` <span class="badge b-warn">${w}</span>` : ''}` });
      b.addEventListener('click', () => { st.ti = i; st.sel = null; st.selRow = null; st.issue = 0; wrap.scrollTop = 0; renderAll(); });
      tabs.append(b);
    });
  }

  function renderToolbar() {
    const t = T();
    toolbar.innerHTML = '';
    const add = el('button', { class: 'btn btn-sm', type: 'button', text: '+ Add row' });
    const del = el('button', { class: 'btn btn-sm btn-danger-text', type: 'button', text: 'Delete selected row' });
    const merge = el('button', { class: 'btn btn-sm', type: 'button', text: 'Merge with row above' });
    const hasHeader = t.columns.some(c => !c.auto);
    const hdr = el('button', { class: 'btn btn-sm', type: 'button', text: hasHeader ? 'Header is actually data' : 'Use first row as header' });
    del.disabled = st.selRow == null; merge.disabled = !st.selRow;
    add.addEventListener('click', addRow); del.addEventListener('click', deleteRow); merge.addEventListener('click', mergeUp); hdr.addEventListener('click', toggleHeader);
    const sp = el('span', { class: 'sp' });
    const info = el('span', { class: 'fmeta mono', text: `${t.rows.length.toLocaleString('en-US')} rows · ${t.columns.length} columns` });
    const issues = currentIssues();
    const prev = el('button', { class: 'btn btn-sm', type: 'button', text: '← Prev issue' });
    const next = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: issues.length ? `Next issue (${Math.min(st.issue + 1, issues.length)} of ${issues.length}) →` : 'No issues' });
    prev.disabled = next.disabled = !issues.length;
    prev.addEventListener('click', () => gotoIssue(st.issue - 1));
    next.addEventListener('click', () => gotoIssue(st.issue + 1));
    toolbar.append(add, del, merge, hdr, sp, info, prev, next);
  }

  function currentIssues() {
    const t = T();
    const list = issueList(t).filter(i => i.sev === 'warn');
    return list;
  }

  // ---------- grid (virtualized) ----------
  function renderGrid() {
    const t = T();
    const thead = `<thead><tr><th class="rn">#</th>${t.columns.map((c, i) => `<th data-c="${i}" title="Click to rename">${esc(c.name)}</th>`).join('')}<th class="rn" style="width:auto">Page</th></tr></thead>`;
    grid.innerHTML = thead + '<tbody></tbody>';
    grid.querySelectorAll('thead th[data-c]').forEach(th => th.addEventListener('click', () => editHeader(th, +th.dataset.c)));
    renderRows();
  }
  function renderRows() {
    const t = T();
    const tb = grid.tBodies[0];
    const total = t.rows.length;
    const viewH = wrap.clientHeight || 500;
    const first = Math.max(0, Math.floor(wrap.scrollTop / ROW_H) - BUFFER);
    const last = Math.min(total, Math.ceil((wrap.scrollTop + viewH) / ROW_H) + BUFFER);
    const nc = t.columns.length + 2;
    let html = `<tr class="spacer"><td colspan="${nc}" style="height:${first * ROW_H}px"></td></tr>`;
    for (let r = first; r < last; r++) {
      const row = t.rows[r];
      html += `<tr data-r="${r}" class="${st.selRow === r ? 'selrow' : ''}" style="height:${ROW_H}px"><td class="rn" data-rn="${r}">${r + 1}</td>`;
      row.cells.forEach((c, ci) => {
        const open = c.verified ? [] : (c.flags || []);
        const warn = open.filter(f => f.sev === 'warn');
        const ocr = warn.some(f => f.kind === 'ocr');
        let cls = c.t === 'number' || c.t === 'percent' ? 'num' : '';
        if (ocr) cls += ' f-ocr'; else if (warn.length) cls += ' f-struct'; else if (open.some(f => f.sev === 'info')) cls += ' f-info';
        if (c.edited) cls += ' edited';
        if (st.sel && st.sel.r === r && st.sel.c === ci) cls += ' active';
        const tip = [describe(c), ...open.map(f => '⚠ ' + f.msg)].filter(Boolean).join('\n');
        html += `<td data-c="${ci}" class="${cls}" title="${esc(tip)}">${esc(String(c.raw ?? '').replace(/\n/g, ' ⏎ '))}</td>`;
      });
      html += `<td class="pg">p.${row.page ?? ''}</td></tr>`;
    }
    html += `<tr class="spacer"><td colspan="${nc}" style="height:${(total - last) * ROW_H}px"></td></tr>`;
    tb.innerHTML = html;
  }
  function describe(c) {
    if (c.t === 'number') return `Excel value: ${c.v} (number)`;
    if (c.t === 'percent') return `Excel value: ${(c.v * 100).toLocaleString('en-US', { maximumFractionDigits: 6 })}% (percentage)`;
    if (c.t === 'date' && c.v) { const d = new Date(c.v); return `Excel value: ${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()} (date)`; }
    if (c.t === 'text') return 'Excel value: text';
    return '';
  }
  let raf = 0;
  wrap.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (!wrap.querySelector('input.cell-in')) renderRows(); }); });

  grid.addEventListener('click', (e) => {
    const rn = e.target.closest('td.rn[data-rn]');
    if (rn) { st.selRow = +rn.dataset.rn; st.sel = null; renderRows(); renderToolbar(); return; }
    const td = e.target.closest('tbody td[data-c]');
    if (!td || td.querySelector('input')) return;
    const r = +td.parentElement.dataset.r, c = +td.dataset.c;
    st.sel = { r, c }; st.selRow = r;
    const iss = currentIssues(); const k = iss.findIndex(i => i.row === r && i.col === c); if (k >= 0) st.issue = k;
    renderToolbar(); renderSide();
    editCell(td, r, c);
  });

  function editCell(td, r, c) {
    const t = T(); const cell = t.rows[r].cells[c];
    renderRowsKeepScroll();
    td = grid.querySelector(`tr[data-r="${r}"] td[data-c="${c}"]`);
    if (!td) return;
    td.classList.add('active');
    const inp = el('input', { class: 'cell-in', value: cell.raw ?? '' });
    td.textContent = ''; td.append(inp); inp.focus(); inp.select();
    let finished = false;
    const finish = (save, move) => {
      if (finished) return; finished = true;
      if (save && inp.value !== (cell.raw ?? '')) setCell(r, c, inp.value);
      renderAllKeepScroll();
      if (move) {
        const nc = t.columns.length;
        let nr = r, ncl = c + move;
        if (ncl >= nc) { ncl = 0; nr++; } if (ncl < 0) { ncl = nc - 1; nr--; }
        if (nr >= 0 && nr < t.rows.length) { st.sel = { r: nr, c: ncl }; const ntd = grid.querySelector(`tr[data-r="${nr}"] td[data-c="${ncl}"]`); if (ntd) editCell(ntd, nr, ncl); }
      }
    };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      else if (e.key === 'Tab') { e.preventDefault(); finish(true, e.shiftKey ? -1 : 1); }
    });
    inp.addEventListener('blur', () => finish(true));
  }

  function setCell(r, c, value) {
    const t = T(); const cell = t.rows[r].cells[c];
    st.undo.push({ ti: st.ti, type: 'cell', r, c, prev: structuredClone(cell) });
    cell.raw = value; cell.edited = true; cell.verified = true; cell.conf = null;
    cell.flags = (cell.flags || []).filter(f => f.kind === 'merged');
    const col = t.columns[c].analysis || analyzeColumn(t.rows.map(x => x.cells[c].raw), t.columns[c].name);
    applyParse(cell, col);
    t.edits = (t.edits || 0) + 1;
    validateTable(t);
  }

  function editHeader(th, c) {
    if (th.querySelector('input')) return;
    const t = T();
    const inp = el('input', { value: t.columns[c].name });
    th.textContent = ''; th.append(inp); inp.focus(); inp.select();
    let done = false;
    const finish = (save) => {
      if (done) return; done = true;
      const v = inp.value.trim();
      if (save && v && v !== t.columns[c].name) {
        snapshot();
        const names = t.columns.map((x, i) => i === c ? v : x.name);
        const u = uniqueNames(names);
        t.columns.forEach((x, i) => { x.name = u[i]; if (i === c) x.auto = false; });
        t.edits = (t.edits || 0) + 1;
        retype(t);
      }
      renderAllKeepScroll();
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
    inp.addEventListener('blur', () => finish(true));
  }

  // ---------- row operations ----------
  function snapshot() { const t = T(); st.undo.push({ ti: st.ti, type: 'snap', data: structuredClone({ columns: t.columns, rows: t.rows, removed: t.removed, edits: t.edits }) }); }
  function addRow() {
    const t = T(); snapshot();
    const at = st.selRow != null ? st.selRow + 1 : t.rows.length;
    const page = t.rows[Math.max(0, at - 1)]?.page ?? t.pages[0];
    t.rows.splice(at, 0, { cells: t.columns.map(() => ({ raw: '', v: null, t: 'empty', flags: [], verified: true, edited: true })), page, src: 'manual' });
    st.selRow = at; st.sel = { r: at, c: 0 }; t.edits = (t.edits || 0) + 1;
    validateTable(t); renderAll();
    wrap.scrollTop = Math.max(0, at * ROW_H - 100);
    renderRows();
    const td = grid.querySelector(`tr[data-r="${at}"] td[data-c="0"]`); if (td) editCell(td, at, 0);
  }
  function deleteRow() {
    const t = T(); if (st.selRow == null) return; snapshot();
    t.rows.splice(st.selRow, 1); t.edits = (t.edits || 0) + 1;
    st.selRow = null; st.sel = null; validateTable(t); renderAllKeepScroll();
  }
  function mergeUp() {
    const t = T(); const r = st.selRow; if (!r) return; snapshot();
    const a = t.rows[r - 1], b = t.rows[r];
    a.cells.forEach((c, i) => {
      const add = b.cells[i]?.raw;
      if (add) { c.raw = c.raw ? c.raw + (doc.settings?.preserveLayout ? '\n' : ' ') + add : add; c.edited = true; }
      if (b.cells[i]?.conf != null) c.conf = c.conf == null ? b.cells[i].conf : Math.min(c.conf, b.cells[i].conf);
      c.flags = (c.flags || []).concat((b.cells[i]?.flags || []).filter(f => f.kind === 'ocr')).filter(f => !(f.kind === 'structure' && /main column/.test(f.msg)));
    });
    t.rows.splice(r, 1); t.edits = (t.edits || 0) + 1;
    st.selRow = r - 1; st.sel = null; retype(t); renderAllKeepScroll();
  }
  function toggleHeader() {
    const t = T(); snapshot();
    if (t.columns.some(c => !c.auto)) {
      t.rows.unshift({ cells: t.columns.map(c => ({ raw: c.auto ? '' : c.name, flags: [] })), page: t.pages[0], src: 'header' });
      t.columns = t.columns.map((c, i) => ({ name: `Column ${i + 1}`, auto: true }));
    } else if (t.rows.length) {
      const first = t.rows.shift();
      const names = uniqueNames(first.cells.map(c => String(c.raw || '').replace(/\n/g, ' ')));
      t.columns = names.map((n, i) => ({ name: n, auto: !first.cells[i].raw }));
    }
    t.edits = (t.edits || 0) + 1; st.selRow = null; st.sel = null;
    retype(t); renderAll();
  }
  function restoreRemoved(k) {
    const t = T(); snapshot();
    const rem = t.removed[k];
    const at = Math.min(rem.at ?? t.rows.length, t.rows.length);
    t.rows.splice(at, 0, { cells: t.columns.map((_, i) => ({ raw: rem.rawRow?.[i] ?? '', flags: [] })), page: rem.page, src: 'restored' });
    t.removed.splice(k, 1); t.edits = (t.edits || 0) + 1;
    retype(t); renderAll();
    wrap.scrollTop = Math.max(0, at * ROW_H - 100); renderRows();
  }
  function undo() {
    const u = st.undo.pop(); if (!u) return;
    const t = doc.tables[u.ti]; st.ti = u.ti;
    if (u.type === 'cell') { t.rows[u.r].cells[u.c] = u.prev; t.edits = Math.max(0, (t.edits || 1) - 1); validateTable(t); }
    else { Object.assign(t, u.data); retype(t); }
    renderAllKeepScroll();
  }

  // ---------- side panel ----------
  function renderSide() {
    const t = T();
    const all = issueList(t);
    const warn = all.filter(i => i.sev === 'warn');
    const info = all.filter(i => i.sev !== 'warn');
    side.innerHTML = `<div class="card-h"><h2>Issues to check</h2><span class="badge ${warn.length ? 'b-warn' : 'b-ok'}">${warn.length}</span></div>`;
    const scroll = el('div', { class: 'issues-scroll' });
    if (!warn.length) scroll.append(el('div', { class: 'issue', html: '<span class="badge b-ok">All clear</span><div style="margin-top:4px">No open warnings in this table.</div>' }));
    warn.slice(0, 400).forEach((it, k) => {
      const cell = t.rows[it.row].cells[it.col];
      const cur = k === st.issue;
      const badge = it.kind === 'ocr' ? `<span class="badge b-ocr">OCR ${it.conf != null ? Math.round(it.conf) + '%' : ''}</span>` : `<span class="badge b-partial">${esc(kindLabel(it.kind))}</span>`;
      const box = el('div', { class: 'issue' + (cur ? ' cur' : ''), html: `${badge}<div style="margin-top:4px">${esc(it.msg)}</div><div class="loc">Row ${it.row + 1} · ${esc(t.columns[it.col]?.name)} · page ${it.page} · read as “${esc(String(cell.raw).slice(0, 60))}”</div>` });
      if (cur) {
        const ed = el('div', { class: 'cell-edit' });
        const inp = el('input', { value: cell.raw ?? '', 'aria-label': 'Corrected value' });
        const ok = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: 'Confirm' });
        const commit = () => {
          if (inp.value !== (cell.raw ?? '')) setCell(it.row, it.col, inp.value);
          else { st.undo.push({ ti: st.ti, type: 'cell', r: it.row, c: it.col, prev: structuredClone(cell) }); cell.verified = true; t.edits = (t.edits || 0) + 1; validateTable(t); }
          const left = currentIssues(); st.issue = Math.min(st.issue, Math.max(0, left.length - 1));
          renderAllKeepScroll();
          if (left.length) gotoIssue(st.issue);
        };
        ok.addEventListener('click', (e) => { e.stopPropagation(); commit(); });
        inp.addEventListener('click', e => e.stopPropagation());
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') commit(); });
        ed.append(inp, ok); box.append(ed);
      }
      box.addEventListener('click', () => gotoIssue(k));
      scroll.append(box);
    });
    if (warn.length > 400) scroll.append(el('div', { class: 'issue', text: `+ ${warn.length - 400} more — use “Next issue” to go through them.` }));
    (t.removed || []).forEach((rem, k) => {
      const box = el('div', { class: 'issue', html: `<span class="badge b-warn">Removed row</span><div style="margin-top:4px">${esc(rem.reason)}</div><div class="loc">“${esc((rem.rawRow || []).filter(Boolean).join(' | ').slice(0, 80))}” · </div>` });
      const a = el('a', { href: '#', text: 'Restore', style: 'color:var(--krka-green-dark)' });
      a.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); restoreRemoved(k); });
      box.querySelector('.loc').append(a);
      scroll.append(box);
    });
    side.append(scroll);
    const notes = el('div', { class: 'ed-notes' });
    const infoCount = info.length;
    for (const n of t.notes || []) notes.append(el('div', { text: '• ' + n.msg }));
    if (infoCount) notes.append(el('div', { text: `• ${infoCount} informational note${infoCount === 1 ? '' : 's'} (blue marker) — hover a cell to read it` }));
    if (notes.childNodes.length) side.append(notes);
  }
  function kindLabel(k) { return { missing: 'Missing value', duplicate: 'Duplicate', type: 'Unexpected value', outlier: 'Check value', gap: 'Missing rows?', header: 'Header in data', structure: 'Structure', number: 'Number format', date: 'Date', merged: 'Merged cell' }[k] || 'Check'; }

  function gotoIssue(k) {
    const iss = currentIssues(); if (!iss.length) return;
    st.issue = (k + iss.length) % iss.length;
    const it = iss[st.issue];
    st.sel = { r: it.row, c: it.col }; st.selRow = it.row;
    const target = it.row * ROW_H - wrap.clientHeight / 2 + ROW_H;
    wrap.scrollTop = Math.max(0, target);
    renderRows(); renderToolbar(); renderSide();
    const td = grid.querySelector(`tr[data-r="${it.row}"] td[data-c="${it.col}"]`);
    if (td) td.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  function renderAll() { renderTitle(); renderTabs(); renderToolbar(); renderGrid(); renderSide(); }
  function renderAllKeepScroll() { const s = wrap.scrollTop, l = wrap.scrollLeft; renderAll(); wrap.scrollTop = s; wrap.scrollLeft = l; renderRows(); }
  function renderRowsKeepScroll() { const s = wrap.scrollTop; renderRows(); wrap.scrollTop = s; }

  // open on the first table with issues
  const firstWithIssues = doc.tables.findIndex(t => countIssues(t).warn > 0);
  st.ti = firstWithIssues >= 0 ? firstWithIssues : 0;
  renderAll();
  requestAnimationFrame(() => renderRows());
}

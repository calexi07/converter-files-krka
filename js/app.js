// Main controller: upload, settings, processing, results.
import { openPdf, closePdf, PdfPasswordError } from './modules/pdf-reader.js';
import { convertPdf } from './modules/converter.js';
import { terminateOcr } from './modules/ocr.js';
import { buildWorkbook, zipFiles, statusLabel } from './modules/excel-export.js';
import { documentStatus, countIssues } from './modules/validator.js';
import { openPreview } from './modules/preview.js';
import { $, el, esc, fmtSize, showModal, toast, downloadBlob } from './modules/ui.js';

const LARGE_BYTES = 100 * 1024 * 1024;
const LARGE_PAGES = 300;

const state = {
  files: [],      // {id, file, buffer, pages, status:'checking'|'ready'|'password'|'invalid', note}
  docs: [],       // conversion results
  running: false,
  cancel: false,
};
let nextId = 1;
// test hook (only when the page is opened with #test); never logs content
if (location.hash === '#test') window.__krkaState = state;

// ---------------- upload ----------------
const dz = $('#dropzone'), input = $('#file-input');
$('#browse-btn').addEventListener('click', (e) => { e.stopPropagation(); input.click(); });
dz.addEventListener('click', () => input.click());
dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
input.addEventListener('change', () => { addFiles([...input.files]); input.value = ''; });
['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('hover'); }));
['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'dragleave' && dz.contains(e.relatedTarget)) return; dz.classList.remove('hover'); }));
dz.addEventListener('drop', (e) => addFiles([...(e.dataTransfer?.files || [])]));
// stop the browser from opening a PDF dropped outside the box
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => { if (!dz.contains(e.target)) { e.preventDefault(); if (!$('#view-main').hidden) addFiles([...(e.dataTransfer?.files || [])]); } });

$('#remove-all').addEventListener('click', () => { state.files = []; renderFiles(); });

async function addFiles(list) {
  const alerts = $('#upload-alerts');
  alerts.innerHTML = '';
  const rejected = [];
  for (const file of list) {
    const isPdfName = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
    if (!isPdfName) { rejected.push(`<b>${esc(file.name)}</b> was not added — only PDF files are supported.`); continue; }
    if (state.files.some(f => f.file.name === file.name && f.file.size === file.size && f.file.lastModified === file.lastModified)) { rejected.push(`<b>${esc(file.name)}</b> is already in the list.`); continue; }
    if (file.size === 0) { rejected.push(`<b>${esc(file.name)}</b> is empty (0 bytes).`); continue; }
    const entry = { id: nextId++, file, status: 'checking' };
    state.files.push(entry);
    renderFiles();
    inspectFile(entry);
  }
  for (const msg of rejected) alerts.append(el('div', { class: 'alert alert-err', html: `<b>!</b><span>${msg}</span>` }));
}

async function inspectFile(entry) {
  try {
    entry.buffer = await entry.file.arrayBuffer();
    const head = new Uint8Array(entry.buffer.slice(0, 1024));
    const headStr = String.fromCharCode(...head);
    if (!headStr.includes('%PDF-')) { entry.status = 'invalid'; entry.note = 'Not a valid PDF file (the content does not match the .pdf extension).'; renderFiles(); return; }
    try {
      const doc = await openPdf(entry.buffer);
      entry.pages = doc.numPages;
      // quick look at first pages: is there selectable text?
      let lowText = 0;
      const sample = Math.min(doc.numPages, 3);
      for (let n = 1; n <= sample; n++) {
        const p = await doc.getPage(n);
        const tc = await p.getTextContent();
        const chars = tc.items.reduce((a, it) => a + (it.str ? it.str.replace(/\s/g, '').length : 0), 0);
        if (chars < 20) lowText++;
        p.cleanup();
      }
      entry.scanned = lowText > 0;
      await closePdf(doc);
      entry.status = 'ready';
    } catch (e) {
      if (e instanceof PdfPasswordError) { entry.status = 'password'; entry.note = 'Password-protected — you will be asked for the password when converting.'; }
      else { entry.status = 'invalid'; entry.note = 'This file is damaged or is not a valid PDF.'; }
    }
  } catch {
    entry.status = 'invalid'; entry.note = 'The file could not be read from your computer.';
  }
  renderFiles();
}

const pdfIcon = `<svg class="ficon" viewBox="0 0 30 36" aria-hidden="true"><path d="M2 2h18l8 8v24H2z" fill="#fff" stroke="#C9D3CD"/><rect x="0" y="20" width="22" height="10" rx="2" fill="#B3261E"/><text x="11" y="27.5" text-anchor="middle" font-size="7" font-weight="700" fill="#fff" font-family="Segoe UI,Arial">PDF</text></svg>`;

function renderFiles() {
  const ul = $('#file-list');
  ul.innerHTML = '';
  const n = state.files.length;
  $('#file-count').hidden = !n; $('#file-count').textContent = `${n} PDF${n === 1 ? '' : 's'}`;
  $('#files-h').hidden = !n; ul.hidden = !n;
  dz.classList.toggle('dz-compact', n > 0);
  dz.querySelector('.dz-title').textContent = n ? 'Add more PDF files' : 'Drag and drop PDF files here';
  dz.querySelector('.dz-sub').textContent = n ? 'Drop here or browse' : 'or select them from your computer · multiple files allowed';
  const total = state.files.reduce((a, f) => a + f.file.size, 0);
  $('#files-total').textContent = `${n} document${n === 1 ? '' : 's'} · ${fmtSize(total)} total`;
  for (const f of state.files) {
    const badge = {
      checking: '<span class="badge b-neutral">Checking…</span>',
      ready: f.scanned ? '<span class="badge b-ocr">OCR needed</span>' : '<span class="badge b-ok">Ready</span>',
      password: '<span class="badge b-warn">Password</span>',
      invalid: '<span class="badge b-fail">Can\'t be read</span>',
    }[f.status];
    const meta = [fmtSize(f.file.size)];
    if (f.pages) meta.push(`${f.pages} page${f.pages === 1 ? '' : 's'}`);
    if (f.scanned) meta.push('scanned pages detected');
    if (f.note) meta.push(f.note);
    const li = el('li', { class: f.status === 'invalid' ? 'bad' : '', html: `${pdfIcon}<div class="fgrow"><div class="fname" title="${esc(f.file.name)}">${esc(f.file.name)}</div><div class="fmeta mono">${esc(meta.join(' · '))}</div></div>${badge}<button class="x" title="Remove" aria-label="Remove ${esc(f.file.name)}" type="button">×</button>` });
    li.querySelector('.x').addEventListener('click', () => { state.files = state.files.filter(x => x !== f); renderFiles(); });
    ul.append(li);
  }
  const convertible = state.files.filter(f => f.status === 'ready' || f.status === 'password');
  $('#convert-btn').disabled = !convertible.length || state.files.some(f => f.status === 'checking') || state.running;
}

// ---------------- settings ----------------
document.querySelectorAll('#mode-group input').forEach(r => r.addEventListener('change', () => {
  document.querySelectorAll('#mode-group .opt').forEach(o => o.classList.toggle('sel', o.querySelector('input').checked));
}));
function readSettings() {
  return {
    mode: document.querySelector('#mode-group input:checked').value,
    langs: $('#ocr-lang').value.split('+'),
    structure: $('#structure').value,
    includeSummary: $('#opt-summary').checked,
    includeFile: $('#opt-file').checked,
    includePage: $('#opt-page').checked,
    includeTableNo: $('#opt-tableno').checked,
    preserveLayout: $('#opt-layout').checked,
    locale: 'ro',
  };
}

// ---------------- conversion ----------------
$('#convert-btn').addEventListener('click', () => startConversion());
$('#cancel-btn').addEventListener('click', async () => {
  if (!state.running) return;
  state.cancel = true;
  $('#cancel-btn').disabled = true; $('#cancel-btn').textContent = 'Cancelling…';
  await terminateOcr();
});

function show(view) {
  for (const v of ['main', 'processing', 'results', 'preview']) $('#view-' + v).hidden = v !== view;
  window.scrollTo(0, 0);
}

async function startConversion(only) {
  if (state.running) return;
  const settings = readSettings();
  let list = only ? [only] : state.files.filter(f => f.status === 'ready' || f.status === 'password');
  // large documents: ask first
  const keep = [];
  for (const f of list) {
    if (f.file.size > LARGE_BYTES || (f.pages || 0) > LARGE_PAGES) {
      const ok = await showModal({
        icon: '!', iconClass: 'warn', title: 'Very large document',
        body: `<b>${esc(f.file.name)}</b> is ${fmtSize(f.file.size)}${f.pages ? ` with ${f.pages.toLocaleString('en-US')} pages` : ''}.<br><br>`
          + `For digital PDFs expect <b>${estimateText(f.pages, false)}</b>.`
          + (f.scanned ? ` This file has scanned pages: OCR takes about 5–7 s per page, so a fully scanned document of this size could take <b>${estimateText(f.pages, true)}</b>. Splitting it into smaller files is strongly recommended.` : '')
          + `<br><br>Keep this tab open and in front while it runs; close other heavy tabs.`,
        actions: [{ label: 'Skip this file', value: false }, { label: 'Process anyway', value: true, primary: true }],
      });
      if (!ok) continue;
    }
    keep.push(f);
  }
  list = keep;
  if (!list.length) return;

  state.running = true; state.cancel = false;
  if (!only) state.docs = [];
  $('#cancel-btn').disabled = false; $('#cancel-btn').textContent = 'Cancel';
  show('processing');
  const started = performance.now();
  const timer = setInterval(() => { $('#p-elapsed').textContent = fmtDuration((performance.now() - started) / 1000); }, 500);
  const queue = $('#p-queue');
  const renderQueue = (current) => {
    queue.innerHTML = '';
    list.forEach((f, i) => {
      const d = state.docs.find(x => x._entry === f);
      let badge = '<span class="badge b-neutral">Waiting</span>', meta = f.pages ? `${f.pages} page${f.pages === 1 ? '' : 's'}` : '';
      if (d) { badge = statusBadge(d.status); meta = d.fatal ? 'not converted' : d.cancelled ? 'cancelled' : `${d.pageCount} page${d.pageCount === 1 ? '' : 's'} · ${d.tables.length} table${d.tables.length === 1 ? '' : 's'}`; }
      else if (i === current) { badge = '<span class="badge" style="background:var(--krka-green);color:#fff">Working</span>'; meta = $('#p-pagepos').textContent; }
      queue.append(el('li', { html: `${badge}<span class="fgrow">${esc(f.file.name)}</span><span class="fmeta mono">${esc(meta)}</span>`, style: i === 0 ? 'border-top:0' : '' }));
    });
  };

  for (let i = 0; i < list.length; i++) {
    if (state.cancel) break;
    const f = list[i];
    $('#p-filepos').textContent = `File ${i + 1} of ${list.length}`;
    $('#p-name').textContent = f.file.name;
    $('#p-ocrbadge').hidden = true;
    $('#p-info').hidden = true;
    $('#p-bar').style.width = '0%';
    $('#p-sub').textContent = 'Opening document…';
    $('#p-page').textContent = '–'; $('#p-method').textContent = '–'; $('#p-ocr').textContent = 'Not needed';
    renderQueue(i);
    let doc;
    try {
      if (!f.buffer) f.buffer = await f.file.arrayBuffer();
      doc = await convertPdf(f.file, f.buffer, settings, {
        isCancelled: () => state.cancel,
        getPassword: (incorrect) => askPassword(f.file.name, incorrect),
        onProgress: (p) => {
          const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
          $('#p-bar').style.width = pct + '%';
          $('#p-bar-wrap').setAttribute('aria-valuenow', pct);
          $('#p-pagepos').textContent = `Page ${p.page} of ${p.total}`;
          $('#p-page').textContent = `${p.page} / ${p.total}`;
          $('#p-method').textContent = p.method || '–';
          const isOcr = /OCR/.test(p.method || '');
          if (isOcr) { $('#p-ocrbadge').hidden = false; $('#p-info').hidden = false; $('#p-info').textContent = 'Scanned pages are being read with OCR. Pages with selectable text are read directly.'; }
          if (p.ocrStatus) $('#p-ocr').textContent = p.ocrStatus;
          let sub = `${p.done} of ${p.total} pages completed`;
          if (p.etaSec != null && p.done < p.total) sub += ` · based on measured speed: about ${fmtEta(p.etaSec)} remaining for this file`;
          $('#p-sub').textContent = sub;
        },
      });
    } catch (e) {
      doc = { fileName: f.file.name, size: f.file.size, fatal: true, error: 'Unexpected error: ' + (e?.message || e), status: 'FAILED', tables: [], pages: [], notes: [] };
    }
    doc._entry = f;
    const prev = state.docs.findIndex(d => d._entry === f);
    if (prev >= 0) state.docs[prev] = doc; else state.docs.push(doc);
  }
  if (state.cancel) {
    for (const f of list) if (!state.docs.some(d => d._entry === f)) state.docs.push({ fileName: f.file.name, size: f.file.size, status: 'CANCELLED', cancelled: true, tables: [], pages: [], notes: [], _entry: f });
    await terminateOcr();
  }
  clearInterval(timer);
  state.running = false;
  renderResults();
  show('results');
}

function askPassword(name, incorrect) {
  return showModal({
    icon: '🔒', iconClass: 'info', title: 'Password-protected PDF',
    body: `${incorrect ? '<span style="color:var(--error)"><b>Incorrect password.</b> Try again.</span><br>' : ''}<b>${esc(name)}</b> is protected. Enter the password to open it. The password stays in your browser and is not saved.`,
    input: { type: 'password', placeholder: 'PDF password' },
    actions: [{ label: 'Skip file', value: null }, { label: 'Unlock', value: 'input', primary: true }],
  });
}

// ---------------- results ----------------
function statusBadge(s) {
  const cls = { SUCCESS: 'b-ok', WARNINGS: 'b-warn', PARTIAL: 'b-partial', FAILED: 'b-fail', CANCELLED: 'b-neutral' }[s] || 'b-neutral';
  return `<span class="badge ${cls}">${esc(statusLabel(s))}</span>`;
}

export function renderResults() {
  const list = $('#r-list');
  list.innerHTML = '';
  const docs = state.docs;
  $('#r-count').textContent = `${docs.length} document${docs.length === 1 ? '' : 's'}`;
  const okDocs = docs.filter(d => !d.fatal && !d.cancelled);
  $('#download-all').hidden = okDocs.length < 2;
  for (const d of docs) {
    if (!d.fatal && !d.cancelled) d.status = documentStatus(d);
    const row = el('div', { class: 'res' });
    const left = el('div');
    left.innerHTML = `<div><b>${esc(d.fileName)}</b> <span style="margin-left:6px">${statusBadge(d.status)}</span></div>`;
    const right = el('div', { class: 'res-actions' });
    if (d.fatal || d.cancelled) {
      left.innerHTML += `<div class="res-note" style="color:${d.cancelled ? 'var(--text-muted)' : 'var(--error)'}">${esc(d.cancelled ? 'Conversion was cancelled before this file was finished.' : (d.error || 'The document could not be processed.'))}</div>`;
      right.append(btn('Retry', true, () => retry(d)));
    } else {
      const rows = d.tables.reduce((a, t) => a + t.rows.length, 0);
      const cols = d.tables.length ? Math.max(...d.tables.map(t => t.columns.length)) : 0;
      const ocrN = d.pages.filter(p => p.method === 'ocr').length;
      const warns = d.tables.reduce((a, t) => a + countIssues(t).warn, 0);
      left.innerHTML += `<div class="stats mono"><span><b>${d.pageCount}</b> page${d.pageCount === 1 ? '' : 's'}</span><span><b>${d.tables.length}</b> table${d.tables.length === 1 ? '' : 's'}</span><span><b>${rows.toLocaleString('en-US')}</b> rows</span><span><b>${cols}</b> column${cols === 1 ? '' : 's'}${d.tables.length > 1 ? ' (max)' : ''}</span><span>OCR: <b>${ocrN ? `${ocrN} of ${d.pageCount} pages` : 'not used'}</b></span><span><b>${warns}</b> cell warning${warns === 1 ? '' : 's'}</span></div>`;
      const docWarn = d.notes.filter(n => n.sev === 'warn');
      let note = '';
      if (warns) note = `${warns} value${warns === 1 ? '' : 's'} need${warns === 1 ? 's' : ''} checking. Review them before using this file.`;
      if (docWarn.length) {
        const first = /read with OCR/.test(docWarn[0].msg) ? 'Scanned pages were read with OCR — the values are not verified; compare them with the original.' : docWarn[0].msg;
        note = (note ? note + ' ' : '') + first + (docWarn.length > 1 ? ` (+${docWarn.length - 1} more under Details)` : '');
      }
      if (note) left.innerHTML += `<div class="res-note" style="color:${d.status === 'PARTIAL' ? '#8A3D00' : 'var(--warn)'}">${esc(note)}</div>`;
      if (d.tables.length) {
        if (warns) right.append(btn(`Review ${warns} issue${warns === 1 ? '' : 's'}`, true, () => preview(d)));
        else right.append(btn('Preview', false, () => preview(d)));
      }
      right.append(btn(warns ? 'Download anyway' : 'Download Excel', !warns, () => downloadDoc(d)));
      if (d.status === 'PARTIAL') right.append(btn('Retry', false, () => retry(d)));
    }
    right.append(btn('Details', false, () => {
      const ex = row.querySelector('.res-details');
      if (ex) { ex.remove(); return; }
      const ul = el('ul', { class: 'res-details' });
      const items = [...(d.error ? [{ sev: 'warn', msg: d.error }] : []), ...(d.notes || [])];
      for (const t of d.tables || []) for (const n of t.notes || []) items.push({ sev: n.sev, msg: `Table ${t.index} (${pagesText(t)}): ${n.msg}` });
      if (d.seconds) items.push({ sev: 'info', msg: `Processing time: ${fmtDuration(d.seconds)}` });
      if (!items.length) items.push({ sev: 'info', msg: 'No notes.' });
      for (const it of items) ul.append(el('li', { class: it.sev === 'warn' ? 'w' : '', text: (it.sev === 'warn' ? '⚠ ' : '• ') + it.msg }));
      // technical details — numbers only, never document content
      const diag = {
        app: 'KRKA PDF to Excel v1.1.0', browser: navigator.userAgent, cores: navigator.hardwareConcurrency, memoryGB: navigator.deviceMemory ?? null,
        fileSizeMB: +(d.size / 1048576).toFixed(2), pages: d.pageCount ?? null, status: d.status, error: d.error ? d.error.replace(d.fileName, '<file>') : null,
        seconds: d.seconds ? +d.seconds.toFixed(1) : null, perPage: (d.diagnostics || d.pages || []).slice(0, 400),
      };
      const li = el('li');
      const copy = el('button', { class: 'btn btn-sm', type: 'button', text: 'Copy technical details (no document content)' });
      copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(JSON.stringify(diag)); copy.textContent = 'Copied ✓'; } catch { copy.textContent = 'Copy not allowed by the browser'; } });
      li.append(copy); ul.append(li);
      row.append(ul);
    }));
    row.append(left, right);
    list.append(row);
  }
  if (!docs.length) list.append(el('div', { class: 'empty-results', text: 'No documents were converted.' }));
}
const pagesText = t => t.pages.length > 1 ? `pages ${t.pages[0]}–${t.pages[t.pages.length - 1]}` : `page ${t.pages[0]}`;

function btn(label, primary, onClick) {
  const b = el('button', { class: 'btn btn-sm' + (primary ? ' btn-primary' : ''), type: 'button', text: label });
  b.addEventListener('click', onClick);
  return b;
}

function retry(d) { startConversion(d._entry); }

function preview(d) {
  show('preview');
  openPreview($('#view-preview'), d, {
    onBack: () => { renderResults(); show('results'); },
    onDownload: () => downloadDoc(d),
  });
}

let downloading = false;
async function downloadDoc(d) {
  if (downloading) return;
  downloading = true;
  const big = (d.tables || []).reduce((a, t) => a + t.rows.length, 0) > 20000;
  const tst = big ? toastSticky('Preparing the Excel file…') : null;
  try {
    const blob = await buildWorkbook([d], readSettings(), (f) => tst?.set(`Preparing the Excel file… ${Math.round(f * 100)}%`));
    downloadBlob(blob, d.fileName.replace(/\.pdf$/i, '') + '.xlsx');
  } catch (e) {
    showModal({ icon: '!', iconClass: 'err', title: 'Excel file could not be created', body: esc(e?.message || String(e)), actions: [{ label: 'Close', value: true, primary: true }] });
  } finally { tst?.close(); downloading = false; }
}

function toastSticky(msg) {
  const t = el('div', { class: 'toast', text: msg, role: 'status' });
  document.getElementById('toast-root').append(t);
  return { set: (m) => { t.textContent = m; }, close: () => t.remove() };
}

$('#download-all').addEventListener('click', async () => {
  const b = $('#download-all'); b.disabled = true; const t = b.textContent; b.textContent = 'Preparing…';
  try {
    const settings = readSettings();
    const files = [];
    const names = new Set();
    for (const d of state.docs.filter(x => !x.fatal && !x.cancelled)) {
      let name = d.fileName.replace(/\.pdf$/i, '') + '.xlsx', k = 2;
      while (names.has(name.toLowerCase())) name = d.fileName.replace(/\.pdf$/i, '') + ` (${k++}).xlsx`;
      names.add(name.toLowerCase());
      files.push({ name, blob: await buildWorkbook([d], settings) });
    }
    const zip = await zipFiles(files);
    const dt = new Date();
    downloadBlob(zip, `PDF-to-Excel_${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}.zip`);
  } catch (e) {
    showModal({ icon: '!', iconClass: 'err', title: 'Download failed', body: esc(e?.message || String(e)), actions: [{ label: 'Close', value: true, primary: true }] });
  } finally { b.disabled = false; b.textContent = t; }
});

$('#reset-btn').addEventListener('click', () => {
  state.files = []; state.docs = [];
  $('#upload-alerts').innerHTML = '';
  $('#view-preview').innerHTML = '';
  renderFiles();
  show('main');
  toast('Cleared. All document data was removed from this page.');
});

function estimateText(pages, ocr) {
  if (!pages) return 'a few minutes';
  const perPage = ocr ? 6 / Math.max(1, Math.min(3, Math.floor((navigator.hardwareConcurrency || 4) / 2))) : 0.035;
  const s = pages * perPage * 1.3;
  if (s < 90) return 'about 1–2 minutes';
  if (s < 3600) return `about ${Math.round(s / 60 * 0.8)}–${Math.round(s / 60 * 1.2)} minutes`;
  return `about ${Math.round(s / 3600 * 0.8 * 10) / 10}–${Math.round(s / 3600 * 1.2 * 10) / 10} hours`;
}

function fmtDuration(s) { s = Math.round(s); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`; }
function fmtEta(s) {
  if (s < 50) return 'less than 1 min';
  const lo = Math.max(1, Math.floor(s / 60)), hi = Math.ceil((s * 1.3) / 60);
  return lo === hi ? `${lo} min` : `${lo}–${hi} min`;
}

renderFiles();

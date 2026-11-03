// Turns raw cell text into typed values (number, percent, date, text).
// Rule: never guess silently. Ambiguous values are either kept as text
// or converted with a visible flag explaining the assumption.

const NBSP = /[   ]/g;
const CURRENCY = /^(?:(lei|ron|eur|euro|usd|€|\$|£)\s*)?(.+?)(?:\s*(lei|ron|eur|euro|usd|€|\$|£))?$/i;

// Columns whose values must stay text even if they look numeric.
const CODE_HEADER = /\b(cod|code|cui|cnp|cif|iban|id|tel|telefon|phone|fax|nr\.?\s*(contract|factur|doc)|ean|gtin|sku|pn|serie|serial|zip|postal)\b/i;

export function normalizeText(s) {
  return String(s ?? '').replace(NBSP, ' ').replace(/\s+/g, ' ').trim();
}

// ---------- number shape classification ----------
// Returns {kind:'int'|'ro'|'en'|'amb-ro-thousand'|'amb-en-thousand'|null, ...}
function classifyNumber(s) {
  let str = s.replace(/\s/g, ' ');
  let neg = false;
  if (/^\(.*\)$/.test(str)) { neg = true; str = str.slice(1, -1).trim(); }
  if (/^[-−–]/.test(str)) { neg = true; str = str.slice(1).trim(); }
  else if (/^\+/.test(str)) str = str.slice(1).trim();
  if (/-$/.test(str)) { neg = true; str = str.slice(0, -1).trim(); }

  // thousands separated with spaces: "1 234 567,89" or "1 234.5"
  if (/^\d{1,3}( \d{3})+([.,]\d+)?$/.test(str)) {
    const dec = str.match(/[.,](\d+)$/);
    const intPart = str.replace(/[.,]\d+$/, '').replace(/ /g, '');
    return { kind: dec ? (str.includes(',') ? 'ro' : 'en') : 'int', neg, intPart, frac: dec ? dec[1] : '', spaced: true };
  }
  if (/ /.test(str)) return null;
  if (/^\d+$/.test(str)) return { kind: 'int', neg, intPart: str, frac: '' };
  // 1.234.567  or 1.234.567,89 -> RO
  if (/^\d{1,3}(\.\d{3}){2,}(,\d+)?$/.test(str) || /^\d{1,3}(\.\d{3})+,\d+$/.test(str)) {
    const [i, f = ''] = str.split(',');
    return { kind: 'ro', neg, intPart: i.replace(/\./g, ''), frac: f };
  }
  // 1,234,567 or 1,234,567.89 -> EN
  if (/^\d{1,3}(,\d{3}){2,}(\.\d+)?$/.test(str) || /^\d{1,3}(,\d{3})+\.\d+$/.test(str)) {
    const [i, f = ''] = str.split('.');
    return { kind: 'en', neg, intPart: i.replace(/,/g, ''), frac: f };
  }
  // single dot with exactly 3 digits after: 1.234 -> ambiguous
  if (/^\d{1,3}\.\d{3}$/.test(str)) {
    const [i, f] = str.split('.');
    return { kind: 'amb', neg, ro: { intPart: i + f, frac: '' }, en: { intPart: i, frac: f } };
  }
  if (/^\d{1,3},\d{3}$/.test(str)) {
    const [i, f] = str.split(',');
    return { kind: 'amb', neg, ro: { intPart: i, frac: f }, en: { intPart: i + f, frac: '' } };
  }
  if (/^\d+,\d+$/.test(str)) { const [i, f] = str.split(','); return { kind: 'ro', neg, intPart: i, frac: f }; }
  if (/^\d+\.\d+$/.test(str)) { const [i, f] = str.split('.'); return { kind: 'en', neg, intPart: i, frac: f }; }
  if (/^[.,]\d+$/.test(str)) return { kind: str[0] === ',' ? 'ro' : 'en', neg, intPart: '0', frac: str.slice(1) };
  return null;
}

function toNumber(intPart, frac, neg) {
  const n = Number(intPart + (frac ? '.' + frac : ''));
  return neg ? -n : n;
}

// ---------- date ----------
function parseDateShape(s) {
  let m = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/);
  if (m) return { a: +m[3], b: +m[2], y: +m[1], sep: s[4], iso: true };
  m = s.match(/^(\d{1,2})([./-])(\d{1,2})\2(\d{4}|\d{2})$/);
  if (m) {
    let y = +m[4];
    if (m[4].length === 2) y += y < 70 ? 2000 : 1900;
    return { a: +m[1], b: +m[3], y, sep: m[2], short: m[4].length === 2 };
  }
  return null;
}
function validDate(d, mth, y) {
  if (mth < 1 || mth > 12 || d < 1 || y < 1900 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, mth - 1, d));
  return dt.getUTCDate() === d ? dt : null;
}

// ---------- column analysis ----------
// Looks at every value of a column and decides how to read ambiguous ones.
export function analyzeColumn(values, headerName = '', defaultLocale = 'ro') {
  let ro = 0, en = 0, dayFirst = 0, monthFirst = 0, slashDates = 0;
  for (const raw of values) {
    const s = stripUnits(normalizeText(raw)).core;
    if (!s) continue;
    const c = classifyNumber(s.replace(/\s*%$/, ''));
    if (c?.kind === 'ro') ro++;
    if (c?.kind === 'en') en++;
    const d = parseDateShape(s);
    if (d && !d.iso) {
      if (d.sep === '/') slashDates++;
      if (d.a > 12 && d.b <= 12) dayFirst++;
      if (d.b > 12 && d.a <= 12) monthFirst++;
    }
  }
  let numLocale = defaultLocale, numEvidence = 'default';
  if (ro && !en) { numLocale = 'ro'; numEvidence = 'column'; }
  else if (en && !ro) { numLocale = 'en'; numEvidence = 'column'; }
  else if (ro && en) { numLocale = null; numEvidence = 'conflict'; }

  let dateOrder = 'dmy', dateEvidence = 'default';
  if (dayFirst && !monthFirst) dateEvidence = 'column';
  else if (monthFirst && !dayFirst) { dateOrder = 'mdy'; dateEvidence = 'column'; }
  else if (dayFirst && monthFirst) { dateOrder = null; dateEvidence = 'conflict'; }

  return {
    numLocale, numEvidence, dateOrder, dateEvidence, slashDates,
    keepText: CODE_HEADER.test(headerName),
  };
}

function stripUnits(s) {
  const m = s.match(CURRENCY);
  if (!m) return { core: s, unit: '' };
  const pre = m[1] || '', post = m[3] || '';
  if ((pre || post) && /\d/.test(m[2])) return { core: m[2].trim(), unit: (pre || post) };
  return { core: s, unit: '' };
}

function numFmtFor(frac, opts = {}) {
  const d = frac ? frac.length : 0;
  const base = (opts.grouped ? '#,##0' : '0') + (d ? '.' + '0'.repeat(Math.min(d, 10)) : '');
  return base;
}

// Parse one cell. Returns {v, t, fmt, flags[]}
// t: 'empty' | 'text' | 'number' | 'percent' | 'date'
export function parseCell(raw, col) {
  const s = normalizeText(raw);
  if (!s) return { v: null, t: 'empty', fmt: null, flags: [] };
  const flags = [];

  if (col?.keepText) return { v: s, t: 'text', fmt: '@', flags };

  // leading zero codes and very long digit strings stay text
  if (/^0\d+$/.test(s)) return { v: s, t: 'text', fmt: '@', flags };
  if (/^\d{16,}$/.test(s.replace(/\s/g, ''))) return { v: s, t: 'text', fmt: '@', flags };

  // percent
  const pm = s.match(/^(.+?)\s*%$/);
  if (pm) {
    const r = readNumber(pm[1].trim(), col, flags, s);
    if (r) return { v: Number((r.n / 100).toPrecision(15)), t: 'percent', fmt: r.frac ? '0.' + '0'.repeat(Math.min(r.frac.length, 6)) + '%' : '0%', flags };
    return { v: s, t: 'text', fmt: null, flags };
  }

  // date
  const d = parseDateShape(s);
  if (d) {
    let day, mon;
    if (d.iso) { day = d.a; mon = d.b; }
    else {
      const order = col?.dateOrder ?? 'dmy';
      if (order === null) {
        flags.push({ kind: 'date', sev: 'warn', msg: 'Date order is inconsistent in this column (day/month vs month/day) — kept as text' });
        return { v: s, t: 'text', fmt: null, flags };
      }
      if (order === 'dmy') { day = d.a; mon = d.b; } else { day = d.b; mon = d.a; }
      if (d.sep === '/' && col?.dateEvidence === 'default' && d.a <= 12 && d.b <= 12 && d.a !== d.b) {
        flags.push({ kind: 'date', sev: 'info', msg: 'Read as day/month/year (Romanian format) — no other value in the column confirms the order' });
      }
    }
    const dt = validDate(day, mon, d.y);
    if (dt) {
      if (d.short) flags.push({ kind: 'date', sev: 'info', msg: `Two-digit year read as ${d.y}` });
      return { v: dt, t: 'date', fmt: 'dd.mm.yyyy', flags };
    }
    flags.push({ kind: 'date', sev: 'warn', msg: 'Looks like a date but is not a valid calendar date — kept as text' });
    return { v: s, t: 'text', fmt: null, flags };
  }

  // number (with optional currency)
  const { core, unit } = stripUnits(s);
  const r = readNumber(core, col, flags, s);
  if (r) {
    let fmt = numFmtFor(r.frac, { grouped: r.grouped });
    if (unit) fmt += ` "${unit.replace(/"/g, '')}"`;
    return { v: r.n, t: 'number', fmt, flags };
  }
  return { v: s, t: 'text', fmt: null, flags };
}

function readNumber(str, col, flags, original) {
  const c = classifyNumber(str);
  if (!c) return null;
  if (/^\(.*\)$/.test(str.trim())) flags.push({ kind: 'number', sev: 'info', msg: `Value in brackets ${original} read as a negative number (accounting format)` });
  const loc = col?.numLocale === undefined ? 'ro' : col.numLocale;
  if (c.kind === 'int') return { n: toNumber(c.intPart, '', c.neg), frac: '', grouped: !!c.spaced };
  if (c.kind === 'ro' || c.kind === 'en') {
    if (loc && c.kind !== loc && col?.numEvidence === 'column') {
      flags.push({ kind: 'number', sev: 'warn', msg: `Number format differs from the rest of the column (${original})` });
    }
    const grouped = /[.,]\d{3}[.,]|\d[.,]\d{3}[.,]|^\d{1,3}[.,]\d{3}[.,]/.test(str) || !!c.spaced || (str.replace(/[^.,]/g, '').length > 1);
    return { n: toNumber(c.intPart, c.frac, c.neg), frac: c.frac, grouped };
  }
  if (c.kind === 'amb') {
    if (loc === null) {
      flags.push({ kind: 'number', sev: 'warn', msg: `"${original}" could be read two ways and the column mixes formats — kept as text` });
      return null;
    }
    const p = c[loc];
    if (col?.numEvidence === 'document') {
      flags.push({ kind: 'number', sev: 'info', msg: `"${original}" read as ${toNumber(p.intPart, p.frac, c.neg)} — the rest of the document uses ${loc === 'ro' ? 'Romanian' : 'English'} number format` });
    } else if (col?.numEvidence !== 'column') {
      flags.push({ kind: 'number', sev: 'warn', msg: `"${original}" read as ${toNumber(p.intPart, p.frac, c.neg)} (${loc === 'ro' ? 'Romanian' : 'English'} format assumed) — please confirm` });
    }
    return { n: toNumber(p.intPart, p.frac, c.neg), frac: p.frac, grouped: !p.frac };
  }
  return null;
}

// Re-type a whole table column-by-column. Mutates cells.
// Counts unambiguous Romanian vs English numbers across a whole document.
export function documentLocale(tables) {
  let ro = 0, en = 0;
  for (const t of tables) for (const r of t.rows) for (const c of r.cells) {
    const s = stripUnits(normalizeText(c.raw)).core.replace(/\s*%$/, '');
    const k = classifyNumber(s)?.kind;
    if (k === 'ro') ro++; else if (k === 'en') en++;
  }
  if (ro >= 3 && en === 0) return 'ro';
  if (en >= 3 && ro === 0) return 'en';
  return null;
}

export function typeTable(table, defaultLocale = 'ro', docLocale = table.docLocale ?? null) {
  const ncol = table.columns.length;
  for (let c = 0; c < ncol; c++) {
    const vals = table.rows.map(r => r.cells[c]?.raw ?? '');
    const col = analyzeColumn(vals, table.columns[c].name, defaultLocale);
    if (col.numEvidence === 'default' && docLocale) { col.numLocale = docLocale; col.numEvidence = 'document'; }
    table.columns[c].analysis = col;
    for (const row of table.rows) {
      const cell = row.cells[c];
      if (!cell) continue;
      applyParse(cell, col);
    }
  }
}

const FMT_CACHE = new Map();
const intern = f => { if (f == null) return f; let x = FMT_CACHE.get(f); if (x === undefined) { FMT_CACHE.set(f, f); x = f; } return x; };

export function applyParse(cell, col) {
  const p = parseCell(cell.raw, col);
  cell.v = (p.t === 'text' && p.v === normalizeText(cell.raw) && p.v === cell.raw) ? cell.raw : p.v;
  cell.t = p.t;
  if (p.fmt) cell.fmt = intern(p.fmt); else delete cell.fmt;
  // keep non-parse flags (ocr, structure), replace parse flags
  const flags = (cell.flags || []).filter(f => f.kind !== 'number' && f.kind !== 'date').concat(cell.verified ? [] : p.flags);
  if (flags.length) cell.flags = flags; else delete cell.flags;
  if (cell.conf == null) delete cell.conf;
}

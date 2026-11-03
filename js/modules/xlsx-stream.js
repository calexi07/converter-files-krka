// Streaming .xlsx writer for very large results (hundreds of thousands of rows).
// Rows are written as compressed chunks one batch at a time, so memory stays
// close to the size of the final file instead of the whole workbook in memory.
// Supports: number/date/percent formats, styled header, frozen header row,
// filters, column widths, highlighted cells and tab colours.
import { Zip, ZipDeflate, strToU8 } from '../../libraries/fflate/fflate.mjs';

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
export const EXCEL_MAX_ROWS = 1048576;

const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
const escXml = s => String(s).replace(INVALID_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function colName(i) { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const toSerial = d => (d.getTime() - EXCEL_EPOCH) / 86400000;

// ---- style registry ----
class Styles {
  constructor() {
    this.numFmts = new Map();      // code -> id
    this.xfs = [];                 // [{numFmtId, fontId, fillId, wrap}]
    this.index = new Map();        // key -> xf index
    this.get({});                  // xf 0 = default
  }
  fmtId(code) {
    if (!code) return 0;
    if (code === '@') return 49;
    if (!this.numFmts.has(code)) this.numFmts.set(code, 164 + this.numFmts.size);
    return this.numFmts.get(code);
  }
  // kind: 'header' | 'title' | 'flag' | undefined
  get({ fmt = null, kind = null, wrap = false }) {
    const numFmtId = this.fmtId(fmt);
    const fontId = kind === 'header' ? 1 : kind === 'title' ? 2 : 0;
    const fillId = kind === 'header' ? 2 : kind === 'flag' ? 3 : 0;
    const key = `${numFmtId}|${fontId}|${fillId}|${wrap ? 1 : 0}`;
    if (!this.index.has(key)) { this.index.set(key, this.xfs.length); this.xfs.push({ numFmtId, fontId, fillId, wrap }); }
    return this.index.get(key);
  }
  xml() {
    const nf = [...this.numFmts].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${escXml(code)}"/>`).join('');
    const xfs = this.xfs.map(x => `<xf numFmtId="${x.numFmtId}" fontId="${x.fontId}" fillId="${x.fillId}" borderId="0" xfId="0"${x.numFmtId ? ' applyNumberFormat="1"' : ''}${x.fontId ? ' applyFont="1"' : ''}${x.fillId ? ' applyFill="1"' : ''}${x.wrap ? ' applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>' : '/>'}`).join('');
    return XML_HEAD + `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
      + (this.numFmts.size ? `<numFmts count="${this.numFmts.size}">${nf}</numFmts>` : '')
      + `<fonts count="3"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="13"/><color rgb="FF006B32"/><name val="Calibri"/><family val="2"/></font></fonts>`
      + `<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF006B32"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/><bgColor indexed="64"/></patternFill></fill></fills>`
      + `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>`
      + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
      + `<cellXfs count="${this.xfs.length}">${xfs}</cellXfs>`
      + `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  }
}

// cell spec: {v, t:'number'|'percent'|'date'|'text'|'empty', fmt, flag, kind, wrap}
function cellXml(ref, c, styles) {
  if (c == null || c.v == null || c.v === '' || c.t === 'empty') {
    if (c && (c.flag || c.kind)) return `<c r="${ref}" s="${styles.get({ kind: c.kind || 'flag' })}"/>`;
    return '';
  }
  const s = styles.get({ fmt: c.fmt, kind: c.kind || (c.flag ? 'flag' : null), wrap: c.wrap });
  const sa = s ? ` s="${s}"` : '';
  if (c.v instanceof Date) return `<c r="${ref}"${sa}><v>${toSerial(c.v)}</v></c>`;
  if (typeof c.v === 'number' && Number.isFinite(c.v)) return `<c r="${ref}"${sa}><v>${c.v}</v></c>`;
  return `<c r="${ref}"${sa} t="inlineStr"><is><t xml:space="preserve">${escXml(c.v)}</t></is></c>`;
}

// sheet: {name, header:[string], widths:[number], tabColor, freeze:bool, filter:bool,
//         rowCount, getRow(i) -> [cellSpec], titleRows?: [[cellSpec]] }
export async function writeXlsx(sheets, onProgress) {
  return new Promise((resolve, reject) => {
    const parts = [];
    const zip = new Zip((err, chunk, final) => {
      if (err) { reject(err); return; }
      parts.push(chunk);
      if (final) resolve(new Blob(parts, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    });
    const styles = new Styles();
    const addFile = (path, text) => { const f = new ZipDeflate(path, { level: 6 }); zip.add(f); f.push(strToU8(text), true); };

    (async () => {
      const totalRows = sheets.reduce((a, s) => a + s.rowCount, 0) || 1;
      let written = 0;
      for (let si = 0; si < sheets.length; si++) {
        const sh = sheets[si];
        const ncol = Math.max(1, sh.header.length, sh.ncol || 0);
        const hasHeader = sh.header.length > 0;
        const lastRow = sh.rowCount + (hasHeader ? 1 : 0) + (sh.titleRows?.length || 0);
        const lastRef = `${colName(ncol - 1)}${lastRow}`;
        const headerRow = (sh.titleRows?.length || 0) + 1;
        const f = new ZipDeflate(`xl/worksheets/sheet${si + 1}.xml`, { level: 6 });
        zip.add(f);
        let head = XML_HEAD + `<worksheet ${NS}>`;
        if (sh.tabColor) head += `<sheetPr><tabColor rgb="${sh.tabColor}"/></sheetPr>`;
        head += `<dimension ref="A1:${lastRef}"/>`;
        head += sh.freeze ? `<sheetViews><sheetView workbookViewId="0"${si === 0 ? ' tabSelected="1"' : ''}><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${headerRow + 1}" sqref="A${headerRow + 1}"/></sheetView></sheetViews>` : `<sheetViews><sheetView workbookViewId="0"${si === 0 ? ' tabSelected="1"' : ''}/></sheetViews>`;
        head += `<sheetFormatPr defaultRowHeight="15"/>`;
        if (sh.widths?.length) head += '<cols>' + sh.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(6, Math.min(80, w)).toFixed(1)}" customWidth="1"/>`).join('') + '</cols>';
        head += '<sheetData>';
        let r = 1;
        for (const tr of sh.titleRows || []) {
          head += `<row r="${r}">` + tr.map((c, i) => cellXml(`${colName(i)}${r}`, c, styles)).join('') + '</row>';
          r++;
        }
        if (hasHeader) {
          head += `<row r="${r}">` + sh.header.map((h, i) => cellXml(`${colName(i)}${r}`, { v: h, t: 'text', kind: sh.headerKind || 'header' }, styles)).join('') + '</row>';
          r++;
        }
        f.push(strToU8(head));
        const BATCH = 2000;
        for (let i0 = 0; i0 < sh.rowCount; i0 += BATCH) {
          let chunk = '';
          const end = Math.min(sh.rowCount, i0 + BATCH);
          for (let i = i0; i < end; i++, r++) {
            const cells = sh.getRow(i);
            let row = '';
            for (let c = 0; c < cells.length; c++) row += cellXml(`${colName(c)}${r}`, cells[c], styles);
            chunk += `<row r="${r}">${row}</row>`;
          }
          f.push(strToU8(chunk));
          written += end - i0;
          onProgress?.(written / totalRows);
          await new Promise(res => setTimeout(res));
        }
        let tail = '</sheetData>';
        if (sh.filter && sh.rowCount) tail += `<autoFilter ref="A${headerRow}:${lastRef}"/>`;
        tail += '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>';
        f.push(strToU8(tail), true);
      }

      const sheetEntries = sheets.map((s, i) => `<sheet name="${escXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
      const defined = sheets.map((s, i) => {
        if (!s.filter || !s.rowCount) return '';
        const hr = (s.titleRows?.length || 0) + 1;
        const last = s.rowCount + hr;
        return `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${escXml(s.name.replace(/'/g, "''"))}'!$A$${hr}:$${colName(Math.max(1, s.header.length) - 1)}$${last}</definedName>`;
      }).join('');
      addFile('xl/workbook.xml', XML_HEAD + `<workbook ${NS}><bookViews><workbookView/></bookViews><sheets>${sheetEntries}</sheets>${defined ? `<definedNames>${defined}</definedNames>` : ''}</workbook>`);
      addFile('xl/_rels/workbook.xml.rels', XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
      addFile('xl/styles.xml', styles.xml());
      addFile('_rels/.rels', XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`);
      const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
      addFile('docProps/core.xml', XML_HEAD + `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>KRKA PDF to Excel Converter</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created></cp:coreProperties>`);
      addFile('[Content_Types].xml', XML_HEAD + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`);
      zip.end();
    })().catch(reject);
  });
}

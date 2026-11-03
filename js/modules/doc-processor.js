// Pure document processing (no DOM): runs inside the table worker, or on the
// main thread as a fallback. Input = per-page words/lines. Output = tables.
import { findRunningLines, extractPageTables, mergeAcrossPages, lineify, joinWords } from './table-engine.js';
import { typeTable, documentLocale } from './value-parser.js';
import { validateTable } from './validator.js';

export function processDocument(pages, opts) {
  const usable = pages.filter(p => p.words && p.words.length);
  const running = findRunningLines(usable);
  const pageResults = pages.map(p => p.words?.length
    ? extractPageTables(p, opts, running)
    : { tables: [], outsideText: [], outsideAfterLast: 0, outsideBeforeFirst: 0 });
  const tables = mergeAcrossPages(pageResults);
  const docLoc = documentLocale(tables);
  tables.forEach((t, i) => {
    t.index = i + 1;
    t.docLocale = docLoc;
    typeTable(t, opts.locale || 'ro', docLoc);
    validateTable(t);
  });
  const outside = pageResults.map((r, i) => ({ page: pages[i].n, lines: r.outsideText })).filter(x => x.lines.length);
  const runningSample = [];
  if (running.size) {
    for (const p of usable) {
      for (const L of lineify(p.words)) {
        const k = joinWords(L.words).toLowerCase().replace(/\s+/g, ' ').trim().replace(/\d+/g, '#') + '@' + Math.round(L.yc / 8);
        if (running.has(k)) { const t = joinWords(L.words); if (!runningSample.includes(t)) runningSample.push(t); }
      }
      if (runningSample.length >= 3) break;
    }
  }
  return { tables, outside, runningLines: runningSample };
}

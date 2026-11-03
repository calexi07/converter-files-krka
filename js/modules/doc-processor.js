// Pure document processing (no DOM).
// Pages are rebuilt one at a time (in the background worker) so memory stays
// small even for long documents; joining pages, typing and validation happen after.
import { findRunningLines, extractPageTables, mergeAcrossPages, lineify, joinWords } from './table-engine.js';
import { typeTable, documentLocale } from './value-parser.js';
import { validateTable } from './validator.js';

export const EMPTY_PAGE_RESULT = { tables: [], outsideText: [], outsideAfterLast: 0, outsideBeforeFirst: 0 };

export function runningLines(pages) {
  return findRunningLines(pages.filter(p => p.words && p.words.length));
}

export function processPage(page, opts, runningKeys) {
  if (!page.words?.length) return EMPTY_PAGE_RESULT;
  return extractPageTables(page, opts, runningKeys instanceof Set ? runningKeys : new Set(runningKeys || []));
}

export function finishDocument(pages, pageResults, opts, running) {
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
    for (const p of pages) {
      if (!p.words?.length) continue;
      for (const L of lineify(p.words)) {
        const k = joinWords(L.words).toLowerCase().replace(/\s+/g, ' ').trim().replace(/\d+/g, '#') + '@' + Math.round(L.yc / 8);
        if (running.has(k)) { const t = joinWords(L.words); if (!runningSample.includes(t)) runningSample.push(t); }
      }
      if (runningSample.length >= 3) break;
    }
  }
  return { tables, outside, runningLines: runningSample };
}

// Whole document in one call (used by tests / fallback)
export function processDocument(pages, opts) {
  const running = runningLines(pages);
  return finishDocument(pages, pages.map(p => processPage(p, opts, running)), opts, running);
}

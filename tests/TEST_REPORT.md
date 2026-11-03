# Test report — KRKA PDF to Excel Converter

**Date:** 3 November 2026  ·  **Browser engine:** Chromium (headless, via Playwright) — the same engine as Google Chrome and Microsoft Edge  ·  **Machine:** 2 CPU cores

Every test below was **actually executed** against the real application, which was served over HTTP exactly as GitHub Pages serves it. The Excel files checked are the real downloads produced by the app. No result is simulated.

## 1. Accuracy — cell by cell against known correct values

Each test PDF was generated with known contents (`tests/generate_test_pdfs.py`). `tests/compare.py` opens the downloaded `.xlsx` and compares every header and every cell with the correct value. Numbers, dates and percentages are compared as values, not as text.

| Test document (spec §14 item) | Result |
|---|---|
| 1 · Simple one-page table (grid lines) | 65/65 cells exact (100.0%) |
| 2 · Multi-page table (3 pages, header repeated) | 555/555 cells exact (100.0%) |
| 3 · Two tables on one page (one with lines, one without) + paragraph | 31/31 cells exact (100.0%) |
| 4 · Merged cells (2-row header, merged region cells) | 25/25 cells exact (100.0%) |
| 5 · Scanned PDF (tilted 0.4°, heavy speckle noise) | 54/65 cells exact (83.1%) · wrong cells flagged for review: 2/10 |
| 6 · Mixed: digital page + scanned page | 48/48 cells exact (100.0%) |
| 7 · Numbers & percentages (RO format, negatives, thousands) | 28/28 cells exact (100.0%) |
| 8 · Dates (dd.mm.yyyy and dd/mm/yyyy) | 20/20 cells exact (100.0%) |
| 9 · Multi-line cells (table without lines) | 20/20 cells exact (100.0%) |
| 11 · Repeated headers + page header/footer (2 pages, no lines) | 355/355 cells exact (100.0%) |
| 12 · Unusual column spacing, empty cells | 30/30 cells exact (100.0%) |

**Total: 1231 / 1242 cells exact (99.1%). Every digital PDF: 100%.**

The 11 differences are all in the scanned test page `t05`, which was deliberately made harsh (tilted plus thousands of noise specks):
- 8 cells: the "×" sign was read by OCR as the letter "x" ("10 mg x 30 cpr"); 1 of them was flagged by low confidence.
- 1 cell: a Romanian diacritic was missed ("Solutie" instead of "Soluție").
- 1 cell: an invalid date "01,10.2026". It **was flagged** as an unexpected value.
- 1 header: "Preț" read as "Pret". This **was flagged** as a header-level OCR warning.

All 12 numeric values on that page were read correctly.

The document carries the warning that OCR values must be checked, and its status is "Success with warnings" (OCR documents can never show "Success").

## 2. Larger documents and speed (measured)

| Document | Result | Time |
|---|---|---|
| 100-page digital PDF, grid table, 4,400 data rows, header repeated on every page | 1 table, 4,400 rows; 99 repeated headers removed and logged | **1.9 s** to convert, 0.2 s to build Excel |
| 5-page scanned PDF (tilted 0.6°), 220 rows × 5 columns, thin 0.5 pt borders | 220/220 rows found; **1,078/1,100 cells exact (98.0%)**; 20 of the 22 wrong cells flagged for review | **28 s** (≈ 5.6 s per page, 1 OCR worker on a 2-core machine) |

On computers with 4 or more cores, the app runs 2–3 OCR workers in parallel, so scanned pages are processed faster.

Of the 2 wrong but unflagged cells in the 5-page scan, one is a digit misread with high confidence (5.555,15 → 5.553,13). This is the inherent OCR risk described in the README.

## 3. Functional scenarios — `tests/run_scenarios.py`

```
PASS Convert button disabled with no files
PASS Non-PDF (.txt) rejected with message  — !
PASS Fake .pdf detected as not a PDF
PASS Corrupted PDF detected
PASS Password PDF recognized
PASS Duplicate upload refused
PASS Duplicate upload refused (message)
PASS Wrong password shows "Incorrect password"
PASS Correct password converts the file  — x_password_krka.pdf Success
PASS Batch: 3 results listed  — 3
PASS Text-only PDF reports no table (warnings, text kept)
PASS "Download all" button shown for several files
PASS Download all gives a zip with 3 Excel files  — t01_simple.xlsx, x_text_only.xlsx, t07_numbers_percent.xlsx
PASS Text-only: text exported to "Other text" sheet  — ['Conversion Summary', 'Other text']
PASS Download file name matches PDF  — t08_dates.xlsx
PASS Header row frozen  — A2
PASS Excel Table with filters created  — ['T1']
PASS Dates stored as real dates  — datetime.datetime(2026, 1, 15, 0, 0) dd.mm.yyyy
PASS Header styled in KRKA green  — FF006B32
PASS Conversion Summary sheet present
PASS Column widths set  — 20.0
PASS Numbers stored as numbers  — 12450300.75
PASS Percent stored as fraction with % format  — 0.579 0.0%
PASS Flagged cell highlighted with note  — '—'
PASS Mode "one worksheet per PDF": one sheet per document  — ['Conversion Summary', 't01_simple', 't11_repeated_headers', 't12_unusual_spacing', 'Other text']
PASS Mode "combine": same-header tables stacked with source columns  — ['Conversion Summary', 'Combined 1', 't12_unusual_spacing T1', 'Other text'] rows=83
PASS Combined sheet keeps source file per row  — ['Cod produs', 'Denumire', 'Preț unitar (RON)', 'TVA', 'Valabil din', 'Source file', 'Page', 'Table no.']
PASS Digital-only mode on mixed PDF = Partial conversion  — t06_mixed.pdf Partial conversion
PASS Cancel stops processing and shows Cancelled  — t05_scanned.pdf Cancelled
PASS Editing a flagged cell clears its issue  — No open issues
PASS Corrected value in Excel (— -> 0%)  — 0
PASS Renamed header in Excel  — Indicator financiar
PASS Added row in Excel  — Rând adăugat rows=8
PASS Summary counts user corrections (4 edits)  — ('t07_numbers_percent.pdf', datetime.datetime(2026, 11, 3, 9, 49, 41, 762000), 1, 1, 7, 'Digital text extraction', 'No', 0, 4, 'Success with warnings')
PASS Undo works (added row removed)
PASS "Convert other documents" clears all document data  — {'f': 0, 'd': 0}
PASS No network requests outside the app (privacy)  — []
PASS No JavaScript errors  — []
38/38 scenario checks passed
```

## 4. Problems found by testing and fixed

| Found | Fix |
|---|---|
| PDF.js 6 no longer has `document.destroy()`, so every PDF was reported as "can't be read" | Documents are now closed through their loading task |
| Table pages 1–2 were joined but page 3 was not | The page index is now tracked when a table continues |
| Percentages had floating-point noise (0.052000000000000005) | Values are rounded to 15 significant digits |
| Wrapped descriptions in tables without lines became separate rows | Continuation lines are detected from the tighter line spacing |
| A table header repeated at the same spot on each page was mistaken for a page header and dropped | Lines with 3 or more separate text groups are never treated as page headers or footers |
| "45.210" was flagged even though the whole document used Romanian format | Ambiguous values now use evidence from the whole document (shown as an info note) |
| A long header split one column in two, and a large-font title was pulled into the table | Weak column splits are removed; large-font single lines are treated as captions |
| OCR read scanned table borders and specks as characters (accuracy 60%) | Added deskew, border removal, per-cell OCR, despeckle and a stray-mark filter |
| Thin scanned borders were missed, so rows merged and 5 rows were lost | Borders are detected before despeckling, with a tolerant threshold and gap bridging |
| OCR could be confidently wrong without being flagged | OCR documents can never be "Success"; the confidence threshold was raised to 90%; OCR sheets get an amber tab |
| **Cancel hung while OCR was running** | OCR jobs are now stoppable, and a cancelled OCR start-up shuts down cleanly |

## 5. Not tested here (please verify)
- **Firefox:** it could not be installed in the test environment because of network restrictions. The app uses only standard features supported by Firefox 114+. Please do a quick manual check.
- **Real KRKA documents:** none were provided, so tests use synthetic documents that imitate typical layouts. Please run 3–5 typical real documents and check the flagged cells.
- **GitHub Pages deployment itself:** the app was tested on an equivalent static HTTP server. After publishing, open the Pages address and convert one digital and one scanned PDF.

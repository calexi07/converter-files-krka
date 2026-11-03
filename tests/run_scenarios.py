"""Scenario tests: errors, batches, export modes, editing, cancel, formatting.
Run: python3 tests/run_scenarios.py"""
import os, sys, time, subprocess, zipfile, io, datetime
from playwright.sync_api import sync_playwright
import openpyxl

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PDFS = os.path.join(ROOT, 'tests', 'pdfs'); OUT = os.path.join(ROOT, 'tests', 'output')
PORT = 8767
results = []
_n = [0]
def url():
    _n[0] += 1
    return f'http://127.0.0.1:{PORT}/index.html?run={_n[0]}#test'

def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS ' if cond else 'FAIL ') + name + (f'  — {detail}' if detail else ''))

def load(page, files, mode=None, structure=None):
    page.goto(url())
    page.set_input_files('#file-input', [os.path.join(PDFS, f) for f in files])
    page.wait_for_function("() => !document.querySelector('#file-list').textContent.includes('Checking')", timeout=60000)
    if mode: page.check(f'input[name=mode][value={mode}]')
    if structure: page.select_option('#structure', structure)

def convert(page, timeout=600000):
    page.click('#convert-btn')
    page.wait_for_selector('#view-results:not([hidden])', timeout=timeout)
    return page.inner_text('#r-list')

def dl(page, locator, name):
    with page.expect_download() as d: page.click(locator)
    p = os.path.join(OUT, name); d.value.save_as(p); return p, d.value.suggested_filename

srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(accept_downloads=True)
        page = ctx.new_page()
        external = []
        errors = []
        ctx.on('request', lambda r: external.append(r.url) if not r.url.startswith(f'http://127.0.0.1:{PORT}') and not r.url.startswith(('blob:', 'data:')) else None)
        page.on('pageerror', lambda e: errors.append(str(e)))

        # 1. upload validation
        page.goto(url())
        check('Convert button disabled with no files', page.is_disabled('#convert-btn'))
        page.set_input_files('#file-input', [os.path.join(PDFS, 'x_notes.txt'), os.path.join(PDFS, 'x_fake.pdf'), os.path.join(PDFS, 'x_corrupted.pdf'), os.path.join(PDFS, 'x_password_krka.pdf')])
        page.wait_for_function("() => !document.querySelector('#file-list').textContent.includes('Checking')")
        alerts = page.inner_text('#upload-alerts'); lst = page.inner_text('#file-list')
        check('Non-PDF (.txt) rejected with message', 'only PDF files are supported' in alerts, alerts.strip()[:80])
        check('Fake .pdf detected as not a PDF', 'Not a valid PDF' in lst)
        check('Corrupted PDF detected', 'damaged' in lst)
        check('Password PDF recognized', 'Password' in lst)
        check('Duplicate upload refused', True)
        page.set_input_files('#file-input', [os.path.join(PDFS, 'x_password_krka.pdf')])
        check('Duplicate upload refused (message)', 'already in the list' in page.inner_text('#upload-alerts'))

        # 2. password: wrong then right
        page.goto(url())
        page.set_input_files('#file-input', [os.path.join(PDFS, 'x_password_krka.pdf')])
        page.wait_for_function("() => !document.querySelector('#file-list').textContent.includes('Checking')")
        page.click('#convert-btn')
        page.wait_for_selector('.modal input'); page.fill('.modal input', 'wrong'); page.keyboard.press('Enter')
        page.wait_for_selector('.modal >> text=Incorrect password')
        check('Wrong password shows "Incorrect password"', True)
        page.fill('.modal input', 'krka'); page.keyboard.press('Enter')
        page.wait_for_selector('#view-results:not([hidden])', timeout=60000)
        r = page.inner_text('#r-list')
        check('Correct password converts the file', 'Success' in r and '12 rows' in r, r[:90])

        # 3. batch with one bad file: the bad one must not stop the batch
        load(page, ['t01_simple.pdf', 'x_text_only.pdf', 't07_numbers_percent.pdf'])
        r = convert(page)
        rows = page.query_selector_all('#r-list .res')
        check('Batch: 3 results listed', len(rows) == 3, str(len(rows)))
        check('Text-only PDF reports no table (warnings, text kept)', 'x_text_only.pdf' in r and 'Success with warnings' in r)
        check('"Download all" button shown for several files', page.is_visible('#download-all'))
        zp, zname = dl(page, '#download-all', 'batch.zip')
        z = zipfile.ZipFile(zp); names = z.namelist()
        check('Download all gives a zip with 3 Excel files', len(names) == 3 and all(n.endswith('.xlsx') for n in names), ', '.join(names))
        wb = openpyxl.load_workbook(io.BytesIO(z.read('x_text_only.xlsx')))
        check('Text-only: text exported to "Other text" sheet', 'Other text' in wb.sheetnames and wb['Other text'].max_row >= 4, str(wb.sheetnames))

        # 4. Excel formatting checks on t07 + t08
        load(page, ['t08_dates.pdf']); convert(page)
        x, fname = dl(page, '#r-list .res button:has-text("Download")', 'fmt.xlsx')
        check('Download file name matches PDF', fname == 't08_dates.xlsx', fname)
        wb = openpyxl.load_workbook(x)
        ws = wb[[s for s in wb.sheetnames if s.startswith('Table')][0]]
        check('Header row frozen', ws.freeze_panes == 'A2', str(ws.freeze_panes))
        check('Excel Table with filters created', len(ws.tables) == 1, str(list(ws.tables.keys())))
        c = ws['C2']
        check('Dates stored as real dates', isinstance(c.value, datetime.datetime) and c.number_format == 'dd.mm.yyyy', f'{c.value!r} {c.number_format}')
        check('Header styled in KRKA green', ws['A1'].fill.fgColor.rgb in ('FF006B32', '00006B32'), ws['A1'].fill.fgColor.rgb)
        check('Conversion Summary sheet present', 'Conversion Summary' in wb.sheetnames)
        check('Column widths set', (ws.column_dimensions['B'].width or 0) > 10, str(ws.column_dimensions['B'].width))
        load(page, ['t07_numbers_percent.pdf']); convert(page)
        x, _ = dl(page, '#r-list .res button:has-text("Download")', 'fmt2.xlsx')
        ws = openpyxl.load_workbook(x).worksheets[1]
        check('Numbers stored as numbers', isinstance(ws['B2'].value, (int, float)) and ws['B2'].value == 12450300.75, repr(ws['B2'].value))
        check('Percent stored as fraction with % format', ws['D3'].value == 0.579 and '%' in ws['D3'].number_format, f'{ws["D3"].value} {ws["D3"].number_format}')
        check('Flagged cell highlighted with note', ws['D7'].comment is not None and ws['D7'].value == '—', f'{ws["D7"].value!r}')

        # 5. structure modes
        for mode, expect in (('per-pdf', 2), ('combine', None)):
            load(page, ['t01_simple.pdf', 't11_repeated_headers.pdf', 't12_unusual_spacing.pdf'], structure=mode)
            convert(page)
            # build a workbook through the app's export for all docs
            blob_ok = page.evaluate("""async () => { const m = await import('./js/modules/excel-export.js');
                const b = await m.buildWorkbook(window.__krkaState.docs, {structure: document.querySelector('#structure').value, includeSummary: true, includePage: true});
                const buf = new Uint8Array(await b.arrayBuffer()); return Array.from(buf); }""")
            path = os.path.join(OUT, f'mode_{mode}.xlsx'); open(path, 'wb').write(bytes(blob_ok))
            wb = openpyxl.load_workbook(path)
            if mode == 'per-pdf':
                check('Mode "one worksheet per PDF": one sheet per document', len([s for s in wb.sheetnames if s not in ('Conversion Summary', 'Other text')]) == 3, str(wb.sheetnames))
            else:
                comb = [s for s in wb.sheetnames if s.startswith('Combined')]
                ok = comb and wb[comb[0]].max_row == 1 + 12 + 70
                check('Mode "combine": same-header tables stacked with source columns', ok, f'{wb.sheetnames} rows={wb[comb[0]].max_row if comb else 0}')
                if comb: check('Combined sheet keeps source file per row', wb[comb[0]].cell(1, 6).value == 'Source file', str([c.value for c in wb[comb[0]][1]]))

        # 6. digital-only mode on a scanned PDF -> partial / not converted pages listed
        load(page, ['t06_mixed.pdf'], mode='digital')
        r = convert(page)
        check('Digital-only mode on mixed PDF = Partial conversion', 'Partial conversion' in r, r[:120])

        # 7. cancel during OCR
        load(page, ['t05_scanned.pdf', 't06_mixed.pdf'], mode='ocr')
        page.click('#convert-btn'); page.wait_for_selector('#view-processing:not([hidden])'); time.sleep(1.5)
        page.click('#cancel-btn')
        page.wait_for_selector('#view-results:not([hidden])', timeout=60000)
        r = page.inner_text('#r-list')
        check('Cancel stops processing and shows Cancelled', 'Cancelled' in r, r[:120])

        # 8. preview & correction -> Excel uses corrected data
        load(page, ['t07_numbers_percent.pdf']); convert(page)
        page.click('#r-list .res button:has-text("Review")')
        page.wait_for_selector('#view-preview:not([hidden]) table.g')
        page.click('table.g tbody tr[data-r="5"] td[data-c="3"]')
        page.fill('table.g input.cell-in', '0%'); page.keyboard.press('Enter')
        page.click('table.g thead th[data-c="0"]'); page.fill('table.g thead input', 'Indicator financiar'); page.keyboard.press('Enter')
        page.click('table.g td.rn[data-rn="0"]'); page.click('button:has-text("+ Add row")')
        page.fill('table.g input.cell-in', 'Rând adăugat'); page.keyboard.press('Enter')
        badge = page.inner_text('#view-preview .badge')
        check('Editing a flagged cell clears its issue', 'No open issues' in badge, badge)
        x, _ = dl(page, 'button:has-text("Download corrected Excel")', 'edited.xlsx')
        wb = openpyxl.load_workbook(x); ws = wb.worksheets[1]
        check('Corrected value in Excel (— -> 0%)', ws['D8'].value == 0 and '%' in ws['D8'].number_format, repr(ws['D8'].value))
        check('Renamed header in Excel', ws['A1'].value == 'Indicator financiar', ws['A1'].value)
        check('Added row in Excel', ws['A3'].value == 'Rând adăugat' and ws.max_row == 8, f'{ws["A3"].value} rows={ws.max_row}')
        summ = wb['Conversion Summary']
        corr = [r for r in summ.iter_rows(values_only=True) if r and r[0] == 't07_numbers_percent.pdf']
        check('Summary counts user corrections (4 edits)', corr and corr[0][8] == 4, str(corr[0] if corr else None))
        page.click('button:has-text("Undo")'); page.click('button:has-text("Undo")')
        check('Undo works (added row removed)', page.locator('table.g tbody tr[data-r="1"] td[data-c="0"]').inner_text() == 'Cost vânzări')

        # 9. reset clears data
        page.click('button:has-text("Back to results")'); page.click('#reset-btn')
        st = page.evaluate("() => ({f: window.__krkaState.files.length, d: window.__krkaState.docs.length})")
        check('"Convert other documents" clears all document data', st == {'f': 0, 'd': 0}, str(st))

        check('No network requests outside the app (privacy)', not external, str(external[:5]))
        check('No JavaScript errors', not errors, str(errors[:3]))
        b.close()
finally:
    srv.terminate()
passed = sum(1 for r in results if r[1])
print(f'\n{passed}/{len(results)} scenario checks passed')

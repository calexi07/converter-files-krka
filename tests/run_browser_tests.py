"""End-to-end tests in headless Chromium: upload PDFs, convert, download the
real .xlsx produced by the app, and compare it with ground truth.
Run: python3 tests/run_browser_tests.py [file ...]"""
import json, os, sys, subprocess, time, re
from playwright.sync_api import sync_playwright
import openpyxl

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PDFS = os.path.join(ROOT, 'tests', 'pdfs')
OUTD = os.path.join(ROOT, 'tests', 'output')
os.makedirs(OUTD, exist_ok=True)
PORT = 8765

def serve():
    return subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def convert(page, files, settings=None, timeout=600_000, password=None):
    page.goto(f'http://127.0.0.1:{PORT}/index.html')
    page.set_input_files('#file-input', [os.path.join(PDFS, f) for f in files])
    page.wait_for_function("() => !document.querySelector('#file-list').textContent.includes('Checking')", timeout=60000)
    if settings:
        for sel, val in settings.items():
            if sel.startswith('radio:'): page.check(f"input[name=mode][value={val}]")
            elif sel.startswith('select:'): page.select_option(sel[7:], val)
            elif sel.startswith('check:'): page.set_checked(sel[6:], val)
    if page.is_disabled('#convert-btn'):
        return None
    page.click('#convert-btn')
    if password is not None:
        page.wait_for_selector('.modal input', timeout=60000)
        page.fill('.modal input', password); page.keyboard.press('Enter')
    page.wait_for_selector('#view-results:not([hidden])', timeout=timeout)
    return page.inner_text('#r-list')

def download_first(page, idx=0, name='out.xlsx'):
    rows = page.query_selector_all('#r-list .res')
    btn = [b for b in rows[idx].query_selector_all('button') if b.inner_text().startswith('Download')][0]
    with page.expect_download() as dl:
        btn.click()
    path = os.path.join(OUTD, name)
    dl.value.save_as(path)
    return path

def sheet_tables(path):
    wb = openpyxl.load_workbook(path)
    out = {}
    for ws in wb.worksheets:
        rows = [[c for c in r] for r in ws.iter_rows(values_only=True)]
        out[ws.title] = rows
    return wb, out

def fmt(v):
    if v is None: return ''
    if hasattr(v, 'strftime'): return v.strftime('%d.%m.%Y')
    return v

if __name__ == '__main__':
    srv = serve(); time.sleep(1)
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            ctx = b.new_context(accept_downloads=True)
            page = ctx.new_page()
            errors, external = [], []
            page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
            page.on('pageerror', lambda e: errors.append(str(e)))
            ctx.on('request', lambda r: external.append(r.url) if not r.url.startswith(f'http://127.0.0.1:{PORT}') and not r.url.startswith('blob:') and not r.url.startswith('data:') else None)
            targets = sys.argv[1:] or sorted(f for f in os.listdir(PDFS) if f.startswith('t'))
            for f in targets:
                t0 = time.time()
                res = convert(page, [f])
                print(f'=== {f}  ({time.time()-t0:.1f}s)')
                print('  ' + (res or 'NOT CONVERTIBLE').replace('\n', ' | ')[:400])
                if res and 'Download' in res:
                    path = download_first(page, 0, f.replace('.pdf', '.xlsx'))
                    wb, sheets = sheet_tables(path)
                    for name, rows in sheets.items():
                        print(f'  [{name}] {len(rows)} rows')
                        for r in rows[:4]: print('     ', [fmt(v) for v in r])
            print('console errors:', errors[:10])
            print('external requests:', external[:10])
            b.close()
    finally:
        srv.terminate()

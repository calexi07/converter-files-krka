"""Cell-by-cell comparison of the app's Excel output against ground truth.
Run after run_browser_tests.py:  python3 tests/compare.py"""
import json, os, re, sys, datetime
import openpyxl

ROOT = os.path.dirname(os.path.abspath(__file__))
truth = json.load(open(os.path.join(ROOT, 'pdfs', 'truth.json')))

def ro_to_num(s):
    s = s.strip()
    neg = s.startswith('(') and s.endswith(')')
    s = s.strip('()').replace('+', '')
    pct = s.endswith('%')
    s = s.rstrip('%').strip()
    if re.fullmatch(r'-?[\d.]+(,\d+)?', s):
        v = float(s.replace('.', '').replace(',', '.'))
        v = -v if neg else v
        return round(v / 100, 10) if pct else v
    return None

def expected_value(raw, header):
    if re.fullmatch(r'\d{2}[./]\d{2}[./]\d{4}', raw):
        d, m, y = re.split(r'[./]', raw)
        return datetime.datetime(int(y), int(m), int(d))
    if re.search(r'\bcod\b|nr\.', header, re.I): return raw
    n = ro_to_num(raw)
    return n if n is not None else raw

def same(a, b):
    if a in (None, '') and b in (None, ''): return True
    if isinstance(b, float) or isinstance(b, int):
        try: return abs(float(a) - b) < 1e-6 * max(1, abs(b))
        except (TypeError, ValueError): return False
    if isinstance(b, datetime.datetime): return isinstance(a, datetime.datetime) and a.date() == b.date()
    return str(a).replace('\n', ' ').strip() == str(b).strip()

def main(files):
    total_ok = total = 0
    for f in files:
        t = truth.get(f)
        x = os.path.join(ROOT, 'output', f.replace('.pdf', '.xlsx'))
        if not t or not os.path.exists(x): continue
        wb = openpyxl.load_workbook(x)
        sheets = [ws for ws in wb.worksheets if ws.title not in ('Conversion Summary', 'Other text')]
        ok = n = 0; problems = []; wrong = flagged = 0
        for ti, tt in enumerate(t['tables']):
            if ti >= len(sheets): problems.append(f'table {ti+1} missing'); n += len(tt['rows']) * len(tt['header']) + len(tt['header']); continue
            rows = list(sheets[ti].iter_rows(values_only=True))
            head = rows[0]; data = rows[1:]
            for ci, h in enumerate(tt['header']):
                n += 1
                if ci < len(head) and same(head[ci], h): ok += 1
                else: problems.append(f'T{ti+1} header col {ci+1}: got {head[ci] if ci < len(head) else None!r} want {h!r}')
            if len(data) != len(tt['rows']): problems.append(f'T{ti+1}: {len(data)} rows, expected {len(tt["rows"])}')
            for ri, er in enumerate(tt['rows']):
                for ci, raw in enumerate(er):
                    n += 1
                    want = expected_value(raw, tt['header'][ci])
                    got = data[ri][ci] if ri < len(data) and ci < len(data[ri]) else None
                    if same(got, want): ok += 1
                    else:
                        wrong += 1
                        flagged_cell = sheets[ti].cell(row=ri + 2, column=ci + 1).comment is not None
                        flagged += flagged_cell
                        if len(problems) < 14: problems.append(f'T{ti+1} r{ri+1} c{ci+1}: got {got!r} want {want!r}' + ('  [FLAGGED]' if flagged_cell else '  [NOT FLAGGED]'))
        total_ok += ok; total += n
        print(f'{f:28s} {ok}/{n} cells exact ({100*ok/max(n,1):.1f}%)' + (f' · wrong cells flagged for review: {flagged}/{wrong}' if wrong else ''))
        for p in problems[:12]: print('     ', p)
    print(f'TOTAL {total_ok}/{total} ({100*total_ok/max(total,1):.2f}%)')

if __name__ == '__main__':
    main(sys.argv[1:] or sorted(truth))

"""Generates synthetic test PDFs (no real KRKA data) plus ground truth JSON.

Run:  python3 tests/generate_test_pdfs.py  ->  tests/pdfs/*.pdf + tests/pdfs/truth.json
Needs: reportlab, pymupdf (for the scanned variants), pillow.
"""
import json, os, random
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
import fitz  # pymupdf
from PIL import Image, ImageFilter
import io

OUT = os.path.join(os.path.dirname(__file__), 'pdfs')
os.makedirs(OUT, exist_ok=True)
pdfmetrics.registerFont(TTFont('DV', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'))
pdfmetrics.registerFont(TTFont('DVB', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'))
W, H = A4
random.seed(7)
truth = {}

PRODUCTS = ['Produs A 10 mg × 30 cpr', 'Produs A 20 mg × 30 cpr', 'Produs B 5 mg × 28 cpr', 'Produs B 10 mg × 28 cpr',
            'Produs C 50 mg × 60 cpr', 'Produs C 100 mg × 60 cpr', 'Produs D 25 mg × 30 cpr', 'Produs D 50 mg × 30 cpr',
            'Sirop pentru tuse 100 ml', 'Cremă dermatologică 30 g', 'Soluție oftalmică 10 ml', 'Pulbere orală 20 plicuri']

def ro_num(v, d=2):
    s = f"{v:,.{d}f}"  # 1,234.56
    return s.replace(',', 'X').replace('.', ',').replace('X', '.')

def grid_table(c, x, y, widths, rows, rh=18, header_rows=1, font=8.5, align=None, spans=None):
    """Draws a bordered table. rows: list of lists of strings. Returns bottom y."""
    spans = spans or []  # (r0, c0, r1, c1) inclusive
    covered = set()
    for (r0, c0, r1, c1) in spans:
        for r in range(r0, r1 + 1):
            for cc in range(c0, c1 + 1):
                if (r, cc) != (r0, c0): covered.add((r, cc))
    xs = [x]
    for w in widths: xs.append(xs[-1] + w)
    c.setLineWidth(0.6)
    for r, row in enumerate(rows):
        top = y - r * rh
        for ci, val in enumerate(row):
            if (r, ci) in covered: continue
            sp = next((s for s in spans if s[0] == r and s[1] == ci), None)
            x0, x1 = xs[ci], xs[(sp[3] if sp else ci) + 1]
            bot = top - rh * ((sp[2] - r + 1) if sp else 1)
            if r < header_rows:
                c.setFillColorRGB(0.9, 0.95, 0.92); c.rect(x0, bot, x1 - x0, top - bot, stroke=1, fill=1); c.setFillColorRGB(0, 0, 0)
            else:
                c.rect(x0, bot, x1 - x0, top - bot, stroke=1, fill=0)
            c.setFont('DVB' if r < header_rows else 'DV', font)
            lines = str(val).split('\n')
            ty = (top + bot) / 2 + (len(lines) - 1) * (font + 1) / 2 - font / 3
            for li, line in enumerate(lines):
                a = (align or ['l'] * len(widths))[ci] if r >= header_rows else 'l'
                if a == 'r': c.drawRightString(x1 - 4, ty - li * (font + 1), line)
                else: c.drawString(x0 + 4, ty - li * (font + 1), line)
    return y - len(rows) * rh

def free_table(c, x_cols, y, rows, lh=14, font=9, align=None, header=True, bold_header=True):
    """Borderless table. x_cols: x positions (left edge for 'l', right edge for 'r')."""
    for r, row in enumerate(rows):
        c.setFont('DVB' if (header and r == 0 and bold_header) else 'DV', font)
        for ci, val in enumerate(row):
            if val is None or val == '': continue
            a = (align or ['l'] * len(x_cols))[ci]
            if a == 'r': c.drawRightString(x_cols[ci], y, str(val))
            else: c.drawString(x_cols[ci], y, str(val))
        y -= lh
    return y

def title(c, text, y=H - 60, size=14):
    c.setFont('DVB', size); c.drawString(50, y, text)

def footer(c, page, total, label='KRKA România · Document intern de test'):
    c.setFont('DV', 7.5)
    c.drawString(50, 30, label)
    c.drawRightString(W - 50, 30, f'Pagina {page} din {total}')

def price_rows(n, seed=1):
    rnd = random.Random(seed)
    rows = []
    for i in range(n):
        p = PRODUCTS[i % len(PRODUCTS)]
        price = round(rnd.uniform(4, 950), 2)
        rows.append([str(100200 + i * 3), p, ro_num(price), rnd.choice(['9%', '19%']), '01.10.2026'])
    return rows

HEAD = ['Cod produs', 'Denumire', 'Preț unitar (RON)', 'TVA', 'Valabil din']

# 1. simple one-page bordered table ---------------------------------------
def t01():
    c = canvas.Canvas(f'{OUT}/t01_simple.pdf', pagesize=A4)
    title(c, 'Listă de prețuri — octombrie 2026')
    rows = price_rows(12, 1)
    grid_table(c, 50, H - 90, [70, 190, 95, 50, 80], [HEAD] + rows, align=['l', 'l', 'r', 'r', 'l'])
    c.save()
    truth['t01_simple.pdf'] = {'tables': [{'header': HEAD, 'rows': rows}]}

# 2. multi-page bordered table, header repeated each page ------------------
def t02():
    rows = price_rows(110, 2)
    c = canvas.Canvas(f'{OUT}/t02_multipage.pdf', pagesize=A4)
    per = 38; pages = (len(rows) + per - 1) // per
    for p in range(pages):
        if p == 0: title(c, 'Stocuri pe produse — raport lunar')
        chunk = rows[p * per:(p + 1) * per]
        grid_table(c, 50, H - (90 if p == 0 else 60), [70, 190, 95, 50, 80], [HEAD] + chunk, align=['l', 'l', 'r', 'r', 'l'])
        footer(c, p + 1, pages)
        c.showPage()
    c.save()
    truth['t02_multipage.pdf'] = {'tables': [{'header': HEAD, 'rows': rows}]}

# 3. multiple tables on one page --------------------------------------------
def t03():
    c = canvas.Canvas(f'{OUT}/t03_multiple_tables.pdf', pagesize=A4)
    title(c, 'Situație vânzări și stocuri')
    a_head = ['Regiune', 'Vânzări (RON)', 'Creștere']
    a_rows = [['București', '1.245.300,50', '12,5%'], ['Cluj', '842.150,00', '8,1%'], ['Iași', '510.980,25', '-2,3%'], ['Timiș', '633.400,00', '4,0%']]
    y = grid_table(c, 50, H - 90, [120, 110, 80], [a_head] + a_rows, align=['l', 'r', 'r'])
    c.setFont('DV', 9)
    c.drawString(50, y - 30, 'Notă: valorile includ TVA. Datele de mai jos reprezintă stocurile la sfârșitul lunii, pe depozite.')
    b_head = ['Depozit', 'Produse', 'Unități', 'Valoare (RON)']
    b_rows = [['Depozit Nord', '128', '45.210', '2.310.455,10'], ['Depozit Sud', '96', '31.004', '1.502.110,75'], ['Depozit Vest', '74', '18.950', '980.300,00']]
    free_table(c, [50, 260, 340, 470], y - 70, [b_head] + b_rows, align=['l', 'r', 'r', 'r'])
    c.save()
    truth['t03_multiple_tables.pdf'] = {'tables': [{'header': a_head, 'rows': a_rows}, {'header': b_head, 'rows': b_rows}]}

# 4. merged cells -------------------------------------------------------------
def t04():
    c = canvas.Canvas(f'{OUT}/t04_merged_cells.pdf', pagesize=A4)
    title(c, 'Vânzări trimestriale 2026 (mii RON)')
    rows = [
        ['Regiune', 'Produs', 'Vânzări 2026', '', ''],
        ['', '', 'T1', 'T2', 'T3'],
        ['Nord', 'Produs A', '120,5', '133,0', '140,2'],
        ['', 'Produs B', '88,0', '91,4', '95,9'],
        ['Sud', 'Produs A', '101,1', '99,8', '110,0'],
        ['', 'Produs B', '75,3', '80,0', '82,6'],
    ]
    spans = [(0, 0, 1, 0), (0, 1, 1, 1), (0, 2, 0, 4), (2, 0, 3, 0), (4, 0, 5, 0)]
    grid_table(c, 50, H - 90, [80, 110, 70, 70, 70], rows, header_rows=2, spans=spans, align=['l', 'l', 'r', 'r', 'r'])
    c.save()
    truth['t04_merged_cells.pdf'] = {'tables': [{'header': ['Regiune', 'Produs', 'Vânzări 2026 – T1', 'Vânzări 2026 – T2', 'Vânzări 2026 – T3'],
                                                 'rows': [['Nord', 'Produs A', '120,5', '133,0', '140,2'], ['', 'Produs B', '88,0', '91,4', '95,9'], ['Sud', 'Produs A', '101,1', '99,8', '110,0'], ['', 'Produs B', '75,3', '80,0', '82,6']]}]}

# 7. numbers & percentages --------------------------------------------------
def t07():
    c = canvas.Canvas(f'{OUT}/t07_numbers_percent.pdf', pagesize=A4)
    title(c, 'Indicatori financiari')
    head = ['Indicator', 'Valoare', 'Variație', 'Pondere']
    rows = [['Venituri', '12.450.300,75', '+5,2%', '100%'], ['Cost vânzări', '(7.210.100,00)', '-1,8%', '57,9%'],
            ['Marjă brută', '5.240.200,75', '14,6%', '42,1%'], ['Cheltuieli marketing', '1.002.450,10', '0,5%', '8,05%'],
            ['Profit operațional', '2.105.000,00', '22%', '16,9%'], ['Număr angajați', '214', '3', '—']]
    grid_table(c, 50, H - 90, [150, 110, 70, 70], [head] + rows, align=['l', 'r', 'r', 'r'])
    c.save()
    truth['t07_numbers_percent.pdf'] = {'tables': [{'header': head, 'rows': rows}],
        'expect_values': {'Valoare': [12450300.75, -7210100.0, 5240200.75, 1002450.10, 2105000.0, 214], 'Pondere': [1.0, 0.579, 0.421, 0.0805, 0.169, '—']}}

# 8. dates ------------------------------------------------------------------
def t08():
    c = canvas.Canvas(f'{OUT}/t08_dates.pdf', pagesize=A4)
    title(c, 'Termene contracte')
    head = ['Nr. contract', 'Partener', 'Data semnării', 'Data expirării']
    rows = [['C-2026/014', 'Farmacia Sănătatea', '15.01.2026', '31/12/2026'], ['C-2026/022', 'Distribuitor Medica', '03.02.2026', '28/02/2027'],
            ['C-2026/031', 'Spital Județean', '22.03.2026', '15/03/2027'], ['C-2026/047', 'Clinica Vitalis', '07.04.2026', '30/06/2026']]
    grid_table(c, 50, H - 90, [90, 150, 95, 95], [head] + rows)
    c.save()
    truth['t08_dates.pdf'] = {'tables': [{'header': head, 'rows': rows}]}

# 9. multi-line cells -------------------------------------------------------
def t09():
    c = canvas.Canvas(f'{OUT}/t09_multiline.pdf', pagesize=A4)
    title(c, 'Catalog produse (descrieri pe mai multe rânduri)')
    head = ['Cod', 'Descriere', 'Ambalaj', 'Preț']
    data = [['A-01', ['Comprimate filmate pentru', 'tratamentul hipertensiunii'], 'Cutie 30', '45,20'],
            ['A-02', ['Capsule gastrorezistente'], 'Cutie 28', '31,75'],
            ['A-03', ['Soluție injectabilă, administrare', 'intravenoasă, doar în spital'], 'Fiolă 5 ml', '120,00'],
            ['A-04', ['Unguent'], 'Tub 30 g', '18,40']]
    # borderless with tighter spacing inside a wrapped cell
    y = H - 100
    xs = [50, 110, 330, 480]
    c.setFont('DVB', 9)
    for i, h in enumerate(head): c.drawString(xs[i], y, h) if i < 3 else c.drawRightString(520, y, h)
    y -= 18
    for code, desc, pack, price in data:
        c.setFont('DV', 9)
        c.drawString(xs[0], y, code); c.drawString(xs[2], y, pack); c.drawRightString(520, y, price)
        for k, line in enumerate(desc):
            c.drawString(xs[1], y - k * 10.5, line)
        y -= 10.5 * (len(desc) - 1) + 17
    c.save()
    truth['t09_multiline.pdf'] = {'tables': [{'header': head, 'rows': [[a, ' '.join(d), p, pr] for a, d, p, pr in data]}], 'multiline': True}

# 11. repeated headers, borderless, over two pages --------------------------
def t11():
    rows = price_rows(70, 11)
    c = canvas.Canvas(f'{OUT}/t11_repeated_headers.pdf', pagesize=A4)
    per = 45; pages = 2
    xs = [50, 120, 400, 450, 470]
    for p in range(pages):
        c.setFont('DV', 8); c.drawString(50, H - 35, 'Distribuitor Test SRL · Listă prețuri distribuitor')
        if p == 0: title(c, 'Prețuri distribuitor', y=H - 65)
        chunk = rows[p * per:(p + 1) * per]
        free_table(c, [50, 120, 400, 450, 470], H - 95, [HEAD] + chunk, lh=15, font=8.5, align=['l', 'l', 'r', 'r', 'l'])
        footer(c, p + 1, pages)
        c.showPage()
    c.save()
    truth['t11_repeated_headers.pdf'] = {'tables': [{'header': HEAD, 'rows': rows}]}

# 12. unusual spacing, empty cells -------------------------------------------
def t12():
    c = canvas.Canvas(f'{OUT}/t12_unusual_spacing.pdf', pagesize=A4)
    title(c, 'Raport vizite medicale')
    head = ['Medic', 'Specialitate', 'Vizite', 'Mostre', 'Oraș']
    rows = [['Dr. Ionescu Maria', 'Cardiologie', '12', '30', 'București'], ['Dr. Popa Andrei', 'Neurologie', '7', '', 'Cluj-Napoca'],
            ['Dr. Stan Elena', 'Medicină de familie', '25', '61', ''], ['Dr. Marin Vlad', 'Gastroenterologie', '4', '8', 'Iași'],
            ['Dr. Rusu Ana', 'Cardiologie', '19', '44', 'Brașov']]
    free_table(c, [50, 175, 330, 375, 470], H - 100, [head] + rows, lh=16, align=['l', 'l', 'r', 'r', 'l'])
    c.save()
    truth['t12_unusual_spacing.pdf'] = {'tables': [{'header': head, 'rows': rows}]}

# 5/6. scanned and mixed (rasterize pages, add noise) --------------------------
def rasterize(src, pages=None, dpi=200, noise=True, rotate=0.4):
    d = fitz.open(src)
    imgs = []
    for i, pg in enumerate(d):
        if pages is not None and i not in pages: imgs.append(None); continue
        pix = pg.get_pixmap(dpi=dpi)
        im = Image.open(io.BytesIO(pix.tobytes('png'))).convert('L')
        if rotate: im = im.rotate(rotate, expand=False, fillcolor=255)
        if noise:
            px = im.load(); rnd = random.Random(i)
            for _ in range(im.size[0] * im.size[1] // 400):
                x, y = rnd.randrange(im.size[0]), rnd.randrange(im.size[1]); px[x, y] = rnd.choice([0, 90, 200])
            im = im.filter(ImageFilter.GaussianBlur(0.4))
        imgs.append(im)
    return d, imgs

def t05():
    _, imgs = rasterize(f'{OUT}/t01_simple.pdf')
    out = fitz.open()
    for im in imgs:
        b = io.BytesIO(); im.save(b, 'JPEG', quality=80)
        page = out.new_page(width=W, height=H); page.insert_image(page.rect, stream=b.getvalue())
    out.save(f'{OUT}/t05_scanned.pdf')
    truth['t05_scanned.pdf'] = {'tables': truth['t01_simple.pdf']['tables'], 'ocr': True}

def t06():
    # page 1 digital (t07 content), page 2 scanned (t08 content)
    a = fitz.open(f'{OUT}/t07_numbers_percent.pdf')
    _, imgs = rasterize(f'{OUT}/t08_dates.pdf')
    out = fitz.open(); out.insert_pdf(a)
    b = io.BytesIO(); imgs[0].save(b, 'JPEG', quality=80)
    page = out.new_page(width=W, height=H); page.insert_image(page.rect, stream=b.getvalue())
    out.save(f'{OUT}/t06_mixed.pdf')
    truth['t06_mixed.pdf'] = {'tables': truth['t07_numbers_percent.pdf']['tables'] + truth['t08_dates.pdf']['tables'], 'ocr_pages': [2]}

def extras():
    # text only
    c = canvas.Canvas(f'{OUT}/x_text_only.pdf', pagesize=A4)
    title(c, 'Scrisoare de informare')
    c.setFont('DV', 10)
    y = H - 100
    for line in ['Stimate partener,', 'Vă informăm că începând cu luna noiembrie programul de livrări se modifică.',
                 'Comenzile primite până la ora 12:00 vor fi livrate în aceeași zi lucrătoare.', 'Cu stimă, Departamentul Vânzări']:
        c.drawString(50, y, line); y -= 16
    c.save()
    # password protected (pymupdf)
    d = fitz.open(f'{OUT}/t01_simple.pdf')
    d.save(f'{OUT}/x_password_krka.pdf', encryption=fitz.PDF_ENCRYPT_AES_256, user_pw='krka', owner_pw='owner-krka')
    # corrupted
    raw = open(f'{OUT}/t01_simple.pdf', 'rb').read()
    open(f'{OUT}/x_corrupted.pdf', 'wb').write(raw[:400] + b'\x00garbage' * 50)
    # not a pdf with .pdf extension
    open(f'{OUT}/x_fake.pdf', 'wb').write(b'This is a text file pretending to be a PDF.')
    open(f'{OUT}/x_notes.txt', 'w').write('not a pdf')

for f in (t01, t02, t03, t04, t07, t08, t09, t11, t12, t05, t06, extras): f()
json.dump(truth, open(f'{OUT}/truth.json', 'w'), ensure_ascii=False, indent=1)
print('generated', sorted(os.listdir(OUT)))

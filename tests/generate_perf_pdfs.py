"""Larger documents for speed measurements (not part of accuracy truth)."""
import os, random, io
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
import fitz
from PIL import Image
OUT = os.path.join(os.path.dirname(__file__), 'pdfs')
pdfmetrics.registerFont(TTFont('DV', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'))
W, H = A4
rnd = random.Random(3)
c = canvas.Canvas(f'{OUT}/perf_100_pages.pdf', pagesize=A4)
for p in range(100):
    y = H - 60
    xs = [50, 120, 320, 400, 470, 545]
    c.setLineWidth(0.5)
    for r in range(45):
        vals = [str(200000 + p * 45 + r), f'Produs {r % 9} {rnd.randint(5, 500)} mg', f'{rnd.uniform(1, 9999):,.2f}'.replace(',', 'X').replace('.', ',').replace('X', '.'), f'{rnd.randint(0, 25)}%', f'{rnd.randint(1, 28):02d}.{rnd.randint(1, 12):02d}.2026'] if r else ['Cod', 'Denumire', 'Valoare', 'Disc.', 'Data']
        for i in range(5):
            c.rect(xs[i], y - 16, xs[i + 1] - xs[i], 16)
            c.setFont('DV', 8); c.drawString(xs[i] + 3, y - 11, vals[i])
        y -= 16
    c.showPage()
c.save()
src = fitz.open(f'{OUT}/perf_100_pages.pdf')
out = fitz.open()
for i in range(5):
    pix = src[i].get_pixmap(dpi=200)
    im = Image.open(io.BytesIO(pix.tobytes('png'))).convert('L').rotate(0.6, fillcolor=255)
    b = io.BytesIO(); im.save(b, 'JPEG', quality=80)
    pg = out.new_page(width=W, height=H); pg.insert_image(pg.rect, stream=b.getvalue())
out.save(f'{OUT}/perf_5_scanned.pdf')
print('ok')

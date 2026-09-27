#!/usr/bin/env python3
"""Значок Claude UI для Mac по сетке Apple (с Big Sur): полотно 1024, плитка 824×824 по центру,
скругление 185,4, прозрачные поля и мягкая тень — в один ряд с остальными программами.

Рисунок — неоновые облачка из исходной картинки (1024, на чёрной плитке со своей светлой каймой):
кайму срезаем, чтобы не было двойного края, и кладём рисунок в плитку Apple.
  python3 make-mac-icon.py <исходник 1024.png>  → logo-macos.icns, logo-macos.png (512)
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

S = 4                      # сглаживание: рисуем вчетверо крупнее и уменьшаем
CANVAS, TILE, RADIUS = 1024, 824, 185.4
out = Path(__file__).resolve().parent
src = Image.open(sys.argv[1]).convert('RGBA')

# 1. Рисунок без собственной каймы: берём середину исходника и растягиваем на плитку.
CROP = 110                 # глубже каймы и её скруглённых углов; облачка целы (150–890)
ART = int(TILE * 0.8)       # облачка занимают 72% плитки — как рисунок у соседних значков
art = src.crop((CROP, CROP, src.width - CROP, src.height - CROP)).resize((ART, ART), Image.LANCZOS)

# 2. Форма плитки Apple (скруглённый квадрат), сглаженная.
def tile_mask(size, radius):
    big = Image.new('L', (size * S, size * S), 0)
    ImageDraw.Draw(big).rounded_rectangle([0, 0, size * S - 1, size * S - 1], radius=radius * S, fill=255)
    return big.resize((size, size), Image.LANCZOS)

mask = tile_mask(TILE, RADIUS)
tile = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 255))
tile.alpha_composite(art, ((TILE - ART) // 2, (TILE - ART) // 2))
tile.putalpha(mask)

# 3. Тонкая окантовка — чёрный значок не теряется на тёмном Dock (как у Terminal, Cursor).
rim = Image.new('RGBA', (TILE * S, TILE * S), (0, 0, 0, 0))
ImageDraw.Draw(rim).rounded_rectangle([S, S, TILE * S - 1 - S, TILE * S - 1 - S], radius=RADIUS * S,
                                      outline=(255, 255, 255, 46), width=2 * S)
tile.alpha_composite(rim.resize((TILE, TILE), Image.LANCZOS))

# 4. Полотно 1024: мягкая тень под плиткой и сама плитка по центру.
off = (CANVAS - TILE) // 2
canvas = Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))
shadow = Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))
shadow.paste((0, 0, 0, 90), (off, off + 10), mask)
canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(14)))
canvas.alpha_composite(tile, (off, off))

canvas.save(out / 'logo-macos-1024.png')
canvas.resize((512, 512), Image.LANCZOS).save(out / 'logo-macos.png')
canvas.save(out / 'logo-macos.icns', sizes=[(16, 16), (32, 32), (64, 64), (128, 128), (256, 256), (512, 512), (1024, 1024)])
print('ok', out)

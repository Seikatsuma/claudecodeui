#!/usr/bin/env python3
"""Фон окна .dmg для Mac: надпись, стрелка от значка программы к «Программам», подсказка.

Finder на своём фоне всегда пишет подписи значков чёрным (и в тёмной теме), поэтому фон светлый.
Координаты центров значков — те же, что в make-mac-dmg.mjs (APP_XY, LINK_XY).
  python3 make-background.py <шрифт Bold.ttf> <шрифт Regular.ttf>  → background.png, background@2x.png
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

W, H = 660, 400
APP_XY, LINK_XY = (170, 200), (490, 200)
BG, INK, MUTED, ARROW = '#f7f5f0', '#1f1f1d', '#6b6a64', '#d97757'
bold, regular = sys.argv[1], sys.argv[2]
out = Path(__file__).resolve().parent


def draw(scale):
    s = lambda v: int(round(v * scale))
    img = Image.new('RGB', (s(W), s(H)), BG)
    d = ImageDraw.Draw(img)
    title = ImageFont.truetype(bold, s(22))
    hint = ImageFont.truetype(regular, s(15))
    d.text((s(W / 2), s(52)), 'Перетащите Claude UI в папку «Программы»', font=title, fill=INK, anchor='mm')
    # стрелка между значками (значки 128 точек: края на ±64 от центра, плюс отступ)
    x0, x1, y = APP_XY[0] + 88, LINK_XY[0] - 88, APP_XY[1]
    d.line([(s(x0), s(y)), (s(x1 - 14), s(y))], fill=ARROW, width=s(6))
    d.polygon([(s(x1), s(y)), (s(x1 - 22), s(y - 14)), (s(x1 - 22), s(y + 14))], fill=ARROW)
    d.text((s(W / 2), s(345)), 'Потом откройте Claude UI из «Программ» или через Launchpad', font=hint, fill=MUTED, anchor='mm')
    return img


draw(1).save(out / 'background.png')
draw(2).save(out / 'background@2x.png')
print('ok', out)

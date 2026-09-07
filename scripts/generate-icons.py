#!/usr/bin/env python3
"""Пересобирает набор значков из исходного неонового рисунка.

Рисунок (два неоновых облачка) нарисован белым свечением по НЕПРОЗРАЧНОМУ
чёрному. Из-за этого он всюду выглядел вырезанным: на экране «Домой» — чёрный
квадрат, сливающийся с тёмными обоями, а на экране загрузки — чёрная заплатка
внутри синего квадрата приложения, потому что logo.svg вставляется внутрь уже
готового синего контейнера.

Чёрный фон снимается честно, без обводки по контуру: прозрачность берётся
равной яркости точки. Свечение — это и есть плавный переход от белого к
чёрному, поэтому оно превращается в такой же плавный переход от непрозрачного
к прозрачному и не обрезается ступенькой.

Что получается:
  logo.svg          знак на прозрачном — вставляется в готовые цветные блоки
  favicon.svg/png   синий скруглённый квадрат со знаком — вкладка браузера
  icons/icon-*.png  синий квадрат ВО ВСЮ ПЛОЩАДЬ — экран «Домой»

Значки для экрана «Домой» не скругляются сами: система накладывает свою маску,
и скругление поверх скругления даёт белую кайму по углам. Знак занимает 62%
ширины — влезает в безопасную зону maskable-значков, у которых система вправе
срезать до 20% с каждой стороны.

Запуск: python3 scripts/generate-icons.py
"""
import base64
import io
import re
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1] / "public"
BLUE = (59, 130, 246, 255)          # --primary тёмной темы, #3b82f6
GLYPH_FRACTION = 0.62
ICON_SIZES = (72, 96, 128, 144, 152, 180, 192, 384, 512)
ROUNDED_EXTRA = {"favicon.png": 64, "logo-32.png": 32, "logo-64.png": 64,
                 "logo-128.png": 128, "logo-256.png": 256, "logo-512.png": 512}


def load_source_artwork() -> Image.Image:
    """Достаёт исходный рисунок из растровой картинки, вложенной в старый SVG."""
    # Строго один источник. Раньше здесь был перебор с подстановкой logo.svg —
    # но скрипт сам его и перезаписывает, поэтому второй запуск обрабатывал бы
    # уже обработанное и обрезал знак повторно, раз за разом.
    path = ROOT / "icons" / "icon-512x512.svg"
    match = re.search(r'href="data:image/png;base64,([^"]+)"',
                      path.read_text(encoding="utf-8")) if path.exists() else None
    if not match:
        raise SystemExit(f"исходный рисунок не найден: {path}")
    return Image.open(io.BytesIO(base64.b64decode(match.group(1)))).convert("RGBA")


def to_transparent(art: Image.Image) -> Image.Image:
    """Чёрный фон -> прозрачность. Альфа = яркость, поэтому свечение выживает.

    Перед этим срезается кайма по периметру. Исходник — не сами облачка, а
    ЧЁРНАЯ СКРУГЛЁННАЯ ПЛАШКА с облачками внутри, и кромка этой плашки чуть
    светлее середины (яркость ~52 против ~3). По яркости её от свечения не
    отличить — оно там же, 30..56 — поэтому порогом резать нельзя, вырежет и
    свечение. Зато кромка занимает узкую полосу у самого края, а облачки
    начинаются много глубже, так что геометрическая обрезка разделяет их
    чисто. Без неё на синем оставалась призрачная рамка — та же плашка,
    просто ставшая полупрозрачной.
    """
    inset = round(min(art.size) * 0.07)
    art = art.crop((inset, inset, art.width - inset, art.height - inset))

    grey = art.convert("L")
    white = Image.new("RGBA", art.size, (255, 255, 255, 255))
    white.putalpha(grey)

    # Ровная обрезка снимает прямые стороны плашки, но её скруглённые углы
    # заходят внутрь по диагонали дальше и остаются светящимися уголками.
    # Маска со щедрым радиусом срезает именно их, не трогая облачка в центре.
    from PIL import ImageChops, ImageDraw as _Draw
    corners = Image.new("L", white.size, 0)
    _Draw.Draw(corners).rounded_rectangle(
        (0, 0, white.width - 1, white.height - 1),
        radius=int(min(white.size) * 0.34), fill=255)
    white.putalpha(ImageChops.multiply(white.getchannel("A"), corners))

    return white.crop(white.getbbox() or (0, 0, *art.size))


def rounded_mask(size: int, radius_fraction: float = 0.22) -> Image.Image:
    from PIL import ImageDraw
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=int(size * radius_fraction), fill=255)
    return mask


def compose(glyph: Image.Image, size: int, rounded: bool) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), BLUE)
    if rounded:
        canvas.putalpha(rounded_mask(size))

    target = int(size * GLYPH_FRACTION)
    scaled = glyph.copy()
    scaled.thumbnail((target, target), Image.LANCZOS)
    canvas.alpha_composite(scaled, ((size - scaled.width) // 2,
                                    (size - scaled.height) // 2))
    return canvas


def embed(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def main() -> int:
    glyph = to_transparent(load_source_artwork())
    print(f"знак без фона: {glyph.width}x{glyph.height}")

    for size in ICON_SIZES:
        path = ROOT / "icons" / f"icon-{size}x{size}.png"
        compose(glyph, size, rounded=False).save(path)
        print(f"  {path.name:22} {size}x{size}  синий во всю площадь")

    for name, size in ROUNDED_EXTRA.items():
        path = ROOT / name
        compose(glyph, size, rounded=True).save(path)
        print(f"  {name:22} {size}x{size}  скруглённый")

    # Знак на прозрачном: вставляется внутрь уже цветных блоков интерфейса.
    side = max(glyph.size)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.alpha_composite(glyph, ((side - glyph.width) // 2, (side - glyph.height) // 2))
    (ROOT / "logo.svg").write_text(
        '<!--\n'
        '  Знак приложения БЕЗ подложки: вставляется внутрь уже готового цветного\n'
        '  блока (экран загрузки, экран входа), поэтому собственный фон здесь читается\n'
        '  как чёрная заплатка поверх синего — именно так и выглядела прежняя версия.\n'
        '  Собирается scripts/generate-icons.py, руками не править.\n'
        '-->\n'
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"\n'
        f'     viewBox="0 0 {side} {side}" width="{side}" height="{side}"\n'
        '     role="img" aria-label="CloudCLI">\n'
        f'  <image href="data:image/png;base64,{embed(square)}"\n'
        f'         width="{side}" height="{side}"/>\n'
        '</svg>\n', encoding="utf-8")
    print(f"  logo.svg               {side}x{side}  прозрачный")

    favicon = compose(glyph, 256, rounded=True)
    (ROOT / "favicon.svg").write_text(
        '<!--\n'
        '  Значок вкладки: подложка нужна — он стоит сам по себе на чужом фоне.\n'
        '  Собирается scripts/generate-icons.py, руками не править.\n'
        '-->\n'
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"\n'
        '     viewBox="0 0 256 256" width="256" height="256" role="img" aria-label="CloudCLI">\n'
        f'  <image href="data:image/png;base64,{embed(favicon)}" width="256" height="256"/>\n'
        '</svg>\n', encoding="utf-8")
    print("  favicon.svg            256x256  синий скруглённый")
    return 0


if __name__ == "__main__":
    sys.exit(main())

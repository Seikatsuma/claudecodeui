#!/usr/bin/env python3
"""Возвращает значок приложения ровно таким, каким его прислал Егор.

История: исходный рисунок — неоновые облачка по ЧЁРНОМУ фону. Была попытка
снять чёрный фон и посадить знак на синий квадрат, чтобы он не сливался с
тёмными обоями. Егор посмотрел на два значка рядом и сказал: верните мой,
всё было хорошо.

Поэтому здесь ничего не «улучшается»: картинка берётся как есть, добивается
до квадрата тем же чёрным, что у неё по краям, и раскладывается по размерам.
Скругление не накладывается — система на экране «Домой» накладывает своё, а
скругление поверх скругления даёт светлую кайму по углам.

Исходник — public/icons/icon-512x512.png в том виде, в каком Егор его принял
(коммит cb8c5f1c). Вшитый в icon-512x512.svg рисунок для этого не годится:
он всего 256 точек, и всё крупнее пришлось бы растягивать.

logo.svg скрипт НЕ трогает: этот файл вставляется внутрь уже готового
цветного блока в шапке и на экране входа, и чёрная плашка выглядит там
заплатой. Там нужен знак на прозрачном, а не исходная картинка.

Запуск: python3 scripts/restore-owner-icon.py
"""
import base64
import io
import re
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1] / "public"
ICON_SIZES = (72, 96, 128, 144, 152, 180, 192, 384, 512)
LOGO_SIZES = (32, 64, 128, 256, 512)


def load_source() -> Image.Image:
    path = ROOT / "icons" / "icon-512x512.png"
    if not path.exists():
        raise SystemExit(f"исходный рисунок не найден: {path}")
    return Image.open(path).convert("RGBA")


def to_square(art: Image.Image) -> Image.Image:
    """Добивает до квадрата цветом угла — у исходника это чёрный фон плашки."""
    if art.width == art.height:
        return art
    side = max(art.width, art.height)
    background = art.getpixel((0, 0))
    square = Image.new("RGBA", (side, side), background)
    square.paste(art, ((side - art.width) // 2, (side - art.height) // 2), art)
    return square


def main() -> None:
    art = to_square(load_source())
    print(f"исходник: {art.size[0]}x{art.size[1]}")

    icons_dir = ROOT / "icons"
    icons_dir.mkdir(parents=True, exist_ok=True)

    for size in ICON_SIZES:
        art.resize((size, size), Image.LANCZOS).save(icons_dir / f"icon-{size}x{size}.png")
    for size in LOGO_SIZES:
        art.resize((size, size), Image.LANCZOS).save(ROOT / f"logo-{size}.png")
    art.resize((64, 64), Image.LANCZOS).save(ROOT / "favicon.png")

    payload = io.BytesIO()
    art.resize((512, 512), Image.LANCZOS).save(payload, format="PNG")
    encoded = base64.b64encode(payload.getvalue()).decode("ascii")
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
        'viewBox="0 0 512 512" width="512" height="512">'
        f'<image width="512" height="512" xlink:href="data:image/png;base64,{encoded}"/>'
        '</svg>'
    )
    header = (
        "<!--\n"
        "  Значок приложения — рисунок Егора без изменений. Собирается\n"
        "  scripts/restore-owner-icon.py, руками не править.\n"
        "-->\n"
    )
    (ROOT / "favicon.svg").write_text(header + svg, encoding="utf-8")

    print("значки пересобраны из исходника без изменений")


if __name__ == "__main__":
    main()

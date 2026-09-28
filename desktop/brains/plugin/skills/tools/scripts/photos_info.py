# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow>=10", "pillow-heif>=0.18"]
# ///
"""Сведения о фотографиях папки: дата съёмки, место (широта/долгота), камера.

Запуск: uv run photos_info.py <папка> [--places] [--out таблица.csv]
  --places — ещё и название места (город, улица) по координатам через
             OpenStreetMap: не чаще 1 запроса в секунду, соседние точки
             берутся из запомненного.
Пишет таблицу CSV (открывается в Excel и Numbers) и печатает сводку.
Файлы не меняет.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import ExifTags, Image

try:
    from pillow_heif import register_heif_opener

    register_heif_opener()
except Exception:  # без HEIC — остальные форматы читаются
    pass

EXTS = {'.jpg', '.jpeg', '.heic', '.heif', '.png', '.tif', '.tiff', '.webp', '.dng'}
GPS_TAG = 0x8825
EXIF_IFD = 0x8769


def to_degrees(value, ref) -> float | None:
    try:
        d, m, s = (float(x) for x in value)
        deg = d + m / 60 + s / 3600
        return -deg if ref in ('S', 'W') else deg
    except Exception:
        return None


def read_photo(path: Path) -> dict:
    row = {'файл': str(path), 'дата_съёмки': '', 'широта': '', 'долгота': '', 'камера': '', 'место': ''}
    try:
        with Image.open(path) as img:
            exif = img.getexif()
            sub = exif.get_ifd(EXIF_IFD)
            gps = exif.get_ifd(GPS_TAG)
            row['дата_съёмки'] = str(sub.get(0x9003) or exif.get(0x0132) or '')
            row['камера'] = ' '.join(str(exif.get(t) or '').strip() for t in (0x010F, 0x0110)).strip()
            if gps:
                named = {ExifTags.GPSTAGS.get(k, k): v for k, v in gps.items()}
                lat = to_degrees(named.get('GPSLatitude'), named.get('GPSLatitudeRef'))
                lon = to_degrees(named.get('GPSLongitude'), named.get('GPSLongitudeRef'))
                if lat is not None and lon is not None:
                    row['широта'], row['долгота'] = round(lat, 6), round(lon, 6)
    except Exception as error:
        row['место'] = f'не прочиталось: {error}'
    return row


_places: dict[tuple, str] = {}
_last_call = 0.0


def place_name(lat: float, lon: float) -> str:
    global _last_call
    key = (round(lat, 3), round(lon, 3))  # ~100 м — соседние снимки не спрашиваем заново
    if key in _places:
        return _places[key]
    wait = 1.1 - (time.time() - _last_call)
    if wait > 0:
        time.sleep(wait)
    query = urllib.parse.urlencode({'lat': lat, 'lon': lon, 'format': 'jsonv2', 'accept-language': 'ru', 'zoom': 16})
    request = urllib.request.Request(
        f'https://nominatim.openstreetmap.org/reverse?{query}',
        headers={'User-Agent': 'ClaudeUI-desktop-photos/1.0'},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            name = json.load(response).get('display_name') or ''
    except Exception as error:
        name = f'не определилось: {error}'
    _last_call = time.time()
    _places[key] = name
    return name


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('folder')
    parser.add_argument('--places', action='store_true')
    parser.add_argument('--out', default=None)
    args = parser.parse_args()

    folder = Path(args.folder).expanduser()
    files = sorted(p for p in folder.rglob('*') if p.is_file() and p.suffix.lower() in EXTS)
    if not files:
        print(f'В папке {folder} нет фотографий')
        return 1

    rows = []
    for index, path in enumerate(files, 1):
        row = read_photo(path)
        if args.places and row['широта'] != '':
            row['место'] = place_name(row['широта'], row['долгота'])
        rows.append(row)
        if index % 50 == 0:
            print(f'…{index} из {len(files)}', file=sys.stderr)

    out = Path(args.out).expanduser() if args.out else folder / 'фото-сведения.csv'
    with out.open('w', newline='', encoding='utf-8-sig') as handle:  # utf-8-sig — Excel откроет по-русски
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()), delimiter=';')
        writer.writeheader()
        writer.writerows(rows)

    with_gps = sum(1 for r in rows if r['широта'] != '')
    print(f'Фото: {len(rows)}; с местом съёмки: {with_gps}; без места: {len(rows) - with_gps}')
    print(f'Таблица: {out}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

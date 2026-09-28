# /// script
# requires-python = ">=3.10"
# dependencies = ["imageio-ffmpeg>=0.5"]
# ///
"""Кадры из видео, чтобы Claude мог его «посмотреть», плюс длительность,
дата и место съёмки, если они записаны в файле.

Запуск: uv run video_frames.py <видео> [--frames 8] [--out папка]
Кадры — равномерно по всей длине, JPEG шириной до 1280. Видео не меняет.
Программа ffmpeg приезжает вместе с пакетом imageio-ffmpeg — ставить её
отдельно и просить пароль администратора не нужно.
Печатает: длительность, дату, координаты и пути к кадрам — их потом
открыть инструментом Read и посмотреть.
Звук в текст: uv run video_frames.py <видео> --audio — ещё и дорожка
audio.wav (16 кГц, моно) для расшифровки.
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

import imageio_ffmpeg


def probe(ffmpeg: str, video: Path) -> str:
    # ffmpeg без выходного файла печатает сведения о видео в stderr и выходит с ошибкой — это нормально.
    result = subprocess.run([ffmpeg, '-hide_banner', '-i', str(video)], capture_output=True, text=True, errors='replace')
    return result.stderr


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('video')
    parser.add_argument('--frames', type=int, default=8)
    parser.add_argument('--out', default=None)
    parser.add_argument('--audio', action='store_true')
    args = parser.parse_args()

    video = Path(args.video).expanduser()
    if not video.is_file():
        print(f'Нет файла {video}')
        return 1
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    info = probe(ffmpeg, video)

    duration = 0.0
    match = re.search(r'Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)', info)
    if match:
        h, m, s = match.groups()
        duration = int(h) * 3600 + int(m) * 60 + float(s)
    created = re.search(r'creation_time\s*:\s*(\S+)', info)
    # iPhone и Android пишут место как «+55.7558+037.6173/» (ISO 6709).
    location = re.search(r'location(?:\.ISO6709|-eng)?\s*:\s*([+-]\d+\.\d+)([+-]\d+\.\d+)', info)

    out = Path(args.out).expanduser() if args.out else video.with_name(video.stem + '-кадры')
    out.mkdir(parents=True, exist_ok=True)

    count = max(1, min(args.frames, 60))
    paths = []
    for index in range(count):
        at = duration * (index + 0.5) / count if duration else index
        target = out / f'кадр-{index + 1:02d}.jpg'
        subprocess.run(
            [ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-ss', f'{at:.2f}', '-i', str(video),
             '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-q:v', '3', str(target)],
            check=False,
        )
        if target.exists():
            paths.append((at, target))

    if args.audio:
        audio = out / 'audio.wav'
        subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-i', str(video),
                        '-vn', '-ac', '1', '-ar', '16000', str(audio)], check=False)
        print(f'Звук: {audio}' if audio.exists() else 'Звука в видео нет или он не извлёкся')

    print(f'Видео: {video.name}; длительность: {duration:.1f} с')
    print(f'Дата съёмки: {created.group(1) if created else "не записана"}')
    print(f'Место съёмки: {location.group(1)}, {location.group(2)}' if location else 'Место съёмки: не записано')
    print(f'Кадров: {len(paths)} в {out}')
    for at, path in paths:
        print(f'  {at:7.1f} с — {path}')
    return 0 if paths else 2


if __name__ == '__main__':
    sys.exit(main())

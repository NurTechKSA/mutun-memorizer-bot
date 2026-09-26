"""Build contact sheets with the first and last text lines of every page.

The sheets are for a human reviewer: read the first and last words of each page
and write them into content/audio-timings/anchors/<book-id>.json.

Usage:
  python tools/audio-align/strips.py <book-id> [--pages-dir DIR] [--per-sheet 6] [--lines 2]
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]


def ink_mask(image: Image.Image) -> np.ndarray:
    rgb = np.asarray(image.convert("RGB")).astype(np.int16)
    brightness = rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114
    spread = rgb.max(axis=2) - rgb.min(axis=2)
    return (brightness < 200) | (spread > 60)


def text_area(mask: np.ndarray) -> tuple[int, int] | None:
    """Rows of the page body: below the running header rule, down to the last ink row."""
    height, width = mask.shape
    rows = mask.sum(axis=1)

    top = 0
    for y in range(int(height * 0.2)):
        if rows[y] > width * 0.55:
            top = y + 4

    ink_rows = np.nonzero(rows[top:] > 2)[0]
    if ink_rows.size == 0:
        return None
    return top + int(ink_rows[0]), top + int(ink_rows[-1])


def page_number(path: Path) -> int:
    match = re.search(r"-(\d+)\.png$", path.name)
    return int(match.group(1)) if match else 0


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("book_id")
    parser.add_argument("--pages-dir")
    parser.add_argument("--out-dir")
    parser.add_argument("--per-sheet", type=int, default=5)
    parser.add_argument("--strip-height", type=int, default=150, help="pixels, ~2 lines at 170 dpi")
    args = parser.parse_args()

    pages_dir = Path(args.pages_dir) if args.pages_dir else ROOT / "content" / "prepared" / args.book_id / "images"
    out_dir = Path(args.out_dir) if args.out_dir else ROOT / "tmp" / "audio-align" / args.book_id / "strips"
    out_dir.mkdir(parents=True, exist_ok=True)

    pages = sorted(pages_dir.glob("*.png"), key=page_number)
    blocks: list[tuple[int, Image.Image]] = []
    for page in pages:
        image = Image.open(page).convert("RGB")
        area = text_area(ink_mask(image))
        if not area:
            continue
        top, bottom = area
        strip = min(args.strip_height, bottom - top)
        head = image.crop((0, max(0, top - 6), image.width, top + strip))
        tail = image.crop((0, bottom - strip, image.width, min(image.height, bottom + 6)))

        label_h = 22
        block = Image.new("RGB", (image.width, label_h * 2 + head.height + tail.height + 10), "white")
        draw = ImageDraw.Draw(block)
        number = page_number(page)
        draw.rectangle((0, 0, image.width, label_h), fill=(30, 30, 30))
        draw.text((8, 4), f"PDF {number}  START", fill="white")
        block.paste(head, (0, label_h))
        y = label_h + head.height + 4
        draw.rectangle((0, y, image.width, y + label_h), fill=(90, 90, 160))
        draw.text((8, y + 4), f"PDF {number}  END", fill="white")
        block.paste(tail, (0, y + label_h))
        blocks.append((number, block))

    for index in range(0, len(blocks), args.per_sheet):
        chunk = blocks[index : index + args.per_sheet]
        width = max(block.width for _, block in chunk)
        height = sum(block.height + 12 for _, block in chunk)
        sheet = Image.new("RGB", (width, height), (200, 200, 200))
        y = 0
        for _, block in chunk:
            sheet.paste(block, (0, y))
            y += block.height + 12
        first, last = chunk[0][0], chunk[-1][0]
        sheet.save(out_dir / f"sheet-{first:03d}-{last:03d}.png")

    print(f"{args.book_id}: {len(blocks)} pages -> {out_dir}")


if __name__ == "__main__":
    main()

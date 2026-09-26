"""Convert a page<TAB>start words<TAB>end words list into content/audio-timings/anchors/<book-id>.json."""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

book_id, tsv = sys.argv[1], Path(sys.argv[2])
pages = []
for line in tsv.read_text("utf-8").splitlines():
    if not line.strip():
        continue
    number, start, end = line.split("\t")
    pages.append({"sourcePageNumber": int(number), "start": start.strip(), "end": end.strip()})

out = ROOT / "content" / "audio-timings" / "anchors" / f"{book_id}.json"
payload = {
    "bookId": book_id,
    "notes": "First and last words of every page, read from the rendered page images. Used by tools/audio-align to locate page boundaries.",
    "pages": pages,
}
out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", "utf-8")
print(f"{book_id}: {len(pages)} pages -> {out}")

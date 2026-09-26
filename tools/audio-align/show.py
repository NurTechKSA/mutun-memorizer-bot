"""Print transcript segments in a time range: python tools/audio-align/show.py <book-id> <from_s> <to_s>"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
book, lo, hi = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
t = json.loads((ROOT / "tmp" / "audio-align" / book / "transcript.json").read_text("utf-8"))
for s in t["segments"]:
    if s["end"] >= lo and s["start"] <= hi:
        print(f"{s['start']:8.2f}-{s['end']:8.2f} {s['text']}")

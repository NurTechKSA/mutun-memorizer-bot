"""Write content/audio-timings/<book-id>.json (status: verified) from checked timings.

Refuses to write while verify.json has failing pages, unless every failing page is listed in
--accept with a reason in content/audio-timings/anchors/<book-id>.json ("reviewNote").

Usage:
  python tools/audio-align/finalize.py <book-id> [--accept 234,235]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("book_id")
    parser.add_argument("--accept", default="", help="pages that failed the automatic check but were reviewed by hand")
    args = parser.parse_args()

    work = ROOT / "tmp" / "audio-align" / args.book_id
    timings = json.loads((work / "timings.json").read_text("utf-8"))
    verify = {r["sourcePageNumber"]: r for r in json.loads((work / "verify.json").read_text("utf-8"))}
    anchors = {
        p["sourcePageNumber"]: p
        for p in json.loads(
            (ROOT / "content" / "audio-timings" / "anchors" / f"{args.book_id}.json").read_text("utf-8")
        )["pages"]
    }
    accepted = {int(v) for v in args.accept.split(",") if v.strip()}

    pages = []
    problems = []
    for page in timings["pages"]:
        number = page["sourcePageNumber"]
        check = verify.get(number)
        if check is None:
            problems.append(f"PDF {number}: not verified")
        elif abs(check["start"] - page["start"]) > 1e-3 or abs(check["end"] - page["end"]) > 1e-3:
            problems.append(f"PDF {number}: verified clip {check['start']}-{check['end']} differs from timings")
        elif not check["ok"] and number not in accepted:
            problems.append(f"PDF {number}: automatic check failed")
        elif not check["ok"] and not anchors[number].get("reviewNote"):
            problems.append(f"PDF {number}: accepted without reviewNote in anchors")

        entry = {"sourcePageNumber": number, "start": page["start"], "end": page["end"]}
        if page.get("segments"):
            entry["segments"] = page["segments"]
        note = anchors[number].get("reviewNote")
        if note:
            entry["note"] = note
        pages.append(entry)

    if problems:
        raise SystemExit("Not finalized:\n" + "\n".join(problems))

    out = {
        "bookId": args.book_id,
        "status": "verified",
        "notes": [
            "Page boundaries found by matching the first/last words of every page (anchors/<book-id>.json) "
            "against a Whisper large-v3 transcript; the cut is placed in the pause between the two pages.",
            "Every page clip was then transcribed on its own and checked to start with the page's first words "
            "and end with its last words (tools/audio-align/verify.py).",
        ],
        "pages": pages,
    }
    path = ROOT / "content" / "audio-timings" / f"{args.book_id}.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", "utf-8")
    print(f"{args.book_id}: {len(pages)} verified pages -> {path}")


if __name__ == "__main__":
    main()

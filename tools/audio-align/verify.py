"""Independent check of page timings: transcribe every page clip on its own and compare with the page text.

A page passes when its clip starts with the page's first words and ends with its last words, with no
more than a few stray characters before/after (i.e. no bleed from the neighbouring pages).

Usage:
  python tools/audio-align/verify.py <book-id> [--timings PATH] [--pages 39,40]

Reads content/audio-timings/anchors/<book-id>.json and, by default, tmp/audio-align/<book-id>/timings.json.
Writes tmp/audio-align/<book-id>/verify.json and verify-report.md.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import torch
import whisper
from rapidfuzz import fuzz

from align import semi_global
from arabic import anchor_key, honorific_mask, normalize
from transcribe import load_model, transcribe_span

ROOT = Path(__file__).resolve().parents[2]
SAMPLE_RATE = whisper.audio.SAMPLE_RATE

# How many stray letters a clip may have before the first / after the last anchor words.
SLACK = 8


# Phrases Whisper invents in silence (subtitle credits, "thanks for watching"); ignored at clip edges.
HALLUCINATIONS = [
    normalize(phrase).replace(" ", "")
    for phrase in [
        "ترجمة نانسي قنقر",
        "اشتركوا في القناة",
        "لا تنسوا الاشتراك في القناة",
        "شكرا للمشاهدة",
        "شكرا لكم",
        "شكرا",
        "اه",
    ]
]


def heard_key(text: str) -> str:
    """Clip transcript for matching: normalized, honorifics removed, edge hallucinations stripped, no spaces."""
    words = normalize(text).split()
    mask = honorific_mask(words)
    key = "".join(w for w, drop in zip(words, mask) if not drop)
    changed = True
    while changed:
        changed = False
        for phrase in HALLUCINATIONS:
            if key.endswith(phrase) and len(key) > len(phrase) * 3:
                key = key[: -len(phrase)]
                changed = True
    return key


def locate(anchor: str, text: str, want: str) -> tuple[float, int]:
    """Score and position of `anchor` in `text`: where it starts (want="start") or ends (want="end")."""
    if not anchor or not text:
        return 0.0, 0
    hits = [j for j in semi_global(anchor, text) if j is not None]
    if not hits:
        return 0.0, 0
    first, last = min(hits), max(hits) + 1
    score = fuzz.ratio(anchor, text[first:last])
    return score, first if want == "start" else last


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("book_id")
    parser.add_argument("--timings")
    parser.add_argument("--audio")
    parser.add_argument("--pages", help="comma separated source page numbers to check")
    parser.add_argument("--model", default="large-v3")
    args = parser.parse_args()

    work = ROOT / "tmp" / "audio-align" / args.book_id
    timings_path = Path(args.timings) if args.timings else work / "timings.json"
    timings = json.loads(timings_path.read_text("utf-8"))["pages"]
    anchors = {
        page["sourcePageNumber"]: page
        for page in json.loads(
            (ROOT / "content" / "audio-timings" / "anchors" / f"{args.book_id}.json").read_text("utf-8")
        )["pages"]
    }
    audio_path = Path(args.audio) if args.audio else ROOT / "content" / "raw" / args.book_id / "matn.mp3"
    audio = whisper.audio.load_audio(str(audio_path))

    only = {int(value) for value in args.pages.split(",")} if args.pages else None
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = load_model(args.model, device)

    results = []
    for page in timings:
        number = page["sourcePageNumber"]
        if only and number not in only:
            continue
        pieces = page.get("segments") or [{"start": page["start"], "end": page["end"]}]
        clip = np.concatenate(
            [audio[int(seg["start"] * SAMPLE_RATE) : int(seg["end"] * SAMPLE_RATE)] for seg in pieces]
        ).astype(np.float32)
        start_anchor = anchor_key(anchors[number].get("alignStart", anchors[number]["start"]))
        end_anchor = anchor_key(anchors[number].get("alignEnd", anchors[number]["end"]))
        # Short chunks: on long clips Whisper sometimes skips whole verses it finds hard. Which verse it drops
        # depends on where the chunks fall, so a failed check is retried with another chunk size; a real bleed
        # from the neighbouring page shows up in every attempt.
        attempt = None
        for chunk in (15.0, 9.0):
            _, segments = transcribe_span(model, clip, 0.0, len(clip) / SAMPLE_RATE, device == "cuda", max_chunk=chunk)
            heard = " ".join(segment["text"] for segment in segments).strip()
            text = heard_key(heard)
            start_score, start_at = locate(start_anchor, text, "start")
            end_score, end_at = locate(end_anchor, text, "end")
            leading = text[:start_at]
            trailing = text[end_at:]
            ok = start_score >= 80 and end_score >= 80 and len(leading) <= SLACK and len(trailing) <= SLACK
            current = (ok, min(start_score, end_score), heard, start_score, end_score, leading, trailing)
            if attempt is None or current[:2] > attempt[:2]:
                attempt = current
            if ok:
                break
        ok, _, heard, start_score, end_score, leading, trailing = attempt
        results.append(
            {
                "sourcePageNumber": number,
                "start": page["start"],
                "end": page["end"],
                "segments": page.get("segments"),
                "duration": round(len(clip) / SAMPLE_RATE, 2),
                "startScore": round(start_score, 1),
                "endScore": round(end_score, 1),
                "leading": leading,
                "trailing": trailing,
                "heard": heard,
                "ok": ok,
            }
        )
        status = "ok " if ok else "BAD"
        print(f"{status} PDF {number}: start {start_score:.0f} end {end_score:.0f} lead '{leading}' trail '{trailing}'")

    if only and (work / "verify.json").exists():
        # Re-checked pages replace their previous results.
        previous = json.loads((work / "verify.json").read_text("utf-8"))
        fresh = {r["sourcePageNumber"]: r for r in results}
        results = [fresh.pop(r["sourcePageNumber"], r) for r in previous] + list(fresh.values())
        results.sort(key=lambda r: r["sourcePageNumber"])
    (work / "verify.json").write_text(json.dumps(results, ensure_ascii=False, indent=1), "utf-8")
    bad = [r for r in results if not r["ok"]]
    lines = [
        f"# Verify report: {args.book_id}",
        "",
        f"{len(results) - len(bad)}/{len(results)} pages pass (clip starts with the page's first words and ends with its last words).",
        "",
        "| PDF | Clip | Start | End | Stray before | Stray after | Heard |",
        "|---|---|---|---|---|---|---|",
    ]
    for r in results:
        mark = "" if r["ok"] else " ⚠"
        lines.append(
            f"| {r['sourcePageNumber']}{mark} | {r['start']:.2f}–{r['end']:.2f} ({r['duration']:.1f}s) | "
            f"{r['startScore']} | {r['endScore']} | {r['leading']} | {r['trailing']} | {r['heard']} |"
        )
    (work / "verify-report.md").write_text("\n".join(lines) + "\n", "utf-8")
    print(f"{args.book_id}: {len(results) - len(bad)}/{len(results)} pages pass")


if __name__ == "__main__":
    main()

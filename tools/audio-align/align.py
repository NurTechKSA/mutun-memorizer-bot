"""Find page boundaries in a book recording.

Inputs:
  content/audio-timings/anchors/<book-id>.json   first/last words of every page (read from the page images)
  tmp/audio-align/<book-id>/transcript.json      Whisper transcript with word timestamps (transcribe.py)
  content/raw/<book-id>/matn.mp3                  source recording (for silence refinement)

For each page break the script searches the transcript for "<last words of page N> <first words of page N+1>",
maps the junction between the two anchors to the transcript words around it, then cuts in the real pause
(from the audio energy) between them. Manual review fields in the anchors file are applied last.

Output:
  tmp/audio-align/<book-id>/timings.json   {bookId, pages: [{sourcePageNumber, start, end}], boundaries: [...]}
  tmp/audio-align/<book-id>/align-report.md
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from rapidfuzz import fuzz

from arabic import anchor_key, compact, honorific_mask

ROOT = Path(__file__).resolve().parents[2]
SAMPLE_RATE = 16000


@dataclass
class Match:
    score: float
    first_end: int  # char index (exclusive) in the transcript where the first anchor ends
    second_start: int  # char index in the transcript where the second anchor starts


def load_audio(path: Path) -> np.ndarray:
    import whisper

    return whisper.audio.load_audio(str(path), sr=SAMPLE_RATE)


def energy_db(audio: np.ndarray, hop: float = 0.01, win: float = 0.03) -> np.ndarray:
    hop_n = int(hop * SAMPLE_RATE)
    win_n = int(win * SAMPLE_RATE)
    frames = max(1, (len(audio) - win_n) // hop_n)
    idx = np.arange(win_n)[None, :] + hop_n * np.arange(frames)[:, None]
    rms = np.sqrt(np.mean(audio[idx] ** 2, axis=1) + 1e-10)
    return 20 * np.log10(rms)


def quietest_point(energy: np.ndarray, lo: float, hi: float, smooth: float = 0.12) -> float:
    """Center of the quietest `smooth`-long stretch between lo and hi seconds."""
    a = max(0, int(lo / 0.01))
    b = min(len(energy), int(hi / 0.01))
    if b - a < 3:
        return (lo + hi) / 2
    k = max(1, int(smooth / 0.01))
    window = energy[a:b]
    if len(window) > k:
        window = np.convolve(window, np.ones(k) / k, mode="same")
    # Prefer the middle of the flat minimum: among near-minimal frames take the median one.
    floor = window.min()
    quiet = np.nonzero(window <= floor + 1.5)[0]
    best = int(np.median(quiet)) if quiet.size else int(np.argmin(window))
    return (a + best) * 0.01


def pause_cut(
    energy: np.ndarray, junction: float, lo: float, hi: float, distance_weight: float = 0.25
) -> tuple[float, float]:
    """Cut time near `junction` (ASR word boundary) inside [lo, hi], and its loudness below local speech (dB).

    Whisper word timestamps drift by up to ~1 s, so look for a real pause (>= 0.15 s, 14 dB below the
    local speech level) anywhere in the window and prefer long pauses close to the ASR junction.
    Falls back to the quietest point next to the junction for connected speech.
    """
    centre = int(junction / 0.01)
    local = energy[max(0, centre - 500) : centre + 500]
    level = float(np.percentile(local, 90)) if local.size else 0.0
    a = max(0, int(lo / 0.01))
    b = min(len(energy), int(hi / 0.01))
    if b - a < 3:
        return junction, 0.0
    smooth = np.convolve(energy[a:b], np.ones(5) / 5, mode="same")
    quiet = smooth < level - 14

    best = None
    start = None
    for i, flag in enumerate(np.append(quiet, False)):
        if flag and start is None:
            start = i
        elif not flag and start is not None:
            length = (i - start) * 0.01
            if length >= 0.15:
                mid = (a + (start + i) / 2) * 0.01
                score = length - distance_weight * abs(mid - junction)
                if best is None or score > best[0]:
                    best = (score, mid)
            start = None

    if best is not None:
        cut = best[1]
    else:
        cut = quietest_point(energy, max(lo, junction - 0.4), min(hi, junction + 0.4))
    depth = float(energy[min(len(energy) - 1, int(cut / 0.01))]) - level
    return cut, depth


def find_junction(text: str, first: str, second: str, lo: int, hi: int) -> Match:
    """Best approximate occurrence of first+second inside text[lo:hi]; returns where `second` begins."""
    pattern = first + second
    window = text[lo:hi]
    alignment = fuzz.partial_ratio_alignment(pattern, window)
    if alignment is None:
        return Match(0.0, lo, lo)
    # Pad the matched region: the ASR may have dropped or added words.
    pad = max(12, len(pattern) // 2)
    r0 = max(lo, lo + alignment.dest_start - pad)
    r1 = min(len(text), lo + alignment.dest_end + pad)
    mapping = semi_global(pattern, text[r0:r1])
    first_hits = [j for j in mapping[: len(first)] if j is not None]
    second_hits = [j for j in mapping[len(first) :] if j is not None]
    if not first_hits or not second_hits:
        return Match(alignment.score * 0.5, r0, r0)
    first_end = r0 + max(first_hits) + 1
    second_start = r0 + min(second_hits)
    return Match(alignment.score, first_end, max(first_end, second_start))


def semi_global(pattern: str, region: str) -> list[int | None]:
    """Align all of `pattern` to a free stretch of `region` (edit distance, free region ends).

    Returns, for each pattern char, the region index it matched or was substituted with, or None when the
    char is missing from the region (e.g. the ASR dropped that word). Ties prefer matches, so words the ASR
    dropped at a page break do not drag the neighbouring anchor across the break.
    """
    m, n = len(pattern), len(region)
    cost = np.zeros((m + 1, n + 1), dtype=np.int32)
    cost[1:, 0] = np.arange(1, m + 1)
    for i in range(1, m + 1):
        pc = pattern[i - 1]
        prev = cost[i - 1]
        row = cost[i]
        sub = prev[:-1] + np.fromiter((0 if rc == pc else 1 for rc in region), dtype=np.int32, count=n)
        dele = prev[1:] + 1
        best = np.minimum(sub, dele)
        # insertions (extra region chars) run along the row: cumulative min with +1 per step
        row[0] = i
        for j in range(1, n + 1):
            value = best[j - 1]
            left = row[j - 1] + 1
            row[j] = value if value <= left else left
    j = int(np.argmin(cost[m]))
    mapping: list[int | None] = [None] * m
    i = m
    while i > 0 and j > 0:
        here = cost[i, j]
        diag = cost[i - 1, j - 1] + (0 if pattern[i - 1] == region[j - 1] else 1)
        if here == diag:
            mapping[i - 1] = j - 1
            i, j = i - 1, j - 1
        elif here == cost[i - 1, j] + 1:
            i -= 1
        else:
            j -= 1
    return mapping


def weak_boundary(boundary: dict) -> bool:
    """Low text match, or the cut is not in a pause (less than 12 dB under the local speech level)."""
    return (
        boundary["score"] < 80
        or min(boundary["endScore"], boundary["startScore"]) < 60
        or boundary["depthDb"] > -12
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("book_id")
    parser.add_argument("--audio")
    parser.add_argument("--window", type=int, default=0, help="search window in chars (default: 5 average pages)")
    parser.add_argument("--first-start", default="auto", choices=["auto", "zero"])
    parser.add_argument("--last-end", default="auto", choices=["auto", "duration"])
    args = parser.parse_args()

    work = ROOT / "tmp" / "audio-align" / args.book_id
    anchors = json.loads((ROOT / "content" / "audio-timings" / "anchors" / f"{args.book_id}.json").read_text("utf-8"))
    transcript = json.loads((work / "transcript.json").read_text("utf-8"))
    audio_path = Path(args.audio) if args.audio else ROOT / "content" / "raw" / args.book_id / "matn.mp3"

    words = transcript["words"]
    duration = transcript["duration"]
    pages = anchors["pages"]

    # Transcript as one letters-only string with a char -> word index map.
    # Honorific formulas are left out of the string (see arabic.HONORIFICS); they stay in `words`.
    chars: list[str] = []
    char_word: list[int] = []
    tokens = [compact(word["word"]) for word in words]
    skip = honorific_mask(tokens)
    for index, token in enumerate(tokens):
        if skip[index]:
            continue
        chars.append(token)
        char_word.extend([index] * len(token))
    text = "".join(chars)
    word_first_char: dict[int, int] = {}
    for position, index in enumerate(char_word):
        word_first_char.setdefault(index, position)

    avg_page = max(200, len(text) // max(1, len(pages)))
    window = args.window or avg_page * 5

    audio = load_audio(audio_path)
    energy = energy_db(audio)

    boundaries = []
    cursor = 0

    # First page start.
    first_anchor = anchor_key(pages[0].get("alignStart", pages[0]["start"]))
    head_hits = [j for j in semi_global(first_anchor, text[:window]) if j is not None]
    head_char = min(head_hits) if head_hits else 0
    first_word = char_word[head_char]
    if args.first_start == "zero" or first_word == 0:
        first_start = 0.0
    else:
        # Recordings open with a spoken title that is not on the first study page.
        prev = words[first_word - 1]
        cur = words[first_word]
        junction = (prev["end"] + cur["start"]) / 2
        first_start, _ = pause_cut(energy, junction, max(prev["start"], prev["end"] - 1.5), min(cur["end"], cur["start"] + 1.5))
    cursor = head_char

    for i in range(1, len(pages)):
        end_prev = anchor_key(pages[i - 1].get("alignEnd", pages[i - 1]["end"]))
        start_cur = anchor_key(pages[i].get("boundaryStart", pages[i].get("alignStart", pages[i]["start"])))
        # Pages follow each other: take the first good match after the cursor rather than the best match in a
        # wide window (a repeated phrase a few pages later must not win).
        match = None
        best_rank = -1.0
        step = avg_page
        lo = cursor
        k = 0
        while lo < min(len(text), cursor + window):
            candidate = find_junction(text, end_prev, start_cur, lo, min(len(text), lo + step * 3))
            rank = candidate.score - 4 * k  # later windows must be clearly better to win
            if rank > best_rank:
                match, best_rank = candidate, rank
            if candidate.score >= 88:
                break
            lo += step
            k += 1

        first_end = min(max(match.first_end, 1), len(text) - 1)
        second_start = min(max(match.second_start, first_end), len(text) - 1)
        junction = second_start
        w_last_of_prev = char_word[first_end - 1]
        w_first_of_next = char_word[second_start]
        if w_last_of_prev == w_first_of_next:
            # Junction falls inside one ASR token: cut before that token if it starts the page, else after it.
            if second_start - word_first_char[w_first_of_next] <= len(compact(words[w_first_of_next]["word"])) / 2:
                w_last_of_prev = w_first_of_next - 1
            else:
                w_first_of_next = w_last_of_prev + 1
        w_last_of_prev = min(max(0, w_last_of_prev), len(words) - 2)
        w_first_of_next = min(len(words) - 1, max(w_first_of_next, w_last_of_prev + 1))

        # Transcript words between the two anchors (spoken honorifics, chapter announcements, ASR noise) belong
        # to neither anchor: search the whole stretch for the real pause. Whisper word times drift up to ~1 s.
        last_word = words[w_last_of_prev]
        first_word_next = words[w_first_of_next]
        extras = w_first_of_next - w_last_of_prev - 1
        asr_junction = (last_word["end"] + first_word_next["start"]) / 2
        cut, depth = pause_cut(
            energy,
            asr_junction,
            max(last_word["start"], last_word["end"] - 1.5),
            min(first_word_next["end"], first_word_next["start"] + 1.5),
            distance_weight=0.25 if extras == 0 else 0.05,
        )

        # Separate scores for each side of the junction, for the report.
        end_score = fuzz.ratio(end_prev, text[max(0, junction - len(end_prev)) : junction])
        start_score = fuzz.ratio(start_cur, text[junction : junction + len(start_cur)])

        context_before = " ".join(w["word"] for w in words[max(0, w_last_of_prev - 5) : w_last_of_prev + 1])
        context_after = " ".join(w["word"] for w in words[w_first_of_next : w_first_of_next + 6])
        extra = " ".join(w["word"] for w in words[w_last_of_prev + 1 : w_first_of_next])
        boundaries.append(
            {
                "between": [pages[i - 1]["sourcePageNumber"], pages[i]["sourcePageNumber"]],
                "cut": round(cut, 3),
                "extra": extra,
                "score": round(match.score, 1),
                "endScore": round(end_score, 1),
                "startScore": round(start_score, 1),
                "gap": round(first_word_next["start"] - last_word["end"], 3),
                "before": context_before,
                "after": context_after,
                "depthDb": round(depth, 1),
            }
        )
        cursor = junction

    # Last page end: after the last anchor word; anything later (closing formula, ASR noise in the
    # trailing silence) is reported but not played.
    last_anchor = anchor_key(pages[-1].get("alignEnd", pages[-1]["end"]))
    tail_lo = cursor
    tail_hits = [j for j in semi_global(last_anchor, text[tail_lo : tail_lo + window]) if j is not None]
    last_end = duration
    w_last = len(words) - 1
    if args.last_end == "auto" and tail_hits:
        w_last = char_word[tail_lo + max(tail_hits)]
        if w_last + 1 < len(words):
            after = words[w_last + 1]
            junction = (words[w_last]["end"] + after["start"]) / 2
            last_end, _ = pause_cut(
                energy, junction, max(words[w_last]["start"], words[w_last]["end"] - 1.5), min(after["end"], after["start"] + 1.5)
            )

    # Breaks reviewed by hand (connected speech the pause search cannot resolve).
    for index in range(1, len(pages)):
        manual = pages[index].get("cutBefore")
        if manual is not None:
            boundaries[index - 1]["cut"] = float(manual)
            boundaries[index - 1]["manual"] = True
    cuts = [first_start] + [b["cut"] for b in boundaries] + [last_end]
    timings = []
    for index, page in enumerate(pages):
        entry = {
            "sourcePageNumber": page["sourcePageNumber"],
            "start": round(cuts[index], 3),
            "end": round(cuts[index + 1], 3),
        }
        if page.get("segments"):
            # Reviewed by hand: the recording reads this page's text out of the printed order.
            # "start"/"end" stand for the page bounds found above.
            segments = []
            for a, b in page["segments"]:
                a = entry["start"] if a == "start" else float(a)
                b = entry["end"] if b == "end" else float(b)
                segments.append({"start": round(a, 3), "end": round(b, 3)})
            entry["segments"] = segments
            entry["start"] = min(seg["start"] for seg in segments)
            entry["end"] = max(seg["end"] for seg in segments)
        timings.append(entry)

    trailing = " ".join(w["word"] for w in words[w_last + 1 :]) if args.last_end == "auto" else ""

    out = {
        "bookId": args.book_id,
        "duration": duration,
        "pages": timings,
        "boundaries": boundaries,
        "leading": " ".join(w["word"] for w in words[:first_word]),
        "trailing": trailing,
    }
    (work / "timings.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), "utf-8")

    lines = [
        f"# Alignment report: {args.book_id}",
        "",
        f"Audio {duration:.1f}s, {len(pages)} pages, transcript {len(words)} words.",
        f"First page starts at {first_start:.2f}s. Leading transcript before page 1: `{out['leading']}`",
        f"Last page ends at {last_end:.2f}s. Trailing transcript after last page: `{trailing}`",
        "",
        "| Pages | Cut (s) | Score | End/Start | Pause dB | Before | Extra | After |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for b in boundaries:
        flag = " (manual)" if b.get("manual") else (" ⚠" if weak_boundary(b) else "")
        lines.append(
            f"| {b['between'][0]}→{b['between'][1]}{flag} | {b['cut']:.2f} | {b['score']} | "
            f"{b['endScore']}/{b['startScore']} | {b['depthDb']} | {b['before']} | {b['extra']} | {b['after']} |"
        )
    (work / "align-report.md").write_text("\n".join(lines) + "\n", "utf-8")

    weak = [b for b in boundaries if weak_boundary(b) and not b.get("manual")]
    print(f"{args.book_id}: {len(pages)} pages, {len(boundaries)} boundaries, {len(weak)} weak -> {work / 'timings.json'}")


if __name__ == "__main__":
    main()

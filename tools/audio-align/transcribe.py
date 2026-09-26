"""Transcribe a book recording with word timestamps (Whisper).

Usage:
  python tools/audio-align/transcribe.py <book-id> [--audio PATH] [--model large-v3]

Writes tmp/audio-align/<book-id>/transcript.json:
  {"audio": ..., "duration": ..., "words": [{"word", "start", "end", "prob"}], "segments": [...]}
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import torch
import whisper

ROOT = Path(__file__).resolve().parents[2]


def load_model(name: str, device: str) -> whisper.Whisper:
    """openai-whisper keeps fp32 weights and casts them per call; large-v3 then overflows an 8 GB GPU.

    Store the weights in fp16 (LayerNorm stays fp32, whisper's LayerNorm computes in fp32 anyway).
    """
    model = whisper.load_model(name, device="cpu")
    if device == "cuda":
        model.half()
        for module in model.modules():
            if isinstance(module, torch.nn.LayerNorm):
                module.float()
    return model.to(device)


def collect(result: dict, offset: float = 0.0) -> tuple[list[dict], list[dict]]:
    words = []
    segments = []
    for segment in result["segments"]:
        segments.append(
            {
                "start": round(segment["start"] + offset, 3),
                "end": round(segment["end"] + offset, 3),
                "text": segment["text"].strip(),
            }
        )
        for word in segment.get("words", []):
            words.append(
                {
                    "word": word["word"].strip(),
                    "start": round(word["start"] + offset, 3),
                    "end": round(word["end"] + offset, 3),
                    "prob": round(word.get("probability", 0.0), 3),
                }
            )
    return words, segments


def transcribe_span(model, samples, lo: float, hi: float, fp16: bool, max_chunk: float = 12.0):
    """Transcribe [lo, hi] in chunks of at most `max_chunk` seconds, split at the quietest moments.

    Whisper drops or compresses text inside long windows it finds hard (melodic Quran recitation);
    short chunks come back complete.
    """
    rate = whisper.audio.SAMPLE_RATE
    cuts = [lo]
    while hi - cuts[-1] > max_chunk:
        a = int((cuts[-1] + max_chunk * 0.6) * rate)
        b = int((cuts[-1] + max_chunk) * rate)
        frame = int(0.05 * rate)
        window = samples[a:b]
        levels = [np.mean(window[k : k + frame] ** 2) for k in range(0, max(1, len(window) - frame), frame)]
        cuts.append((a + int(np.argmin(levels)) * frame + frame // 2) / rate)
    cuts.append(hi)
    words, segments = [], []
    for c0, c1 in zip(cuts, cuts[1:]):
        result = model.transcribe(
            samples[int(c0 * rate) : int(c1 * rate)],
            language="ar",
            word_timestamps=True,
            condition_on_previous_text=False,
            fp16=fp16,
            verbose=None,
        )
        chunk_words, chunk_segments = collect(result, c0)
        words.extend(chunk_words)
        segments.extend(chunk_segments)
    return words, segments


def fill_gaps(model, samples, words, segments, fp16: bool, min_gap: float = 4.0):
    """Repair two Whisper failure modes on long recordings.

    1. A window is dropped: a long stretch with speech but no words.
    2. A window is compressed: a few words stretched over a long segment.
    Both stretches are re-transcribed in short chunks.
    """
    rate = whisper.audio.SAMPLE_RATE
    duration = len(samples) / rate
    bounds = [(0.0, 0.0)] + [(w["start"], w["end"]) for w in words] + [(duration, duration)]
    gaps = [
        (bounds[i][1], bounds[i + 1][0])
        for i in range(len(bounds) - 1)
        if bounds[i + 1][0] - bounds[i][1] >= min_gap
    ]
    filled = 0
    for lo, hi in gaps:
        clip = samples[int(lo * rate) : int(hi * rate)]
        if clip.size == 0:
            continue
        loud = np.sqrt(np.mean(clip.astype(np.float64) ** 2))
        if loud < 0.01:
            continue  # real silence
        new_words, new_segments = transcribe_span(model, samples, max(0.0, lo - 0.3), min(duration, hi + 0.3), fp16)
        # Keep every word that starts inside the gap; the word right after the gap already exists.
        new_words = [w for w in new_words if lo - 0.1 <= w["start"] < hi - 0.05]
        if not new_words:
            continue
        words.extend(new_words)
        segments.extend(s for s in new_segments if s["start"] >= lo - 0.3)
        filled += 1
        print(f"filled gap {lo:.1f}-{hi:.1f}s with {len(new_words)} words")

    for segment in list(segments):
        span = segment["end"] - segment["start"]
        inside = [w for w in words if segment["start"] - 0.05 <= w["start"] < segment["end"]]
        if span < 8 or len(inside) / span >= 0.7:
            continue
        lo, hi = segment["start"], segment["end"]
        new_words, new_segments = transcribe_span(model, samples, max(0.0, lo - 0.3), min(duration, hi + 0.3), fp16)
        new_words = [w for w in new_words if lo - 0.1 <= w["start"] < hi - 0.05]
        if len(new_words) <= len(inside):
            continue
        ids = {id(w) for w in inside}
        words[:] = [w for w in words if id(w) not in ids] + new_words
        segments.remove(segment)
        segments.extend(s for s in new_segments if lo - 0.3 <= s["start"] < hi)
        filled += 1
        print(f"re-transcribed sparse segment {lo:.1f}-{hi:.1f}s: {len(inside)} -> {len(new_words)} words")
    words.sort(key=lambda w: w["start"])
    segments.sort(key=lambda s: s["start"])
    return filled


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("book_id")
    parser.add_argument("--audio")
    parser.add_argument("--model", default="large-v3")
    parser.add_argument("--out")
    parser.add_argument("--prompt", default="بسم الله الرحمن الرحيم")
    parser.add_argument("--fill-only", action="store_true", help="only re-transcribe gaps of an existing transcript")
    args = parser.parse_args()

    audio = Path(args.audio) if args.audio else ROOT / "content" / "raw" / args.book_id / "matn.mp3"
    out = Path(args.out) if args.out else ROOT / "tmp" / "audio-align" / args.book_id / "transcript.json"
    out.parent.mkdir(parents=True, exist_ok=True)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    started = time.time()
    model = load_model(args.model, device)
    samples = whisper.audio.load_audio(str(audio))

    if args.fill_only:
        existing = json.loads(out.read_text("utf-8"))
        words, segments = existing["words"], existing["segments"]
    else:
        result = model.transcribe(
            samples,
            language="ar",
            task="transcribe",
            word_timestamps=True,
            condition_on_previous_text=False,
            initial_prompt=args.prompt,
            fp16=device == "cuda",
            verbose=False,
        )
        words, segments = collect(result)
    fill_gaps(model, samples, words, segments, device == "cuda")

    duration = samples.shape[0] / whisper.audio.SAMPLE_RATE
    payload = {
        "bookId": args.book_id,
        "audio": str(audio.relative_to(ROOT)) if audio.is_relative_to(ROOT) else str(audio),
        "model": args.model,
        "duration": round(duration, 3),
        "words": words,
        "segments": segments,
    }
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{args.book_id}: {len(words)} words, {duration:.1f}s audio, {time.time() - started:.0f}s -> {out}")


if __name__ == "__main__":
    main()

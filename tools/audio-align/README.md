# audio-align

Page-level timings for books whose recording is one long MP3 (content/raw/<book-id>/matn.mp3).
The output is `content/audio-timings/<book-id>.json` with `status: "verified"`, which
`npm run content:prepare` uses to cut one MP3 per page.

The PDFs use custom-encoded fonts, so their text cannot be extracted. Page text comes from a person
reading the rendered pages instead: the first and last words of every page are stored in
`content/audio-timings/anchors/<book-id>.json` and are the reference for every step below.

## Setup

Python 3.12 and an NVIDIA GPU (Whisper large-v3 runs in fp16 in about 4 GB of VRAM; CPU works but is slow).
`ffmpeg` must be on PATH (the one from `node_modules/ffmpeg-static` is fine).

```bash
python -m venv ~/.venvs/hifz-align
~/.venvs/hifz-align/Scripts/python -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128
~/.venvs/hifz-align/Scripts/python -m pip install -r tools/audio-align/requirements.txt
```

## Workflow

1. `npm run content:fetch && npm run content:prepare` — renders the pages to `content/prepared/<book-id>/images`.
2. `python tools/audio-align/strips.py <book-id>` — contact sheets with the first/last lines of every page
   (`tmp/audio-align/<book-id>/strips`). Read them and fill the anchors file:
   `{"sourcePageNumber": 85, "start": "<first words>", "end": "<last words>"}`.
   Write what the reciter says: section headings he reads are part of `start`; honorifics
   (ﷺ, ؓ, ﷻ …) can be left out, matching ignores them.
3. `python tools/audio-align/transcribe.py <book-id>` — Whisper transcript with word times
   (`tmp/audio-align/<book-id>/transcript.json`). Stretches Whisper skipped or compressed are
   re-transcribed in short chunks automatically.
4. `python tools/audio-align/align.py <book-id>` — finds every page break (last words of page N followed by the
   first words of page N+1) and cuts at the real pause between them. See `align-report.md`; rows marked ⚠ have a
   weak text match or a cut outside a clear pause.
5. `python tools/audio-align/verify.py <book-id> [--pages 86,117]` — transcribes every page clip on its own and checks that it
   starts with the page's first words and ends with its last words, with nothing from the neighbouring pages.
   See `verify-report.md`.
6. Review every failing page by hand (listen, look at the page). Record the outcome in the anchors file:
   - `reviewNote` — why the page is accepted (e.g. the reciter's edition words it differently);
   - `alignStart` / `alignEnd` — what the reciter actually says at the page start / end when it differs from
     the print (used by align.py and verify.py);
   - `boundaryStart` — words to find the page break by, when the page's own first words are read elsewhere
     (align.py only);
   - `cutBefore` — the break time in seconds, set by hand for connected speech without a pause;
   - `segments` — when the recording reads the page's text in another order, e.g.
     `[["start", 34.45], [49.3, "end"]]` ("start"/"end" are the computed page bounds).
7. `python tools/audio-align/finalize.py <book-id> [--accept 39]` — writes
   `content/audio-timings/<book-id>.json`. It refuses pages that failed step 5 unless they are listed in
   `--accept` and have a `reviewNote`.
8. `npm run content:prepare && npm run audio:report`.

`show.py <book-id> <from_s> <to_s>` prints the transcript around a spot; `tsv2json.py` turns a
`page<TAB>start<TAB>end` list into an anchors file.

# Audio timings

This folder is for manually verified page-level timings.

- `<book-id>.json` — verified timings used by `npm run content:prepare`.
- `anchors/<book-id>.json` — the first and last words of every page, read from the page images, plus review
  notes. They are the reference the timings were found and checked against.

Books with verified timings: `kitab-at-tawhid`, `al-aqidah-al-wasitiyyah`, `kashf-ash-shubuhat`, `al-ilbiri`.
They were produced with `tools/audio-align` (Whisper transcript + page anchors, every page clip re-checked);
see `tools/audio-align/README.md` to redo or extend them.

A page normally is one stretch of the recording (`start`–`end`). When the reciter reads a page's text in a
different order than the printed edition, the page lists `segments` that are played one after another.

Manual workflow for a new book:

1. Generate a draft:

   ```bash
   npm run audio:template -- al-usul-ath-thalatha
   ```

2. Listen to the original `content/prepared/<book-id>/matn.mp3` and check each
   rendered page in `content/prepared/<book-id>/images/`.
3. Fix every `start` and `end` in the draft.
4. Rename `<book-id>.draft.json` to `<book-id>.json`.
5. Change `status` to `verified`.
6. Run:

   ```bash
   npm run content:prepare
   npm run audio:report
   ```

`scripts/prepare-content.ts` refuses non-verified timing files. This prevents
estimated audio from being shipped as exact page audio by accident.

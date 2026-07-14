# Audio timings

This folder is for manually verified page-level timings.

Workflow:

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

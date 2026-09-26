---
project: mutun-memorizer-bot
public: true
type: fix
audience: users
title: Проверенное аудио для четырёх книг
summary: «Китаб ат-таухид», «Аль-Акыда аль-Васития», «Кашф аш-шубухат» и касыда аль-Ильбири получили точную нарезку аудио по страницам — каждая страница звучит ровно со своего первого до последнего слова.
user_impact:
  - Четыре книги, которые раньше были скрыты из занятий из-за примерной нарезки, снова доступны для заучивания.
  - Аудио страницы начинается с её первого слова и заканчивается последним — без хвостов соседних страниц и без вступления диктора.
  - В касыде аль-Ильбири появилась последняя страница (бейты 110–113), которой раньше не было.
  - В «Трёх основах» снова звучит фрагмент 71 — аудио в канале оказалось целым.
screenshots: []
checks:
  - python tools/audio-align/verify.py (каждая страница распознана отдельно и сверена с текстом)
  - npm run content:prepare
  - npm run audio:report
  - npm run typecheck
  - npm run build
deploy_url: https://hifz.nurtech.dev
---

Notes for editor:
- What changed: content/audio-timings/<book>.json with verified page timings for kitab-at-tawhid (150 pages), al-aqidah-al-wasitiyyah (92), kashf-ash-shubuhat (80), al-ilbiri (20). Timings were found by matching the first/last words of every page (read from the page images) against a Whisper transcript and cutting in the pause between pages; every page clip was then re-transcribed and checked. prepare-content supports pages assembled from several audio segments (the Kitab at-Tawhid reciter reads one verse of page 86 inside page 85). content:prepare now re-applies the @hifzun import so it no longer wipes the verified hifzun books. «Три основы» card 71 is unmuted: the @hifzun file (message 166) is 19.6 s and matches the card; telegram:hifzun:scan now re-downloads incomplete media.
- Where to verify: open any of the four books in the cabinet, switch pages and play audio; run npm run audio:report.
- Risks: the recordings follow a slightly different edition in a few places (noted per page in content/audio-timings/*.json); al-ilbiri gains one page at the end (index 19), existing progress is unaffected.

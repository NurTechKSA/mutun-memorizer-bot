---
project: mutun-memorizer-bot
public: true
type: fix
audience: users
title: Аудио теперь совпадает со страницей
summary: Для каждой страницы матна подготовлен отдельный аудиофрагмент вместо повторного запуска полного аудио с начала.
user_impact:
  - При переключении на следующую страницу аудио больше не начинается заново с начала матна.
  - В Telegram-боте и личном кабинете каждая страница получает свой MP3-фрагмент.
screenshots: []
checks:
  - npm run build
  - npm run content:prepare
  - local /api/app/state smoke: 12 books, 564 pages, 564 page audio files
  - local audio headers: page MP3 returns audio/mpeg
deploy_url: https://hifz.nurtech.dev
---

Notes for editor:
- What changed: page-level audio was generated and wired through the catalog/API.
- Where to verify: open any matn, switch between pages, and play audio.
- Risks: automatic split is based on page text density from the PDF image because source audio has no official page timestamps.

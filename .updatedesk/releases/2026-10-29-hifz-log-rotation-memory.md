---
project: hifz
public: false
backfilled: true
type: internal
audience: team
title: Ротация журналов и лимит памяти бота
summary: Журналы контейнера больше не растут без ограничения, у бота задан лимит памяти, выкладка идёт через общий выкладчик.
user_impact:
  - Сервер меньше забивается журналами.
  - Бот не займёт лишнюю память.
screenshots: []
checks: []
deploy_url: https://hifz.nurtech.dev
commits: a7756ca..8a6cdc8
---

Notes for editor:
- What changed: Ротация json-file 20m x 3 (сначала 50m), лимит памяти 512m в compose, переход на общий выкладчик. Исправление срока initData описано в существующей карточке.
- Where to verify: Compose-файл и выкладчик.
- Risks: восстановлено по git log задним числом.

---
project: hifz
public: false
type: fix
audience: team
title: Бот отключает заблокированные чаты
summary: Если Telegram возвращает 403 "bot was blocked by the user", бот автоматически отключает активные подписки этого chatId.
user_impact:
  - Ежедневная рассылка перестает повторно пытаться отправлять задания пользователям, которые заблокировали бота.
  - В логах становится меньше ожидаемых Telegram 403 ошибок.
screenshots:
  - tmp/audio-qa/audio-alignment-report.md
checks:
  - npm run build
  - npm run audio:report
deploy_url: https://hifz.nurtech.dev
---

Notes for editor:
- What changed: Added JsonStore.deactivateChat and Telegram 403 handling in scheduled lessons and reminders.
- Where to verify: docker compose logs should show deactivation warning once per blocked chat instead of repeated failed sends.
- Risks: Only the exact Telegram blocked-user 403 is auto-deactivated; other delivery errors still log normally.

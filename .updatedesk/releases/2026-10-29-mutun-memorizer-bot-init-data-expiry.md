---
project: hifz
public: false
type: fix
audience: team
title: Кабинет — срок действия входа из Telegram
summary: Внутреннее исправление безопасности кабинета; для пользователей ничего не меняется.
user_impact:
  - Перехваченная строка входа в кабинет перестаёт работать через сутки.
  - Если кабинет открыт слишком давно, он просит переоткрыть его из бота.
screenshots: []
checks:
  - 'npm test — 3 проверки (свежий, просроченный, будущий, без auth_date, подделка)'
  - 'npx tsc --noEmit'
deploy_url: https://hifz.nurtech.dev/app
---

Notes for editor:
- What changed: src/app.ts verifyInitData — auth_date старше INIT_DATA_MAX_AGE_SECONDS (86400) или больше чем на 5 минут в будущем → 401 error_code init_data_expired; src/config.ts initDataMaxAgeSeconds.
- Where to verify: кабинет из бота открывается и сохраняет прогресс.
- Risks: кабинет, открытый больше суток, попросит переоткрыть.

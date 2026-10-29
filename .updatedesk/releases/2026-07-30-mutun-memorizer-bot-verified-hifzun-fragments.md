---
project: hifz
public: true
type: fix
audience: users
title: Проверенные фрагменты и аудио для занятий
summary: В занятия теперь попадают только матны с проверенными парами «картинка + аудио». Подозрительное аудио отключается, чтобы пользователь не заучивал по неправильной записи.
user_impact:
  - В кабинете и боте доступны 10 матнов с проверенными фрагментами из готового источника.
  - Старые книги с примерной нарезкой больше не попадают в обучение, пока аудио не будет проверено.
  - В интерфейсе используется слово «фрагмент», чтобы не путать учебную карточку с номером страницы PDF.
  - Один подозрительный аудиофрагмент в «Трех основах» отключен и не будет отправляться пользователям.
screenshots: []
checks:
  - npm run content:import:hifzun
  - npm run typecheck
  - npm run build
  - npm run audio:report
deploy_url: https://hifz.nurtech.dev
---

Notes for editor:
- What changed: Imported verified Hifzun card/audio pairs, disabled estimated lesson audio, hid books without verified lesson content, cleaned old generated files during import, and clarified app/bot copy around fragments.
- Where to verify: Open the Telegram app cabinet, check the books list, start a ready matn, and inspect the generated audio report.
- Risks: Four catalog books remain unavailable for lessons until exact audio pairs are found. One «Три основы» fragment intentionally has no audio because the source MP3 is too short for the card.

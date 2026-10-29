---
project: hifz
public: false
type: fix
audience: team
title: Убраны пустые страницы из занятий
summary: Подозрительные аудио-страницы проверены: пустые листы и служебный хвост Кашф аш-шубухат исключены из занятий.
user_impact:
  - Пользователь больше не должен получать пустые страницы как задание.
  - Кашф аш-шубухат заканчивается на последней странице матна, без оглавления, пустого листа и задней обложки.
screenshots:
  - tmp/audio-qa/audio-alignment-report.md
checks:
  - npm run content:prepare
  - npm run audio:report
  - npm run build
deploy_url: https://hifz.nurtech.dev
---

Notes for editor:
- What changed: prepare-content skips fully blank rendered pages; kashf studyRange now ends at PDF 96.
- Where to verify: audio report should show 551 pages, 0 missing audio, and no suspicious chunks.
- Risks: Existing index-based progress must be migrated for books where pages were removed.

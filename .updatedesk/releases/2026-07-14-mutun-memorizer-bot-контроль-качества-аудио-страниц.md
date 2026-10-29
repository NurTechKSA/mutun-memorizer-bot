---
project: hifz
public: false
type: internal
audience: team
title: Контроль качества аудио страниц
summary: Добавлен статус качества аудио для страниц, отчёт по проверке и workflow для ручных таймкодов.
user_impact:
  - Приложение больше не должно выдавать примерную нарезку как полностью проверенную.
  - Для будущей точной нарезки появился формат проверенных таймкодов и валидатор.
screenshots:
  - tmp/audio-qa/audio-alignment-report.md
checks:
  - npm run build
  - npm run content:prepare
  - npm run audio:report
deploy_url: https://hifz.nurtech.dev
---

Notes for editor:
- What changed: Catalog chunks now carry audioStatus; API and UI can distinguish verified and estimated page audio. Added audio timing templates and an alignment report.
- Where to verify: Run npm run audio:report and inspect tmp/audio-qa/audio-alignment-report.md.
- Risks: Existing audio remains estimated until each book receives manually verified timings.

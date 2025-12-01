# Repository Guidelines

## Project Structure & Module Organization
- `src/refresh-monthly.js` — основной скрипт обновления каналов через TDLib, пишет данные в SQLite (`channels.sqlite`).
- `src/config/paths.js` — все пути/окружение (DB, media, tdlib). `src/l.txt` — список каналов; `agent-notes.md` — рабочие договорённости.
- `scripts/` — вспомогательные утилиты (визуализация, добивка данных). `media/` хранит выгруженные превью, `tdlib/` — файлы TDLib.

## Build, Test, and Development Commands
- `npm install` — поставить зависимости (tdl, Gemini SDK).
- `npm run refresh` — запуск основного обновления (использует env: `CHANNEL_*`, `TDLIB_*`, см. `src/config/paths.js`).
- `node scripts/visualize.js` — вспомогательная визуализация данных (если нужна). Тестов нет; проверяйте синтаксис `node -c <file>` при изменениях.

## Coding Style & Naming Conventions
- Node.js (ESM не используется), `"use strict"` в файлах. Предпочтение — `async/await`, явные `return`, короткие логгеры `logInfo`.
- Имена переменных/функций snake_case в данных (SQLite), camelCase в JS. Константы `SCREAMING_SNAKE_CASE`.

## Testing Guidelines
- Автотестов нет. Минимум — `node -c src/refresh-monthly.js` перед коммитом. При сложных правках прогоняйте `npm run refresh` на тестовом списке (копия `src/l.txt`).

## Commit & Pull Request Guidelines
- Коммит-месседжи: короткие, в повелительном наклонении, описывают главное изменение (`Handle is_rkn schema and skip low-comment threads`).
- Перед PR: краткое описание изменений, упоминание затронутых env/путей, скрин/лог только если меняется вывод. Не удалять чужие данные в БД/медиа.

## Security & Configuration Tips
- TDLib требует локальных файлов (`tdlib/database`, `tdlib/files`) и `tdlib` бинарника (`TDLIB_PATH`). Не коммить эти артефакты.
- Используйте `TDLIB_REQUEST_DELAY_MS` (по умолчанию 3000) и не опускайте защиту от FLOOD/429. RKN-список читается из `src/l.txt` — обновляйте осознанно.

## Agent-Specific Instructions
- Перед работой прочитайте `agent-notes.md` и добавьте новую запись о договорённостях/решениях. Не переписывайте историю, добавляйте блоки с датой.

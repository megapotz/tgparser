# парсер: codex resume 019ac533-7e3f-7bb2-8889-01cc8147b317
# codex resume 019acc2b-56aa-7e62-b029-d23652539347
# ллм

# tgparser

Минимальный скриптовый набор для обновления данных каналов через TDLib с сохранением агрегатов в SQLite.

## Быстрый старт
1. Установи зависимости: `npm install`.
2. Подготовь переменные окружения (пример):
   - `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` — свои ключи.
   - `TDLIB_PATH` — путь до `libtdjson.so` (например `/home/mike/td/build/libtdjson.so`).
   - `CHANNEL_LIST_FILE` — список каналов (по умолчанию `src/l.txt`).
   - `CHANNEL_DB_PATH` — путь к SQLite (по умолчанию `channels.filtered.sqlite` в корне).
   - `CHANNEL_MEDIA_DIR` — куда складывать скачанные превью (по умолчанию `media/`).
   - `CHANNEL_REFRESH_ONLY` — перечисление сущностей через запятую, чтобы обновить только их (`searchPublicChat`, `getSupergroupFullInfo`, `getChatHistory`, `comments`, `getChatSimilarChats`).
   - `CHANNEL_REFRESH_SKIP` — перечисление сущностей через запятую, которые нужно пропустить (та же номенклатура).
   - `CHANNEL_FORCE_REFRESH` — `1/true/yes`, чтобы игнорировать TTL и перезапросить всё выбранное.
   - `TDLIB_RESPONSES_LOG`, `TDLIB_UPDATES_LOG` — пути для логов всех TDLib ответов/апдейтов (`*.ndjson`, по умолчанию в корне `td-responses.ndjson`, `td-updates.ndjson`).
3. Запуск обновления: `npm run refresh`.

## Что делает refresh-monthly
- Для каналов из `l.txt` обновляет таблицу `channels` (с `is_rkn`, `reactions_disabled`, `similar_count`).
- Тянет до 100 сообщений и складывает их пачкой в `channel_messages.messages_json` (с путями к скачанным превью и транскрипциями голосовых/кружков).
- Тянет комментарии к свежему посту (100–200 шт., ≤30 дней) в `channel_comments.payload_json` или `null`, если комментарии недоступны.
- Вызывает `getChatSimilarChats`, сохраняет массив пар `[chat_id, supergroup_id|null]` в `channel_similar.items_json` и счётчик в `channels.similar_count`.
- `refresh_state` отмечает время последнего запроса/успеха/ошибки по сущностям, чтобы не дёргать чаще 30 дней (TTL конфигурируем).

Подробнее — в `src/README.md`.

export GEMINI_API_KEY=AIzaSyAEKOyWcyrN_W0429mQYrkn2lZebjuwIi8 node src/llm-handler.js why4ch

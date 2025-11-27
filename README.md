# tgparser

Минимальный скриптовый набор для обновления данных каналов через TDLib с сохранением агрегатов в SQLite.

## Быстрый старт
1. Установи зависимости: `npm install`.
2. Подготовь переменные окружения (пример):
   - `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` — свои ключи.
   - `TDLIB_PATH` — путь до `libtdjson.so` (например `/home/mike/td/build/libtdjson.so`).
   - `CHANNEL_LIST_FILE` — список каналов (по умолчанию `src/l.txt`).
   - `CHANNEL_DB_PATH` — путь к SQLite (по умолчанию `channels.sqlite` в корне).
   - `CHANNEL_MEDIA_DIR` — куда складывать скачанные превью (по умолчанию `media/`).
3. Запуск обновления: `npm run refresh`.

## Что делает refresh-monthly
- Для каналов из `l.txt` обновляет таблицу `channels` (с `is_rkn`, `reactions_disabled`, `similar_count`).
- Тянет до 100 сообщений и складывает их пачкой в `channel_messages.messages_json` (с путями к скачанным превью и транскрипциями голосовых/кружков).
- Тянет комментарии к свежему посту (100–200 шт., ≤30 дней) в `channel_comments.payload_json` или `null`, если комментарии недоступны.
- Вызывает `getChatSimilarChats`, сохраняет массив пар `[chat_id, supergroup_id|null]` в `channel_similar.items_json` и счётчик в `channels.similar_count`.
- `refresh_state` отмечает время последнего запроса/успеха/ошибки по сущностям, чтобы не дёргать чаще 30 дней (TTL конфигурируем).

Подробнее — в `src/README.md`.

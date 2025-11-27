# src/refresh-monthly.js

Задача: раз в ~30 дней освежать данные по каналам из `l.txt` и складывать агрегаты в SQLite одним JSON-полем:
- пачка сообщений (`channel_messages.messages_json`);
- пачка комментариев к свежему посту за последние 30 дней (`channel_comments.payload_json`);
- похожие каналы (`channel_similar.items_json`);
- отметки времени в `refresh_state` для точечного запуска.

Старые файлы в корне не трогаются, вся новая логика — в `src/`.

## Запуск
```
node src/refresh-monthly.js
```

### Основные переменные окружения
- `CHANNEL_DB_PATH` — путь к SQLite (по умолчанию `channels.sqlite` в корне).
- `CHANNEL_HISTORY_FETCH_LIMIT` — сколько сообщений тянуть (`1..100`, по умолчанию `100`).
- `CHANNEL_COMMENT_LIMIT_MIN` / `CHANNEL_COMMENT_LIMIT_MAX` — диапазон количества комментариев (по умолчанию `100`/`200`).
- `CHANNEL_COMMENT_MAX_AGE_SECONDS` — максимальный возраст комментариев (по умолчанию 30 дней).
- `CHANNEL_REFRESH_DAYS` — TTL для принудительного освежения сущностей (по умолчанию 30 дней).
- `TDLIB_REQUEST_DELAY_MS` — пауза между запросами к TDLib (по умолчанию 1000 мс).
- `CHANNEL_LIST_FILE` — путь к списку каналов (по умолчанию `src/l.txt`).
- `CHANNEL_MEDIA_TEXT_THRESHOLD` — если текст сообщения длиннее порога (по умолчанию 100 символов), превью не скачивается.
- `SPEECH_RETRY_COUNT` / `SPEECH_RETRY_DELAY_MS` — сколько раз и с какой паузой опрашивать распознавание голоса/кружков (по умолчанию 5 раз, 2000 мс).
- `CHANNEL_REFRESH_ONLY` — перечисление сущностей через запятую, которые нужно обновить (например, `comments,getChatHistory`).
- `CHANNEL_REFRESH_SKIP` — перечисление сущностей через запятую, которые нужно пропустить.
- `CHANNEL_FORCE_REFRESH` — `1/true/yes`, чтобы игнорировать TTL.
- `TDLIB_RESPONSES_LOG`, `TDLIB_UPDATES_LOG` — пути к ndjson-логам всех ответов/апдейтов TDLib (по умолчанию `td-responses.ndjson`/`td-updates.ndjson` в корне).

## Что кладётся в БД
- `channels.is_rkn` — для всех имён из `l.txt` ставится `1`.
- `channel_messages`: строка на канал, `messages_json` = `{"chat_id","fetched_count","limit","collected_at","messages":[...]}`.
- `channel_comments`: строка на канал, `payload_json` = JSON-массив комментариев или `null` (если нет linked_chat_id/сообщений/ответов). Комментарии не старше 30 дней, 100–200 штук.
- `channel_similar`: строка на канал, `items_json` = массив пар `[chat_id, supergroup_id|null]` из `getChatSimilarChats`.
- `refresh_state`: отметки `last_success_at`/`last_error_at`/`last_request_at` по сущностям (`searchPublicChat`, `getSupergroupFullInfo`, `getChatHistory`, `comments`, `getChatSimilarChats`), чтобы решать, что протухло.
- `channels.reactions_disabled` — 1 если в канале отключены реакции (`chatAvailableReactionsNone`), 0 если нет/не знаем.
- `channels.similar_count` — сколько похожих каналов вернулось.

Формат сообщения/комментария внутри массивов:
```json
{
  "id": 1234567890,
  "chat_id": -100111222333,
  "date": 1717430000,
  "content_type": "messageText",
  "text_markdown": "Пример **сообщения**",
  "media_remote_id": null,
  "media_unique_id": null,
  "forward_count": 12,
  "reply_count": 3,
  "view_count": 4500,
  "reactions": { "total": 25, "paid": 4, "free": 21 },
  "media_local_path": "media/-100111222333/1234567890.jpg",
  "transcription": "текст распознанного голосового"
}
```

Числовые поля (`forward_count`, `reply_count`, `view_count`, `reactions`) пишутся только если > 0.
Превью скачивается только если текст сообщения короче `CHANNEL_MEDIA_TEXT_THRESHOLD` (по умолчанию 100 символов); иначе `media_local_path` будет `null`.

Формат комментария внутри `comments`: `{"text":"Комментарий **markdown**","reactions_count":10}` — `reactions_count` присутствует только если > 0.

## Поток
1. Читает `l.txt`, логинится в TDLib.
2. Для каждого канала делает `searchPublicChat` (обновляет `channels` и `is_rkn`).
3. Если супергруппа — `getSupergroupFullInfo` (если старше TTL).
4. Собирает апдейты, маппит их в `channels`.
5. `getChatHistory` → сохраняет пачку сообщений в JSON (если старше TTL).
6. По свежему посту тянет `getMessageThread` + `getMessageThreadHistory`, фильтрует по возрасту, кладёт в JSON (если старше TTL).
7. `getChatSimilarChats` → кладёт сырые items в JSON (если старше TTL).
8. Все отметки протухания — в `refresh_state`.

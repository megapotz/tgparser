"use strict";

"use strict";

/**
 * Ежемесячный освежатель данных каналов.
 * - Берёт список каналов из l.txt (is_rkn = 1 для всех из списка).
 * - Для каждого канала точечно вызывает TDLib-методы, если данные старше TTL (по умолчанию 30 дней):
 *   searchPublicChat, getSupergroupFullInfo, getChatHistory, getMessageThread(History), getChatSimilarChats.
 * - Сообщения и комментарии хранятся пачкой в одном JSON-поле, рассчитанном на потребление LLM.
 * - Учитывает апдейты, пришедшие во время работы, чтобы не терять updateSupergroup/updateChatLastMessage и т.п.
 */

const path = require("node:path");
const fs = require("node:fs/promises");
const { DatabaseSync } = require("node:sqlite");
const {
  CHANNEL_LIST_FILE,
  ensureDirectories,
  createClient,
  login,
  readChannelList,
  createTdCaller,
  delay,
  filterUpdatesForChat,
  logUpdateEvent
} = require("../tdlib-helpers");
const { DB_PATH, MEDIA_ROOT } = require("./config/paths");

const REQUEST_DELAY_MS = Number(process.env.TDLIB_REQUEST_DELAY_MS || 3000);
const HISTORY_FETCH_LIMIT = Math.max(1, Number(process.env.CHANNEL_HISTORY_FETCH_LIMIT) || 100);
const COMMENT_LIMIT_MIN = Number(process.env.CHANNEL_COMMENT_LIMIT_MIN || 100);
const COMMENT_LIMIT_MAX = Math.max(COMMENT_LIMIT_MIN, Math.min(Number(process.env.CHANNEL_COMMENT_LIMIT_MAX) || 200, 200));
const COMMENT_TOTAL_TARGET = Number(process.env.CHANNEL_COMMENT_TOTAL_TARGET || COMMENT_LIMIT_MAX); // сколько максимум собираем за раз
const COMMENT_MAX_AGE_SECONDS = Number(process.env.CHANNEL_COMMENT_MAX_AGE_SECONDS || 30 * 24 * 60 * 60); // не старше 30 дней
const FORCE_REFRESH = ["1", "true", "yes"].includes(String(process.env.CHANNEL_FORCE_REFRESH || "").toLowerCase());
const ONLY_ENTITIES = (process.env.CHANNEL_REFRESH_ONLY || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SKIP_ENTITIES = (process.env.CHANNEL_REFRESH_SKIP || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// По умолчанию не рефрешим, а только заполняем дыры; включить таймер можно через CHANNEL_REFRESH_DAYS>0
const STALE_DAYS = Number(process.env.CHANNEL_REFRESH_DAYS ?? -1);
const STALE_SECONDS = STALE_DAYS > 0 ? STALE_DAYS * 24 * 60 * 60 : null;
const MEDIA_TEXT_THRESHOLD = Number(process.env.CHANNEL_MEDIA_TEXT_THRESHOLD || 100);
const SPEECH_WAIT_TIMEOUT_MS = Number(process.env.SPEECH_WAIT_TIMEOUT_MS || 20000);
const REACTIONS_LOG_PATH = process.env.CHANNEL_REACTIONS_LOG || path.join(process.cwd(), "reactions.log");

const updatesByChannel = new Map();
let currentChannel = null;
const pendingTranscriptions = new Map();
let rknUsernames = new Set();

function logInfo(message, ...args) {
  console.log(`[refresh] ${message}`, ...args);
}

async function logReactionsUpdate(update) {
  try {
    const payload = {
      timestamp: new Date().toISOString(),
      update
    };
    await fs.writeFile(REACTIONS_LOG_PATH, JSON.stringify(payload) + "\n", { flag: "a", encoding: "utf8" });
  } catch (_) {
    // swallow
  }
}

function boolToInt(value) {
  return value ? 1 : 0;
}

function normalizeUsername(name) {
  if (!name || typeof name !== "string") return null;
  return name.trim().toLowerCase();
}

function isRknByChat(chat) {
  if (!chat) return false;
  const usernames = [];
  if (Array.isArray(chat.usernames?.active_usernames)) {
    usernames.push(...chat.usernames.active_usernames);
  }
  if (typeof chat.username === "string") {
    usernames.push(chat.username);
  }
  for (const name of usernames) {
    const norm = normalizeUsername(name);
    if (norm && rknUsernames.has(norm)) {
      return true;
    }
  }
  return false;
}

function hasEnoughMembers(update) {
  const mc =
    update?.supergroup?.member_count ??
    update?.supergroup_full_info?.member_count ??
    update?.chat?.member_count ??
    update?.message?.chat_member_count;
  if (typeof mc === "number") {
    return mc >= 800;
  }
  return true; // если информации нет, сохраняем
}

function attachUpdateCollector(client) {
  client.on("update", (update) => {
    maybeResolveTranscriptionFromUpdate(update);

    if (!currentChannel || !updatesByChannel.has(currentChannel)) {
      logUpdateEvent(update);
      return;
    }
    logUpdateEvent(update);
    updatesByChannel.get(currentChannel).push(update);
  });
}

function initDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA synchronous=NORMAL;");

  function ensureColumn(table, column, definition) {
    const existing = db.prepare(`PRAGMA table_info(${table});`).all();
    const hasColumn = existing.some((row) => row.name === column);
    if (!hasColumn) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      chat_id INTEGER PRIMARY KEY,
      title TEXT,
      supergroup_id INTEGER,
      boost_level INTEGER,
      date INTEGER,
      has_direct_messages_group INTEGER,
      has_linked_chat INTEGER,
      member_count INTEGER,
      active_username TEXT,
      is_verified INTEGER,
    description TEXT,
    direct_messages_chat_id INTEGER,
    gift_count INTEGER,
    linked_chat_id INTEGER,
    outgoing_paid_message_star_count INTEGER,
    photo_small_id TEXT,
    photo_small_unique_id TEXT,
    photo_big_id TEXT,
    photo_big_unique_id TEXT,
    reactions_disabled INTEGER,
    similar_count INTEGER,
    updated_at TEXT DEFAULT (datetime('now'))
  );
    CREATE INDEX IF NOT EXISTS idx_channels_supergroup ON channels(supergroup_id);

    CREATE TABLE IF NOT EXISTS channel_messages (
      chat_id INTEGER PRIMARY KEY,
      messages_json TEXT,
      collected_at TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS channel_comments (
      chat_id INTEGER PRIMARY KEY,
      payload_json TEXT,
      collected_at TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS channel_similar (
      chat_id INTEGER PRIMARY KEY,
      items_json TEXT,
      collected_at TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS refresh_state (
      chat_id INTEGER,
      entity TEXT,
      last_request_at TEXT,
      last_success_at TEXT,
      last_error_at TEXT,
      error_code INTEGER,
      PRIMARY KEY(chat_id, entity)
    );
  `);

  ensureColumn("channels", "is_rkn", "INTEGER DEFAULT 0");
  ensureColumn("channels", "similar_count", "INTEGER");

  const upsertChannel = db.prepare(`
    INSERT INTO channels (
      chat_id, title, supergroup_id, boost_level, date, has_direct_messages_group,
      has_linked_chat, member_count, active_username, is_verified, description,
      direct_messages_chat_id, gift_count, linked_chat_id, outgoing_paid_message_star_count,
      photo_small_id, photo_small_unique_id, photo_big_id, photo_big_unique_id, reactions_disabled, similar_count, is_rkn, updated_at
    ) VALUES (
      @chat_id, @title, @supergroup_id, @boost_level, @date, @has_direct_messages_group,
      @has_linked_chat, @member_count, @active_username, @is_verified, @description,
      @direct_messages_chat_id, @gift_count, @linked_chat_id, @outgoing_paid_message_star_count,
      @photo_small_id, @photo_small_unique_id, @photo_big_id, @photo_big_unique_id, @reactions_disabled, @similar_count, @is_rkn, datetime('now')
    )
    ON CONFLICT(chat_id) DO UPDATE SET
      title = COALESCE(excluded.title, channels.title),
      supergroup_id = COALESCE(excluded.supergroup_id, channels.supergroup_id),
      boost_level = COALESCE(excluded.boost_level, channels.boost_level),
      date = COALESCE(excluded.date, channels.date),
      has_direct_messages_group = COALESCE(excluded.has_direct_messages_group, channels.has_direct_messages_group),
      has_linked_chat = COALESCE(excluded.has_linked_chat, channels.has_linked_chat),
      member_count = COALESCE(excluded.member_count, channels.member_count),
      active_username = COALESCE(excluded.active_username, channels.active_username),
      is_verified = COALESCE(excluded.is_verified, channels.is_verified),
      description = COALESCE(excluded.description, channels.description),
      direct_messages_chat_id = COALESCE(excluded.direct_messages_chat_id, channels.direct_messages_chat_id),
      gift_count = COALESCE(excluded.gift_count, channels.gift_count),
      linked_chat_id = COALESCE(excluded.linked_chat_id, channels.linked_chat_id),
      outgoing_paid_message_star_count = COALESCE(excluded.outgoing_paid_message_star_count, channels.outgoing_paid_message_star_count),
      photo_small_id = COALESCE(excluded.photo_small_id, channels.photo_small_id),
      photo_small_unique_id = COALESCE(excluded.photo_small_unique_id, channels.photo_small_unique_id),
      photo_big_id = COALESCE(excluded.photo_big_id, channels.photo_big_id),
      photo_big_unique_id = COALESCE(excluded.photo_big_unique_id, channels.photo_big_unique_id),
      reactions_disabled = COALESCE(excluded.reactions_disabled, channels.reactions_disabled),
      similar_count = COALESCE(excluded.similar_count, channels.similar_count),
      is_rkn = COALESCE(excluded.is_rkn, channels.is_rkn),
      updated_at = datetime('now');
  `);

  const upsertMessagesJson = db.prepare(`
    INSERT INTO channel_messages (chat_id, messages_json, collected_at, updated_at)
    VALUES (@chat_id, @messages_json, @collected_at, datetime('now'))
    ON CONFLICT(chat_id) DO UPDATE SET
      messages_json = excluded.messages_json,
      collected_at = excluded.collected_at,
      updated_at = datetime('now');
  `);

  const upsertCommentsJson = db.prepare(`
    INSERT INTO channel_comments (chat_id, payload_json, collected_at, updated_at)
    VALUES (@chat_id, @payload_json, @collected_at, datetime('now'))
    ON CONFLICT(chat_id) DO UPDATE SET
      payload_json = excluded.payload_json,
      collected_at = excluded.collected_at,
      updated_at = datetime('now');
  `);

  const upsertSimilarJson = db.prepare(`
    INSERT INTO channel_similar (chat_id, items_json, collected_at, updated_at)
    VALUES (@chat_id, @items_json, @collected_at, datetime('now'))
    ON CONFLICT(chat_id) DO UPDATE SET
      items_json = excluded.items_json,
      collected_at = excluded.collected_at,
      updated_at = datetime('now');
  `);

  const upsertRefresh = db.prepare(`
    INSERT INTO refresh_state (chat_id, entity, last_request_at, last_success_at, last_error_at, error_code)
    VALUES (@chat_id, @entity, @last_request_at, @last_success_at, @last_error_at, @error_code)
    ON CONFLICT(chat_id, entity) DO UPDATE SET
      last_request_at = COALESCE(excluded.last_request_at, refresh_state.last_request_at),
      last_success_at = COALESCE(excluded.last_success_at, refresh_state.last_success_at),
      last_error_at = COALESCE(excluded.last_error_at, refresh_state.last_error_at),
      error_code = excluded.error_code;
  `);

  const getRefresh = db.prepare(`SELECT * FROM refresh_state WHERE chat_id = ? AND entity = ? LIMIT 1;`);
  const getChannel = db.prepare(`SELECT * FROM channels WHERE chat_id = ? LIMIT 1;`);
  const getChannelByUsername = db.prepare(`SELECT * FROM channels WHERE active_username = ? LIMIT 1;`);

  ensureColumn("channels", "reactions_disabled", "INTEGER");
  ensureColumn("channels", "active_username", "TEXT");
  ensureColumn("channels", "is_verified", "INTEGER");

  return {
    db,
    upsertChannel,
    upsertMessagesJson,
    upsertCommentsJson,
    upsertSimilarJson,
    upsertRefresh,
    getRefresh,
    getChannel,
    getChannelByUsername
  };
}

function isSupergroup(chat) {
  return chat?.type?._ === "chatTypeSupergroup" && typeof chat.type.supergroup_id === "number";
}

function toChatIdFromSupergroup(supergroupId) {
  if (typeof supergroupId !== "number") return null;
  return -1000000000000 - supergroupId;
}

function extractPhotoIds(photo) {
  if (!photo || !Array.isArray(photo.sizes) || photo.sizes.length === 0) {
    return { photo_small_id: null, photo_small_unique_id: null, photo_big_id: null, photo_big_unique_id: null };
  }
  const first = photo.sizes[0]?.photo?.remote || {};
  const last = photo.sizes[photo.sizes.length - 1]?.photo?.remote || {};
  return {
    photo_small_id: first.id || null,
    photo_small_unique_id: first.unique_id || null,
    photo_big_id: last.id || null,
    photo_big_unique_id: last.unique_id || null
  };
}

function applyChatToChannel(upsertChannel, chat, isRkn = null) {
  if (!chat || typeof chat.id !== "number") return;
  const primaryUsername =
    Array.isArray(chat.usernames?.active_usernames) && chat.usernames.active_usernames.length > 0
      ? chat.usernames.active_usernames[0]
      : null;
  const isVerified =
    typeof chat.verification_status?.is_verified === "boolean" ? boolToInt(chat.verification_status.is_verified) : null;
  const params = {
    chat_id: chat.id,
    title: chat.title || null,
    supergroup_id: isSupergroup(chat) ? chat.type.supergroup_id : null,
    is_rkn: isRkn !== null ? boolToInt(Boolean(isRkn)) : null,
    active_username: primaryUsername,
    is_verified: isVerified,
    reactions_disabled: reactionsDisabled(chat.available_reactions)
  };
  upsertChannel.run(params);
}

function applySupergroupToChannel(upsertChannel, supergroup, chatIdOverride = null) {
  if (!supergroup || typeof supergroup.id !== "number") return;
  const chatId = chatIdOverride || toChatIdFromSupergroup(supergroup.id);
  if (chatId === null) return;
  const params = {
    chat_id: chatId,
    supergroup_id: supergroup.id,
    boost_level: supergroup.boost_level ?? null,
    date: supergroup.date ?? null,
    has_direct_messages_group: typeof supergroup.has_direct_messages_group === "boolean" ? boolToInt(supergroup.has_direct_messages_group) : null,
    has_linked_chat: typeof supergroup.has_linked_chat === "boolean" ? boolToInt(supergroup.has_linked_chat) : null,
    member_count: supergroup.member_count ?? null,
    active_username:
      Array.isArray(supergroup.usernames?.active_usernames) && supergroup.usernames.active_usernames.length > 0
        ? supergroup.usernames.active_usernames[0]
        : null,
    is_verified:
      typeof supergroup.verification_status?.is_verified === "boolean"
        ? boolToInt(supergroup.verification_status.is_verified)
        : null
  };
  upsertChannel.run(params);
}

function applyFullInfoToChannel(upsertChannel, supergroupId, fullInfo, chatIdOverride = null) {
  if (!fullInfo || typeof supergroupId !== "number") return;
  const photoIds = extractPhotoIds(fullInfo.photo);
  const chatId = chatIdOverride || toChatIdFromSupergroup(supergroupId);
  if (chatId === null) return;
  const params = {
    chat_id: chatId,
    supergroup_id: supergroupId,
    description: fullInfo.description || null,
    direct_messages_chat_id: fullInfo.direct_messages_chat_id ?? null,
    gift_count: fullInfo.gift_count ?? null,
    linked_chat_id: fullInfo.linked_chat_id ?? null,
    member_count: fullInfo.member_count ?? null,
    outgoing_paid_message_star_count: fullInfo.outgoing_paid_message_star_count ?? null,
    photo_small_id: photoIds.photo_small_id,
    photo_small_unique_id: photoIds.photo_small_unique_id,
    photo_big_id: photoIds.photo_big_id,
    photo_big_unique_id: photoIds.photo_big_unique_id,
    reactions_disabled: reactionsDisabled(fullInfo.available_reactions)
  };
  upsertChannel.run(params);
}

function reactionsDisabled(availableReactions) {
  if (!availableReactions || typeof availableReactions !== "object") return null;
  if (availableReactions._ === "chatAvailableReactionsNone") return 1;
  if (availableReactions._ === "chatAvailableReactionsSome") {
    const hasList = Array.isArray(availableReactions.reactions) && availableReactions.reactions.length > 0;
    const hasMax = Number.isFinite(availableReactions.max_reaction_count) && availableReactions.max_reaction_count > 0;
    if (!hasList && hasMax) {
      return 1; // явно ничего нельзя выбрать
    }
    return 0;
  }
  return 0;
}

function entityMarkers(entity) {
  const type = entity?.type;
  switch (type?._) {
    case "textEntityTypeBold":
      return { open: "**", close: "**" };
    case "textEntityTypeItalic":
      return { open: "_", close: "_" };
    case "textEntityTypeUnderline":
      return { open: "__", close: "__" };
    case "textEntityTypeStrikethrough":
      return { open: "~~", close: "~~" };
    case "textEntityTypeCode":
      return { open: "`", close: "`" };
    case "textEntityTypePre": {
      const lang = type.language ? `${type.language}\n` : "";
      return { open: "```" + lang, close: "\n```" };
    }
    case "textEntityTypeSpoiler":
      return { open: "||", close: "||" };
    case "textEntityTypeTextUrl":
      return { open: "[", close: `](${type.url})` };
    case "textEntityTypeMentionName":
      return { open: "[", close: type.user_id ? `](tg://user?id=${type.user_id})` : "]" };
    default:
      return { open: "", close: "" };
  }
}

function formattedTextToMarkdown(formatted) {
  if (!formatted) return null;
  const text = formatted.text || "";
  const entities = Array.isArray(formatted.entities) ? formatted.entities.slice() : [];
  if (entities.length === 0) return text || null;

  const openAt = Array.from({ length: text.length + 1 }, () => []);
  const closeAt = Array.from({ length: text.length + 1 }, () => []);

  for (const entity of entities) {
    const start = Math.max(0, Number(entity.offset) || 0);
    const end = Math.min(text.length, start + (Number(entity.length) || 0));
    if (start >= end) continue;
    const { open, close } = entityMarkers(entity);
    openAt[start].push(open);
    closeAt[end].unshift(close);
  }

  let result = "";
  for (let i = 0; i <= text.length; i += 1) {
    if (openAt[i]?.length) {
      result += openAt[i].join("");
    }
    if (i < text.length) {
      result += text[i];
    }
    if (closeAt[i + 1]?.length) {
      result += closeAt[i + 1].join("");
    }
  }

  return result;
}

function extractMarkdownText(message) {
  if (!message || !message.content) return null;
  const content = message.content;
  if (content.text) return formattedTextToMarkdown(content.text);
  if (content.caption) return formattedTextToMarkdown(content.caption);
  return null;
}

function extractMediaIds(message) {
  const content = message?.content;
  if (!content) return { media_remote_id: null, media_unique_id: null };

  if (content._ === "messagePhoto" && content.photo) {
    const ids = extractPhotoIds(content.photo);
    return { media_remote_id: ids.photo_big_id || ids.photo_small_id, media_unique_id: ids.photo_big_unique_id || ids.photo_small_unique_id };
  }

  if (content._ === "messageVideo" && content.video?.video?.remote) {
    return { media_remote_id: content.video.video.remote.id || null, media_unique_id: content.video.video.remote.unique_id || null };
  }

  if (content._ === "messageVoiceNote" && content.voice_note?.voice?.remote) {
    return { media_remote_id: content.voice_note.voice.remote.id || null, media_unique_id: content.voice_note.voice.remote.unique_id || null };
  }

  if (content._ === "messageVideoNote" && content.video_note?.video?.remote) {
    return { media_remote_id: content.video_note.video.remote.id || null, media_unique_id: content.video_note.video.remote.unique_id || null };
  }

  return { media_remote_id: null, media_unique_id: null };
}

function aggregateReactions(interactionInfo) {
  const reactions = interactionInfo?.reactions?.reactions;
  if (!Array.isArray(reactions)) {
    return { total: null, paid: null, free: null };
  }
  let hasData = false;
  let paid = 0;
  let free = 0;
  for (const reaction of reactions) {
    const count = Number(reaction?.total_count);
    if (!Number.isFinite(count)) continue;
    hasData = true;
    if (reaction?.type?._ === "reactionTypePaid") {
      paid += count;
    } else {
      free += count;
    }
  }
  if (!hasData) {
    return { total: null, paid: null, free: null };
  }
  return { total: paid + free, paid, free };
}

function mapMessageToJson(message) {
  if (!message || typeof message.id !== "number") return null;
  const media = extractMediaIds(message);
  const reactions = aggregateReactions(message.interaction_info);
  const row = {
    id: message.id,
    chat_id: message.chat_id ?? null,
    date: message.date ?? null,
    content_type: message.content?._ || null,
    text_markdown: extractMarkdownText(message),
    media_remote_id: media.media_remote_id,
    media_unique_id: media.media_unique_id,
    media_local_path: null
  };

  const forwardCount = message.interaction_info?.forward_count;
  if (Number.isFinite(forwardCount) && forwardCount > 0) {
    row.forward_count = forwardCount;
  }

  const replyCount = message.interaction_info?.reply_info?.reply_count;
  if (Number.isFinite(replyCount) && replyCount > 0) {
    row.reply_count = replyCount;
  }

  const viewCount = message.interaction_info?.view_count;
  if (Number.isFinite(viewCount) && viewCount > 0) {
    row.view_count = viewCount;
  }

  if (Number.isFinite(reactions.total) && reactions.total > 0) {
    row.reactions = {
      total: reactions.total,
      paid: reactions.paid,
      free: reactions.free
    };
  }

  return row;
}

function mapInteractionToJson(chatId, messageId, interactionInfo) {
  if (typeof messageId !== "number") return null;
  const reactions = aggregateReactions(interactionInfo);
  const row = {
    id: messageId,
    chat_id: chatId ?? null,
    date: null,
    content_type: null,
    text_markdown: null,
    media_remote_id: null,
    media_unique_id: null,
  };

  const forwardCount = interactionInfo?.forward_count;
  if (Number.isFinite(forwardCount) && forwardCount > 0) {
    row.forward_count = forwardCount;
  }

  const replyCount = interactionInfo?.reply_info?.reply_count;
  if (Number.isFinite(replyCount) && replyCount > 0) {
    row.reply_count = replyCount;
  }

  const viewCount = interactionInfo?.view_count;
  if (Number.isFinite(viewCount) && viewCount > 0) {
    row.view_count = viewCount;
  }

  if (Number.isFinite(reactions.total) && reactions.total > 0) {
    row.reactions = {
      total: reactions.total,
      paid: reactions.paid,
      free: reactions.free
    };
  }

  return row;
}

function applyUpdate(upsertChannel, update, fallbackChatId = null, fallbackSupergroupId = null) {
  if (!update || typeof update !== "object") return;

  const updateChatId =
    typeof update.chat_id === "number"
      ? update.chat_id
      : typeof update.chat?.id === "number"
      ? update.chat.id
      : typeof update.message?.chat_id === "number"
      ? update.message.chat_id
      : null;

  const updateSupergroupId =
    typeof update.supergroup?.id === "number"
      ? update.supergroup.id
      : typeof update.supergroup_id === "number"
      ? update.supergroup_id
      : typeof update.chat?.type?.supergroup_id === "number"
      ? update.chat.type.supergroup_id
      : null;

  switch (update._) {
    case "updateNewChat":
      if (!fallbackChatId || updateChatId === fallbackChatId || hasEnoughMembers(update)) {
        applyChatToChannel(upsertChannel, update.chat, isRknByChat(update.chat));
      }
      break;
    case "updateSupergroup": {
      const targetChatId = updateChatId || toChatIdFromSupergroup(updateSupergroupId) || fallbackChatId;
      if (!fallbackChatId || targetChatId === fallbackChatId || hasEnoughMembers(update)) {
        applySupergroupToChannel(upsertChannel, update.supergroup, targetChatId);
      }
      break;
    }
    case "updateSupergroupFullInfo": {
      const sgId = updateSupergroupId || fallbackSupergroupId;
      const targetChatId = updateChatId || toChatIdFromSupergroup(sgId) || fallbackChatId;
      if (!fallbackChatId || targetChatId === fallbackChatId || hasEnoughMembers(update)) {
        applyFullInfoToChannel(upsertChannel, sgId, update.supergroup_full_info, targetChatId);
      }
      break;
    }
    case "updateMessageInteractionInfo": {
      // Переносим interaction_info в messages JSON не делаем напрямую, но оставляем задел для агрегации.
      break;
    }
    case "updateChatAvailableReactions": {
      const targetChatId = updateChatId || fallbackChatId;
      if (typeof targetChatId === "number") {
        upsertChannel.run({
          chat_id: targetChatId,
          reactions_disabled: reactionsDisabled(update.available_reactions)
        });
        logInfo(`update reactions: chat_id=${targetChatId}, disabled=${reactionsDisabled(update.available_reactions)}`);
        logReactionsUpdate(update);
      }
      break;
    }
    default:
      break;
  }
}

async function callTdWithDelay(callTd, args) {
  if (REQUEST_DELAY_MS > 0) {
    await delay(REQUEST_DELAY_MS);
  }
  try {
    return await callTd(args);
  } catch (error) {
    abortOnFlood(error);
    throw error;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function isFloodError(error) {
  if (!error) return false;
  if (Number(error.code) === 429) return true;
  const message = String(error.message || error || "").toUpperCase();
  return message.includes("FLOOD") || message.includes("TOO MANY REQUESTS");
}

function abortOnFlood(error) {
  if (isFloodError(error)) {
    const ts = nowIso();
    console.error(`[refresh] FLOOD detected at ${ts}: ${error.message || error}`);
    throw error;
  }
}

function isStale(getRefresh, chatId, entity) {
  if (FORCE_REFRESH) return true;
  if (ONLY_ENTITIES.length > 0 && !ONLY_ENTITIES.includes(entity)) return false;
  if (SKIP_ENTITIES.length > 0 && SKIP_ENTITIES.includes(entity)) return false;
  const row = getRefresh.get(chatId, entity);
  if (!row || !row.last_success_at) return true;
  if (STALE_SECONDS === null) return false; // таймер отключён, данных достаточно
  const last = new Date(row.last_success_at).getTime();
  if (!Number.isFinite(last)) return true;
  const ageMs = Date.now() - last;
  return ageMs > STALE_SECONDS * 1000;
}

function allEntitiesFresh(getRefresh, chatId) {
  if (!chatId) return false;
  const targetsBase = ["searchPublicChat", "getSupergroup", "getSupergroupFullInfo", "getChatHistory", "comments", "getChatSimilarChats"];
  const targets = targetsBase.filter((entity) => {
    if (ONLY_ENTITIES.length > 0 && !ONLY_ENTITIES.includes(entity)) return false;
    if (SKIP_ENTITIES.length > 0 && SKIP_ENTITIES.includes(entity)) return false;
    return true;
  });
  if (targets.length === 0) return false;
  return targets.every((entity) => !isStale(getRefresh, chatId, entity));
}

function touchRefresh(upsertRefresh, chatId, entity, status, errorCode = null) {
  const ts = nowIso();
  const payload = {
    chat_id: chatId,
    entity,
    last_request_at: status === "request" ? ts : null,
    last_success_at: status === "success" ? ts : null,
    last_error_at: status === "error" ? ts : null,
    error_code: errorCode
  };
  upsertRefresh.run(payload);
}

async function fetchMessages({ callTd, callTdFast, chatId, limit }) {
  const messages = [];
  const batchStats = [];
  let fromMessageId = 0;
  let totalRaw = 0;

  while (totalRaw < limit) {
    if (REQUEST_DELAY_MS > 0 && batchStats.length > 0) {
      await delay(REQUEST_DELAY_MS);
    }
    const remaining = limit - totalRaw;
    const batchLimit = Math.min(remaining, 100);
    const batch = await callTd({
      method: "getChatHistory",
      params: { chat_id: chatId, from_message_id: fromMessageId, offset: 0, limit: batchLimit },
      responses: []
    });
    const batchMessages = Array.isArray(batch?.messages) ? batch.messages : [];
    batchStats.push({
      requested: batchLimit,
      received: batchMessages.length,
      from_message_id: fromMessageId
    });
    logInfo(
      `history batch: chat_id=${chatId}, batch=${batchStats.length}, requested=${batchLimit}, got=${batchMessages.length}, total_raw=${totalRaw + batchMessages.length}, total_kept=${messages.length}`
    );
    if (batchMessages.length === 0) break;

    for (const message of batchMessages) {
      const mapped = mapMessageToJson(message);
      if (mapped) {
        mapped.media_local_path = await maybeDownloadPreview(callTdFast, message, chatId, mapped.text_markdown);
        if (isVoiceOrCircle(message)) {
          const transcript = await ensureTranscription(callTd, message);
          if (transcript) {
            mapped.transcription = transcript;
          }
        }
        messages.push(mapped);
      }
    }

    totalRaw += batchMessages.length;
    if (batchMessages.length < batchLimit) {
      break; // данных меньше, дальше не спрашиваем
    }

    const last = batchMessages[batchMessages.length - 1];
    const nextFrom = typeof last?.id === "number" ? last.id : 0;
    if (!nextFrom || nextFrom === fromMessageId) break;
    fromMessageId = nextFrom;
  }

  return { messages, batchStats, totalRaw };
}

async function fetchComments({ callTd, chatId, rootMessageId, sinceTimestamp, limit }) {
  const comments = [];
  const seenIds = new Set();
  let fromMessageId = 0;
  let more = true;

  while (more && comments.length < limit) {
    if (REQUEST_DELAY_MS > 0 && comments.length > 0) {
      await delay(REQUEST_DELAY_MS);
    }
    const batchLimit = Math.min(limit - comments.length, 100);
    const history = await callTd({
      method: "getMessageThreadHistory",
      params: { chat_id: chatId, message_id: rootMessageId, from_message_id: fromMessageId, offset: 0, limit: batchLimit },
      responses: []
    });
    const batchMessages = Array.isArray(history?.messages) ? history.messages : [];
    if (batchMessages.length === 0) break;

    for (const msg of batchMessages) {
      if (msg?.id === rootMessageId) continue;
      if (typeof msg?.date === "number" && msg.date < sinceTimestamp) {
        more = false;
        break;
      }
      if (seenIds.has(msg?.id)) continue;
      const mapped = mapMessageToCommentJson(msg);
      if (mapped) {
        comments.push(mapped);
        seenIds.add(msg.id);
      }
      if (comments.length >= limit) {
        more = false;
        break;
      }
    }

    const last = batchMessages[batchMessages.length - 1];
    const nextFrom = typeof last?.id === "number" ? last.id : 0;
    if (!nextFrom || nextFrom === fromMessageId) break;
    fromMessageId = nextFrom;
  }

  return comments;
}

function mapMessageToCommentJson(message) {
  const text = extractMarkdownText(message);
  if (!text) return null;
  const reactions = aggregateReactions(message?.interaction_info);
  const total = reactions.total ?? 0;
  const result = { text };
  if (total > 0) {
    result.reactions_count = total;
  }
  return result;
}

function normalizeSimilarItems(rawItems) {
  if (!Array.isArray(rawItems)) return [];
  const normalized = [];
  for (const item of rawItems) {
    if (typeof item === "number") {
      normalized.push([item, null]);
      continue;
    }
    if (item && typeof item === "object") {
      const id = typeof item.id === "number" ? item.id : null;
      const supergroupId =
        item.type?._ === "chatTypeSupergroup" && typeof item.type.supergroup_id === "number" ? item.type.supergroup_id : null;
      if (id !== null) {
        normalized.push([id, supergroupId]);
      }
    }
  }
  return normalized;
}

async function maybeDownloadPreview(callTd, message, chatId, text) {
  const textLen = typeof text === "string" ? text.length : 0;
  if (textLen >= MEDIA_TEXT_THRESHOLD) {
    return null;
  }

  const content = message?.content;
  if (!content) return null;

  if (content._ === "messagePhoto" && Array.isArray(content.photo?.sizes)) {
    const cached = await findExistingMedia(chatId, String(message.id));
    if (cached) return cached;
    const best = choosePhotoFile(content.photo.sizes);
    if (!best) return null;
    const localPath = await downloadFile(callTd, best.file_id);
    if (!localPath) return null;
    return await copyToMedia(localPath, chatId, `${message.id}${path.extname(localPath) || ".jpg"}`);
  }

  if (content._ === "messageVideo" && content.video?.thumbnail?.file?.id) {
    const cached = await findExistingMedia(chatId, `${message.id}_thumb`);
    if (cached) return cached;
    const fileId = content.video.thumbnail.file.id;
    const localPath = await downloadFile(callTd, fileId);
    if (!localPath) return null;
    return await copyToMedia(localPath, chatId, `${message.id}_thumb${path.extname(localPath) || ".jpg"}`);
  }

  return null;
}

function choosePhotoFile(sizes) {
  if (!Array.isArray(sizes) || sizes.length === 0) return null;
  const target = 400;
  let best = null;
  let bestDiff = Infinity;
  for (const size of sizes) {
    const fileId = size?.photo?.id;
    const width = size?.width;
    if (!fileId || !Number.isFinite(width)) continue;
    const diff = Math.abs(width - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = { file_id: fileId };
    }
  }
  return best;
}

async function downloadFile(callTd, fileId) {
  try {
    const file = await callTd({
      method: "downloadFile",
      params: { file_id: fileId, priority: 1, offset: 0, limit: 0, synchronous: true },
      responses: []
    });
    const localPath = file?.local?.path;
    if (localPath) return localPath;
    return null;
  } catch (error) {
    abortOnFlood(error);
    return null;
  }
}

async function copyToMedia(srcPath, chatId, filename) {
  try {
    await fs.mkdir(path.join(MEDIA_ROOT, String(chatId)), { recursive: true });
    const targetPath = path.join(MEDIA_ROOT, String(chatId), filename);
    try {
      await fs.access(targetPath);
      return targetPath; // уже есть, не перезаписываем
    } catch (_) {
      // fall through to copy
    }
    await fs.copyFile(srcPath, targetPath);
    return targetPath;
  } catch (error) {
    return null;
  }
}

async function findExistingMedia(chatId, namePrefix) {
  try {
    const dir = path.join(MEDIA_ROOT, String(chatId));
    const entries = await fs.readdir(dir);
    const found = entries.find((file) => file.startsWith(namePrefix));
    if (found) {
      return path.join(dir, found);
    }
  } catch (_) {
    return null;
  }
  return null;
}

function isVoiceOrCircle(message) {
  const kind = message?.content?._;
  return kind === "messageVoiceNote" || kind === "messageVideoNote";
}

function extractSpeechText(message) {
  const note = message?.content?.voice_note || message?.content?.video_note;
  const result = note?.speech_recognition_result;
  if (!result) return null;
  if (result._ === "speechRecognitionResultText") {
    return result.text || null;
  }
  return null;
}

function transcriptionKey(chatId, messageId) {
  return `${chatId}:${messageId}`;
}

function resolvePendingTranscription(chatId, messageId, text) {
  const key = transcriptionKey(chatId, messageId);
  const pending = pendingTranscriptions.get(key);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingTranscriptions.delete(key);
  pending.resolve(text || null);
}

function cancelPendingTranscription(chatId, messageId) {
  const key = transcriptionKey(chatId, messageId);
  const pending = pendingTranscriptions.get(key);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingTranscriptions.delete(key);
  pending.resolve(null);
}

function waitForTranscription(chatId, messageId) {
  const key = transcriptionKey(chatId, messageId);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingTranscriptions.delete(key);
      resolve(null);
    }, SPEECH_WAIT_TIMEOUT_MS);
    pendingTranscriptions.set(key, { resolve, timer });
  });
}

function maybeResolveTranscriptionFromUpdate(update) {
  if (!update || typeof update !== "object") return;
  let chatId = null;
  let messageId = null;
  let content = null;

  switch (update._) {
    case "updateMessageContent":
      chatId = update.chat_id;
      messageId = update.message_id;
      content = update.new_content;
      break;
    case "updateNewMessage":
      chatId = update.message?.chat_id;
      messageId = update.message?.id;
      content = update.message?.content;
      break;
    default:
      return;
  }

  if (!chatId || !messageId || !content) return;
  const text = extractSpeechText({ content });
  if (text) {
    resolvePendingTranscription(chatId, messageId, text);
  }
}

async function ensureTranscription(callTd, message) {
  const initial = extractSpeechText(message);
  if (initial) return initial;
  if (!isVoiceOrCircle(message)) return null;

  const chatId = message.chat_id;
  const messageId = message.id;
  if (!chatId || !messageId) return null;
  const waitPromise = waitForTranscription(chatId, messageId);
  try {
    await callTd({
      method: "recognizeSpeech",
      params: { chat_id: chatId, message_id: messageId },
      responses: []
    });
  } catch (error) {
    abortOnFlood(error);
    cancelPendingTranscription(chatId, messageId);
    return null;
  }
  const textFromUpdate = await waitPromise;
  if (textFromUpdate) return textFromUpdate;

  // Одно финальное чтение, если апдейт не пришёл вовремя
  try {
    const fresh = await callTd({
      method: "getMessage",
      params: { chat_id: chatId, message_id: messageId },
      responses: []
    });
    return extractSpeechText(fresh);
  } catch (error) {
    abortOnFlood(error);
    return null;
  }
}

async function main() {
  const stageStartedAt = nowIso();
  let client = null;
  const {
    db,
    upsertChannel,
    upsertMessagesJson,
    upsertCommentsJson,
    upsertSimilarJson,
    upsertRefresh,
    getRefresh,
    getChannel,
    getChannelByUsername
  } = initDb(DB_PATH);

  try {
    await ensureDirectories();
    client = createClient();
    client.on("error", console.error);
    attachUpdateCollector(client);
    await login(client);
    const callTd = createTdCaller(client);

    const channelNames = await readChannelList(CHANNEL_LIST_FILE);
    rknUsernames = new Set(channelNames.map((name) => normalizeUsername(name)).filter(Boolean));
    if (channelNames.length === 0) {
      console.log("Список каналов пуст, ничего не делаю.");
      return;
    }

    for (const channelName of channelNames) {
      updatesByChannel.set(channelName, []);
      currentChannel = channelName;
      logInfo(`Начинаю ${channelName}`);

      const existing = getChannelByUsername.get(channelName);
      const existingChatId = existing?.chat_id;
      if (!FORCE_REFRESH && STALE_SECONDS === null && allEntitiesFresh(getRefresh, existingChatId)) {
        logInfo(`Пропускаю ${channelName}: всё актуально (chat_id=${existingChatId || "n/a"})`);
        updatesByChannel.set(channelName, []);
        currentChannel = null;
        continue;
      }

      try {
        const isRknFlag = true; // все из списка l.txt считаем is_rkn=true

        // searchPublicChat — делаем всегда, чтобы получить chat_id и свежие данные
        const chat = await callTdWithDelay(callTd, {
          method: "searchPublicChat",
          params: { username: channelName },
          responses: []
        });
        if (!chat || !chat.id) {
          throw new Error("Чат не найден");
        }
        applyChatToChannel(upsertChannel, chat, isRknFlag);
        try {
          const chatDetails = await callTdWithDelay(callTd, {
            method: "getChat",
            params: { chat_id: chat.id },
            responses: []
          });
          applyChatToChannel(upsertChannel, chatDetails, isRknFlag);
          logInfo(`getChat ok: chat_id=${chat.id}`);
        } catch (_) {
          // ignore, searchPublicChat data already applied
        }
        touchRefresh(upsertRefresh, chat.id, "searchPublicChat", "success");
        logInfo(`searchPublicChat ok: chat_id=${chat.id}, title=${chat.title || ""}`);

        let supergroupId = null;
        if (isSupergroup(chat)) {
          supergroupId = chat.type.supergroup_id;
          if (isStale(getRefresh, chat.id, "getSupergroup")) {
            try {
              const supergroup = await callTdWithDelay(callTd, {
                method: "getSupergroup",
                params: { supergroup_id: supergroupId },
                responses: []
              });
              applySupergroupToChannel(upsertChannel, supergroup, chat.id);
              touchRefresh(upsertRefresh, chat.id, "getSupergroup", "success");
              logInfo(`getSupergroup ok: supergroup_id=${supergroupId}`);
            } catch (sgErr) {
              abortOnFlood(sgErr);
              touchRefresh(upsertRefresh, chat.id, "getSupergroup", "error", sgErr.code);
              logInfo(`getSupergroup error: ${sgErr.message || sgErr}`);
            }
          }
          if (isStale(getRefresh, chat.id, "getSupergroupFullInfo")) {
            try {
              const fullInfo = await callTdWithDelay(callTd, {
                method: "getSupergroupFullInfo",
                params: { supergroup_id: supergroupId },
                responses: []
              });
              applyFullInfoToChannel(upsertChannel, supergroupId, fullInfo, chat.id);
              touchRefresh(upsertRefresh, chat.id, "getSupergroupFullInfo", "success");
              logInfo(`fullInfo ok: supergroup_id=${supergroupId}`);
            } catch (fullErr) {
              abortOnFlood(fullErr);
              touchRefresh(upsertRefresh, chat.id, "getSupergroupFullInfo", "error", fullErr.code);
              logInfo(`fullInfo error: ${fullErr.message || fullErr}`);
            }
          }
        }

        // История сообщений пачкой в JSON
        if (isStale(getRefresh, chat.id, "getChatHistory")) {
          try {
            logInfo(`history request: chat_id=${chat.id}, limit=${HISTORY_FETCH_LIMIT}`);
            const { messages, batchStats, totalRaw } = await fetchMessages({
              callTd: (args) => callTdWithDelay(callTd, args),
              callTdFast: callTd,
              chatId: chat.id,
              limit: HISTORY_FETCH_LIMIT
            });
            const payload = {
              chat_id: chat.id,
              fetched_count: messages.length,
              fetched_raw: totalRaw,
              batches: batchStats,
              limit: HISTORY_FETCH_LIMIT,
              collected_at: nowIso(),
              messages
            };
            upsertMessagesJson.run({ chat_id: chat.id, messages_json: JSON.stringify(payload), collected_at: payload.collected_at });
            touchRefresh(upsertRefresh, chat.id, "getChatHistory", "success");
            logInfo(
              `history ok: chat_id=${chat.id}, fetched=${messages.length}/${HISTORY_FETCH_LIMIT}, raw=${totalRaw}, batches=${batchStats.length}`
            );
          } catch (histErr) {
            abortOnFlood(histErr);
            touchRefresh(upsertRefresh, chat.id, "getChatHistory", "error", histErr.code);
            logInfo(`history error: ${histErr.message || histErr}`);
          }
        }

        // Комментарии к свежему сообщению (только если есть linked_chat_id)
        if (isStale(getRefresh, chat.id, "comments")) {
          const channelRow = getChannel.get(chat.id);
          const linkedChatId = channelRow?.linked_chat_id;
          if (!linkedChatId) {
            upsertCommentsJson.run({ chat_id: chat.id, payload_json: JSON.stringify(null), collected_at: nowIso() });
            touchRefresh(upsertRefresh, chat.id, "comments", "success");
            logInfo(`comments skip: chat_id=${chat.id} нет linked_chat_id`);
          } else {
            const messagesPayload = db
              .prepare("SELECT messages_json FROM channel_messages WHERE chat_id = ?")
              .get(chat.id);
            let messagesList = [];
            if (messagesPayload?.messages_json) {
              try {
                const parsed = JSON.parse(messagesPayload.messages_json);
                messagesList = Array.isArray(parsed.messages) ? parsed.messages : [];
              } catch (_) {
                messagesList = [];
              }
            }
            const candidates = messagesList
              .filter((msg) => Number.isFinite(msg?.reply_count) && msg.reply_count > 0)
              .sort((a, b) => (b.reply_count || 0) - (a.reply_count || 0))
              .slice(0, 5);

            const totalReplies = candidates.reduce((sum, msg) => sum + (msg.reply_count || 0), 0);

            if (candidates.length === 0) {
              upsertCommentsJson.run({ chat_id: chat.id, payload_json: JSON.stringify(null), collected_at: nowIso() });
              touchRefresh(upsertRefresh, chat.id, "comments", "success");
              logInfo(`comments skip: chat_id=${chat.id} нет сообщений с reply_count>0`);
            } else if (totalReplies < 30) {
              upsertCommentsJson.run({ chat_id: chat.id, payload_json: JSON.stringify(null), collected_at: nowIso() });
              touchRefresh(upsertRefresh, chat.id, "comments", "success");
              logInfo(`comments skip: chat_id=${chat.id} суммарно мало комментариев (replies=${totalReplies})`);
            } else {
              const collected = [];
              const usedRoots = [];
              for (const candidate of candidates) {
                if (collected.length >= COMMENT_TOTAL_TARGET) break;
                try {
                  logInfo(`comments fetch start: chat_id=${chat.id} msg=${candidate.id} replies=${candidate.reply_count}`);
                  const threadInfo = await callTdWithDelay(callTd, {
                    method: "getMessageThread",
                    params: { chat_id: chat.id, message_id: candidate.id },
                    responses: []
                  });
                  const sinceTimestamp = Math.floor(Date.now() / 1000) - COMMENT_MAX_AGE_SECONDS;
                  const threadChatId = threadInfo?.chat_id || linkedChatId || chat.id;
                  const threadMessageId = threadInfo?.message_thread_id || candidate.id;
                  const remaining = Math.max(0, COMMENT_TOTAL_TARGET - collected.length);
                  const comments = await fetchComments({
                    callTd: (args) => callTdWithDelay(callTd, args),
                    chatId: threadChatId,
                    rootMessageId: threadMessageId,
                    sinceTimestamp,
                    limit: Math.min(remaining, COMMENT_LIMIT_MAX)
                  });
                  if (comments.length > 0) {
                    collected.push(...comments);
                    usedRoots.push(candidate.id);
                    logInfo(`comments chunk: chat_id=${chat.id} msg=${candidate.id} got=${comments.length} total=${collected.length}`);
                  } else {
                    logInfo(`comments chunk empty: chat_id=${chat.id} msg=${candidate.id}`);
                  }
                } catch (err) {
                  abortOnFlood(err);
                  logInfo(`comments error: chat_id=${chat.id} msg=${candidate.id} ${err.message || err}`);
                }
              }

              const payloadJson = collected.length > 0 ? JSON.stringify(collected) : JSON.stringify(null);
              upsertCommentsJson.run({ chat_id: chat.id, payload_json: payloadJson, collected_at: nowIso() });
              touchRefresh(upsertRefresh, chat.id, "comments", "success");
              logInfo(
                `comments done: chat_id=${chat.id}, fetched=${collected.length}/${COMMENT_TOTAL_TARGET}, roots=${usedRoots.join(",") || "none"}`
              );
            }
          }
        }

        // Похожие каналы
        if (isStale(getRefresh, chat.id, "getChatSimilarChats")) {
          try {
            logInfo(`similar request: chat_id=${chat.id}`);
            const response = await callTdWithDelay(callTd, {
              method: "getChatSimilarChats",
              params: { chat_id: chat.id },
              responses: []
            });
            const items = Array.isArray(response?.chat_ids)
              ? response.chat_ids
              : Array.isArray(response?.chats)
              ? response.chats
              : Array.isArray(response)
              ? response
              : [];
            const collectedAt = nowIso();
            upsertSimilarJson.run({ chat_id: chat.id, items_json: JSON.stringify(items), collected_at: collectedAt });
            upsertChannel.run({ chat_id: chat.id, similar_count: Array.isArray(items) ? items.length : null });
            touchRefresh(upsertRefresh, chat.id, "getChatSimilarChats", "success");
            logInfo(`similar ok: chat_id=${chat.id}, count=${Array.isArray(items) ? items.length : 0}`);
          } catch (similarErr) {
            abortOnFlood(similarErr);
            touchRefresh(upsertRefresh, chat.id, "getChatSimilarChats", "error", similarErr.code);
            logInfo(`similar error: ${similarErr.message || similarErr}`);
          }
        }

        // Применяем все накопленные апдейты за время цикла
        const rawUpdates = updatesByChannel.get(channelName) || [];
        const extraIds = [];
        if (supergroupId) extraIds.push(supergroupId);
        // Добавляем идентификаторы похожих каналов, чтобы не терять их апдейты
        const similarRow = db.prepare("SELECT items_json FROM channel_similar WHERE chat_id = ?").get(chat.id);
        if (similarRow?.items_json) {
          try {
            const parsed = JSON.parse(similarRow.items_json);
            if (Array.isArray(parsed)) {
              for (const pair of parsed) {
                if (!Array.isArray(pair)) continue;
                const [cid, sgid] = pair;
                if (typeof cid === "number") extraIds.push(cid);
                if (typeof sgid === "number") extraIds.push(sgid);
              }
            }
          } catch (_) {
            // ignore parse errors
          }
        }
        const filteredUpdates = filterUpdatesForChat(rawUpdates, chat, extraIds);
        logInfo(`apply updates: chat_id=${chat.id}, collected=${rawUpdates.length}, filtered=${filteredUpdates.length}`);
        for (const update of filteredUpdates) {
          applyUpdate(upsertChannel, update, chat?.id, supergroupId);
        }
      } catch (error) {
        abortOnFlood(error);
        logInfo(`Ошибка по ${channelName}: ${error.message || error}`);
      } finally {
        updatesByChannel.set(channelName, []);
        currentChannel = null;
      }
    }
  } catch (error) {
    const ts = nowIso();
    console.error(`Скрипт завершился с ошибкой (${ts}):`, error.message || error);
  } finally {
    currentChannel = null;
    if (client) {
      try {
        await client.close();
      } catch (closeError) {
        console.error("Ошибка при закрытии клиента:", closeError);
      }
    }
    console.log(`Стадия refresh завершена (начало ${stageStartedAt}).`);
  }
}

main();

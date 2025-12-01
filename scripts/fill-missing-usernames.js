"use strict";

/**
 * Добивает пропущенные поля каналов (username, verified, counts, date, linked-флаги) через TDLib.
 * Работает с базой, на которую указывает CHANNEL_DB_PATH (или дефолт DB_PATH).
 */

const { DatabaseSync } = require("node:sqlite");
const { createClient, login, createTdCaller, ensureDirectories } = require("../tdlib-helpers");
const path = require("node:path");
const { DB_PATH } = require("../src/config/paths");

const EFFECTIVE_DB_PATH = process.env.CHANNEL_DB_PATH
  ? path.resolve(process.cwd(), process.env.CHANNEL_DB_PATH)
  : DB_PATH;

const REQUEST_DELAY_MS = Number(process.env.FILL_USERNAME_DELAY_MS || 3000);

function boolToInt(value) {
  return value ? 1 : 0;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logInfo(message, ...args) {
  console.log(`[fill-usernames] ${message}`, ...args);
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

function applyChatToChannel(upsertChannel, chat) {
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
    supergroup_id: chat.type?._ === "chatTypeSupergroup" ? chat.type.supergroup_id : null,
    active_username: primaryUsername,
    is_verified: isVerified,
    member_count: chat.member_count ?? null,
    reactions_disabled: null
  };
  upsertChannel.run(params);
}

function applyFullInfoToChannel(upsertChannel, supergroupId, fullInfo, chatIdOverride = null) {
  if (!fullInfo || typeof supergroupId !== "number") return;
  const photoIds = extractPhotoIds(fullInfo.photo);
  const chatId = chatIdOverride || -1000000000000 - Number(supergroupId);
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
    photo_big_unique_id: photoIds.photo_big_unique_id
  };
  upsertChannel.run(params);
}

function applySupergroupToChannel(upsertChannel, supergroup, chatIdOverride = null) {
  if (!supergroup || typeof supergroup.id !== "number") return;
  const params = {
    chat_id: chatIdOverride || -1000000000000 - Number(supergroup.id),
    supergroup_id: supergroup.id,
    active_username:
      Array.isArray(supergroup.usernames?.active_usernames) && supergroup.usernames.active_usernames.length > 0
        ? supergroup.usernames.active_usernames[0]
        : null,
    is_verified:
      typeof supergroup.verification_status?.is_verified === "boolean"
        ? boolToInt(supergroup.verification_status.is_verified)
        : null,
    member_count: supergroup.member_count ?? null,
    boost_level: supergroup.boost_level ?? null,
    date: supergroup.date ?? null,
    has_direct_messages_group:
      typeof supergroup.has_direct_messages_group === "boolean" ? boolToInt(supergroup.has_direct_messages_group) : null,
    has_linked_chat: typeof supergroup.has_linked_chat === "boolean" ? boolToInt(supergroup.has_linked_chat) : null
  };
  upsertChannel.run(params);
}

async function main() {
  await ensureDirectories();

  logInfo(`Использую базу: ${EFFECTIVE_DB_PATH}`);

  const db = new DatabaseSync(EFFECTIVE_DB_PATH);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA synchronous=NORMAL;");

  const rows = db
    .prepare(
      `SELECT chat_id, supergroup_id
       FROM channels
       WHERE (supergroup_id IS NOT NULL OR chat_id <= -1000000000000)
         AND (
           active_username IS NULL OR active_username = ''
           OR date IS NULL
           OR has_direct_messages_group IS NULL
           OR has_linked_chat IS NULL
           OR member_count IS NULL
           OR boost_level IS NULL
         )`
    )
    .all();

  if (rows.length === 0) {
    console.log("Нет каналов с пустым username.");
    return;
  }

  const upsertChannel = db.prepare(`
    INSERT INTO channels (
      chat_id, title, supergroup_id, boost_level, date, has_direct_messages_group, has_linked_chat,
      member_count, active_username, is_verified, description, direct_messages_chat_id, gift_count,
      linked_chat_id, outgoing_paid_message_star_count, photo_small_id, photo_small_unique_id,
      photo_big_id, photo_big_unique_id, reactions_disabled, similar_count, updated_at, is_rkn
    ) VALUES (
      @chat_id, @title, @supergroup_id, @boost_level, @date, @has_direct_messages_group, @has_linked_chat,
      @member_count, @active_username, @is_verified, @description, @direct_messages_chat_id, @gift_count,
      @linked_chat_id, @outgoing_paid_message_star_count, @photo_small_id, @photo_small_unique_id,
      @photo_big_id, @photo_big_unique_id, @reactions_disabled, @similar_count, datetime('now'), @is_rkn
    )
    ON CONFLICT(chat_id) DO UPDATE SET
      supergroup_id=COALESCE(excluded.supergroup_id, channels.supergroup_id),
      boost_level=COALESCE(excluded.boost_level, channels.boost_level),
      date=COALESCE(excluded.date, channels.date),
      has_direct_messages_group=COALESCE(excluded.has_direct_messages_group, channels.has_direct_messages_group),
      has_linked_chat=COALESCE(excluded.has_linked_chat, channels.has_linked_chat),
      member_count=COALESCE(excluded.member_count, channels.member_count),
      active_username=COALESCE(excluded.active_username, channels.active_username),
      is_verified=COALESCE(excluded.is_verified, channels.is_verified),
      updated_at=datetime('now');
  `);

  const client = createClient();
  client.on("error", console.error);
  await login(client);
  const callTd = createTdCaller(client);

  for (const row of rows) {
    const chatId = row.chat_id;
    const sgId = Number.isFinite(row.supergroup_id) ? row.supergroup_id : chatId < 0 ? -chatId - 1000000000000 : null;
    if (!Number.isFinite(sgId)) {
      logInfo(`Пропуск chat_id=${chatId}: нет supergroup_id`);
      continue;
    }

    try {
      logInfo(`Запрос chat_id=${chatId} / supergroup_id=${sgId}`);

      // getChat для обновления title/username и уточнения supergroup_id
      try {
        const chat = await callTd({
          method: "getChat",
          params: { chat_id: chatId },
          responses: []
        });
        applyChatToChannel(upsertChannel, chat);
        logInfo(`getChat ok: chat_id=${chatId}, username=${chat?.usernames?.active_usernames?.[0] || ""}`);
      } catch (err) {
        console.warn(`getChat failed for ${chatId}: ${err.message || err}`);
      }

      if (REQUEST_DELAY_MS > 0) await delay(REQUEST_DELAY_MS);

      const supergroup = await callTd({
        method: "getSupergroup",
        params: { supergroup_id: sgId },
        responses: []
      });
      applySupergroupToChannel(upsertChannel, supergroup, chatId);
      logInfo(`getSupergroup ok: supergroup_id=${sgId}, username=${supergroup?.usernames?.active_usernames?.[0] || ""}`);

      if (REQUEST_DELAY_MS > 0) await delay(REQUEST_DELAY_MS);

      try {
        const fullInfo = await callTd({
          method: "getSupergroupFullInfo",
          params: { supergroup_id: sgId },
          responses: []
        });
        applyFullInfoToChannel(upsertChannel, sgId, fullInfo, chatId);
        logInfo(`getSupergroupFullInfo ok: supergroup_id=${sgId}`);
      } catch (err) {
        console.warn(`getSupergroupFullInfo failed for ${sgId}: ${err.message || err}`);
      }
    } catch (err) {
      console.warn(`getSupergroup failed for ${sgId}: ${err.message || err}`);
    }

    if (REQUEST_DELAY_MS > 0) {
      await delay(REQUEST_DELAY_MS);
    }
  }

  try {
    await client.close();
  } catch (_) {
    // ignore
  }
}

main().catch((error) => {
  console.error("fill-missing-usernames failed:", error.message || error);
  process.exitCode = 1;
});

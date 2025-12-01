"use strict";

/**
 * Добивает пропущенные поля в таблице channels по chat_id/supergroup_id,
 * не трогая историю/комменты. Берёт все строки, где boost_level или
 * has_linked_chat = NULL и при этом есть supergroup_id.
 */

const { DatabaseSync } = require("node:sqlite");
const { createClient, login, createTdCaller, ensureDirectories } = require("../tdlib-helpers");
const { DB_PATH } = require("../src/config/paths");

const REQUEST_DELAY_MS = Number(process.env.FILL_SUPERGROUP_DELAY_MS || 3000);

function boolToInt(value) {
  return value ? 1 : 0;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logInfo(message, ...args) {
  console.log(`[fill] ${message}`, ...args);
}

function toChatIdFromSupergroup(supergroupId) {
  if (!Number.isFinite(supergroupId)) return null;
  return -1000000000000 - Number(supergroupId);
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
    photo_big_unique_id: photoIds.photo_big_unique_id
  };
  upsertChannel.run(params);
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
    is_verified: isVerified
  };
  upsertChannel.run(params);
}

async function main() {
  await ensureDirectories();
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA synchronous=NORMAL;");

  const missing = db
    .prepare(
      `SELECT chat_id, supergroup_id
       FROM channels
       WHERE (boost_level IS NULL OR has_linked_chat IS NULL)
         AND supergroup_id IS NOT NULL`
    )
    .all();

  if (missing.length === 0) {
    console.log("Нет строк для дозаполнения.");
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
      supergroup_id=excluded.supergroup_id,
      boost_level=COALESCE(excluded.boost_level, channels.boost_level),
      date=COALESCE(excluded.date, channels.date),
      has_direct_messages_group=COALESCE(excluded.has_direct_messages_group, channels.has_direct_messages_group),
      has_linked_chat=COALESCE(excluded.has_linked_chat, channels.has_linked_chat),
      member_count=COALESCE(excluded.member_count, channels.member_count),
      active_username=COALESCE(excluded.active_username, channels.active_username),
      is_verified=COALESCE(excluded.is_verified, channels.is_verified),
      description=COALESCE(excluded.description, channels.description),
      direct_messages_chat_id=COALESCE(excluded.direct_messages_chat_id, channels.direct_messages_chat_id),
      gift_count=COALESCE(excluded.gift_count, channels.gift_count),
      linked_chat_id=COALESCE(excluded.linked_chat_id, channels.linked_chat_id),
      outgoing_paid_message_star_count=COALESCE(excluded.outgoing_paid_message_star_count, channels.outgoing_paid_message_star_count),
      photo_small_id=COALESCE(excluded.photo_small_id, channels.photo_small_id),
      photo_small_unique_id=COALESCE(excluded.photo_small_unique_id, channels.photo_small_unique_id),
      photo_big_id=COALESCE(excluded.photo_big_id, channels.photo_big_id),
      photo_big_unique_id=COALESCE(excluded.photo_big_unique_id, channels.photo_big_unique_id),
      reactions_disabled=COALESCE(excluded.reactions_disabled, channels.reactions_disabled),
      updated_at=datetime('now')
  `);

  const client = createClient();
  client.on("error", console.error);
  await login(client);
  const callTd = createTdCaller(client);

  for (const row of missing) {
    const chatId = row.chat_id;
    let sgId = row.supergroup_id;
    console.log(`Фиксим chat_id=${chatId} supergroup_id=${sgId}`);

    // Сначала getChat, чтобы обновить username/verified и актуализировать supergroup_id.
    try {
      const chat = await callTd({
        method: "getChat",
        params: { chat_id: chatId },
        responses: []
      });
      applyChatToChannel(upsertChannel, chat);
      if (chat?.type?._ === "chatTypeSupergroup" && Number.isFinite(chat.type.supergroup_id)) {
        sgId = chat.type.supergroup_id;
      }
      logInfo(`getChat ok: chat_id=${chatId}, username=${chat?.usernames?.active_usernames?.[0] || ""}`);
    } catch (err) {
      console.warn(`getChat failed for ${chatId}: ${err.message || err}`);
    }

    if (!Number.isFinite(sgId)) {
      console.warn(`Skip chat_id=${chatId} — нет supergroup_id`);
      await delay(1000);
      continue;
    }

    await delay(REQUEST_DELAY_MS);

    try {
      const supergroup = await callTd({
        method: "getSupergroup",
        params: { supergroup_id: sgId },
        responses: []
      });
      applySupergroupToChannel(upsertChannel, supergroup, chatId);
      logInfo(`getSupergroup ok: supergroup_id=${sgId}`);
    } catch (err) {
      console.warn(`getSupergroup failed for ${sgId}: ${err.message || err}`);
    }

    await delay(REQUEST_DELAY_MS);

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

    await delay(REQUEST_DELAY_MS);
  }

  console.log("Готово.");
  client.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

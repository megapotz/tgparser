"use strict";

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const tdl = require("tdl");
const { CHANNEL_LIST_FILE, TD_LIB_PATH, TDLIB_DATABASE_DIR, TDLIB_FILES_DIR } = require("./src/config/paths");

const API_ID = Number(process.env.TELEGRAM_API_ID || 2749123);
const API_HASH = process.env.TELEGRAM_API_HASH || "1cdcd76b0683d0e66570bcb5e453350d";
const HISTORY_LIMIT = Number(process.env.CHANNEL_HISTORY_LIMIT || 100);
const COMMENTS_LIMIT = Number(process.env.CHANNEL_COMMENTS_LIMIT || 100);
const OUTPUT_ROOT = process.env.CHANNEL_OUTPUT_ROOT || process.cwd();
const OUTPUT_SUBDIR = process.env.CHANNEL_OUTPUT_SUBDIR || "full";

const tdDatabaseDir = TDLIB_DATABASE_DIR;
const tdFilesDir = TDLIB_FILES_DIR;

if (TD_LIB_PATH && fsSync.existsSync(TD_LIB_PATH)) {
  tdl.configure({ tdjson: TD_LIB_PATH });
} else if (process.env.TDLIB_PATH) {
  console.warn(`Предупреждение: файл TDLib по пути ${TD_LIB_PATH} не найден. Будет использован поиск по системным путям.`);
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function ensureDirectories() {
  await fs.mkdir(tdDatabaseDir, { recursive: true });
  await fs.mkdir(tdFilesDir, { recursive: true });
}

function createClient() {
  return tdl.createClient({
    apiId: API_ID,
    apiHash: API_HASH,
    databaseDirectory: tdDatabaseDir,
    filesDirectory: tdFilesDir,
    tdlibParameters: {
      use_test_dc: false,
      use_file_database: true,
      use_chat_info_database: true,
      use_message_database: true,
      use_secret_chats: false,
      system_language_code: "ru",
      device_model: `nodejs ${process.version}`,
      system_version: `${process.platform} ${process.arch}`,
      application_version: "0.1.0",
      enable_storage_optimizer: true,
      ignore_file_names: false
    }
  });
}

async function login(client) {
  await client.login(async (retry) => {
    if (retry?.error) {
      console.error("Ошибка авторизации:", retry.error.message || retry.error);
    }

    return {
      type: "user",
      getPhoneNumber: async () => {
        const phone = await ask("Введите номер телефона в международном формате: ");
        return phone;
      },
      getAuthCode: async () => {
        const code = await ask("Введите код из Telegram: ");
        return code;
      },
      getPassword: async () => {
        const password = await ask("Введите пароль двухфакторной аутентификации (если не установлен, оставьте пустым): ");
        return password || undefined;
      }
    };
  });
}

async function readChannelList(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function responseEntry(method, params, payload, error) {
  const entry = {
    method,
    params,
    timestamp: new Date().toISOString()
  };

  if (typeof payload !== "undefined") {
    entry.response = payload;
  }

  if (error) {
    entry.error = {
      message: error.message,
      code: error.code,
      data: error.data
    };
  }

  return entry;
}

function createTdCaller(client) {
  return async function callTd({ method, params, responses, suppressError = false }) {
    console.log(`TDLib -> ${method}`);

    try {
      const payload = await client.invoke({ _: method, ...params });
      responses.push(responseEntry(method, params, payload));
      return payload;
    } catch (error) {
      responses.push(responseEntry(method, params, undefined, error));
      if (suppressError) {
        return null;
      }
      throw error;
    }
  };
}

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectChatIdentifiers(chat) {
  const identifiers = new Set();
  if (!chat || typeof chat !== "object") {
    return identifiers;
  }

  if (typeof chat.id === "number") {
    identifiers.add(chat.id);
  }

  const type = chat.type;
  if (!type || typeof type !== "object") {
    return identifiers;
  }

  switch (type._) {
    case "chatTypePrivate":
      if (typeof type.user_id === "number") {
        identifiers.add(type.user_id);
      }
      break;
    case "chatTypeBasicGroup":
      if (typeof type.basic_group_id === "number") {
        identifiers.add(type.basic_group_id);
      }
      break;
    case "chatTypeSupergroup":
      if (typeof type.supergroup_id === "number") {
        identifiers.add(type.supergroup_id);
      }
      break;
    case "chatTypeSecret":
      if (typeof type.secret_chat_id === "number") {
        identifiers.add(type.secret_chat_id);
      }
      if (typeof type.user_id === "number") {
        identifiers.add(type.user_id);
      }
      break;
    default:
      break;
  }

  return identifiers;
}

function hasRelevantIdentifier(payload, identifiers) {
  if (!payload || identifiers.size === 0) {
    return false;
  }

  const stack = [payload];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === "number" && identifiers.has(current)) {
      return true;
    }

    if (Array.isArray(current)) {
      for (const item of current) {
        stack.push(item);
      }
    } else if (current && typeof current === "object") {
      for (const value of Object.values(current)) {
        stack.push(value);
      }
    }
  }

  return false;
}

function filterUpdatesForChat(updates, chat, extraIdentifiers = []) {
  if (!Array.isArray(updates) || updates.length === 0 || !chat) {
    return [];
  }

  const identifiers = collectChatIdentifiers(chat);
  for (const id of extraIdentifiers) {
    if (typeof id === "number") {
      identifiers.add(id);
    }
  }

  if (identifiers.size === 0) {
    return [];
  }

  const filtered = updates.filter((update) => hasRelevantIdentifier(update, identifiers));
  return keepOnlyLatestUpdates(filtered);
}

function buildUpdateSignature(update, fallbackKey = "") {
  if (!update || typeof update !== "object") {
    return `unknown:${fallbackKey}`;
  }

  const type = update._ || "unknown";
  const chatId = typeof update.chat_id === "number" ? update.chat_id : update.chat?.id;
  if (typeof chatId === "number") {
    return `${type}:chat:${chatId}`;
  }

  const supergroupId = update.supergroup?.id;
  if (typeof supergroupId === "number") {
    return `${type}:supergroup:${supergroupId}`;
  }

  const userId = update.user?.id;
  if (typeof userId === "number") {
    return `${type}:user:${userId}`;
  }

  const messageChatId = update.message?.chat_id;
  const messageId = update.message?.id;
  if (typeof messageChatId === "number" && typeof messageId === "number") {
    return `${type}:message:${messageChatId}:${messageId}`;
  }

  const optionName = typeof update.name === "string" ? update.name : undefined;
  if (type === "updateOption" && optionName) {
    return `${type}:option:${optionName}`;
  }

  return `${type}:fallback:${fallbackKey}`;
}

function keepOnlyLatestUpdates(updates) {
  if (!Array.isArray(updates) || updates.length === 0) {
    return [];
  }

  const seen = new Set();
  const deduped = [];
  for (let idx = updates.length - 1; idx >= 0; idx -= 1) {
    const update = updates[idx];
    const signature = buildUpdateSignature(update, idx);
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    deduped.push(update);
  }

  return deduped.reverse();
}

module.exports = {
  API_ID,
  API_HASH,
  TD_LIB_PATH,
  CHANNEL_LIST_FILE,
  HISTORY_LIMIT,
  COMMENTS_LIMIT,
  OUTPUT_ROOT,
  OUTPUT_SUBDIR,
  tdDatabaseDir,
  tdFilesDir,
  ensureDirectories,
  createClient,
  login,
  readChannelList,
  createTdCaller,
  writeJson,
  delay,
  filterUpdatesForChat,
  keepOnlyLatestUpdates
};

"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { DB_PATH, CHANNEL_LIST_FILE } = require("../src/config/paths");

async function main() {
  const db = new DatabaseSync(DB_PATH);
  const rows = db
    .prepare(
      `SELECT c.active_username AS username
       FROM channel_messages cm
       JOIN channels c ON c.chat_id = cm.chat_id
       WHERE json_array_length(json_extract(cm.messages_json, '$.messages')) = 1
         AND c.active_username IS NOT NULL
         AND c.active_username != ''`
    )
    .all();

  if (!Array.isArray(rows) || rows.length === 0) {
    console.log("Нет каналов с одним сообщением.");
    db.close();
    return;
  }

  const tmpDir = path.join(process.cwd(), "tmp");
  await fs.mkdir(tmpDir, { recursive: true });
  const targetListPath = path.join(tmpDir, "refetch-single.txt");
  const names = Array.from(new Set(rows.map((r) => r.username.trim()))).filter(Boolean);
  await fs.writeFile(targetListPath, names.join("\n") + "\n", "utf8");

  console.log(`Найдено ${names.length} каналов. Список: ${targetListPath}`);
  console.log("Запускаю refresh только для истории и комментариев...");

  const child = spawn(
    process.execPath,
    [path.join(process.cwd(), "src", "refresh-monthly.js")],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        CHANNEL_LIST_FILE: targetListPath,
        CHANNEL_REFRESH_ONLY: "getChatHistory,comments",
        CHANNEL_FORCE_REFRESH: "true"
      }
    }
  );

  child.on("exit", (code) => {
    db.close();
    if (code === 0) {
      console.log("Refetch завершён успешно.");
    } else {
      console.error(`Refetch завершился с кодом ${code}`);
    }
  });
}

main().catch((error) => {
  console.error("Ошибка в refetch-single-message:", error.message || error);
  process.exitCode = 1;
});

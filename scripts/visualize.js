"use strict";

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const url = require("node:url");
const { DatabaseSync } = require("node:sqlite");
const { DB_PATH, MEDIA_ROOT } = require("../src/config/paths");

const PORT = Number(process.env.PORT || 3000);
const STATIC_DIR = path.join(__dirname, "..", "visualizer");

const db = new DatabaseSync(DB_PATH);

function safeParse(json) {
  try {
    return JSON.parse(json);
  } catch (_) {
    return null;
  }
}

function toIso(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return new Date(value * 1000).toISOString();
  if (typeof value === "string") {
    const normalized = value.includes("T") ? value : `${value}Z`;
    const dt = new Date(normalized);
    if (!Number.isNaN(dt.getTime())) return dt.toISOString();
  }
  return null;
}

function mediaUrl(localPath) {
  if (!localPath || typeof localPath !== "string") return null;
  const rel = path.relative(MEDIA_ROOT, localPath).split(path.sep).join("/");
  return `/media/${rel}`;
}

function normalizeMessage(msg) {
  const reactionsTotal = msg?.reactions?.total || 0;
  const replies = msg?.reply_count || 0;
  const forwards = msg?.forward_count || 0;
  const views = msg?.view_count || 0;
  const interactions = reactionsTotal + replies + forwards;
  const er = views > 0 ? interactions / views : null;
  const text = msg?.text_markdown || msg?.transcription || "";

  return {
    id: msg?.id,
    date: toIso(msg?.date),
    content_type: msg?.content_type || "unknown",
    text_preview: text ? text.slice(0, 400) : null,
    transcription: msg?.transcription || null,
    view_count: views || null,
    reactions_total: reactionsTotal || null,
    reply_count: replies || null,
    forward_count: forwards || null,
    er,
    is_ad: Boolean(msg?.is_ad),
    image_urls: Array.isArray(msg?.image_urls) ? msg.image_urls : [],
    media_url: mediaUrl(msg?.media_local_path)
  };
}

function loadMessages(chatId) {
  const row = db.prepare("SELECT messages_json FROM channel_messages WHERE chat_id = ? LIMIT 1;").get(chatId);
  const parsed = safeParse(row?.messages_json) || {};
  const list = Array.isArray(parsed.messages) ? parsed.messages : [];
  return list.map(normalizeMessage);
}

function channelSummary(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      total: 0,
      avg_views: null,
      avg_er: null,
      ads: 0,
      types: []
    };
  }

  let viewSum = 0;
  let erSum = 0;
  let erCount = 0;
  let ads = 0;
  const typeMap = new Map();

  for (const msg of messages) {
    if (msg.view_count) viewSum += msg.view_count;
    if (msg.er !== null && msg.er !== undefined) {
      erSum += msg.er;
      erCount += 1;
    }
    if (msg.is_ad) ads += 1;
    const key = msg.content_type || "unknown";
    const prev = typeMap.get(key) || { type: key, count: 0, erSum: 0, erCount: 0 };
    prev.count += 1;
    if (msg.er !== null && msg.er !== undefined) {
      prev.erSum += msg.er;
      prev.erCount += 1;
    }
    typeMap.set(key, prev);
  }

  const types = Array.from(typeMap.values()).map((entry) => ({
    type: entry.type,
    count: entry.count,
    avg_er: entry.erCount > 0 ? entry.erSum / entry.erCount : null
  }));

  return {
    total: messages.length,
    avg_views: viewSum / messages.length,
    avg_er: erCount > 0 ? erSum / erCount : null,
    ads,
    types
  };
}

function getChannelRow(chatId) {
  return db.prepare("SELECT * FROM channels WHERE chat_id = ? LIMIT 1;").get(chatId);
}

function listChannels() {
  const rows = db
    .prepare("SELECT chat_id, active_username, title, member_count, updated_at, is_rkn, reactions_disabled FROM channels ORDER BY title;")
    .all();

  return rows.map((row) => {
    const messages = loadMessages(row.chat_id);
    const summary = channelSummary(messages);
    return {
      chat_id: row.chat_id,
      active_username: row.active_username,
      title: row.title,
      member_count: row.member_count,
      updated_at: toIso(row.updated_at),
      is_rkn: row.is_rkn,
      reactions_disabled: row.reactions_disabled,
      summary
    };
  });
}

function channelDetail(chatId) {
  const channel = getChannelRow(chatId);
  if (!channel) return null;
  const messages = loadMessages(chatId);
  const summary = channelSummary(messages);
  return {
    channel: {
      chat_id: channel.chat_id,
      active_username: channel.active_username,
      title: channel.title,
      description: channel.description,
      member_count: channel.member_count,
      updated_at: toIso(channel.updated_at),
      is_rkn: channel.is_rkn,
      reactions_disabled: channel.reactions_disabled,
      similar_count: channel.similar_count,
      boost_level: channel.boost_level
    },
    messages,
    summary
  };
}

async function serveStatic(res, filePath) {
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const types = {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp"
    };
    const contentType = types[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  } catch (error) {
    res.writeHead(404);
    res.end("Not found");
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || "/";

  if (pathname.startsWith("/api/channels")) {
    if (pathname === "/api/channels") {
      const data = listChannels();
      return sendJson(res, 200, { channels: data });
    }

    const parts = pathname.split("/").filter(Boolean);
    const idPart = parts[2];
    const chatId = Number(idPart) || idPart;
    const detail = channelDetail(chatId);
    if (!detail) {
      return sendJson(res, 404, { error: "Channel not found" });
    }
    return sendJson(res, 200, detail);
  }

  if (pathname.startsWith("/media/")) {
    const rel = pathname.replace(/^\/media\//, "");
    const filePath = path.join(MEDIA_ROOT, rel);
    return serveStatic(res, filePath);
  }

  const staticPath = path.join(STATIC_DIR, pathname === "/" ? "index.html" : pathname.slice(1));
  return serveStatic(res, staticPath);
});

server.listen(PORT, () => {
  console.log(`Visualizer running at http://localhost:${PORT}`);
});

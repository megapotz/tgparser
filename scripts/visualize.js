"use strict";

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const url = require("node:url");
const { DatabaseSync } = require("node:sqlite");
const { DB_PATH, MEDIA_ROOT } = require("../src/config/paths");

const PORT = Number(process.env.PORT || 3000);
const STATIC_DIR = path.join(__dirname, "..", "visualizer");
const DAY_MS = 24 * 60 * 60 * 1000;

const db = new DatabaseSync(DB_PATH);

function safeParse(json) {
  try {
    return JSON.parse(json);
  } catch (_) {
    return null;
  }
}

function parseArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    const parsed = safeParse(value);
    if (Array.isArray(parsed)) return parsed;
    return value
      .split(/[,;]+/)
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
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
  const reactionsPaid = msg?.reactions?.paid || 0;
  const replies = msg?.reply_count || 0;
  const forwards = msg?.forward_count || 0;
  const views = msg?.view_count || 0;
  const interactions = reactionsTotal + replies + forwards;
  const er = views > 0 ? interactions / views : null;
  const text = msg?.text_markdown || msg?.transcription || "";
  const isoDate = toIso(msg?.date);

  return {
    id: msg?.id,
    date: isoDate,
    ts: isoDate ? new Date(isoDate).getTime() : null,
    content_type: msg?.content_type || "unknown",
    text_preview: text ? text.slice(0, 400) : null,
    transcription: msg?.transcription || null,
    view_count: views || null,
    reactions_total: reactionsTotal || null,
    reactions_paid: reactionsPaid || null,
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
  return list.map(normalizeMessage).filter((m) => m.id);
}

function channelSummary(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      total: 0,
      avg_views: null,
      avg_er: null,
      ads: 0,
      types: [],
      has_paid: false
    };
  }

  let viewSum = 0;
  let erSum = 0;
  let erCount = 0;
  let ads = 0;
   let hasPaid = false;
  const typeMap = new Map();

  for (const msg of messages) {
    if (msg.view_count) viewSum += msg.view_count;
    if (msg.er !== null && msg.er !== undefined) {
      erSum += msg.er;
      erCount += 1;
    }
    if (msg.is_ad) ads += 1;
    if (!hasPaid && (msg.reactions_paid || 0) > 0) hasPaid = true;
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
    types,
    has_paid: hasPaid
  };
}

function getChannelRow(chatId) {
  return db.prepare("SELECT * FROM channels WHERE chat_id = ? LIMIT 1;").get(chatId);
}

function getChannelByUsername(username) {
  if (!username) return null;
  return db
    .prepare("SELECT * FROM channels WHERE active_username = ? COLLATE NOCASE LIMIT 1;")
    .get(username.replace(/^@/, ""));
}

function listChannels() {
  const rows = db
    .prepare(
      `SELECT c.chat_id, c.active_username, c.title, c.member_count, c.updated_at, c.is_rkn, c.reactions_disabled, c.is_verified, c.boost_level,
              p.content_channel_format, p.content_tags, p.content_category
       FROM channels c
       LEFT JOIN llm_passports p ON p.chat_id = c.chat_id
       ORDER BY c.title;`
    )
    .all();

  return rows.map((row) => {
    const messages = loadMessages(row.chat_id);
    const summary = channelSummary(messages);
    const tags = parseArray(row.content_tags);
    const categories = parseArray(row.content_category);
    return {
      chat_id: row.chat_id,
      active_username: row.active_username,
      title: row.title,
      member_count: row.member_count,
      updated_at: toIso(row.updated_at),
      is_rkn: row.is_rkn,
      reactions_disabled: row.reactions_disabled,
      is_verified: row.is_verified,
      boost_level: row.boost_level,
      format: row.content_channel_format,
      tags,
      categories,
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
      boost_level: channel.boost_level,
      gift_count: channel.gift_count,
      has_linked_chat: channel.has_linked_chat,
      outgoing_paid_message_star_count: channel.outgoing_paid_message_star_count,
      date: channel.date,
      is_verified: channel.is_verified
    },
    messages,
    summary
  };
}

function loadPassport(chatId) {
  const row = db.prepare("SELECT * FROM llm_passports WHERE chat_id = ? LIMIT 1;").get(chatId);
  if (!row) return null;
  const raw = row.raw_json ? safeParse(row.raw_json) : null;
  const contentSummary =
    raw?.advertising_potential?.brand_safety_content_summary ||
    raw?.brand_safety_content_summary ||
    raw?.content_summary ||
    null;

  return {
    format: row.content_channel_format,
    short_description: row.content_short_description,
    tags: parseArray(row.content_tags),
    category: parseArray(row.content_category),
    language: row.content_language,
    contacts: parseArray(row.content_contacts),
    ads: parseArray(row.ads).map((v) => Number(v) || v),
    geo: row.audience_geo,
    gender_age: safeParse(row.audience_gender_age) || {},
    psychotype: row.community_psychotype,
    content_risks: parseArray(row.community_content_risks),
    brand_safety: row.advertising_brand_safety,
    tone_of_voice: parseArray(row.advertising_tone_of_voice),
    monetization_model: parseArray(row.advertising_monetization_model),
    ad_report: raw?.advertising_potential?.ad_report || safeParse(row.advertising_ad_report),
    communication_tips: row.advertising_communication_strategy_tips,
    stats_comment: row.advertising_stats_comment || raw?.advertising_potential?.stats_comment
    , content_summary: contentSummary
  };
}

function loadComments(chatId) {
  const row = db.prepare("SELECT payload_json FROM channel_comments WHERE chat_id = ? LIMIT 1;").get(chatId);
  const parsed = safeParse(row?.payload_json);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((c) => (typeof c?.text === "string" ? c.text.trim() : ""))
    .filter(Boolean)
    .slice(0, 50);
}

function splitByAds(messages, adIds) {
  const ids = new Set((adIds || []).map((v) => Number(v)));
  const ads = [];
  const organic = [];
  for (const msg of messages) {
    if (ids.has(Number(msg.id))) ads.push(msg);
    else organic.push(msg);
  }
  return { ads, organic };
}

function last30Days(messages) {
  const dated = messages.filter((m) => typeof m.ts === "number");
  if (!dated.length) return { list: [], factor: 1, coverageDays: 0, latest: null };
  const latest = dated.reduce((max, m) => Math.max(max, m.ts), dated[0].ts);
  const cutoff = latest - 30 * DAY_MS;
  const filtered = dated.filter((m) => m.ts >= cutoff);
  if (!filtered.length) return { list: [], factor: 1, coverageDays: 0, latest: latest || null };
  const earliest = filtered.reduce((min, m) => Math.min(min, m.ts), filtered[0].ts);
  const coverageDays = Math.max(1, (latest - earliest) / DAY_MS);
  const factor = coverageDays < 30 ? 30 / coverageDays : 1;
  return { list: filtered, factor, coverageDays, latest };
}

function aggregateMetrics(messages, memberCount, factor) {
  if (!messages.length) {
    return {
      posts: 0,
      avg_views: null,
      er: null,
      err: null,
      paid_reactions: null,
      reactions: null,
      forwards: null,
      comments: null
    };
  }

  let viewSum = 0;
  let interactions = 0;
  let paidSum = 0;
  let reactionsSum = 0;
  let forwardsSum = 0;
  let repliesSum = 0;

  for (const m of messages) {
    const views = m.view_count || 0;
    const paid = m.reactions_paid || 0;
    const reactions = m.reactions_total || 0;
    const forwards = m.forward_count || 0;
    const replies = m.reply_count || 0;
    viewSum += views;
    paidSum += paid;
    reactionsSum += reactions;
    forwardsSum += forwards;
    repliesSum += replies;
    interactions += reactions + forwards + replies;
  }

  const scaledPosts = messages.length * factor;
  const scaledViewSum = viewSum * factor;
  const scaledInteractions = interactions * factor;
  const scaledReactions = reactionsSum * factor;
  const scaledForwards = forwardsSum * factor;
  const scaledReplies = repliesSum * factor;
  const scaledPaid = paidSum * factor;

  return {
    posts: Number(scaledPosts.toFixed(1)),
    avg_views: scaledPosts > 0 ? scaledViewSum / scaledPosts : null,
    er: scaledViewSum > 0 ? scaledInteractions / scaledViewSum : null,
    err: memberCount > 0 ? scaledInteractions / memberCount : null,
    paid_reactions: scaledPosts > 0 ? scaledPaid / scaledPosts : null,
    reactions: scaledPosts > 0 ? scaledReactions / scaledPosts : null,
    forwards: scaledPosts > 0 ? scaledForwards / scaledPosts : null,
    comments: scaledPosts > 0 ? scaledReplies / scaledPosts : null
  };
}

function normalizeContentTypes(messages) {
  if (!messages.length) return [];
  const map = new Map();
  for (const m of messages) {
    const key = m.content_type || "unknown";
    const prev = map.get(key) || { type: key, count: 0, views: 0 };
    prev.count += 1;
    prev.views += m.view_count || 0;
    map.set(key, prev);
  }
  const total = Array.from(map.values()).reduce((acc, v) => acc + v.count, 0) || 1;
  return Array.from(map.values()).map((v) => ({
    type: v.type,
    count: v.count,
    share: v.count / total,
    avg_views: v.count > 0 ? v.views / v.count : null
  }));
}

function demographicsFromPassport(passport) {
  const raw = passport?.gender_age || {};
  const buckets = ["12-17", "18-24", "25-34", "35-44", "45-54", "55+"];
  const genderKeys = { M: "men", F: "women" };
  const result = { all: [], men: [], women: [], buckets: [] };
  let menTotal = 0;
  let womenTotal = 0;

  for (const bucket of buckets) {
    const mKey = `M${bucket}`;
    const fKey = `F${bucket}`;
    const male = Number(raw[mKey]) || 0;
    const female = Number(raw[fKey]) || 0;
    const total = male + female;
    menTotal += male;
    womenTotal += female;
    result.all.push({ label: bucket, value: total });
    result.men.push({ label: bucket, value: male });
    result.women.push({ label: bucket, value: female });
    result.buckets.push({ label: bucket, male, female, total });
  }

  const totalGender = menTotal + womenTotal || 1;
  const genderPie = {
    men: menTotal / totalGender,
    women: womenTotal / totalGender
  };

  const grand = menTotal + womenTotal || 1;
  result.buckets = result.buckets.map((b) => ({
    ...b,
    shareMale: b.male / grand,
    shareFemale: b.female / grand
  }));

  return { ...result, genderPie };
}

function formatShortAge(dateSeconds) {
  if (!dateSeconds) return null;
  const created = new Date(dateSeconds * 1000);
  const now = Date.now();
  const diffYears = (now - created.getTime()) / (365 * DAY_MS);
  if (diffYears < 1) {
    const months = Math.max(1, Math.floor((now - created.getTime()) / (30 * DAY_MS)));
    return `${months} мес.`;
  }
  return `${diffYears.toFixed(1)} г.`;
}

function buildMediakit(chatId) {
  const channel = getChannelRow(chatId);
  if (!channel) return null;
  const passport = loadPassport(chatId);
  const allMessages = loadMessages(chatId);
  const { ads: adMessages, organic: organicMessages } = splitByAds(allMessages, passport?.ads || []);
  const recent = last30Days(allMessages);
  const recentAds = last30Days(adMessages);
  const recentOrganic = last30Days(organicMessages);

  const metricsAll = aggregateMetrics(recent.list, channel.member_count, recent.factor);
  const metricsAds = aggregateMetrics(recentAds.list, channel.member_count, recentAds.factor);
  const metricsOrganic = aggregateMetrics(recentOrganic.list, channel.member_count, recentOrganic.factor);
  const contentTypes = normalizeContentTypes(recent.list);
  const wealthPaid = recent.list.reduce((acc, m) => acc + (m.reactions_paid || 0), 0);
  const hasPaid = recent.list.some((m) => (m.reactions_paid || 0) > 0);

  const comments = loadComments(chatId);
  const demographics = demographicsFromPassport(passport);

  function shortMessageId(id) {
    try {
      const big = BigInt(id);
      return big >> 20n;
    } catch (_) {
      return null;
    }
  }

  const cleanedMessages = (list) =>
    list.slice(0, 25).map((m) => ({
      id: m.id,
      date: m.date,
      text_preview: m.text_preview,
      view_count: m.view_count,
      forward_count: m.forward_count,
      reply_count: m.reply_count,
      reactions_total: m.reactions_total,
      reactions_paid: m.reactions_paid,
      content_type: m.content_type,
      is_ad: m.is_ad,
      media_url: m.media_url || m.image_urls?.[0] || null,
      link: (() => {
        if (!channel.active_username) return null;
        const mid = shortMessageId(m.id);
        if (!mid) return null;
        return `https://t.me/${channel.active_username}/${mid}`;
      })()
    }));

  const ageLabel = formatShortAge(channel.date);

  return {
    channel: {
      chat_id: channel.chat_id,
      title: channel.title,
      active_username: channel.active_username,
      member_count: channel.member_count,
      description: channel.description,
      is_rkn: channel.is_rkn,
      is_verified: Boolean(channel.is_verified),
      boost_level: channel.boost_level,
      gift_count: channel.gift_count,
      has_linked_chat: channel.has_linked_chat,
      outgoing_paid_message_star_count: channel.outgoing_paid_message_star_count,
      reactions_disabled: channel.reactions_disabled,
      age_label: ageLabel,
      link: channel.active_username ? `https://t.me/${channel.active_username}` : null
    },
    passport: passport || {},
    reports: {
      ad_report: passport?.ad_report || null,
      communication_tips: passport?.communication_tips || null,
      content_summary: passport?.content_summary || null
    },
    metrics: {
      last30: metricsAll,
      ads: metricsAds,
      organic: metricsOrganic,
      scale: Number(recent.factor ? recent.factor.toFixed(2) : 1),
      coverage_days: Number(recent.coverageDays ? recent.coverageDays.toFixed(1) : 0),
      content_types: contentTypes,
      wealth_signal: { has_paid: hasPaid, paid_total: wealthPaid }
    },
    demographics,
    messages: {
      ads: cleanedMessages(adMessages),
      organic: cleanedMessages(organicMessages.length ? organicMessages : allMessages)
    },
    comments
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

  if (pathname.startsWith("/api/mediakit")) {
    const id = parsed.query.id || parsed.query.chat_id || parsed.query.username;
    const channelRow =
      typeof id === "string" && isNaN(Number(id)) ? getChannelByUsername(id) : getChannelRow(Number(id) || id);
    if (!channelRow) return sendJson(res, 404, { error: "Channel not found" });
    const detail = buildMediakit(channelRow.chat_id);
    if (!detail) return sendJson(res, 404, { error: "Channel not found" });
    return sendJson(res, 200, detail);
  }

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

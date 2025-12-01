"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
let GoogleGenAI = null;
try {
  ({ GoogleGenAI } = require("@google/genai"));
} catch (_) {
  // Библиотека подтянется после установки зависимостей
}
const { DB_PATH } = require("./config/paths");
const LLMPP_TABLE = "llm_passports";
const LLMPP_SCHEMA_VERSION = 1;

const LLM_IMAGE_INLINE_LIMIT = Math.max(0, Number(process.env.LLM_IMAGE_INLINE_LIMIT) || 25);
const LLM_IMAGE_MAX_BYTES = Math.max(0, Number(process.env.LLM_IMAGE_MAX_BYTES) || 2 * 1024 * 1024);

const DEFAULT_MODEL_ID = process.env.GEMINI_MODEL_ID || "gemini-2.5-pro";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || null;
const TMP_ROOT = path.join(process.cwd(), "tmp");
const PROMPT_PATH = path.join(__dirname, "prompts", "blogger-passport.md");
const OUTPUT_SCHEMA = {
  type: "object",
  required: ["blogger_id", "content_summary", "audience_profile", "advertising_potential"],
  properties: {
    blogger_id: { type: "string" },
    ads: { type: "array", items: { type: "integer" } },
    content_summary: {
      type: "object",
      required: ["short_description", "channel_format", "tags", "language", "contacts", "category"],
      properties: {
        short_description: { type: "string" },
        channel_format: { type: "string", enum: ["blog", "newsfeed", "aggregator", "catalog", "review", "visual_gallery"] },
        tags: { type: "array", items: { type: "string" } },
        language: { type: "string" },
        contacts: { type: ["string", "null"] },
        category: { type: "array", items: { type: "string" } },
        ads: { type: "array", items: { type: "integer" } }
      }
    },
    audience_profile: {
      type: "object",
      required: ["geo", "gender_age_distribution"],
      properties: {
        geo: { type: "string" },
        gender_age_distribution: { type: "object" },
        community: {
          type: "object",
          properties: {
            audience_psychotype: { type: "string" },
            content_risks: { type: "array", items: { type: "string" } }
          }
        }
      }
    },
    advertising_potential: {
      type: "object",
      required: ["brand_safety_risk", "tone_of_voice", "monetization_model", "ad_report", "communication_strategy_tips", "stats_comment"],
      properties: {
        brand_safety_risk: { type: "string", enum: ["green", "yellow", "red"] },
        tone_of_voice: { type: "array", items: { type: "string" } },
        monetization_model: { type: "array", items: { type: "string" } },
        ad_report: { type: ["object", "string", "null"] },
        communication_strategy_tips: { type: ["string", "null"] },
        stats_comment: { type: ["string", "null"] }
      }
    }
  }
};

const CHANNEL_FIELDS = new Set([
  "active_username",
  "title",
  "description",
  "boost_level",
  "date",
  "has_direct_messages_group",
  "has_linked_chat",
  "member_count",
  "is_verified",
  "direct_messages_chat_id",
  "gift_count",
  "linked_chat_id",
  "outgoing_paid_message_star_count",
  "reactions_disabled",
  "similar_count",
  "updated_at",
  "is_rkn"
]);

function safeParseJson(value, fallback = null) {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function extractImageUrls(text) {
  if (typeof text !== "string") return [];
  const regex = /(https?:\/\/[^\s)]+\.(?:png|jpe?g|gif|webp))/gi;
  const found = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    found.push(match[1]);
  }
  return Array.from(new Set(found));
}

function toIso(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    // seconds precision in DB
    return new Date(value * 1000).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const normalized = value.includes("T") ? value : value.replace(" ", "T") + "Z";
    const dt = new Date(normalized);
    if (!Number.isNaN(dt.getTime())) {
      return dt.toISOString();
    }
  }
  return null;
}

function sanitizeFilename(base) {
  return String(base || "channel")
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "channel";
}

function mimeFromPath(filePath) {
  const ext = (path.extname(filePath || "").toLowerCase() || "").replace(/^\./, "");
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

async function buildInlineImages(imagePaths) {
  if (!Array.isArray(imagePaths) || imagePaths.length === 0 || LLM_IMAGE_INLINE_LIMIT === 0) return [];
  const parts = [];
  for (const p of imagePaths.slice(0, LLM_IMAGE_INLINE_LIMIT)) {
    try {
      const stat = await fs.stat(p);
      if (!stat.isFile() || (LLM_IMAGE_MAX_BYTES > 0 && stat.size > LLM_IMAGE_MAX_BYTES)) {
        continue;
      }
      const buf = await fs.readFile(p);
      parts.push({ inlineData: { data: buf.toString("base64"), mimeType: mimeFromPath(p) }, _src: p });
    } catch (_) {
      // skip unreadable files
    }
  }
  return parts;
}

function sum(list) {
  return Array.isArray(list) ? list.reduce((acc, value) => acc + value, 0) : 0;
}

function average(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  return sum(list) / list.length;
}

function stddev(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const mean = average(list);
  if (!Number.isFinite(mean) || mean === 0) return null;
  const variance = list.reduce((acc, value) => acc + (value - mean) ** 2, 0) / list.length;
  return Math.sqrt(variance);
}

function percentile(sortedAsc, p) {
  if (!Array.isArray(sortedAsc) || sortedAsc.length === 0) return null;
  if (p <= 0) return sortedAsc[0];
  if (p >= 100) return sortedAsc[sortedAsc.length - 1];
  const rank = (p / 100) * (sortedAsc.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sortedAsc[low];
  const weight = rank - low;
  return sortedAsc[low] * (1 - weight) + sortedAsc[high] * weight;
}

function ensureColumn(db, table, column, definition) {
  const existing = db.prepare(`PRAGMA table_info(${table});`).all();
  const has = existing.some((row) => row.name === column);
  if (!has) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

class GeminiHandler {
  constructor({ dbPath = DB_PATH, modelId = DEFAULT_MODEL_ID, apiKey = GEMINI_API_KEY } = {}) {
    this.db = new DatabaseSync(dbPath);
    this.modelId = modelId;
    this.apiKey = apiKey;
    this.model = null;

    if (this.apiKey && GoogleGenAI) {
      try {
        const client = new GoogleGenAI({ apiKey: this.apiKey });
        this.model = client.getGenerativeModel({ model: this.modelId });
      } catch (error) {
        // Локальная подготовка должна работать даже без валидного ключа
        console.warn("Gemini client init skipped:", error.message || error);
      }
    } else if (this.apiKey && !GoogleGenAI) {
      console.warn("Install @google/genai to enable Gemini calls.");
    }

    // Плоская таблица результатов LLM (создаём при первом запуске, затем мигрируем колонками)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${LLMPP_TABLE} (
        chat_id INTEGER PRIMARY KEY,
        schema_version INTEGER DEFAULT ${LLMPP_SCHEMA_VERSION},
        raw_json TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);

    const columns = [
      ["blogger_id", "TEXT"],
      ["content_short_description", "TEXT"],
      ["content_channel_format", "TEXT"],
      ["content_tags", "TEXT"],
      ["content_language", "TEXT"],
      ["content_contacts", "TEXT"],
      ["content_category", "TEXT"],
      ["ads", "TEXT"],
      ["audience_geo", "TEXT"],
      ["audience_gender_age", "TEXT"],
      ["community_psychotype", "TEXT"],
      ["community_content_risks", "TEXT"],
      ["advertising_brand_safety", "TEXT"],
      ["advertising_tone_of_voice", "TEXT"],
      ["advertising_monetization_model", "TEXT"],
      ["advertising_ad_report", "TEXT"],
      ["advertising_communication_strategy_tips", "TEXT"],
      ["advertising_stats_comment", "TEXT"],
      ["schema_version", "INTEGER"]
    ];
    for (const [col, def] of columns) {
      ensureColumn(this.db, LLMPP_TABLE, col, def);
    }

    this.statements = {
      eligible: this.db.prepare(`
        SELECT c.chat_id, c.title, c.active_username
        FROM channels c
        JOIN channel_messages cm ON cm.chat_id = c.chat_id
        JOIN channel_comments cc ON cc.chat_id = c.chat_id
        JOIN channel_similar cs ON cs.chat_id = c.chat_id
      `),
      channel: this.db.prepare("SELECT * FROM channels WHERE chat_id = ? LIMIT 1"),
      messages: this.db.prepare("SELECT messages_json FROM channel_messages WHERE chat_id = ? LIMIT 1"),
      comments: this.db.prepare("SELECT payload_json FROM channel_comments WHERE chat_id = ? LIMIT 1"),
      refreshState: this.db.prepare("SELECT * FROM refresh_state WHERE chat_id = ?")
    };

    this.statements.upsertResult = this.db.prepare(`
      INSERT INTO ${LLMPP_TABLE} (
        chat_id, blogger_id,
        content_short_description, content_channel_format, content_tags, content_language, content_contacts, content_category,
        ads,
        audience_geo, audience_gender_age, community_psychotype, community_content_risks,
        advertising_brand_safety, advertising_tone_of_voice, advertising_monetization_model, advertising_ad_report, advertising_communication_strategy_tips, advertising_stats_comment,
        raw_json, created_at, updated_at
      )
      VALUES (
        @chat_id, @blogger_id,
        @content_short_description, @content_channel_format, @content_tags, @content_language, @content_contacts, @content_category,
        @ads,
        @audience_geo, @audience_gender_age, @community_psychotype, @community_content_risks,
        @advertising_brand_safety, @advertising_tone_of_voice, @advertising_monetization_model, @advertising_ad_report, @advertising_communication_strategy_tips, @advertising_stats_comment,
        @raw_json, datetime('now'), datetime('now')
      )
      ON CONFLICT(chat_id) DO UPDATE SET
        blogger_id=excluded.blogger_id,
        content_short_description=excluded.content_short_description,
        content_channel_format=excluded.content_channel_format,
        content_tags=excluded.content_tags,
        content_language=excluded.content_language,
        content_contacts=excluded.content_contacts,
        content_category=excluded.content_category,
        ads=excluded.ads,
        audience_geo=excluded.audience_geo,
        audience_gender_age=excluded.audience_gender_age,
        community_psychotype=excluded.community_psychotype,
        community_content_risks=excluded.community_content_risks,
        advertising_brand_safety=excluded.advertising_brand_safety,
        advertising_tone_of_voice=excluded.advertising_tone_of_voice,
        advertising_monetization_model=excluded.advertising_monetization_model,
        advertising_ad_report=excluded.advertising_ad_report,
        advertising_communication_strategy_tips=excluded.advertising_communication_strategy_tips,
        advertising_stats_comment=excluded.advertising_stats_comment,
        raw_json=excluded.raw_json,
        updated_at=datetime('now');
    `);
  }

  adaptChannel(raw) {
    if (!raw || typeof raw !== "object") return {};
    const result = {};
    for (const key of CHANNEL_FIELDS) {
      if (key in raw) {
        result[key] = raw[key];
      }
    }
    result.date = toIso(raw.date) || null;
    result.updated_at = toIso(raw.updated_at) || null;
    return result;
  }

  adaptMessages(messagesPayload) {
    const list = Array.isArray(messagesPayload?.messages) ? messagesPayload.messages : [];
    return list.map((msg) => {
      const base = {
        id: msg.id,
        chat_id: msg.chat_id,
        date: toIso(msg.date),
        content_type: msg.content_type || null,
        text_markdown: msg.text_markdown || null,
        media_local_path: msg.media_local_path || null
      };

      if (Number.isFinite(msg.forward_count)) base.forward_count = msg.forward_count;
      if (Number.isFinite(msg.reply_count)) base.reply_count = msg.reply_count;
      if (Number.isFinite(msg.view_count)) base.view_count = msg.view_count;
      if (msg.reactions) base.reactions = msg.reactions;
      if (msg.transcription) base.transcription = msg.transcription;

      const urls = extractImageUrls(msg.text_markdown || "");
      if (urls.length > 0) {
        base.image_urls = urls;
      }

      return base;
    });
  }

  adaptComments(commentsPayload) {
    if (!Array.isArray(commentsPayload)) return null;
    const MAX_COMMENTS = 200;
    const strings = [];
    for (const c of commentsPayload) {
      if (strings.length >= MAX_COMMENTS) break;
      if (typeof c?.text === "string" && c.text.trim()) {
        strings.push(c.text);
      }
    }
    return strings.length > 0 ? strings : null;
  }

  buildMessageSummary(messages) {
    const total = Array.isArray(messages) ? messages.length : 0;

    if (!Array.isArray(messages) || messages.length === 0) {
      return { total, avg_posts_30d: null };
    }

    const msInDay = 24 * 60 * 60 * 1000;
    const timestamps = messages
      .map((m) => new Date(m.date).getTime())
      .filter((ts) => Number.isFinite(ts));

    if (timestamps.length === 0) {
      return { total, avg_posts_30d: null };
    }

    const oldest = Math.min(...timestamps);
    const newest = Math.max(...timestamps);
    const spanMs = Math.max(newest - oldest, 60 * 60 * 1000); // минимум час, чтобы не взрывалась формула
    const ratePerMs = timestamps.length / spanMs;
    const avg30 = Math.round(ratePerMs * 30 * msInDay);

    return { total, avg_posts_30d: avg30 };
  }

  buildEngagementStats(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const sampleSize = list.length;

    const views = [];
    const orderedViews = [];
    const reactionsList = [];
    const repliesList = [];
    const forwardsList = [];
    const engagements = [];

    for (const msg of list) {
      const viewsVal = Number(msg?.view_count);
      if (Number.isFinite(viewsVal)) {
        views.push(viewsVal);
        orderedViews.push(viewsVal);
      }

      const reactionsVal = Number.isFinite(Number(msg?.reactions?.total)) ? Number(msg.reactions.total) : 0;
      const repliesVal = Number.isFinite(Number(msg?.reply_count)) ? Number(msg.reply_count) : 0;
      const forwardsVal = Number.isFinite(Number(msg?.forward_count)) ? Number(msg.forward_count) : 0;

      reactionsList.push(reactionsVal);
      repliesList.push(repliesVal);
      forwardsList.push(forwardsVal);
      engagements.push(reactionsVal + repliesVal + forwardsVal);
    }

    const sortedViews = views.slice().sort((a, b) => a - b);
    const p50Views = percentile(sortedViews, 50);
    const p95Views = percentile(sortedViews, 95);
    const maxViews = sortedViews.length > 0 ? sortedViews[sortedViews.length - 1] : null;

    const totalViews = sum(views);
    const totalEngagement = sum(engagements);
    const totalReactions = sum(reactionsList);
    const totalReplies = sum(repliesList);
    const totalForwards = sum(forwardsList);

    const engagementPerView = [];
    for (let i = 0; i < list.length; i += 1) {
      const viewsVal = Number(list[i]?.view_count);
      const engVal = engagements[i] || 0;
      if (Number.isFinite(viewsVal) && viewsVal > 0) {
        engagementPerView.push(engVal / viewsVal);
      }
    }

    const erTotal = totalViews > 0 ? totalEngagement / totalViews : null;
    const erAvg = engagementPerView.length > 0 ? average(engagementPerView) : null;
    const reactionRate = totalViews > 0 ? totalReactions / totalViews : null;
    const replyRate = totalViews > 0 ? totalReplies / totalViews : null;
    const forwardRate = totalViews > 0 ? totalForwards / totalViews : null;

    const spikeRatioViews = Number.isFinite(p50Views) && p50Views > 0 && Number.isFinite(p95Views)
      ? p95Views / p50Views
      : null;
    const maxOverP95Views = Number.isFinite(p95Views) && p95Views > 0 && Number.isFinite(maxViews)
      ? maxViews / p95Views
      : null;

    const recentViews = orderedViews.slice(0, 30);
    let flatnessLast30Views = null;
    if (recentViews.length > 0) {
      const meanRecent = average(recentViews);
      const stdRecent = stddev(recentViews);
      if (Number.isFinite(meanRecent) && meanRecent > 0 && Number.isFinite(stdRecent)) {
        flatnessLast30Views = stdRecent / meanRecent;
      }
    }

    let flatBandShareViews = null;
    if (Number.isFinite(p50Views) && p50Views > 0) {
      const lower = p50Views * 0.95;
      const upper = p50Views * 1.05;
      const inBand = views.filter((v) => v >= lower && v <= upper).length;
      flatBandShareViews = views.length > 0 ? inBand / views.length : null;
    }

    const hasSpikes = spikeRatioViews !== null ? spikeRatioViews > 1.4 : null;
    const possibleSmoothing =
      flatnessLast30Views !== null && flatBandShareViews !== null
        ? flatnessLast30Views < 0.05 && flatBandShareViews > 0.7
        : null;

    return {
      sample_size: sampleSize,
      avg_views: average(views),
      median_views: p50Views,
      p95_views: p95Views,
      max_views: maxViews,
      avg_engagement: average(engagements),
      er_total: erTotal,
      er_avg: erAvg,
      reaction_rate: reactionRate,
      reply_rate: replyRate,
      forward_rate: forwardRate,
      spike_ratio_views: spikeRatioViews,
      max_over_p95_views: maxOverP95Views,
      flatness_last30_views: flatnessLast30Views,
      flat_band_share_views: flatBandShareViews,
      has_spikes: hasSpikes,
      possible_smoothing: possibleSmoothing,
      data_sparse: sampleSize < 10
    };
  }

  buildEngagementSummary(messages) {
    const list = Array.isArray(messages) ? messages : [];
    return [{ scope: "all", ...this.buildEngagementStats(list) }];
  }

  close() {
    try {
      this.db?.close();
    } catch (_) {
      // noop
    }
  }

  listEligibleChannels() {
    return this.statements.eligible.all();
  }

  findEligibleChannel(selector) {
    if (!selector) return null;
    const normalized = String(selector).toLowerCase();
    return this.listEligibleChannels().find((row) => {
      const byUsername = row.active_username && row.active_username.toLowerCase() === normalized;
      const byId = String(row.chat_id) === normalized;
      return byUsername || byId;
    });
  }

  buildPayload(chatId) {
    const channel = this.adaptChannel(this.statements.channel.get(chatId));
    const messagesJson = safeParseJson(this.statements.messages.get(chatId)?.messages_json, null);
    const commentsJson = safeParseJson(this.statements.comments.get(chatId)?.payload_json, null);

    const messages = this.adaptMessages(messagesJson);
    const comments = this.adaptComments(commentsJson);
    const imagePaths = Array.from(
      new Set(
        (Array.isArray(messages) ? messages : [])
          .map((m) => m?.media_local_path)
          .filter((p) => typeof p === "string" && p.trim())
      )
    );

    return {
      ...channel,
      messages,
      message_summary: this.buildMessageSummary(messages),
      engagement_summary: this.buildEngagementSummary(messages),
      comments,
      images: imagePaths
    };
  }

  async callGemini(promptText, inputObject, imagePaths = []) {
    if (!this.model) {
      throw new Error("Gemini model is not initialized; install @google/generative-ai and set GEMINI_API_KEY");
    }

    const payloadString = JSON.stringify(inputObject, null, 2);
    const parts = [{ text: promptText }, { text: `\nINPUT JSON:\n${payloadString}` }];
    const inlineImages = await buildInlineImages(imagePaths);
    for (const img of inlineImages) {
      parts.push({ inlineData: img.inlineData });
    }

    const response = await this.model.generateContent({
      contents: parts,
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: OUTPUT_SCHEMA
      }
    });

    const rawText = response?.response?.text?.() || response?.response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    let parsed = null;
    try {
      parsed = JSON.parse(rawText);
    } catch (_) {
      parsed = { _raw: rawText };
    }

    return { parsed, raw: rawText };
  }

  saveResult(chatId, parsed, raw) {
    if (!parsed || typeof parsed !== "object") return;

    // Если парсинг не удался и модель вернула _raw, попробуем ещё раз распарсить.
    if (parsed._raw && typeof parsed._raw === "string") {
      try {
        const reParsed = JSON.parse(parsed._raw);
        parsed = reParsed;
      } catch (_) {
        // оставляем как есть
      }
    }

    const cs = parsed.content_summary || {};
    const ap = parsed.audience_profile || {};
    const comm = ap.community || {};
    const adv = parsed.advertising_potential || {};
    const adsField = typeof parsed.ads !== "undefined" ? parsed.ads : cs.ads;

    const safeJson = (val) => {
      if (val === null || typeof val === "undefined") return null;
      try {
        return JSON.stringify(val);
      } catch (_) {
        return null;
      }
    };

    const payload = {
      chat_id: chatId,
      blogger_id: parsed.blogger_id || null,
      content_short_description: cs.short_description || null,
      content_channel_format: cs.channel_format || null,
      content_tags: safeJson(cs.tags),
      content_language: cs.language || null,
      content_contacts: cs.contacts || null,
      content_category: safeJson(cs.category),
      ads: safeJson(adsField),
      audience_geo: ap.geo || null,
      audience_gender_age: safeJson(ap.gender_age_distribution),
      community_psychotype: comm.audience_psychotype || null,
      community_content_risks: safeJson(comm.content_risks),
      advertising_brand_safety: adv.brand_safety_risk || null,
      advertising_tone_of_voice: safeJson(adv.tone_of_voice),
      advertising_monetization_model: safeJson(adv.monetization_model),
      advertising_ad_report: safeJson(adv.ad_report),
      advertising_communication_strategy_tips: adv.communication_strategy_tips || null,
      advertising_stats_comment: adv.stats_comment || null,
      raw_json: typeof raw === "string" ? raw : safeJson(raw)
    };
    this.statements.upsertResult.run(payload);
  }

  async writeInputBundles(targetDir = null) {
    const baseDir = targetDir || TMP_ROOT;
    await fs.mkdir(baseDir, { recursive: true });
    const dir = await fs.mkdtemp(path.join(baseDir, "llm-input-"));
    const channels = this.listEligibleChannels();
    let written = 0;

    for (const row of channels) {
      const payload = this.buildPayload(row.chat_id);
      const namePart = sanitizeFilename(row.active_username || row.title || row.chat_id);
      const filePath = path.join(dir, `${namePart}_${row.chat_id}.json`);
      await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
      written += 1;
    }

    return { dir, written };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const allFlag = args.includes("--all");
  const selectors = args.filter((a) => a && !a.startsWith("--"));

  const handler = new GeminiHandler();
  const promptText = await fs.readFile(PROMPT_PATH, "utf8");
  const targets = [];

  if (allFlag || selectors.length === 0) {
    targets.push(...handler.listEligibleChannels());
  } else {
    for (const sel of selectors) {
      const found = handler.findEligibleChannel(sel);
      if (found) targets.push(found);
    }
  }

  if (targets.length === 0) {
    console.log("No eligible channels found. Usage: node src/llm-handler.js [--all] [--force] <channel_username|chat_id> ...");
    handler.close();
    return;
  }

  await fs.mkdir(TMP_ROOT, { recursive: true });
  const outDir = await fs.mkdtemp(path.join(TMP_ROOT, "llm-output-"));

  try {
    for (const row of targets) {
      if (!force) {
        const exists = handler.db
          .prepare(`SELECT 1 FROM ${LLMPP_TABLE} WHERE chat_id = ? LIMIT 1;`)
          .get(row.chat_id);
        if (exists) {
          console.log(`Skip ${row.chat_id}: already has LLM passport`);
          continue;
        }
      }

      console.log(`LLM for chat_id=${row.chat_id} (${row.active_username || row.title || ""})`);
      const payload = handler.buildPayload(row.chat_id);
      const { messages, comments, message_summary, engagement_summary, images, ...channelInfo } = payload;

      const input = {
        channel_info: { id: row.chat_id, ...channelInfo },
        messages,
        message_summary,
        engagement_summary,
        comments
      };

      const { parsed, raw } = await handler.callGemini(promptText, input, images);

      handler.saveResult(row.chat_id, parsed, raw);

      const baseName = sanitizeFilename(row.active_username || row.title || row.chat_id);
      await fs.writeFile(path.join(outDir, `${baseName}_input.json`), JSON.stringify(input, null, 2), "utf8");
      await fs.writeFile(path.join(outDir, `${baseName}_output.json`), JSON.stringify(parsed, null, 2), "utf8");
    }

    console.log(`LLM processing done. Outputs saved to ${outDir}`);
  } catch (error) {
    console.error("LLM handler failed:", error.message || error);
    process.exitCode = 1;
  } finally {
    handler.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("LLM handler failed:", error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { GeminiHandler };

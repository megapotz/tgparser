"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
let GoogleGenerativeAI = null;
try {
  ({ GoogleGenerativeAI } = require("@google/generative-ai"));
} catch (_) {
  // Библиотека подтянется после установки зависимостей
}
const { DB_PATH } = require("./config/paths");

const DEFAULT_MODEL_ID = process.env.GEMINI_MODEL_ID || "gemini-2.5-pro";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || null;
const TMP_ROOT = path.join(process.cwd(), "tmp");

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

class GeminiHandler {
  constructor({ dbPath = DB_PATH, modelId = DEFAULT_MODEL_ID, apiKey = GEMINI_API_KEY } = {}) {
    this.db = new DatabaseSync(dbPath);
    this.modelId = modelId;
    this.apiKey = apiKey;
    this.model = null;

    if (this.apiKey && GoogleGenerativeAI) {
      try {
        const client = new GoogleGenerativeAI(this.apiKey);
        this.model = client.getGenerativeModel({ model: this.modelId });
      } catch (error) {
        // Локальная подготовка должна работать даже без валидного ключа
        console.warn("Gemini client init skipped:", error.message || error);
      }
    } else if (this.apiKey && !GoogleGenerativeAI) {
      console.warn("Install @google/generative-ai to enable Gemini calls.");
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

      if (typeof msg.text_markdown === "string" && /erid/i.test(msg.text_markdown)) {
        base.is_ad = true;
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
    const hasErid = Array.isArray(messages)
      ? messages.filter((m) => typeof m.text_markdown === "string" && /erid/i.test(m.text_markdown)).length
      : 0;

    if (!Array.isArray(messages) || messages.length === 0) {
      return { total, has_erid: hasErid, avg_posts_30d: null };
    }

    const msInDay = 24 * 60 * 60 * 1000;
    const timestamps = messages
      .map((m) => new Date(m.date).getTime())
      .filter((ts) => Number.isFinite(ts));

    if (timestamps.length === 0) {
      return { total, has_erid: hasErid, avg_posts_30d: null };
    }

    const oldest = Math.min(...timestamps);
    const newest = Math.max(...timestamps);
    const spanMs = Math.max(newest - oldest, 60 * 60 * 1000); // минимум час, чтобы не взрывалась формула
    const ratePerMs = timestamps.length / spanMs;
    const avg30 = Math.round(ratePerMs * 30 * msInDay);

    return { total, has_erid: hasErid, avg_posts_30d: avg30 };
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

    return {
      ...channel,
      messages,
      message_summary: this.buildMessageSummary(messages),
      comments
    };
  }

  async callGemini(promptText, inputObject) {
    if (!this.model) {
      throw new Error("Gemini model is not initialized; install @google/generative-ai and set GEMINI_API_KEY");
    }

    const payloadString = JSON.stringify(inputObject, null, 2);
    const response = await this.model.generateContent([
      { text: promptText },
      { text: `\nINPUT JSON:\n${payloadString}` }
    ]);

    const text = response?.response?.text?.() || response?.response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const match = text.match(/\{[\s\S]*\}/);
    const raw = match ? match[0] : text;
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      parsed = { _raw: text };
    }

    return { parsed, raw: text };
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
  const target = process.argv[2];
  if (!target) {
    console.log("No channel specified. Usage: node src/llm-handler.js <channel_username|chat_id>");
    return;
  }

  const handler = new GeminiHandler();
  try {
    const channelRow = handler.findEligibleChannel(target);
    if (!channelRow) {
      console.error(`Channel not found or missing data in all tables: ${target}`);
      return;
    }

    const payload = handler.buildPayload(channelRow.chat_id);
    const { messages, comments, message_summary, ...channelInfo } = payload;
    const ads = Array.isArray(messages) ? messages.filter((m) => m.is_ad) : [];

    const input = {
      channel_info: { id: channelRow.chat_id, ...channelInfo },
      messages,
      ads,
      message_summary,
      comments
    };

    const promptText = `Вы — экспертный маркетинг-аналитик, специализирующийся на социальных медиа и influencer-маркетинге. Ваша задача — проанализировать предоставленные данные из ленты блогера (список постов с текстом, изображениями, метриками) и сгенерировать подробный "паспорт блогера" в строго определенном JSON-формате.

Ваш анализ должен быть глубоким, учитывая не только прямой текст, но и подтекст, тональность, смысл изображений, а также количественные и качественные показатели вовлеченности аудитории.

**Входные данные:**
JSON-объект, содержащий \`channel_info\` и массив \`messages\` с последними публикациями, включая текст, медиа, просмотры, реакции, комментарии и пересылки, а также массив \`ads\`, в котором собраны рекламные публикации блогера за последнее время.

**Задача:**
На основе входных данных сгенерируйте JSON-объект, который строго соответствует следующей структуре и правилам.

### **ПРАВИЛА И СТРУКТУРА ВЫХОДНОГО JSON**

**1. \`blogger_id\` (string):**
   - Скопируйте \`id\` из \`channel_info\`.

**2. \`content_summary\` (object):**
   - \`short_description\` (string): Краткое, но емкое описание канала в 2-3 предложениях. О чем этот канал и для кого он?
   - \`content_type\` (enum string): Определите основной тип контента. Допустимые значения: \`personal_brand\`, \`news\`, \`entertainment\`, \`niche\`. *Если ни одна категория не подходит, предложите наиболее релевантное кастомное значение.*
 - “has_personal_content”: есть личное присутствие с фото и видео (либо это обезличенный паблик, в котором автор анонимен)
   - \`tags\` (array of strings): Список тегов, которые описывают о чем этот канал в целом. Не привязывайся к содержанию отдельных постов, нужно выхватить общую суть и описать ее.
   - \`language\` (string): Язык, на котором ведется канал.
   - \`contacts\` (string): из поля description нужно вынуть контакты. Если контактов в описании нет, установи значение поля в null.
   - \`category\` (object):
     - \`primary\` (array of strings): Выберите 1-2 максимально подходящие категории из списка ниже (канал можно привести как канонический пример).
     - \`secondary\` (array of strings): Если есть категории, к которым канал точно относится, но когда думаешь про эту категорию, то на ум приходят несколько другой контент, то добавляем их в secondary

     Список категорий: Авто и мото, Бизнес и стартапы, Видеоигры и киберспорт, Для взрослых (18+), Духовные практики и эзотерика, Еда и кулинария, Животные и природа, Здоровье, медицина и фитнес, Инвестиции и трейдинг, Иностранные языки, Искусство и дизайн, История, Карьера и работа, Кино и сериалы, Книги, аудиокниги и подкасты, Криптовалюты, Культура и события, Лайфстайл и блоги, Маркетинг и PR, Мода и стиль, Музыка, Наука и технологии, Недвижимость, Новости и СМИ, Образование и познавательное, Политика и общество, Право и юриспруденция, Психология и саморазвитие, Путешествия и туризм, Ставки и гемблинг, Строительство, ремонт и интерьер, Теневой интернет и Digital-андерграунд, Товары, скидки и акции, Экономика и финансы, Юмор и развлечения.

**3. \`audience_profile\` (object):**
   - \`geo\` (object): Определяй географию на основе языка канала, упоминаемых в постах локаций, обсуждаемых событий и культурного контекста.
     - \`primary\` (string): Основной географический регион (страна или город).
     - \`secondary\` (array of strings): Второстепенные регионы (если применимо).
   - \`gender_age_distribution\` (object): Оцените распределение аудитории по полу и возрасту. Ключи — строка в формате \`[F/M][возрастной_диапазон]\`, значение — доля от 0.0 до 1.0. Сумма всех долей должна быть равна 1.0. Используйте диапазоны: \`12-17\`, \`18-24\`, \`25-34\`, \`35-44\`, \`45-54\`, \`55+\`.

**4. \`advertising_potential\` (object):**
   - \`brand_safety_risk\` (enum string): Оцените риск для бренда при размещении рекламы (\`green\`, \`yellow\`, \`red\`).
   - \`tone_of_voice\` (array of strings): Опишите тональность автора/канала (например, "экспертный", "юмористический", "саркастичный", "новостной", "мотивирующий", "личный и доверительный").
   - \`community_type\` (enum string): Если есть комментарии к постам, оцените тип взаимодействия внутри сообщества (\`strong_fan_community\`, \`passive_audience\`, \`professional_network\`, \`toxic_community\`). Иначе оставь поле null.
   - \`organic_activity_score\` (enum string): Оцени вовлеченность как \`high\`, \`medium\` или \`low\`. Для оценки анализируй соотношение \`views\`, \`reactions\`, \`comments\` и \`forwards\`. \`high\` — стабильная и пропорциональная активность. \`low\` — низкая активность или явные диспропорции (например, много просмотров, но почти нет реакций/комментариев).
   - \`score_explanation\` (string): Обоснуй свою оценку. Укажи примерный ER (отношение суммы реакций и комментариев к просмотрам), сравни активность на разных типах постов (новостных, дискуссионных, рекламных) и сделай вывод об органичности.
   - \`monetization_model\` (array of enum strings): Проанализируй существующие рекламные посты (если есть), блог в целом и сделай вывод какой какой рекламный продукт лучше всего подойдет блогеру:

cpc - самый низкий CPM, подходит новостникам, тематическим пабликам без сильного бренда. Это каналы с невысоким качеством контента или небольшой и не слишком вовлеченной аудиторией, где с “драной овцы хоть шерсти клок”. У них, как правило, нет или очень мало прямых рекламодателей, и они не могут уверенно стоять на ногах.

cpv - более качественные, "экспертные" каналы, которые не готовы работать за низкий CPM модели CPC. Ключевой барьер: Отсутствие контроля. Как и в CPC, реклама приходит "как есть", без предварительного согласования и возможности редактирования. Это отталкивает многие каналы, которые тщательно следят за своим контентом.

cpp - Топовые и экспертные каналы, ценящие полный контроль
(Личные блоги экспертов, каналы с высокой репутацией, например, условный "Код Дурова")
Продукт: CPP (Cost Per Post)
Описание сегмента: Это премиум-сегмент. Каналы, которые дорожат своей репутацией, пишут посты сами или тесно согласовывают их с рекламодателем. Для них критически важен контроль над контентом.
Почему выбирают этот продукт:
Полный контроль над процессом: Владелец канала видит рекламный пост до публикации.
Возможность редактирования: Можно согласовать и внести правки в текст поста.
Свои условия: Можно установить любую фиксированную цену за пост.
Характерный признак - прямые интеграции других рекламодетелей

cpa (Скидочники, купонники, каналы с подборками товаров)
Продукты: CPA (Cost Per Action) и Ритм
Описание сегмента: Это узкая, но специфическая ниша каналов, чей основной бизнес — генерация целевых действий (покупок, регистраций, установок). Их аудитория готова переходить по ссылкам и совершать действия.

   - \`communication_strategy_tips\` (string): Дайте краткий, но действенный совет менеджеру по работе с блогерами. Обязательно подсвети в общих чертах какая реклама уже выходила.`;

    const { parsed } = await handler.callGemini(promptText, input);

    await fs.mkdir(TMP_ROOT, { recursive: true });
    const outDir = await fs.mkdtemp(path.join(TMP_ROOT, "llm-output-"));
    const baseName = sanitizeFilename(channelRow.active_username || channelRow.title || channelRow.chat_id);
    await fs.writeFile(path.join(outDir, `${baseName}_input.json`), JSON.stringify(input, null, 2), "utf8");
    await fs.writeFile(path.join(outDir, `${baseName}_output.json`), JSON.stringify(parsed, null, 2), "utf8");

    console.log(`LLM result saved to ${outDir}`);
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

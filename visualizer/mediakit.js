(() => {
  "use strict";

  const qs = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const els = {
    avatar: qs("#avatar"),
    title: qs("#channel-title"),
    channelLink: qs("#channel-link"),
    trustBadges: qs("#trust-badges"),
    navPrev: qs("#nav-prev"),
    navNext: qs("#nav-next"),
    pills: qs("#pills"),
    puzomerki: qs("#puzomerki"),
    tags: qs("#tags"),
    contactActions: qs("#contact-actions"),
    contactFlags: qs("#contact-flags"),
    priceInput: qs("#price-input"),
    priceMeta: qs("#price-meta"),
    formatBadges: qs("#format-badges"),
    shortDescription: qs("#short-description"),
    psychotype: qs("#psychotype"),
    statsComment: qs("#stats-comment"),
    brandFlag: qs("#brand-flag"),
    toneTags: qs("#tone-tags"),
    riskTags: qs("#risk-tags"),
    contentSummary: qs("#content-summary"),
    commentsHint: qs("#comments-hint"),
    monetizationList: qs("#monetization-list"),
    recCommunication: qs("#rec-communication"),
    recReport: qs("#rec-report"),
    languageGeo: qs("#language-geo"),
    ageBars: qs("#age-bars"),
    genderToggle: qs("#gender-toggle"),
    genderPie: qs("#gender-pie"),
    genderLegend: qs("#gender-legend"),
    contentPie: qs("#content-pie"),
    contentLegend: qs("#content-legend"),
    metricsTable: qs("#metrics-table tbody"),
    coverage: qs("#coverage"),
    adsRow: qs("#ads-row"),
    postsRow: qs("#posts-row"),
    commentsBox: qs("#comments-box")
  };

  function formatNumber(num) {
    if (num === null || num === undefined || Number.isNaN(num)) return "–";
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}m`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
    return Math.round(num).toLocaleString("ru-RU");
  }

  function formatPct(value) {
    if (value === null || value === undefined || Number.isNaN(value)) return "–";
    return `${(value * 100).toFixed(1)}%`;
  }

  function pickColor(idx) {
    const colors = ["#4f9cf9", "#00c6ae", "#a78bfa", "#f59e0b", "#ef4444", "#ec4899", "#10b981"];
    return colors[idx % colors.length];
  }

  async function fetchData() {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("id") || params.get("chat_id") || "why4ch";
    const res = await fetch(`/api/mediakit?id=${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`Не удалось загрузить данные: ${res.status}`);
    return res.json();
  }

  function buildBadges(data) {
    const badges = [];
    if (data.channel.is_verified) badges.push({ text: "Верифицирован", class: "accent" });
    if (data.channel.is_rkn) badges.push({ text: "РКН: ✅", class: "success" });

    els.trustBadges.innerHTML = badges
      .map((b) => `<span class="badge ${b.class || ""}">${b.text}</span>`)
      .join("");
  }

  function renderPuzomerki(data) {
    const hints = {
      wealth: "Добровольные платёжки за контент. Показывают, что аудитория готова платить автору — сильный сигнал вовлечённости и доверия.",
      boost: "Уровень бустов от Premium-слотов/подарков. Чем выше и стабильнее, тем больше фанатов вкладываются в канал — косвенный маркер лояльной базы.",
      gift: "Сколько подарков отправили каналу (Stars/денежный эквивалент). Индикатор щедрости и готовности аудитории поддерживать автора."
    };
    const avgViews = data.metrics?.last30?.avg_views || null;
    const items = [
      { key: "subs", label: "Подписчики", value: formatNumber(data.channel.member_count) },
      { key: "views", label: "Средние просмотры", value: formatNumber(avgViews) },
      { key: "age", label: "Возраст канала", value: data.channel.age_label || "–" },
      data.metrics?.wealth_signal?.has_paid
        ? {
            key: "wealth",
            label: "Wealth ⭐",
            value: formatNumber(data.metrics.wealth_signal.paid_total),
            hint: hints.wealth
          }
        : null,
      data.channel.gift_count > 0
        ? { key: "gift", label: "Gifts 🎁", value: formatNumber(data.channel.gift_count), hint: hints.gift }
        : null,
      { key: "boost", label: "Boost L", value: data.channel.boost_level ?? 0, hint: hints.boost }
    ].filter(Boolean);

    els.puzomerki.innerHTML = items
      .map(
        (m) => `
        <div class="chip-pill pill-${m.key || "neutral"}" ${m.hint ? `data-hint="${m.hint}"` : ""}>
          <span class="chip-key">${m.label}</span>
          <span class="chip-val">${m.value}</span>
        </div>
      `
      )
      .join("");
  }

  function renderTags(passport) {
    const categories = passport?.category || [];
    const tags = passport?.tags || [];
    const catLinks = categories
      .map((c) => `<a href="/index.html?category=${encodeURIComponent(c)}">${c}</a>`)
      .join(", ");
    const tagLinks = tags
      .map((t) => `<a class="tag-plain" href="/index.html?tag=${encodeURIComponent(t)}">#${t}</a>`)
      .join("");
    els.tags.innerHTML = `
      ${catLinks ? `<div class="muted">Категории: ${catLinks}</div>` : ""}
      ${tagLinks ? `<div class="tag-row">${tagLinks}</div>` : ""}
    `;
  }

  function normalizeContact(contact) {
    if (!contact) return null;
    const value = contact.trim();
    if (value.startsWith("@")) return `https://t.me/${value.replace("@", "")}`;
    if (/^https?:\/\//i.test(value)) return value;
    return `https://t.me/${value}`;
  }

  function renderContact(data) {
    const contacts = Array.isArray(data.passport?.contacts) ? data.passport.contacts : [];
    const mainContact = normalizeContact(contacts[0]);
    const fallback = data.channel.has_linked_chat ? data.channel.link : null;
    const target = mainContact || fallback;
    els.contactActions.innerHTML = target
      ? `<button class="primary" id="write-btn">Написать</button><div class="muted mini">${target}</div>`
      : '<div class="muted">Нет контактов</div>';
    if (target) {
      qs("#write-btn").addEventListener("click", () => window.open(target, "_blank"));
    }
    if (data.channel.outgoing_paid_message_star_count > 0) {
      els.contactFlags.innerHTML = `<span class="badge warn">⭐ канал тратит ${formatNumber(
        data.channel.outgoing_paid_message_star_count
      )}</span>`;
    }
  }

  function renderIdentity(data) {
    const title = data.channel.title || "Канал";
    els.avatar.textContent = title.slice(0, 2).toUpperCase();
    els.title.textContent = title;
    els.channelLink.textContent = data.channel.active_username ? `@${data.channel.active_username}` : data.channel.chat_id;
    if (data.channel.link) {
      els.channelLink.innerHTML = `<a href="${data.channel.link}" target="_blank" style="color:var(--accent)">${els.channelLink.textContent}</a>`;
    }
    const pills = [];
    if (data.passport?.ads?.length) pills.push(`Рекламных постов: ${data.passport.ads.length}`);
    els.pills.innerHTML = pills.map((p) => `<span class="pill">${p}</span>`).join("");
  }

  function renderAI(data) {
    const passport = data.passport || {};
    const badges = [];
    if (passport.format) badges.push(`<a class="badge" href="/index.html?format=${encodeURIComponent(passport.format)}">${passport.format}</a>`);
    // язык не показываем по ТЗ
    els.formatBadges.innerHTML = badges
      .map((b) => (b.includes("href") ? b : `<span class="badge">${b}</span>`))
      .join("");
    els.shortDescription.textContent = passport.short_description || "Нет описания";
    els.psychotype.textContent = passport.psychotype || "Нет описания аудитории";
    els.statsComment.textContent = passport.stats_comment || "";
    // Вовлеченность в ИИ блоке убираем по ТЗ
  }

  function renderBrandSafety(data) {
    const brand = (data.passport && data.passport.brand_safety) || "unknown";
    const flagClass =
      brand === "green" ? "brand-green" : brand === "red" ? "brand-red" : brand === "yellow" ? "brand-yellow" : "";
    els.brandFlag.innerHTML = `<div class="brand-flag ${flagClass}">Brand safety: ${brand || "–"}</div>`;
    els.toneTags.innerHTML = (data.passport?.tone_of_voice || []).map((t) => `<span class="tag">${t}</span>`).join("");
    els.riskTags.innerHTML = (data.passport?.content_risks || []).map((t) => `<span class="tag warn">${t}</span>`).join("");
    els.commentsHint.textContent = data.comments?.length ? "Комментарии собраны" : "Комментариев нет";
    const contentSummary = data.passport?.content_summary || data.reports?.content_summary;
    els.contentSummary.textContent = contentSummary || "Временно отсутствует";
  }

  function renderRecommendations(data) {
    const monetization = data.passport?.monetization_model || [];
    els.monetizationList.innerHTML = monetization.map((m) => `<li>${m}</li>`).join("") || "<li>—</li>";
    els.recCommunication.textContent = data.reports?.communication_tips || "Временно отсутствует";
    const report = data.reports?.ad_report;
    const parts = [];
    if (report?.brands) parts.push(`Бренды: ${report.brands}`);
    if (report?.format) parts.push(`Формат: ${report.format}`);
    if (report?.cta) parts.push(`CTA: ${report.cta}`);
    els.recReport.textContent = parts.join("\n") || "Временно отсутствует";
  }

  function drawPie(canvas, legendEl, items, labelFormatter) {
    const ctx = canvas.getContext("2d");
    const total = items.reduce((sum, i) => sum + i.value, 0) || 1;
    let start = -Math.PI / 2;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const radius = Math.min(canvas.width, canvas.height) / 2 - 6;
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    items.forEach((item, idx) => {
      const slice = (item.value / total) * Math.PI * 2;
      const end = start + slice;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, radius, start, end);
      ctx.closePath();
      ctx.fillStyle = pickColor(idx);
      ctx.fill();
      start = end;
    });
    legendEl.innerHTML = items
      .map(
        (item, idx) =>
          `<li><span class="dot" style="background:${pickColor(idx)}"></span>${labelFormatter(item)} — ${(
            (item.value / total) *
            100
          ).toFixed(1)}%</li>`
      )
      .join("");
  }

  function renderDemographics(data) {
    const passport = data.passport || {};
    const geoBadge = passport.geo ? `<span class="badge">${passport.geo}</span>` : "";
    const langBadge = passport.language ? `<span class="badge">${passport.language}</span>` : "";
    els.languageGeo.innerHTML = [langBadge, geoBadge].filter(Boolean).join("");

    const buckets = data.demographics?.buckets || [];
    const maxVal = Math.max(0.001, ...buckets.map((b) => Math.max(b.male || 0, b.female || 0)));
    els.ageBars.innerHTML = `
      <div class="pyramid">
        ${buckets
          .map((b) => {
            const malePct = formatPct(b.shareMale || 0);
            const femalePct = formatPct(b.shareFemale || 0);
            const maleW = ((b.male || 0) / maxVal) * 100;
            const femaleW = ((b.female || 0) / maxVal) * 100;
            return `
              <div class="pyr-row">
                <div class="pyr-bar female" style="width:${femaleW}%;" title="${femalePct}"></div>
                <div class="pyr-label">${b.label}</div>
                <div class="pyr-bar male" style="width:${maleW}%;" title="${malePct}"></div>
              </div>
            `;
          })
          .join("")}
      </div>
    `;
    if (els.genderToggle) els.genderToggle.classList.add("hidden");

    const pieItems = [
      { label: "Мужчины", value: data.demographics?.genderPie?.men || 0 },
      { label: "Женщины", value: data.demographics?.genderPie?.women || 0 }
    ];
    drawPie(
      els.genderPie,
      els.genderLegend,
      pieItems,
      (item) => `${item.label} ${formatPct(item.value || 0)}`
    );

    if (els.genderToggle) els.genderToggle.classList.add("hidden");
  }

  function renderContentMix(data) {
    const types = data.metrics?.content_types || [];
    if (!types.length) return;
    const items = types.map((t) => ({ label: t.type, value: t.share || 0 }));
    drawPie(
      els.contentPie,
      els.contentLegend,
      items,
      (item) => `${item.label}`
    );
  }

  function valueOrDash(val, isPct) {
    if (val === null || val === undefined || Number.isNaN(val)) return "–";
    return isPct ? formatPct(val) : formatNumber(val);
  }

  function renderMetricsTable(data) {
    const organic = data.metrics?.organic || {};
    const ads = data.metrics?.ads || {};
    const typeTable = data.metrics?.content_types
      .map((t) => `<tr><td>${t.type}</td><td>${formatNumber(t.count)}</td><td>${formatNumber(t.avg_views)}</td></tr>`)
      .join("");
    if (typeTable) {
      els.contentLegend.insertAdjacentHTML(
        "afterend",
        `<table class="table-metrics mini-table"><thead><tr><th>Формат</th><th>Кол-во</th><th>Avg Views</th></tr></thead><tbody>${typeTable}</tbody></table>`
      );
    }
    const rows = [
      ["Постов", organic.posts, ads.posts],
      ["Средний охват", organic.avg_views, ads.avg_views],
      ["ER (вовлеч.)", organic.er, ads.er, true],
      ["ERR (к подписчикам)", organic.err, ads.err, true],
      ["Платные реакции", organic.paid_reactions, ads.paid_reactions],
      [
        "Реакции",
        data.channel.reactions_disabled ? null : organic.reactions,
        data.channel.reactions_disabled ? null : ads.reactions
      ],
      ["Форварды", organic.forwards, ads.forwards],
      ["Комментарии", organic.comments, ads.comments]
    ];

    els.metricsTable.innerHTML = rows
      .map(
        (r) => `
      <tr>
        <td>${r[0]}</td>
        <td>${valueOrDash(r[1], r[3])}</td>
        <td>${valueOrDash(r[2], r[3])}</td>
      </tr>`
      )
      .join("");

    const coverage = data.metrics?.coverage_days || 0;
    const scale = data.metrics?.scale || 1;
    els.coverage.textContent =
      coverage >= 30 ? "Покрытие: 30 дней" : `Покрытие: ${coverage} дн, эстимация x${scale}`;
  }

  function formatDate(dateStr) {
    if (!dateStr) return "";
    const dt = new Date(dateStr);
    if (Number.isNaN(dt.getTime())) return "";
    return dt.toLocaleDateString("ru-RU", { day: "2-digit", month: "short" });
  }

  function renderPosts(targetEl, list) {
    if (!list || !list.length) {
      targetEl.innerHTML = '<div class="muted">Нет данных</div>';
      return;
    }
    targetEl.innerHTML = list
      .map((m) => {
        const stats = [
          `👁 ${formatNumber(m.view_count || 0)}`,
          `↪️ ${formatNumber(m.forward_count || 0)}`,
          `🔥 ${formatNumber(m.reactions_total || 0)}`,
          m.reactions_paid ? `⭐ ${formatNumber(m.reactions_paid)}` : null,
          `💬 ${formatNumber(m.reply_count || 0)}`
        ]
          .filter(Boolean)
          .join(" ");
        const link = m.link ? `<a href="${m.link}" target="_blank" class="mini">Открыть пост</a>` : '<span class="mini muted">Ссылка недоступна</span>';
        return `
          <div class="post-card">
            <h4>${formatDate(m.date)} • ${m.content_type || ""}${m.is_ad ? " • Ad" : ""}</h4>
            <div class="post-meta">${stats}</div>
            <div class="post-text">${(m.text_preview || "")}</div>
            ${m.media_url ? `<img class="post-media" src="${m.media_url}" alt="media" />` : ""}
            ${link}
          </div>
        `;
      })
      .join("");
  }

  function resolveId(entity) {
    if (!entity) return null;
    return entity.active_username || entity.chat_id || entity;
  }

  function setupNavigation(data, list) {
    const ids = (list || []).map((c) => resolveId(c)).filter(Boolean);
    const currentId = resolveId(data.channel);
    const idx = ids.findIndex((v) => String(v) === String(currentId));
    const go = (delta) => {
      if (!ids.length || idx === -1) return;
      const next = ids[(idx + delta + ids.length) % ids.length];
      window.location.href = `/mediakit.html?id=${encodeURIComponent(next)}`;
    };
    const prevId = idx > -1 ? ids[(idx - 1 + ids.length) % ids.length] : null;
    const nextId = idx > -1 ? ids[(idx + 1) % ids.length] : null;
    const resolveName = (id) => {
      const found = (list || []).find((c) => String(resolveId(c)) === String(id));
      return found?.active_username ? `@${found.active_username}` : found?.title || id;
    };
    if (els.navPrev) {
      els.navPrev.textContent = prevId ? `← ${resolveName(prevId)}` : "←";
      els.navPrev.onclick = (e) => {
        e.preventDefault();
        go(-1);
      };
    }
    if (els.navNext) {
      els.navNext.textContent = nextId ? `${resolveName(nextId)} →` : "→";
      els.navNext.onclick = (e) => {
        e.preventDefault();
        go(1);
      };
    }
    window.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    });
  }

  function renderComments(data) {
    const box = els.commentsBox;
    if (!data.comments || !data.comments.length) {
      box.parentElement.style.display = "none";
      return;
    }
    box.innerHTML = data.comments.slice(0, 12).map((c) => `<div class="comment">${c}</div>`).join("");
  }

  function setupPriceCalc(data) {
    const avgViews = data.metrics?.last30?.avg_views || 0;
    const update = () => {
      const price = Number(els.priceInput.value || 0);
      if (!avgViews) {
        els.priceMeta.textContent = "Avg. Views: нет данных • CPM: –";
        return;
      }
      const cpm = price > 0 ? Math.round((price / avgViews) * 1000) : 0;
      els.priceMeta.textContent = `Avg. Views: ${formatNumber(avgViews)} • CPM: ${formatNumber(cpm)} ₽`;
    };
    els.priceInput.addEventListener("input", update);
    update();
  }

  function run() {
    Promise.all([fetchData(), fetch("/api/channels").then((r) => r.json())])
      .then(([data, list]) => {
        buildBadges(data);
        renderIdentity(data);
        renderPuzomerki(data);
        renderTags(data.passport);
        renderContact(data);
        renderAI(data);
        renderBrandSafety(data);
        renderRecommendations(data);
        renderDemographics(data);
        renderContentMix(data);
        renderMetricsTable(data);
        renderPosts(els.adsRow, data.messages?.ads || []);
        renderPosts(els.postsRow, data.messages?.organic || []);
        if (!data.messages?.ads?.length) els.adsRow.parentElement.style.display = "none";
        renderComments(data);
        setupPriceCalc(data);
        setupNavigation(data, list.channels || []);
      })
      .catch((err) => {
        console.error(err);
        alert(err.message);
      });
  }

  run();
})();

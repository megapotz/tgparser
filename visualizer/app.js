const tableBody = document.querySelector("#channels-table tbody");
const tableHead = document.querySelector("#channels-table thead");
const detailSection = document.getElementById("detail-section");
const detailTitle = document.getElementById("detail-title");
const meta = document.getElementById("meta");
const postsEl = document.getElementById("posts");
const pieCanvas = document.getElementById("type-pie");
const legendEl = document.getElementById("type-legend");
const barsCanvas = document.getElementById("bars");
const refreshBtn = document.getElementById("refresh-btn");

let channelsCache = [];
let sortState = { key: "title", dir: "asc" };

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

function formatNumber(num) {
  if (num === null || num === undefined || Number.isNaN(num)) return "–";
  if (num >= 1000000) return (num / 1000000).toFixed(1) + "m";
  if (num >= 1000) return (num / 1000).toFixed(1) + "k";
  return num.toString();
}

function formatPct(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "–";
  return (value * 100).toFixed(2) + "%";
}

async function loadChannels() {
  const data = await fetchJson("/api/channels");
  channelsCache = data.channels;
  renderChannels();
}

function sortChannels() {
  const { key, dir } = sortState;
  const factor = dir === "desc" ? -1 : 1;
  const accessor = {
    title: (c) => (c.title || "").toLowerCase(),
    username: (c) => (c.active_username || "").toLowerCase(),
    members: (c) => c.member_count || 0,
    posts: (c) => c.summary.total || 0,
    avg_views: (c) => c.summary.avg_views || 0,
    avg_er: (c) => c.summary.avg_er || 0,
    ads: (c) => c.summary.ads || 0
  }[key];

  return [...channelsCache].sort((a, b) => {
    const av = accessor ? accessor(a) : 0;
    const bv = accessor ? accessor(b) : 0;
    if (typeof av === "string" && typeof bv === "string") return av.localeCompare(bv) * factor;
    return (av - bv) * factor;
  });
}

function renderChannels() {
  const channels = sortChannels();
  tableBody.innerHTML = "";
  channels.forEach((ch) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${ch.title || ""}</td>
      <td>${ch.active_username || ""}</td>
      <td>${formatNumber(ch.member_count)}</td>
      <td>${ch.summary.total}</td>
      <td>${formatNumber(Math.round(ch.summary.avg_views || 0))}</td>
      <td>${formatPct(ch.summary.avg_er)}</td>
      <td>${ch.summary.ads}</td>
    `;
    tr.addEventListener("click", () => {
      window.location.href = `/channel.html?id=${encodeURIComponent(ch.chat_id)}`;
    });
    tableBody.appendChild(tr);
  });
}

function handleSortClick(e) {
  const key = e.target.getAttribute("data-sort");
  if (!key) return;
  if (sortState.key === key) {
    sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
  } else {
    sortState.key = key;
    sortState.dir = "asc";
  }
  renderChannels();
}

function drawPie(canvas, data) {
  const ctx = canvas.getContext("2d");
  const total = data.reduce((acc, item) => acc + item.count, 0) || 1;
  let start = 0;
  const colors = ["#60a5fa", "#22d3ee", "#a78bfa", "#f59e0b", "#f472b6", "#34d399"];
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const radius = Math.min(canvas.width, canvas.height) / 2 - 8;
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;

  data.forEach((item, idx) => {
    const slice = (item.count / total) * Math.PI * 2;
    const end = start + slice;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, start, end);
    ctx.closePath();
    ctx.fillStyle = colors[idx % colors.length];
    ctx.fill();
    start = end;
  });

  legendEl.innerHTML = data
    .map((item, idx) => {
      const color = colors[idx % colors.length];
      const pct = ((item.count / total) * 100).toFixed(1);
      const er = item.avg_er !== null && item.avg_er !== undefined ? `${(item.avg_er * 100).toFixed(2)}%` : "–";
      return `<li><span class="dot" style="background:${color}"></span>${item.type} — ${pct}% • ER ${er}</li>`;
    })
    .join("");
}

function drawBars(canvas, messages) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const maxVal = Math.max(
    1,
    ...messages.map((m) => Math.max(m.reactions_total || 0, m.reply_count || 0, m.forward_count || 0))
  );
  const pad = 10;
  const barWidth = Math.max(4, (canvas.width - pad * 2) / messages.length - 2);
  messages.forEach((m, idx) => {
    const x = pad + idx * (barWidth + 2);
    const scales = [
      { val: m.reactions_total || 0, color: "#60a5fa" },
      { val: m.reply_count || 0, color: "#f59e0b" },
      { val: m.forward_count || 0, color: "#a78bfa" }
    ];
    scales.forEach((s, i) => {
      const h = (s.val / maxVal) * (canvas.height - pad * 2);
      ctx.fillStyle = s.color;
      ctx.fillRect(x + i * (barWidth / 3), canvas.height - pad - h, barWidth / 3 - 1, h);
    });
  });
}

function renderPosts(messages) {
  postsEl.innerHTML = "";
  messages.slice(0, 60).forEach((m) => {
    const div = document.createElement("div");
    div.className = "post";
    const date = m.date ? new Date(m.date).toLocaleString() : "";
    const meta = [
      `views ${formatNumber(m.view_count)}`,
      `ER ${formatPct(m.er)}`,
      m.content_type,
      m.is_ad ? "Реклама" : null
    ].filter(Boolean);
    const imgs = m.media_url ? [m.media_url] : m.image_urls || [];
    div.innerHTML = `
      <h4>${date}</h4>
      <div class="meta">${meta.map((t) => `<span class="badge">${t}</span>`).join(" ")}</div>
      <p>${(m.text_preview || "").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>
      ${imgs.length ? `<img class="preview" src="${imgs[0]}" alt="preview" />` : ""}
    `;
    postsEl.appendChild(div);
  });
}

async function loadDetail(chatId) {
  const data = await fetchJson(`/api/channels/${chatId}`);
  detailTitle.textContent = `${data.channel.title || ""} (${data.channel.active_username || data.channel.chat_id})`;
  meta.textContent = `Подписчики: ${formatNumber(data.channel.member_count)} • Сообщений: ${data.summary.total} • Avg Views: ${formatNumber(Math.round(data.summary.avg_views || 0))} • Avg ER: ${formatPct(data.summary.avg_er)} • Ads: ${data.summary.ads}`;

  const pieData = data.summary.types.length ? data.summary.types : [{ type: "unknown", count: 1, avg_er: null }];
  drawPie(pieCanvas, pieData);
  drawBars(barsCanvas, data.messages);
  renderPosts(data.messages);
  detailSection.classList.remove("hidden");
}

refreshBtn.addEventListener("click", loadChannels);
tableHead.addEventListener("click", handleSortClick);
loadChannels().catch((err) => alert(err.message));

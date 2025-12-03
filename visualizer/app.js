const tableBody = document.querySelector("#channels-table tbody");
const tableHead = document.querySelector("#channels-table thead");
const refreshBtn = document.getElementById("refresh-btn");
const filterEls = {
  search: document.getElementById("filter-search"),
  subs: document.getElementById("filter-subs"),
  views: document.getElementById("filter-views"),
  category: document.getElementById("filter-category"),
  tag: document.getElementById("filter-tag"),
  format: document.getElementById("filter-format"),
  rkn: document.getElementById("filter-rkn"),
  verified: document.getElementById("filter-verified"),
  paid: document.getElementById("filter-paid"),
  reset: document.getElementById("filters-reset")
};

let channelsCache = [];
let sortState = { key: "title", dir: "asc" };
let filterState = {
  search: "",
  subs: "",
  views: "",
  category: "",
  tag: "",
  format: "",
  rkn: false,
  verified: false,
  paid: false
};

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

function readFiltersFromQuery() {
  const params = new URLSearchParams(window.location.search);
  filterState.search = params.get("q") || "";
  filterState.subs = params.get("subs") || "";
  filterState.views = params.get("views") || "";
  filterState.category = params.get("category") || "";
  filterState.tag = params.get("tag") || "";
  filterState.format = params.get("format") || "";
  filterState.rkn = params.get("rkn") === "1";
  filterState.verified = params.get("verified") === "1";
  filterState.paid = params.get("paid") === "1";
}

function syncFiltersToUI() {
  filterEls.search.value = filterState.search;
  filterEls.subs.value = filterState.subs;
  filterEls.views.value = filterState.views;
  filterEls.category.value = filterState.category;
  filterEls.tag.value = filterState.tag;
  filterEls.format.value = filterState.format;
  filterEls.rkn.checked = filterState.rkn;
  filterEls.verified.checked = filterState.verified;
  filterEls.paid.checked = filterState.paid;
}

function updateQuery() {
  const params = new URLSearchParams();
  if (filterState.search) params.set("q", filterState.search);
  if (filterState.subs) params.set("subs", filterState.subs);
  if (filterState.views) params.set("views", filterState.views);
  if (filterState.category) params.set("category", filterState.category);
  if (filterState.tag) params.set("tag", filterState.tag);
  if (filterState.format) params.set("format", filterState.format);
  if (filterState.rkn) params.set("rkn", "1");
  if (filterState.verified) params.set("verified", "1");
  if (filterState.paid) params.set("paid", "1");
  const qs = params.toString();
  const newUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  window.history.replaceState(null, "", newUrl);
}

function collectOptions() {
  const categories = new Set();
  const tags = new Set();
  const formats = new Set();
  channelsCache.forEach((c) => {
    (c.categories || []).forEach((v) => categories.add(v));
    (c.tags || []).forEach((v) => tags.add(v));
    if (c.format) formats.add(c.format);
  });
  const toOptions = (set) => ["", ...Array.from(set).sort()];
  return { categories: toOptions(categories), tags: toOptions(tags), formats: toOptions(formats) };
}

function fillSelect(el, options, placeholder, selected) {
  const opts = [...options];
  if (selected && !opts.includes(selected)) opts.unshift(selected);
  el.innerHTML = opts.map((opt) => `<option value="${opt}">${opt || placeholder}</option>`).join("");
}

function applyFilters(list) {
  const search = filterState.search.trim().toLowerCase();
  const minSubs = Number(filterState.subs) || 0;
  const minViews = Number(filterState.views) || 0;
  const category = filterState.category;
  const tag = filterState.tag;
  const format = filterState.format;
  const norm = (v) => (v || "").toString().trim().toLowerCase();
  const matchAny = (needle, hay) => {
    if (!needle) return true;
    const target = norm(needle);
    return (hay || []).some((v) => norm(v) === target);
  };
  return list.filter((c) => {
    if (search) {
      const hay = `${c.title || ""} ${c.active_username || ""}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    if (minSubs && (c.member_count || 0) < minSubs) return false;
    if (minViews && (c.summary.avg_views || 0) < minViews) return false;
    if (filterState.rkn && !c.is_rkn) return false;
    if (filterState.verified && !c.is_verified) return false;
    if (filterState.paid && !c.summary.has_paid) return false;
    if (!matchAny(category, c.categories)) return false;
    if (!matchAny(tag, c.tags)) return false;
    if (format && norm(c.format) !== norm(format)) return false;
    return true;
  });
}

function sortChannels(list) {
  const { key, dir } = sortState;
  const factor = dir === "desc" ? -1 : 1;
  const accessor = {
    title: (c) => (c.title || "").toLowerCase(),
    username: (c) => (c.active_username || "").toLowerCase(),
    format: (c) => (c.format || "").toLowerCase(),
    category: (c) => ((c.categories || [])[0] || "").toLowerCase(),
    tags: (c) => ((c.tags || [])[0] || "").toLowerCase(),
    members: (c) => c.member_count || 0,
    posts: (c) => c.summary.total || 0,
    avg_views: (c) => c.summary.avg_views || 0,
    avg_er: (c) => c.summary.avg_er || 0,
    ads: (c) => c.summary.ads || 0
  }[key];

  return [...list].sort((a, b) => {
    const av = accessor ? accessor(a) : 0;
    const bv = accessor ? accessor(b) : 0;
    if (typeof av === "string" && typeof bv === "string") return av.localeCompare(bv) * factor;
    return (av - bv) * factor;
  });
}

function renderChannels() {
  const filtered = applyFilters(channelsCache);
  const channels = sortChannels(filtered);
  tableBody.innerHTML = "";
  channels.forEach((ch) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${ch.title || ""}</td>
      <td>${ch.active_username || ""}</td>
      <td>${ch.format || "–"}</td>
      <td>${(ch.categories || []).join(", ")}</td>
      <td>${(ch.tags || []).join(", ")}</td>
      <td>${formatNumber(ch.member_count)}</td>
      <td>${ch.summary.total}</td>
      <td>${formatNumber(Math.round(ch.summary.avg_views || 0))}</td>
      <td>${formatPct(ch.summary.avg_er)}</td>
      <td>${ch.summary.ads}</td>
    `;
    tr.addEventListener("click", () => {
      const id = ch.active_username || ch.chat_id;
      window.location.href = `/mediakit.html?id=${encodeURIComponent(id)}`;
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

function bindFilters() {
  const onChange = () => {
    filterState = {
      search: filterEls.search.value,
      subs: filterEls.subs.value,
      views: filterEls.views.value,
      category: filterEls.category.value,
      tag: filterEls.tag.value,
      format: filterEls.format.value,
      rkn: filterEls.rkn.checked,
      verified: filterEls.verified.checked,
      paid: filterEls.paid.checked
    };
    updateQuery();
    renderChannels();
  };
  Object.values(filterEls)
    .filter((el) => el && el !== filterEls.reset)
    .forEach((el) => {
      el.addEventListener("input", onChange);
      el.addEventListener("change", onChange);
    });
  filterEls.reset.addEventListener("click", () => {
    filterState = {
      search: "",
      subs: "",
      views: "",
      category: "",
      tag: "",
      format: "",
      rkn: false,
      verified: false,
      paid: false
    };
    syncFiltersToUI();
    updateQuery();
    renderChannels();
  });
}

async function loadChannels() {
  const data = await fetchJson("/api/channels");
  readFiltersFromQuery();
  channelsCache = data.channels;
  const opts = collectOptions();
  fillSelect(filterEls.category, opts.categories, "Все категории", filterState.category);
  fillSelect(filterEls.tag, opts.tags, "Все теги", filterState.tag);
  fillSelect(filterEls.format, opts.formats, "Все типы", filterState.format);
  syncFiltersToUI();
  renderChannels();
}

readFiltersFromQuery();
syncFiltersToUI();
bindFilters();
refreshBtn.addEventListener("click", loadChannels);
tableHead.addEventListener("click", handleSortClick);
loadChannels().catch((err) => alert(err.message));

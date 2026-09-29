(() => {
  "use strict";

  const API = "https://api.opendota.com/api";
  const CDN = "https://cdn.cloudflare.steamstatic.com";
  const DAY = 24 * 60 * 60 * 1000;

  const BRACKETS = ["1", "2", "3", "4", "5", "6", "7", "8"];
  const BRACKET_NAMES = { 1: "Herald", 2: "Guardian", 3: "Crusader", 4: "Archon", 5: "Legend", 6: "Ancient", 7: "Divine", 8: "Immortal" };
  const ATTR_NAMES = { str: "Strength", agi: "Agility", int: "Intelligence", all: "Universal" };
  const PHASES = [
    ["start_game_items", "Starting items", "Bought before creeps spawn"],
    ["early_game_items", "Early game", "Minute 0 to 10"],
    ["mid_game_items", "Mid game", "Minute 10 to 25"],
    ["late_game_items", "Late game", "After minute 25"]
  ];
  // Consumables and wards drown out real build items outside the starting phase.
  const CONSUMABLES = new Set([
    "tango", "flask", "clarity", "enchanted_mango", "faerie_fire", "ward_observer", "ward_sentry",
    "ward_dispenser", "dust", "smoke_of_deceit", "tpscroll", "blood_grenade", "tome_of_knowledge",
    "cheese", "aghanims_shard_roshan", "ultimate_scepter_roshan", "refresher_shard", "famango",
    "great_famango", "greater_famango", "royal_jelly", "branches"
  ]);

  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const liteMedia = !finePointer || window.matchMedia("(max-width: 899px)").matches || !!(navigator.connection && navigator.connection.saveData);

  const state = { heroes: [], items: {}, attr: "", role: "", bracket: "all", sort: "tier", query: "", meta: null, order: [] };
  const cards = new Map();
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // ---------- data ----------

  const cache = {
    get(key) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const { t, v } = JSON.parse(raw);
        return Date.now() - t < DAY ? v : null;
      } catch { return null; }
    },
    set(key, v) {
      try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), v })); } catch { /* storage full or blocked */ }
    }
  };

  async function getJSON(path) {
    const res = await fetch(API + path);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
    return res.json();
  }

  async function cached(key, path, slim = (x) => x) {
    const hit = cache.get(key);
    if (hit) return hit;
    const v = slim(await getJSON(path));
    cache.set(key, v);
    return v;
  }

  // A daily snapshot of the API lives in data/ (built by a GitHub Action). Use it when it is fresh,
  // otherwise fall back to the live API.
  const snapshot = fetch("data/meta.json", { cache: "no-cache" })
    .then((r) => (r.ok ? r.json() : null))
    .then((m) => (m && Date.now() - Date.parse(m.generatedAt) < 3 * DAY ? m : null))
    .catch(() => null);

  async function fromSnapshot(file) {
    const m = await snapshot;
    if (!m) return null;
    try {
      const res = await fetch(`data/${file}?v=${encodeURIComponent(m.generatedAt)}`);
      return res.ok ? await res.json() : null;
    } catch { return null; }
  }

  const loadHeroStats = async () => (await fromSnapshot("heroStats.json")) || cached("d2.heroStats", "/heroStats");
  const loadPatch = async () => {
    const m = await snapshot;
    return (m && m.patch) || cached("d2.patch", "/constants/patch", (list) => list[list.length - 1]);
  };
  const loadItems = async () => (await fromSnapshot("items.json")) || cached("d2.items", "/constants/items", (all) => {
    const byId = {};
    for (const [key, it] of Object.entries(all)) {
      if (!it || it.id == null || key.startsWith("recipe_")) continue;
      byId[it.id] = { key, name: it.dname || key, img: it.img, cost: it.cost || 0 };
    }
    return byId;
  });

  // ---------- meta math ----------

  function bracketStats(h, bracket) {
    if (bracket === "pro") return { pick: h.pro_pick || 0, win: h.pro_win || 0 };
    const keys = bracket === "all" ? BRACKETS : [bracket];
    let pick = 0, win = 0;
    for (const b of keys) { pick += h[`${b}_pick`] || 0; win += h[`${b}_win`] || 0; }
    return { pick, win };
  }

  function computeMeta(bracket) {
    const rows = state.heroes.map((h) => ({ h, ...bracketStats(h, bracket) }));
    const matches = rows.reduce((s, r) => s + r.pick, 0) / 10 || 1;
    for (const r of rows) {
      r.wr = r.pick ? r.win / r.pick : 0;
      r.pr = r.pick / matches;
    }
    const valid = rows.filter((r) => r.pick > 0);
    const z = (vals) => {
      const m = vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
      const sd = Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / (vals.length || 1)) || 1;
      return (v) => (v - m) / sd;
    };
    const zWr = z(valid.map((r) => r.wr));
    const zPr = z(valid.map((r) => Math.log(r.pr + 1e-4)));
    for (const r of rows) r.score = r.pick ? zWr(r.wr) * 0.7 + zPr(Math.log(r.pr + 1e-4)) * 0.3 : -99;

    const ranked = [...rows].sort((a, b) => b.score - a.score);
    const cuts = [["S", 0.1], ["A", 0.3], ["B", 0.65], ["C", 0.85], ["D", 1]];
    ranked.forEach((r, i) => {
      const p = (i + 1) / ranked.length;
      r.tier = cuts.find(([, c]) => p <= c)[0];
      r.rank = i + 1;
    });
    const map = new Map(rows.map((r) => [r.h.id, r]));
    map.ranked = ranked;
    map.totalPicks = rows.reduce((s, r) => s + r.pick, 0);
    return map;
  }

  // ---------- helpers ----------

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = (v, d = 1) => `${(v * 100).toFixed(d)}%`;
  const img = (path) => (path ? CDN + path : "");
  const heroSlug = (h) => h.name.replace("npc_dota_hero_", "");
  const heroImg = (h) => img(h.img) || `${CDN}/apps/dota2/images/dota_react/heroes/${heroSlug(h)}.png`;
  // Dota's site keeps the still renders next to the videos; the images/ path is an older location.
  const heroRenders = (h) => [
    `${CDN}/apps/dota2/videos/dota_react/heroes/renders/${heroSlug(h)}.png`,
    `${CDN}/apps/dota2/images/dota_react/heroes/renders/${heroSlug(h)}.png`
  ];
  const heroVideo = (h, ext) => `${CDN}/apps/dota2/videos/dota_react/heroes/renders/${heroSlug(h)}.${ext}`;
  const wrClass = (wr) => (wr >= 0.52 ? "good" : wr <= 0.48 ? "bad" : "");
  const compact = (n) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
  const bracketLabel = () => $("#bracket").selectedOptions[0].textContent;

  // Transparent hero videos are decoded on the CPU, so only the ones on screen keep playing.
  const onScreen = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const v = e.target;
      v._visible = e.isIntersecting;
      if (v.id === "intro-video") $(".intro").classList.toggle("off", !e.isIntersecting);
      if (!e.isIntersecting) v.pause();
      else if (v.currentSrc) v.play().catch(() => {});
    }
  });

  // Point a <video> at a hero's animated render. Phones get a still render instead, and when no render
  // exists at all the hero portrait is shown in a framed card rather than a bare rectangle.
  function setHeroVideo(video, h) {
    video.classList.remove("failed", "portrait");
    video.style.backgroundImage = "";
    const token = (video._heroToken = {});
    const renders = heroRenders(h);
    const portrait = () => {
      if (video._heroToken !== token) return;
      video.removeAttribute("poster");
      video.classList.add("failed", "portrait");
      video.style.backgroundImage = `url("${heroImg(h)}")`;
    };
    // Try each still render in turn; use the first that loads as the poster.
    const probe = (i = 0) => {
      if (i >= renders.length) return portrait();
      const im = new Image();
      im.onload = () => { if (video._heroToken === token) video.poster = renders[i]; };
      im.onerror = () => probe(i + 1);
      im.src = renders[i];
    };
    if (liteMedia) {
      video.removeAttribute("src");
      video.innerHTML = "";
      probe();
      return;
    }
    video.innerHTML = `
      <source src="${esc(heroVideo(h, "webm"))}" type="video/webm">
      <source src="${esc(heroVideo(h, "mov"))}" type='video/mp4; codecs="hvc1"'>`;
    video.poster = renders[0];
    const lastSource = video.querySelector("source:last-child");
    lastSource.addEventListener("error", () => { video.classList.add("failed"); probe(); }, { once: true });
    video.load();
    if (video._visible === false) return;
    const p = video.play();
    if (p && p.catch) p.catch(() => {});
  }

  // ---------- motion ----------
  // Everything moves once, with CSS transitions: an element marked data-rv fades up the first time it
  // scrolls into view, and nothing runs per frame after that. The browser does its own scrolling.

  const revealIO = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("in");
      revealIO.unobserve(e.target);
      if (e.target._onReveal) e.target._onReveal();
    }
  }, { rootMargin: "0px 0px -6% 0px" });

  const reveal = (root = document) => {
    const els = root.matches && root.matches("[data-rv]") ? [root] : [];
    els.push(...$$("[data-rv]:not(.in)", root));
    els.forEach((el) => revealIO.observe(el));
  };
  const onReveal = (el, fn) => { if (!el) return; if (el.classList.contains("in")) fn(); else el._onReveal = fn; };

  function countUp(el, to, fmt = (v) => Math.round(v).toLocaleString("en-US"), ms = 1400) {
    if (!el) return;
    if (reduceMotion) { el.textContent = fmt(to); return; }
    const t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / ms);
      el.textContent = fmt(to * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---------- highlights ----------

  let highlights = null;
  const loadHighlights = () => (highlights ||= fetch("data/highlights.json", { cache: "no-cache" })
    .then((r) => (r.ok ? r.json() : null)).then((d) => (d && d.videos) || []).catch(() => []));

  function ago(iso) {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    for (const [n, unit] of [[31536000, "year"], [2592000, "month"], [604800, "week"], [86400, "day"], [3600, "hour"], [60, "minute"]]) {
      if (s >= n) { const v = Math.floor(s / n); return `${v} ${unit}${v > 1 ? "s" : ""} ago`; }
    }
    return "just now";
  }
  const duration = (sec) => {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = String(sec % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  };
  // Channels tack "| DOTA2" and similar onto every title; the page already says it's Dota.
  const tidyTitle = (t) => t.replace(/\s*[|·-]\s*dota ?2\s*$/i, "").trim();

  const highlightCard = (v) => `
    <button class="hl-card" type="button" data-video="${esc(v.id)}" data-title="${esc(tidyTitle(v.title))}">
      <span class="hl-thumb">
        <img src="https://i.ytimg.com/vi/${esc(v.id)}/hqdefault.jpg" alt="" loading="lazy" decoding="async">
        <i class="hl-play" aria-hidden="true"></i>
        <em class="hl-ch">${esc(v.channel)}</em>
        ${v.duration ? `<em class="hl-dur">${duration(v.duration)}</em>` : ""}
      </span>
      <span class="hl-meta">
        <b>${esc(tidyTitle(v.title))}</b>
        <small>${esc(ago(v.published))}${v.views ? ` · ${compact(v.views)} views` : ""}</small>
      </span>
    </button>`;

  let hlFilter = "";
  async function renderHighlightsPage() {
    const view = $("#highlights-view");
    view.innerHTML = `
      <section class="wrap hl-page">
        <a class="back" href="#/" data-rv><span>←</span> All heroes</a>
        <p class="eyebrow" data-rv style="--d:1"><span class="line"></span>Fresh from the pro scene</p>
        <h1 class="section-title hl-title" data-rv style="--d:2">Tournament highlights</h1>
        <div class="hl-chips" id="hl-chips" role="group" aria-label="Channel" data-rv style="--d:3"></div>
        <div class="hl-grid" id="hl-grid"><p class="state">Loading highlights…</p></div>
      </section>`;
    reveal(view);
    const videos = await loadHighlights();
    if (current !== "highlights") return;
    const grid = $("#hl-grid", view);
    if (!videos.length) { grid.innerHTML = `<p class="state">No highlights yet. They are collected every few hours, check back soon.</p>`; return; }
    const channels = [...new Set(videos.map((v) => v.channel))];
    if (!channels.includes(hlFilter)) hlFilter = "";
    const chips = $("#hl-chips", view);
    const draw = () => {
      chips.innerHTML = ["", ...channels].map((c) => `<button type="button" class="chip${c === hlFilter ? " on" : ""}" data-ch="${esc(c)}">${esc(c || "All")}</button>`).join("");
      grid.innerHTML = videos.filter((v) => !hlFilter || v.channel === hlFilter).map(highlightCard).join("");
      $$(".hl-card", grid).forEach((c, i) => { c.setAttribute("data-rv", ""); c.style.setProperty("--d", i % 4); });
      reveal(grid);
    };
    chips.addEventListener("click", (e) => {
      const b = e.target.closest(".chip");
      if (!b || b.dataset.ch === hlFilter) return;
      hlFilter = b.dataset.ch;
      draw();
    });
    draw();
  }

  function renderHomeHighlights(videos) {
    if (!videos.length) return;
    $("#hl-row").innerHTML = videos.slice(0, 8).map(highlightCard).join("");
    $$("#hl-row .hl-card").forEach((c, i) => { c.setAttribute("data-rv", ""); c.style.setProperty("--d", i % 4); });
    $("#highlights").hidden = false;
  }

  // One shared player: the YouTube iframe only exists while the dialog is open.
  function initPlayer() {
    const box = $("#player");
    const frame = $(".player-frame", box);
    let paused = [], lastFocus = null;
    const close = () => {
      if (box.hidden) return;
      box.hidden = true;
      frame.innerHTML = "";
      document.body.classList.remove("player-open");
      paused.forEach((v) => v.play().catch(() => {}));
      paused = [];
      lastFocus && lastFocus.focus();
    };
    const open = (id, title) => {
      lastFocus = document.activeElement;
      frame.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&rel=0&playsinline=1" title="${esc(title)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
      $(".player-title", box).textContent = title;
      $(".player-yt", box).href = `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
      // Hero videos behind the dialog would only compete with the YouTube player.
      paused = $$("video").filter((v) => !v.paused);
      paused.forEach((v) => v.pause());
      box.hidden = false;
      document.body.classList.add("player-open");
      $(".player-close", box).focus();
    };
    document.addEventListener("click", (e) => {
      const card = e.target.closest(".hl-card");
      if (card) { open(card.dataset.video, card.dataset.title); return; }
      if (e.target.closest("[data-close]")) close();
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
    addEventListener("hashchange", close);
  }

  // ---------- home ----------

  function renderIntro() {
    const top = state.meta.ranked.find((r) => r.pick > 0);
    if (!top) return;
    setHeroVideo($("#intro-video"), top.h);
    onScreen.observe($("#intro-video"));
    $("#intro-hero-link").href = `#/hero/${top.h.id}`;
    $("#intro-hero-link span").textContent = `${top.h.localized_name}, #1 right now`;
    $("#intro-now").innerHTML = `
      <span class="now-label">Hero #1 meta</span>
      <b>${esc(top.h.localized_name)}</b>
      <span><em class="${wrClass(top.wr)}">${pct(top.wr)}</em> win rate · tier <b class="tier t-${top.tier}">${top.tier}</b></span>`;
  }

  // Top 5 cards show a still render; the animated one only plays while the pointer is over a card,
  // the way the hero grid on dota2.com works.
  function renderTop() {
    const top = state.meta.ranked.filter((r) => r.pick > 0).slice(0, 5);
    $("#top-bracket").textContent = `Top 5 · ${bracketLabel()}`;
    $("#top-track").innerHTML = top.map(({ h, wr, pr, tier }, i) => {
      const [still, alt] = heroRenders(h);
      return `
      <a class="top-card attr-${esc(h.primary_attr)}" href="#/hero/${h.id}" data-hero="${h.id}" data-rv style="--d:${i}">
        <span class="top-rank">0${i + 1}</span>
        <div class="top-art">
          <img class="top-still" src="${esc(still)}" alt="" loading="lazy" data-alt="${esc(alt)}" data-portrait="${esc(heroImg(h))}">
        </div>
        <div class="top-info">
          <p class="top-attr"><i class="attr ${esc(h.primary_attr)}"></i>${esc(ATTR_NAMES[h.primary_attr] || "")}</p>
          <h3>${esc(h.localized_name)}</h3>
          <div class="top-stats">
            <span><b class="${wrClass(wr)}">${pct(wr)}</b><small>Win rate</small></span>
            <span><b>${pct(pr)}</b><small>Pick rate</small></span>
            <span><b class="tier t-${tier}">${tier}</b><small>Tier</small></span>
          </div>
        </div>
      </a>`;
    }).join("");
    // Missing render: try the older path, then fall back to the portrait.
    $$(".top-still").forEach((im) => im.addEventListener("error", () => {
      if (im.dataset.alt) { im.src = im.dataset.alt; im.dataset.alt = ""; }
      else if (im.dataset.portrait) { im.src = im.dataset.portrait; im.dataset.portrait = ""; im.classList.add("portrait"); }
    }));
    reveal($("#top-track"));
  }

  function initTopHover() {
    if (liteMedia) return;
    const byId = () => new Map(state.heroes.map((h) => [h.id, h]));
    $("#top-track").addEventListener("pointerover", (e) => {
      const card = e.target.closest(".top-card");
      if (!card || card._video) return;
      const h = byId().get(Number(card.dataset.hero));
      const v = document.createElement("video");
      v.className = "top-video";
      v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true;
      v.setAttribute("aria-hidden", "true");
      v.innerHTML = `<source src="${esc(heroVideo(h, "webm"))}" type="video/webm"><source src="${esc(heroVideo(h, "mov"))}" type='video/mp4; codecs="hvc1"'>`;
      v.addEventListener("playing", () => card.classList.add("playing"), { once: true });
      $(".top-art", card).append(v);
      card._video = v;
      const leave = (ev) => {
        if (card.contains(ev.relatedTarget)) return;
        card.removeEventListener("pointerout", leave);
        card.classList.remove("playing");
        setTimeout(() => { v.remove(); if (card._video === v) card._video = null; }, 300);
      };
      card.addEventListener("pointerout", leave);
    });
  }

  function renderNumbers(animate) {
    const meta = state.meta;
    const best = meta.ranked.filter((r) => r.pick > 0).reduce((m, r) => Math.max(m, r.wr), 0);
    const vals = [
      [$("#n-heroes"), state.heroes.length, undefined],
      [$("#n-picks"), meta.totalPicks, compact],
      [$("#n-s"), meta.ranked.filter((r) => r.tier === "S").length, undefined],
      [$("#n-best"), best, (v) => pct(v)]
    ];
    for (const [el, to, fmt] of vals) {
      if (animate) onReveal(el.closest(".num"), () => countUp(el, to, fmt));
      else el.textContent = (fmt || ((v) => Math.round(v).toLocaleString("en-US")))(to);
    }
  }

  // ---------- hero grid ----------

  function buildCards() {
    const grid = $("#grid");
    grid.innerHTML = "";
    for (const h of state.heroes) {
      const a = document.createElement("a");
      a.className = `card attr-${h.primary_attr}`;
      a.href = `#/hero/${h.id}`;
      a.dataset.id = h.id;
      a.innerHTML = `
        <div class="card-img">
          <img src="${esc(heroImg(h))}" alt="" loading="lazy" decoding="async">
          <b class="tier"></b>
        </div>
        <div class="card-body">
          <div class="card-name"><i class="attr ${esc(h.primary_attr)}"></i>${esc(h.localized_name)}</div>
          <div class="card-stats">
            <span class="c-wr" title="Win rate"></span>
            <span class="c-pr" title="Pick rate"></span>
          </div>
        </div>`;
      grid.appendChild(a);
      cards.set(h.id, a);
    }
  }

  function updateCards() {
    for (const [id, el] of cards) {
      const r = state.meta.get(id);
      el.classList.remove("tier-S", "tier-A", "tier-B", "tier-C", "tier-D");
      el.classList.add(`tier-${r.tier}`);
      const t = $(".tier", el);
      t.className = `tier t-${r.tier}`;
      t.textContent = r.tier;
      const wr = $(".c-wr", el);
      wr.className = `c-wr ${wrClass(r.wr)}`;
      wr.innerHTML = `${pct(r.wr)} <small>WR</small>`;
      $(".c-pr", el).innerHTML = `${pct(r.pr)} <small>PR</small>`;
    }
  }

  function applyFilters({ animate = true } = {}) {
    const q = state.query.trim().toLowerCase();
    const rows = state.heroes.map((h) => state.meta.get(h.id));
    const sorters = {
      tier: (a, b) => b.score - a.score,
      win: (a, b) => b.wr - a.wr,
      pick: (a, b) => b.pr - a.pr,
      name: (a, b) => a.h.localized_name.localeCompare(b.h.localized_name)
    };
    rows.sort(sorters[state.sort]);
    const show = (h) => (!state.attr || h.primary_attr === state.attr)
      && (!state.role || (h.roles || []).includes(state.role))
      && (!q || h.localized_name.toLowerCase().includes(q));

    const grid = $("#grid");
    const frag = document.createDocumentFragment();
    const order = [];
    for (const r of rows) {
      const el = cards.get(r.h.id);
      const on = show(r.h);
      el.hidden = !on;
      if (on) order.push(r.h.id);
      frag.appendChild(el);
    }
    grid.appendChild(frag);
    state.order = order;
    // A quick fade tells the eye the list changed, without moving 100+ cards around.
    if (animate && !reduceMotion) {
      grid.classList.remove("refresh");
      void grid.offsetWidth;
      grid.classList.add("refresh");
    }
    $("#result-count").textContent = `${order.length} ${order.length === 1 ? "hero" : "heroes"}`;
    $("#grid-empty").hidden = order.length > 0;
  }

  function initFilters() {
    const roles = [...new Set(state.heroes.flatMap((h) => h.roles || []))].sort();
    $("#role").insertAdjacentHTML("beforeend", roles.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join(""));
    const live = new Set(liveBrackets().map(String));
    for (const o of $$("#bracket option")) if (/^\d$/.test(o.value) && !live.has(o.value)) o.remove();

    let t;
    $("#search").addEventListener("input", (e) => {
      state.query = e.target.value;
      clearTimeout(t);
      t = setTimeout(() => applyFilters(), 150);
    });
    $("#role").addEventListener("change", (e) => { state.role = e.target.value; applyFilters(); });
    $("#sort").addEventListener("change", (e) => { state.sort = e.target.value; applyFilters(); });
    $("#bracket").addEventListener("change", (e) => {
      state.bracket = e.target.value;
      state.meta = computeMeta(state.bracket);
      updateCards();
      applyFilters();
      renderTop();
      renderIntro();
      renderNumbers(false);
    });
    $("#attr-filter").addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      state.attr = btn.dataset.attr;
      for (const b of $$("#attr-filter button")) b.classList.toggle("on", b === btn);
      applyFilters();
    });
    initSelects();
  }

  // Custom dropdowns: the native <select> stays as the source of truth (hidden), the button + list drive it.
  function initSelects() {
    const all = [];
    const closeAll = (except) => all.forEach((d) => d !== except && d.close());
    for (const select of $$(".controls select")) {
      const wrap = document.createElement("div");
      wrap.className = "dd";
      select.before(wrap);
      wrap.append(select);
      select.tabIndex = -1;
      select.setAttribute("aria-hidden", "true");
      const id = `${select.id}-menu`;
      wrap.insertAdjacentHTML("beforeend", `
        <button type="button" class="dd-btn" aria-haspopup="listbox" aria-expanded="false" aria-controls="${id}" aria-label="${esc(select.getAttribute("aria-label"))}">
          <span class="dd-label"></span><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5"/></svg>
        </button>
        <ul class="dd-menu" id="${id}" role="listbox" tabindex="-1"></ul>`);
      const btn = $(".dd-btn", wrap), label = $(".dd-label", wrap), menu = $(".dd-menu", wrap);
      let active = 0;
      const opts = () => [...select.options];
      const sync = () => { label.textContent = select.selectedOptions[0] ? select.selectedOptions[0].textContent : ""; };
      const setActive = (i) => {
        const items = $$("li", menu);
        active = Math.max(0, Math.min(items.length - 1, i));
        items.forEach((li, j) => li.classList.toggle("active", j === active));
        if (items[active]) { items[active].scrollIntoView({ block: "nearest" }); menu.setAttribute("aria-activedescendant", items[active].id); }
      };
      const choose = (i) => {
        const o = opts()[i];
        if (o && select.value !== o.value) {
          select.value = o.value;
          select.dispatchEvent(new Event("change", { bubbles: true }));
        }
        sync();
        dd.close();
        btn.focus();
      };
      const dd = {
        open() {
          closeAll(dd);
          menu.innerHTML = opts().map((o, i) => `<li role="option" id="${id}-${i}" style="--i:${i}" aria-selected="${o.selected}" data-i="${i}"><i></i>${esc(o.textContent)}</li>`).join("");
          wrap.classList.add("open");
          btn.setAttribute("aria-expanded", "true");
          setActive(select.selectedIndex);
          menu.focus({ preventScroll: true });
        },
        close() {
          if (!wrap.classList.contains("open")) return;
          wrap.classList.remove("open");
          btn.setAttribute("aria-expanded", "false");
        },
      };
      all.push(dd);
      btn.addEventListener("click", () => (wrap.classList.contains("open") ? dd.close() : dd.open()));
      btn.addEventListener("keydown", (e) => {
        if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) { e.preventDefault(); dd.open(); }
      });
      menu.addEventListener("click", (e) => { const li = e.target.closest("li"); if (li) choose(Number(li.dataset.i)); });
      menu.addEventListener("mousemove", (e) => { const li = e.target.closest("li"); if (li && Number(li.dataset.i) !== active) setActive(Number(li.dataset.i)); });
      menu.addEventListener("keydown", (e) => {
        const n = select.options.length;
        if (e.key === "ArrowDown") setActive(active + 1);
        else if (e.key === "ArrowUp") setActive(active - 1);
        else if (e.key === "Home") setActive(0);
        else if (e.key === "End") setActive(n - 1);
        else if (e.key === "Enter" || e.key === " ") choose(active);
        else if (e.key === "Escape") { dd.close(); btn.focus(); }
        else if (e.key === "Tab") { dd.close(); return; }
        else return;
        e.preventDefault();
      });
      select.addEventListener("change", sync);
      sync();
    }
    document.addEventListener("pointerdown", (e) => { if (!e.target.closest(".dd")) closeAll(); });
  }

  // ---------- hero page ----------

  function topItems(phaseData, { skipConsumables }) {
    return Object.entries(phaseData || {})
      .filter(([id]) => state.items[id] && !(skipConsumables && CONSUMABLES.has(state.items[id].key)))
      .sort((a, b) => b[1] - a[1]);
  }

  function coreBuild(pop) {
    // The most bought non-consumable items from each phase, in purchase order.
    const seen = new Set();
    const out = [];
    for (const phase of ["early_game_items", "mid_game_items", "late_game_items"]) {
      const list = topItems(pop[phase], { skipConsumables: true }).filter(([id]) => (state.items[id].cost || 0) >= 1000);
      for (const [id] of list.slice(0, phase === "early_game_items" ? 1 : 3)) {
        if (!seen.has(id)) { seen.add(id); out.push(id); }
      }
    }
    return out.slice(0, 6);
  }

  function renderBuild(pop) {
    const core = coreBuild(pop);
    const total = core.reduce((s, id) => s + (state.items[id].cost || 0), 0);
    const coreHtml = core.length ? `
      <div class="core">
        <div class="core-head"><h3>Core build</h3><span class="gold-total"><i></i><b data-gold="${total}">0</b> gold</span></div>
        <div class="core-row">
          <svg class="core-path" preserveAspectRatio="none" viewBox="0 0 100 10" aria-hidden="true"><path d="M0 5 H100"/></svg>
          ${core.map((id, i) => {
            const it = state.items[id];
            return `<figure title="${esc(it.name)} · ${it.cost} gold"><span class="core-step">${i + 1}</span><div class="core-img"><img src="${esc(img(it.img))}" alt="${esc(it.name)}"></div><figcaption>${esc(it.name)}<small>${it.cost.toLocaleString("en-US")}</small></figcaption></figure>`;
          }).join("")}
        </div>
      </div>` : "";

    const phases = PHASES.map(([key, title, sub]) => {
      const list = topItems(pop[key], { skipConsumables: key !== "start_game_items" }).slice(0, 6);
      if (!list.length) return "";
      const max = list[0][1];
      return `<div class="phase"><h4><span class="phase-dot"></span>${title}<small>${sub}</small></h4>${list.map(([id, n]) => {
        const it = state.items[id];
        return `<div class="item" title="${esc(it.name)}${it.cost ? ` · ${it.cost} gold` : ""}">
          <img src="${esc(img(it.img))}" alt="${esc(it.name)}" loading="lazy">
          <div class="item-meta"><span class="item-name">${esc(it.name)}${it.cost ? `<small>${it.cost}</small>` : ""}</span><span class="bar"><i style="--w:${Math.max(0.06, n / max)}"></i></span></div>
        </div>`;
      }).join("")}</div>`;
    }).join("");

    return coreHtml + `<div class="phases">${phases || '<p class="state">No item data for this hero yet.</p>'}</div>`;
  }

  function renderMatchups(matchups) {
    const byId = new Map(state.heroes.map((h) => [h.id, h]));
    const rows = (matchups || [])
      .filter((m) => m.games_played >= 10 && byId.has(m.hero_id))
      .map((m) => ({ h: byId.get(m.hero_id), wr: m.wins / m.games_played, n: m.games_played }));
    if (rows.length < 4) return `<p class="state">Not enough matchup data yet.</p>`;
    rows.sort((a, b) => b.wr - a.wr);
    const list = (arr) => arr.map(({ h, wr, n }) => `
      <a class="mu" href="#/hero/${h.id}" title="${n} ${n === 1 ? "game" : "games"}">
        <img src="${esc(heroImg(h))}" alt="" loading="lazy"><span>${esc(h.localized_name)}</span><b class="${wrClass(wr)}">${pct(wr, 0)}</b>
      </a>`).join("");
    return `
      <div class="mus">
        <div><h4 class="good">Strong against</h4>${list(rows.slice(0, 5))}</div>
        <div><h4 class="bad">Weak against</h4>${list(rows.slice(-5).reverse())}</div>
      </div>`;
  }

  // OpenDota sometimes reports no games for a bracket (lately Immortal); leave those out everywhere.
  const liveBrackets = () => BRACKETS.filter((b) => state.heroes.some((h) => h[`${b}_pick`] > 0));

  function renderBracketBars(h) {
    return `<div class="brackets">${liveBrackets().map((b) => {
      const { pick, win } = bracketStats(h, b);
      if (!pick) {
        return `<div class="br empty" title="${BRACKET_NAMES[b]}: no data">
          <span class="br-bar"><i style="--h:0"></i></span>
          <span class="br-val">–</span>
          <span class="br-name">${BRACKET_NAMES[b].slice(0, 3)}</span>
        </div>`;
      }
      const wr = win / pick;
      return `<div class="br" title="${BRACKET_NAMES[b]}: ${pct(wr)} · ${pick.toLocaleString("en-US")} picks">
        <span class="br-bar ${wrClass(wr)}"><i style="--h:${Math.max(0.04, Math.min(1, (wr - 0.4) / 0.2))}"></i></span>
        <span class="br-val">${pct(wr, 0)}</span>
        <span class="br-name">${BRACKET_NAMES[b].slice(0, 3)}</span>
      </div>`;
    }).join("")}</div>`;
  }

  function ring(wr) {
    const c = 2 * Math.PI * 52;
    return `
      <div class="ring ${wrClass(wr)}">
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <circle class="ring-bg" cx="60" cy="60" r="52"/>
          <circle class="ring-fg" cx="60" cy="60" r="52" style="stroke-dasharray:${c};stroke-dashoffset:${c}" data-off="${c * (1 - wr)}"/>
        </svg>
        <div class="ring-val"><b data-to="${wr}" data-fmt="pct">0%</b><small>Win rate</small></div>
      </div>`;
  }

  function heroNeighbours(id) {
    const order = state.order.includes(id) ? state.order : state.meta.ranked.map((r) => r.h.id);
    const i = order.indexOf(id);
    const byId = new Map(state.heroes.map((h) => [h.id, h]));
    return { prev: byId.get(order[(i - 1 + order.length) % order.length]), next: byId.get(order[(i + 1) % order.length]) };
  }

  // Lore, abilities, talents and base stats from dota2.com, copied into data/profiles/ by the daily snapshot.
  const profiles = new Map();
  const loadProfile = (id) => {
    if (!profiles.has(id)) profiles.set(id, fetch(`data/profiles/${id}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
    return profiles.get(id);
  };

  const ROLE_NAMES = ["Carry", "Support", "Nuker", "Disabler", "Jungler", "Durable", "Escape", "Pusher", "Initiator"];
  const ATTR_ICONS = { str: "strength", agi: "agility", int: "intelligence", all: "universal" };
  const attrIcon = (a, cls = "attr-ico") => `<img class="${cls}" src="${CDN}/apps/dota2/images/dota_react/icons/hero_${ATTR_ICONS[a] || "universal"}.png" alt="" data-attr="${esc(a)}">`;
  const abilityImg = (name) => `${CDN}/apps/dota2/images/dota_react/abilities/${name}.png`;
  const fixed = (v, d = 1) => (v == null ? "–" : Number.isInteger(v) ? String(v) : v.toFixed(d).replace(/\.0$/, ""));
  const safeHtml = (s) => esc(s).replace(/&lt;(\/?b)&gt;/gi, "<$1>").replace(/&lt;br\s*\/?&gt;/gi, "<br>");
  // The feed's damage already counts a single-attribute hero's primary stat; universal heroes still need
  // their 45% of all three added, which is how dota2.com shows it.
  function attackDamage(p) {
    const bonus = p.primary === "all" ? (p.str[0] + p.agi[0] + p.int[0]) * 0.45 : 0;
    return p.damage.map((d) => Math.floor(d + bonus));
  }

  function renderProfileTop(p) {
    if (!p) return "";
    const dots = [1, 2, 3].map((n) => `<i class="${n <= p.complexity ? "on" : ""}"></i>`).join("");
    return `
      ${p.tagline ? `<p class="hero-tagline" data-rv style="--d:3">${esc(p.tagline)}</p>` : ""}
      ${p.hype ? `<p class="hero-hype" data-rv style="--d:4">${safeHtml(p.hype)}</p>` : ""}
      ${p.bio ? `<button class="hero-lore-btn" type="button" data-rv style="--d:4" aria-expanded="false">Read full history</button>
        <div class="hero-bio" hidden>${safeHtml(p.bio)}</div>` : ""}
      <div class="hero-facts" data-rv style="--d:5">
        <div><small>Attack type</small><b><i class="atk-ico ${p.attack === "Ranged" ? "ranged" : "melee"}" aria-hidden="true"></i>${esc(p.attack)}</b></div>
        <div><small>Complexity</small><span class="cx" title="${p.complexity} of 3">${dots}</span></div>
      </div>`;
  }

  // One entry per ability, innate first, then one entry each for Aghanim's Shard and Scepter, the way the
  // ability strip on dota2.com lists them. An ability the Shard or Scepter grants outright only shows up
  // as that upgrade entry, tagged as a new ability.
  function abilityEntries(p) {
    const granted = (a, kind) => kind === "scepter" ? a.fromScepter : a.fromShard;
    const base = [...p.abilities.filter((a) => a.innate), ...p.abilities.filter((a) => !a.innate)];
    const out = base.filter((a) => !a.fromShard && !a.fromScepter).map((a) => ({ key: a.name, a, kind: "base" }));
    for (const kind of ["shard", "scepter"]) {
      const flag = kind === "scepter" ? "hasScepter" : "hasShard";
      // Profiles written before the upgrade flags existed fall back to the first ability with upgrade text.
      const a = base.find((x) => x[flag]) || base.find((x) => granted(x, kind)) || base.find((x) => x[kind]);
      if (a) out.push({ key: `${a.name}:${kind}`, a, kind, granted: !!granted(a, kind) });
    }
    return out;
  }
  // Each upgrade has one clip of its own per hero (<hero>_aghanims_shard / _scepter), showing what it adds.
  const clipName = (h, e) => e.kind === "base" ? e.a.name : `${heroSlug(h)}_aghanims_${e.kind}`;
  const abilityVideo = (h, name, ext) => `${CDN}/apps/dota2/videos/dota_react/abilities/${heroSlug(h)}/${name}.${ext}`;
  const abButton = (e, cls, selected) => `<button type="button" class="${cls}${e.a.innate ? " innate" : ""}${e.kind !== "base" ? ` up ${e.kind}` : ""}" data-ab="${esc(e.key)}" aria-pressed="${selected}" title="${esc(e.a.title)}${e.kind !== "base" ? ` (Aghanim's ${e.kind === "scepter" ? "Scepter" : "Shard"})` : ""}">
      <img src="${esc(abilityImg(e.a.name))}" alt="${esc(e.a.title)}" loading="lazy"><span>${esc(e.a.title.slice(0, 2))}</span>${e.kind !== "base" ? `<i class="aghs-badge ${e.kind}" aria-hidden="true"></i>` : ""}
    </button>`;

  function renderAbilityRow(p) {
    if (!p || !p.abilities.length) return "";
    const list = abilityEntries(p).filter((e) => e.kind === "base");
    return `
      <div class="hero-abilities" data-rv style="--d:6">
        <h3>Abilities</h3>
        <div class="ab-row" aria-label="Abilities">${list.map((e, i) => abButton(e, "ab", i === 0)).join("")}</div>
      </div>`;
  }

  function abilityDetail(e) {
    const { a, kind } = e;
    const vals = (arr) => arr.map((v) => fixed(v)).join(" / ");
    const up = kind === "scepter" ? "Scepter" : "Shard";
    const tags = kind === "base" ? [a.innate && "Innate", a.ult && "Ultimate"].filter(Boolean)
      : e.granted ? [`New ability from Aghanim's ${up}`] : [`${up} ability upgrade`];
    // A granted ability reads like a normal one: its own description, values and notes.
    const base = kind === "base" || e.granted;
    return `
      <div class="ad-head">
        <img src="${esc(abilityImg(a.name))}" alt="" class="ad-img">
        <div>
          <h3>${esc(a.title)}</h3>
          ${tags.length ? `<p class="ad-tags">${tags.map((t) => `<span class="${kind}">${esc(t)}</span>`).join("")}</p>` : ""}
          <p class="ad-desc">${safeHtml(base ? a.desc : a[kind])}</p>
        </div>
      </div>
      <div class="ad-body">
        ${base && (a.values || []).length ? `<dl class="ad-values">${a.values.map((v) => `<div><dt>${esc(v.label)}</dt><dd>${esc(v.value)}</dd></div>`).join("")}</dl>` : ""}
        ${a.cooldowns.length || a.mana.length ? `<div class="ad-costs">
          ${a.cooldowns.length ? `<span><i class="cd" aria-hidden="true"></i><small>Cooldown</small>${vals(a.cooldowns)}</span>` : ""}
          ${a.mana.length ? `<span><i class="mc" aria-hidden="true"></i><small>Mana</small>${vals(a.mana)}</span>` : ""}
        </div>` : ""}
        ${base && a.notes.length ? `<ul class="ad-notes">${a.notes.map((n) => `<li>${safeHtml(n)}</li>`).join("")}</ul>` : ""}
        ${a.lore ? `<p class="ad-lore">${safeHtml(a.lore)}</p>` : ""}
      </div>`;
  }

  function renderProfileBody(h, p) {
    if (!p) return "";
    const [hp, hpRegen] = p.health, [mp, mpRegen] = p.mana;
    const attrRow = (a) => `<div class="pa-row${p.primary === a || p.primary === "all" ? " primary" : ""}">${attrIcon(a)}<b>${p[a][0]}</b><small>+${fixed(p[a][1])}</small></div>`;
    const [dmin, dmax] = attackDamage(p);
    const stat = (icon, label, value) => `<li><i class="st-ico ${icon}" aria-hidden="true"></i><span>${label}</span><b>${value}</b></li>`;
    const talents = p.talents.length === 8 ? [3, 2, 1, 0].map((i) => `
      <div class="tl-row"><span>${esc(p.talents[i * 2 + 1] || "")}</span><b>${10 + i * 5}</b><span>${esc(p.talents[i * 2] || "")}</span></div>`).join("") : "";
    return `
      <section class="hero-bar" data-rv>
        <div class="wrap hb-grid">
          <div class="hb-col">
            <div class="pa">
              <div class="pa-portrait">
                <img src="${esc(heroImg(h))}" alt="">
                <span class="pa-hp"><b>${hp}</b><small>+${fixed(hpRegen)}</small></span>
                <span class="pa-mp"><b>${mp}</b><small>+${fixed(mpRegen)}</small></span>
              </div>
              <div class="pa-attrs">${["str", "agi", "int"].map(attrRow).join("")}</div>
            </div>
            <h4>Attributes</h4>
          </div>
          <div class="hb-col">
            <div class="roles-grid">${ROLE_NAMES.map((r, i) => `<div class="rl${p.roles[i] ? " on" : ""}"><span>${r}</span><i style="--v:${(p.roles[i] || 0) / 3}"></i></div>`).join("")}</div>
            <h4>Roles</h4>
          </div>
          <div class="hb-col">
            <div class="stats-grid">
              <div><h5>Attack</h5><ul>
                ${stat("dmg", "Damage", `${dmin}–${dmax}`)}
                ${stat("rate", "Attack time", fixed(p.attackRate))}
                ${stat("range", "Range", p.attackRange)}
                ${p.attack === "Ranged" ? stat("proj", "Projectile", p.projectileSpeed) : ""}
              </ul></div>
              <div><h5>Defense</h5><ul>
                ${stat("armor", "Armor", fixed(p.armor))}
                ${stat("mres", "Magic resist", `${fixed(p.magicResist)}%`)}
              </ul></div>
              <div><h5>Mobility</h5><ul>
                ${stat("ms", "Move speed", p.moveSpeed)}
                ${stat("turn", "Turn rate", fixed(p.turnRate))}
                ${stat("vision", "Vision", `${p.vision[0]} / ${p.vision[1]}`)}
              </ul></div>
            </div>
            <h4>Stats</h4>
          </div>
        </div>
      </section>
      ${p.abilities.length ? `<section class="wrap hero-skills">
        <h2 class="skills-title" data-rv>Ability details</h2>
        <div class="skills-grid">
          <div class="ad-stage" data-rv>
            <div class="ad-media">
              <video class="ad-video" muted loop playsinline preload="none" aria-hidden="true"></video>
              <video class="ad-video" muted loop playsinline preload="none" aria-hidden="true"></video>
              <img class="ad-fallback" alt="">
            </div>
            <div class="ad-strip" aria-label="All abilities">${abilityEntries(p).map((e, i) => abButton(e, "ab-thumb", i === 0)).join("")}</div>
          </div>
          <div class="ab-detail" id="ab-detail" data-rv style="--d:1" aria-live="polite"></div>
        </div>
      </section>
      ${talents ? `<section class="wrap hero-talents"><div class="panel talents" data-rv><h2>Talents</h2><div class="tl">${talents}</div></div></section>` : ""}` : ""}`;
  }

  // The band at the bottom of a hero page, like dota2.com's: the neighbouring heroes' renders stand on it,
  // leaning out of each side, with a link back to the full list in the middle.
  function heroFootNav(prev, next) {
    const card = (h, dir) => {
      const [render, older] = heroRenders(h);
      const attack = h.attack_type || "";
      return `<a href="#/hero/${h.id}" class="fn-card ${dir} attr-${esc(h.primary_attr)}" aria-label="${dir === "prev" ? "Previous" : "Next"} hero, ${esc(h.localized_name)}">
          <span class="fn-art" aria-hidden="true"><img src="${esc(render)}" data-alt-src="${esc(older)}" data-last-src="${esc(heroImg(h))}" alt="" loading="lazy" decoding="async"></span>
          <span class="fn-text">
            <small>${dir === "prev" ? "Previous hero" : "Next hero"}</small>
            <b>${esc(h.localized_name)}</b>
            <span class="fn-type">${attrIcon(h.primary_attr)}${esc(attack)}</span>
          </span>
          <svg class="fn-arrow" viewBox="0 0 12 12" aria-hidden="true"><path d="${dir === "prev" ? "M8 2 3 6l5 4z" : "m4 2 5 4-5 4z"}"/></svg>
        </a>`;
    };
    return `
      <nav class="hero-footnav" aria-label="Browse heroes" data-rv>
        ${card(prev, "prev")}
        <a href="#/" class="fn-all" aria-label="All heroes"><span class="fn-grid" aria-hidden="true">${"<i></i>".repeat(6)}</span><small>All heroes</small></a>
        ${card(next, "next")}
      </nav>`;
  }

  function renderHero(id, p) {
    const h = state.heroes.find((x) => x.id === id);
    const view = $("#hero-view");
    $$("video", view).forEach((v) => onScreen.unobserve(v));
    if (!h) { view.innerHTML = `<div class="wrap hero-missing"><a class="back" href="#/"><span>←</span> All heroes</a><p class="state">Hero not found.</p></div>`; return null; }
    document.title = `${h.localized_name} · Dota 2 Meta`;
    const meta = state.meta.get(h.id);
    const { prev, next } = heroNeighbours(h.id);
    const attr = (p && p.primary) || h.primary_attr;

    view.innerHTML = `
      <section class="hero-stage attr-${esc(h.primary_attr)}${p ? " has-profile" : ""}">
        <div class="hero-art"><video class="hero-video" muted loop playsinline preload="auto" aria-hidden="true"></video></div>
        <div class="hero-side" aria-hidden="true">${attrIcon(attr, "side-ico")}<b>${esc(h.localized_name)}</b><span>${h.id}</span></div>
        <nav class="hero-nav" aria-label="Other heroes">
          <a href="#/hero/${prev.id}" class="hn prev" title="Previous: ${esc(prev.localized_name)}" aria-label="Previous hero, ${esc(prev.localized_name)}"><svg viewBox="0 0 12 12"><path d="M8 2 3 6l5 4z"/></svg></a>
          <a href="#/" class="hn all" title="All heroes" aria-label="All heroes"><svg viewBox="0 0 18 12"><path d="M0 0h5v5H0zM6.5 0h5v5h-5zM13 0h5v5h-5zM0 7h5v5H0zM6.5 7h5v5h-5zM13 7h5v5h-5z"/></svg></a>
          <a href="#/hero/${next.id}" class="hn next" title="Next: ${esc(next.localized_name)}" aria-label="Next hero, ${esc(next.localized_name)}"><svg viewBox="0 0 12 12"><path d="m4 2 5 4-5 4z"/></svg></a>
        </nav>
        <div class="wrap hero-grid">
          <div class="hero-info">
            <a class="back" href="#/" data-rv><span>←</span> All heroes</a>
            <p class="hero-sub" data-rv style="--d:1">${attrIcon(attr)}${esc(ATTR_NAMES[attr] || attr)}</p>
            <h1 class="hero-name" data-rv style="--d:2">${esc(h.localized_name)}</h1>
            ${p ? renderProfileTop(p) : `<p class="hero-line" data-rv style="--d:3">${esc(h.attack_type)} · ${(h.roles || []).map(esc).join(" · ")}</p>`}
          </div>
          ${renderAbilityRow(p)}
        </div>
      </section>

      ${renderProfileBody(h, p)}

      <section class="wrap hero-meta">
        <div class="panel meta-panel" data-rv>
          <div class="mp-head"><h2>Current meta</h2><p class="hint">${esc(bracketLabel())} · recent public matches</p></div>
          <div class="hero-stats">
            ${ring(meta.wr)}
            <div class="kpis">
              <div><b class="tier t-${meta.tier}">${meta.tier}</b><small>Tier · ${esc(bracketLabel())}</small></div>
              <div><b data-to="${meta.pr}" data-fmt="pct">0%</b><small>Pick rate</small></div>
              <div><b data-to="${meta.rank}" data-fmt="rank">#0</b><small>of ${state.heroes.length} heroes</small></div>
              ${h.pro_ban != null ? `<div><b data-to="${h.pro_ban}">0</b><small>Pro match bans</small></div>` : ""}
            </div>
          </div>
        </div>
      </section>

      <div class="wrap panels">
        <section class="panel build" data-rv>
          <h2>Item build</h2>
          <p class="hint">Items most often bought by ${esc(h.localized_name)} players in recent matches. Bars show relative popularity.</p>
          <div id="build"><div class="skeleton skel-core"></div><div class="skel-rows">${'<span class="skeleton"></span>'.repeat(6)}</div></div>
        </section>
        <aside class="side">
          <section class="panel" data-rv style="--d:1">
            <h2>Win rate by rank</h2>
            ${renderBracketBars(h)}
          </section>
          <section class="panel" data-rv style="--d:2">
            <h2>Matchup</h2>
            <p class="hint">From pro matches, at least 10 games.</p>
            <div id="matchups"><div class="skel-rows">${'<span class="skeleton"></span>'.repeat(5)}</div></div>
          </section>
        </aside>
      </div>

      ${heroFootNav(prev, next)}`;

    setHeroVideo($(".hero-video", view), h);
    onScreen.observe($(".hero-video", view));
    const fmtOf = (el) => el.dataset.fmt === "rank" ? (v) => `#${Math.max(1, Math.round(v))}`
      : el.dataset.fmt === "pct" ? (v) => pct(v) : (v) => Math.round(v).toLocaleString("en-US");
    onReveal($(".meta-panel", view), () => {
      const fg = $(".ring-fg", view);
      fg.style.strokeDashoffset = fg.dataset.off;
      $$("[data-to]", view).forEach((el) => countUp(el, Number(el.dataset.to), fmtOf(el)));
    });
    // Icons that don't exist on the CDN fall back to a coloured dot or the ability's initials.
    $$("img.attr-ico, img.side-ico", view).forEach((im) => im.addEventListener("error", () => { im.replaceWith(Object.assign(document.createElement("i"), { className: `attr ${im.dataset.attr}` })); }, { once: true }));
    // Neighbour renders try the older CDN path, then the portrait, before hiding.
    $$(".fn-art img", view).forEach((im) => im.addEventListener("error", function next() {
      const alt = im.dataset.altSrc || im.dataset.lastSrc;
      if (!alt) { im.removeEventListener("error", next); im.parentNode.classList.add("missing"); return; }
      if (im.dataset.altSrc) delete im.dataset.altSrc; else { delete im.dataset.lastSrc; im.parentNode.classList.add("portrait"); }
      im.src = alt;
    }));
    $$(".ab img, .ab-thumb img, .ad-img", view).forEach((im) => im.addEventListener("error", () => im.classList.add("missing"), { once: true }));
    if (p) initProfile(view, p, h);
    const art = $(".hero-art", view);
    requestAnimationFrame(() => requestAnimationFrame(() => art.classList.add("in")));
    reveal(view);
    loadProfile(prev.id); loadProfile(next.id);
    return h;
  }

  function initProfile(view, p, h) {
    const lore = $(".hero-lore-btn", view);
    if (lore) lore.addEventListener("click", () => {
      const bio = $(".hero-bio", view);
      bio.hidden = !bio.hidden;
      lore.setAttribute("aria-expanded", String(!bio.hidden));
      lore.textContent = bio.hidden ? "Read full history" : "Hide history";
    });
    const detail = $("#ab-detail", view);
    if (!detail) return;
    const entries = new Map(abilityEntries(p).map((e) => [e.key, e]));
    const media = $(".ad-media", view);
    const fallback = $(".ad-fallback", view);
    const layers = $$(".ad-video", view);
    layers.forEach((v) => onScreen.observe(v));
    // Two stacked videos: the next clip loads underneath and fades in over the old one once it plays,
    // so switching abilities cross-fades instead of flashing black.
    let front = null, current = null, textTimer = 0;
    const unload = (v) => { v.pause(); v.removeAttribute("poster"); v.innerHTML = ""; v.load(); };
    const showClip = (name, icon) => {
      const v = layers.find((x) => x !== front);
      const old = front;
      front = v;
      media.classList.remove("novideo");
      fallback.src = abilityImg(icon);
      v.poster = abilityVideo(h, name, "jpg");
      v.innerHTML = `<source src="${esc(abilityVideo(h, name, "webm"))}" type="video/webm"><source src="${esc(abilityVideo(h, name, "mp4"))}" type="video/mp4">`;
      let shown = false;
      const reveal = () => {
        if (shown || front !== v) return;
        shown = true;
        v.classList.add("on");
        if (old) { old.classList.remove("on"); setTimeout(() => { if (front !== old) unload(old); }, 500); }
      };
      v.addEventListener("playing", reveal, { once: true });
      // A clip that is slow to start still swaps in on its poster rather than leaving the old one up.
      setTimeout(reveal, 900);
      $("source:last-child", v).addEventListener("error", () => { if (front === v) { reveal(); media.classList.add("novideo"); } }, { once: true });
      v.load();
      // Off screen it waits; the shared observer starts it once it scrolls into view.
      if (v._visible) v.play().catch(() => {});
    };
    const pick = (key, scroll) => {
      const e = entries.get(key);
      if (!e) return;
      $$(".ab, .ab-thumb", view).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.ab === key || (e.kind !== "base" && b.classList.contains("ab") && b.dataset.ab === e.a.name))));
      // The text fades out, swaps while invisible and fades back in.
      const swap = () => {
        detail.innerHTML = abilityDetail(e);
        const im = $(".ad-img", detail);
        if (im) im.addEventListener("error", () => im.classList.add("missing"), { once: true });
        requestAnimationFrame(() => detail.classList.remove("swap"));
      };
      clearTimeout(textTimer);
      if (!detail.innerHTML || reduceMotion) swap();
      else { detail.classList.add("swap"); textTimer = setTimeout(swap, 180); }
      const clip = clipName(h, e);
      if (current !== clip) { current = clip; showClip(clip, e.a.name); }
      if (scroll) $(".hero-skills", view).scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    };
    $(".ab-row", view)?.addEventListener("click", (ev) => { const b = ev.target.closest(".ab"); if (b) pick(b.dataset.ab, true); });
    $(".ad-strip", view).addEventListener("click", (ev) => { const b = ev.target.closest(".ab-thumb"); if (b) pick(b.dataset.ab, false); });
    pick(entries.keys().next().value, false);
  }

  async function loadHeroData(id) {
    const snap = await fromSnapshot(`heroes/${id}.json`);
    const [pop, mu] = await Promise.allSettled([
      snap ? snap.itemPopularity : cached(`d2.pop.${id}`, `/heroes/${id}/itemPopularity`),
      snap ? snap.matchups : cached(`d2.mu.${id}`, `/heroes/${id}/matchups`)
    ]);
    if (location.hash !== `#/hero/${id}`) return; // user navigated away while loading
    const build = $("#build");
    build.innerHTML = pop.status === "fulfilled" ? renderBuild(pop.value) : errorBox(pop.reason);
    $$(".core, .phase", build).forEach((el, i) => { el.setAttribute("data-rv", ""); el.style.setProperty("--d", i % 3); });
    const gold = $("[data-gold]", build);
    if (gold) onReveal($(".core", build), () => countUp(gold, Number(gold.dataset.gold)));
    reveal(build);
    const mus = $("#matchups");
    mus.innerHTML = mu.status === "fulfilled" ? renderMatchups(mu.value) : errorBox(mu.reason);
    $$(".mus > div", mus).forEach((el, i) => { el.setAttribute("data-rv", ""); el.style.setProperty("--d", i); });
    reveal(mus);
  }

  // ---------- routing ----------

  let current = null;
  let listScroll = 0;

  // Pages cross-fade: the old one fades out, the new one is swapped in at the top and fades in.
  function fade(swap) {
    const main = $("main");
    if (reduceMotion) { swap(); return; }
    main.classList.add("leaving");
    setTimeout(async () => {
      await swap();
      main.classList.remove("leaving");
    }, 220);
  }

  const views = ["#list-view", "#hero-view", "#highlights-view"];
  function showOnly(sel) {
    for (const v of views) {
      const el = $(v);
      el.hidden = v !== sel;
      if (v !== sel && v !== "#list-view") el.innerHTML = "";
    }
  }

  function showList() {
    document.title = "Dota 2 Meta · Hero & Item Build";
    showOnly("#list-view");
    window.scrollTo(0, listScroll);
  }

  function showHero(id, profile) {
    const h = renderHero(id, profile);
    showOnly("#hero-view");
    window.scrollTo(0, 0);
    if (h) loadHeroData(id);
  }

  function showHighlights() {
    showOnly("#highlights-view");
    window.scrollTo(0, 0);
    renderHighlightsPage();
  }

  function route(first = false) {
    const m = location.hash.match(/^#\/hero\/(\d+)/);
    const hl = /^#\/highlights/.test(location.hash);
    const next = m ? `hero:${m[1]}` : hl ? "highlights" : "list";
    if (next === current) return;
    if (current === "list") listScroll = window.scrollY;
    // The profile is a small static file; wait briefly for it so the page doesn't reflow once it lands.
    const profile = m ? Promise.race([loadProfile(Number(m[1])), new Promise((r) => setTimeout(r, 1500))]) : null;
    const go = async () => {
      current = next;
      if (!m) { hl ? showHighlights() : showList(); return; }
      const p = await profile;
      if (current === next) showHero(Number(m[1]), p);
    };
    if (first) go(); else fade(go);
  }

  const errorBox = (err) => `<p class="state error">Failed to load data (${esc(err && err.message)}). OpenDota allows 60 requests per minute, please try again shortly.</p>`;

  // ---------- page chrome ----------

  function initScrollUi() {
    const bar = $(".progress");
    const header = $(".top");
    let ticking = false;
    const update = () => {
      ticking = false;
      const max = document.documentElement.scrollHeight - innerHeight;
      bar.style.transform = `scaleX(${max > 0 ? scrollY / max : 0})`;
      header.classList.toggle("scrolled", scrollY > 20);
    };
    addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
    update();

    document.addEventListener("click", (e) => {
      const a = e.target.closest("[data-scroll]");
      if (!a) return;
      e.preventDefault();
      const go = () => { const target = $(a.dataset.scroll); if (target) target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" }); };
      if (current !== "list") { location.hash = "#/"; setTimeout(go, 400); } else go();
    });
  }

  function startLoader() {
    const started = performance.now();
    return {
      async finish() {
        await new Promise((r) => setTimeout(r, Math.max(0, 700 - (performance.now() - started))));
        const el = $("#loader");
        el.classList.add("done");
        document.body.classList.remove("is-loading");
        setTimeout(() => el.remove(), 600);
      },
      fail(err) {
        $(".loader-text").innerHTML = `<span class="bad">Failed to load data: ${esc(err && err.message)}</span><br>Please reload the page in a moment.`;
        $("#loader").classList.add("failed");
      }
    };
  }

  // ---------- boot ----------

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator) || location.protocol !== "https:" && location.hostname !== "localhost") return;
    const go = () => navigator.serviceWorker.register("sw.js").catch(() => {});
    if (document.readyState === "complete") go(); else addEventListener("load", go, { once: true });
  }

  async function boot() {
    registerServiceWorker();
    const loader = startLoader();
    loadHighlights();

    loadPatch().then((p) => {
      if (!p) return;
      $("#patch-text").textContent = p.name;
      $("#intro-patch").textContent = p.name;
    }).catch(() => { $("#patch-text").textContent = "latest"; });

    try {
      const [heroes, items] = await Promise.all([loadHeroStats(), loadItems()]);
      state.heroes = heroes;
      state.items = items;
    } catch (err) {
      loader.fail(err);
      return;
    }

    renderHomeHighlights(await loadHighlights());
    await Promise.race([loadPatch().catch(() => {}), new Promise((r) => setTimeout(r, 600))]);

    state.meta = computeMeta(state.bracket);
    renderIntro();
    renderTop();
    initTopHover();
    buildCards();
    updateCards();
    applyFilters({ animate: false });
    renderNumbers(true);
    initFilters();
    initScrollUi();
    initPlayer();

    await loader.finish();
    document.body.classList.add("ready");
    route(true);
    reveal(document);
    addEventListener("hashchange", () => route());
  }

  boot();
})();

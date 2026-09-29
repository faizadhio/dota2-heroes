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

  const hasGsap = typeof window.gsap !== "undefined";
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const liteMedia = !finePointer || window.matchMedia("(max-width: 899px)").matches || !!(navigator.connection && navigator.connection.saveData);
  if (hasGsap) gsap.registerPlugin(ScrollTrigger, SplitText, Flip);

  const state = { heroes: [], items: {}, attr: "", role: "", bracket: "all", sort: "tier", query: "", meta: null };
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

  function countTo(el, to, fmt = (v) => Math.round(v).toLocaleString("en-US"), opts = {}) {
    if (!el) return;
    if (!hasGsap) { el.textContent = fmt(to); return; }
    const o = { v: 0 };
    return gsap.to(o, { v: to, duration: 2, ease: "power3.out", ...opts, onUpdate: () => { el.textContent = fmt(o.v); } });
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
  // Channels tack "| DOTA2" and similar onto every title; the page already says it's Dota.
  const tidyTitle = (t) => t.replace(/\s*[|·-]\s*dota ?2\s*$/i, "").trim();

  const highlightCard = (v) => `
    <button class="hl-card" type="button" data-video="${esc(v.id)}" data-title="${esc(tidyTitle(v.title))}">
      <span class="hl-thumb">
        <img src="https://i.ytimg.com/vi/${esc(v.id)}/hqdefault.jpg" alt="" loading="lazy" decoding="async">
        <i class="hl-play" aria-hidden="true"></i>
        <em class="hl-ch">${esc(v.channel)}</em>
      </span>
      <span class="hl-meta">
        <b>${esc(tidyTitle(v.title))}</b>
        <small>${esc(ago(v.published))}${v.views ? ` · ${compact(v.views)} views` : ""}</small>
      </span>
    </button>`;

  function renderHomeHighlights(videos) {
    if (!videos.length) return;
    $("#hl-row").innerHTML = videos.slice(0, 8).map(highlightCard).join("");
    $("#highlights").hidden = false;
  }

  let hlFilter = "";
  async function renderHighlightsPage() {
    const view = $("#highlights-view");
    view.innerHTML = `
      <section class="wrap hl-page">
        <a class="back" href="#/"><span>←</span> All heroes</a>
        <p class="eyebrow"><span class="line"></span>Fresh from the pro scene</p>
        <h1 class="section-title hl-title">Tournament highlights</h1>
        <div class="hl-chips" id="hl-chips" role="group" aria-label="Channel"></div>
        <div class="hl-grid" id="hl-grid"><p class="state">Loading highlights…</p></div>
      </section>`;
    const videos = await loadHighlights();
    if (current !== "highlights") return;
    const grid = $("#hl-grid", view);
    if (!videos.length) { grid.innerHTML = `<p class="state">No highlights yet. They are collected once a day, check back soon.</p>`; return; }
    const channels = [...new Set(videos.map((v) => v.channel))];
    if (!channels.includes(hlFilter)) hlFilter = "";
    const chips = $("#hl-chips", view);
    const draw = (animate) => {
      chips.innerHTML = ["", ...channels].map((c) => `<button type="button" class="chip${c === hlFilter ? " on" : ""}" data-ch="${esc(c)}">${esc(c || "All")}</button>`).join("");
      grid.innerHTML = videos.filter((v) => !hlFilter || v.channel === hlFilter).map(highlightCard).join("");
      if (animate && hasGsap) gsap.from($$(".hl-card", grid), { y: 50, opacity: 0, duration: 0.8, ease: "expo.out", stagger: 0.04, clearProps: "transform,opacity" });
    };
    chips.addEventListener("click", (e) => {
      const b = e.target.closest(".chip");
      if (!b || b.dataset.ch === hlFilter) return;
      hlFilter = b.dataset.ch;
      draw(true);
      ScrollTrigger.refresh();
    });
    draw(true);
    ScrollTrigger.refresh();
  }

  function animateHighlightsIn() {
    if (!hasGsap) return;
    gsap.timeline({ defaults: { ease: "expo.out" } })
      .from(".hl-page .back", { x: -30, opacity: 0, duration: 0.8 }, 0.1)
      .from(".hl-page .eyebrow", { y: 20, opacity: 0, duration: 0.8 }, 0.15)
      .from(".hl-title", { yPercent: 60, opacity: 0, duration: 1.1 }, 0.2);
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
      lenis && lenis.start();
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
      lenis && lenis.stop();
      $(".player-close", box).focus();
      if (hasGsap) gsap.fromTo(".player-box", { y: 40, scale: 0.94, opacity: 0 }, { y: 0, scale: 1, opacity: 1, duration: 0.6, ease: "expo.out", clearProps: "transform,opacity" });
    };
    document.addEventListener("click", (e) => {
      const card = e.target.closest(".hl-card");
      if (card) { open(card.dataset.video, card.dataset.title); return; }
      if (e.target.closest("[data-close]")) close();
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
    addEventListener("hashchange", close);
  }

  // ---------- intro ----------

  function renderIntro() {
    const meta = state.meta;
    const top = meta.ranked.find((r) => r.pick > 0);
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

  function renderMarquee() {
    const heroes = [...state.heroes].sort(() => Math.random() - 0.5);
    const half = Math.ceil(heroes.length / 2);
    const row = (list) => {
      const html = list.map((h) => `<a class="mq attr-${esc(h.primary_attr)}" href="#/hero/${h.id}" tabindex="-1"><img src="${esc(heroImg(h))}" alt="" loading="lazy"><span>${esc(h.localized_name)}</span></a>`).join("");
      return `<div class="mq-inner">${html}</div><div class="mq-inner">${html}</div>`;
    };
    $("#marquee-a").innerHTML = row(heroes.slice(0, half));
    $("#marquee-b").innerHTML = row(heroes.slice(half));
  }

  function renderTop() {
    const top = state.meta.ranked.filter((r) => r.pick > 0).slice(0, 5);
    $$(".top-video").forEach((v) => onScreen.unobserve(v));
    $("#top-bracket").textContent = `Top 5 · ${bracketLabel()}`;
    $("#top-track").innerHTML = top.map(({ h, wr, pr, tier }, i) => `
      <a class="top-card attr-${esc(h.primary_attr)}" href="#/hero/${h.id}">
        <span class="top-rank">0${i + 1}</span>
        <div class="top-art">
          <div class="top-glow"></div>
          <video class="top-video" muted loop playsinline preload="none" data-hero="${h.id}" aria-hidden="true"></video>
        </div>
        <div class="top-info">
          <p class="top-attr"><i class="attr ${esc(h.primary_attr)}"></i>${esc(ATTR_NAMES[h.primary_attr] || "")}</p>
          <h3>${esc(h.localized_name)}</h3>
          <div class="top-stats">
            <span><b class="${wrClass(wr)}">${pct(wr)}</b><small>Win rate</small></span>
            <span><b>${pct(pr)}</b><small>Pick rate</small></span>
            <span><b class="tier t-${tier}">${tier}</b><small>Tier</small></span>
          </div>
          <span class="top-cta">View build <i>→</i></span>
        </div>
      </a>`).join("");

    // Load each card's hero video when it comes near the screen; it only plays while actually on screen.
    const byId = new Map(state.heroes.map((h) => [h.id, h]));
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        setHeroVideo(e.target, byId.get(Number(e.target.dataset.hero)));
      }
    }, { rootMargin: "200px" });
    $$(".top-video").forEach((v) => { io.observe(v); onScreen.observe(v); });
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
      if (animate) countTo(el, to, fmt, { scrollTrigger: { trigger: el, start: "top 90%" } });
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
          <img src="${esc(heroImg(h))}" alt="" loading="lazy">
          <b class="tier"></b>
        </div>
        <div class="card-body">
          <div class="card-name"><i class="attr ${esc(h.primary_attr)}"></i>${esc(h.localized_name)}</div>
          <div class="card-stats">
            <span class="c-wr" title="Win rate"></span>
            <span class="c-pr" title="Pick rate"></span>
          </div>
          <span class="wr-line"><i></i></span>
        </div>
        <span class="glare" aria-hidden="true"></span>`;
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
      $(".wr-line i", el).style.setProperty("--w", Math.max(0, Math.min(1, (r.wr - 0.4) / 0.2)));
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

    const els = [...cards.values()];
    const flipState = animate && hasGsap ? Flip.getState(els) : null;
    const grid = $("#grid");
    let shown = 0;
    for (const r of rows) {
      const el = cards.get(r.h.id);
      const on = show(r.h);
      el.style.display = on ? "" : "none";
      if (on) shown++;
      grid.appendChild(el);
    }
    $("#result-count").textContent = `${shown} ${shown === 1 ? "hero" : "heroes"}`;
    $("#grid-empty").hidden = shown > 0;

    if (flipState) {
      Flip.from(flipState, {
        duration: 0.7,
        ease: "power3.inOut",
        absolute: true,
        stagger: 0.008,
        onEnter: (e) => gsap.fromTo(e, { opacity: 0, scale: 0.6, y: 30 }, { opacity: 1, scale: 1, y: 0, duration: 0.6, ease: "back.out(1.6)", stagger: 0.015 }),
        onLeave: (e) => gsap.to(e, { opacity: 0, scale: 0.6, duration: 0.4, ease: "power2.in" }),
        onComplete: () => ScrollTrigger.refresh()
      });
    }
  }

  function moveSegThumb(animate = true) {
    const on = $("#attr-filter button.on");
    const thumb = $(".seg-thumb");
    if (!on || !thumb) return;
    const props = { width: on.offsetWidth, x: on.offsetLeft - 3 };
    if (hasGsap && animate) gsap.to(thumb, { ...props, duration: 0.5, ease: "back.out(1.7)" });
    else if (hasGsap) gsap.set(thumb, props);
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
      ScrollTrigger.refresh();
    });
    $("#attr-filter").addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      state.attr = btn.dataset.attr;
      for (const b of $$("#attr-filter button")) b.classList.toggle("on", b === btn);
      moveSegThumb();
      applyFilters();
    });
    window.addEventListener("resize", () => moveSegThumb(false));
    moveSegThumb(false);
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
        <ul class="dd-menu" id="${id}" role="listbox" tabindex="-1" data-lenis-prevent></ul>`);
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

  let heroCtx = null;

  function renderHero(id) {
    const h = state.heroes.find((x) => x.id === id);
    const view = $("#hero-view");
    $$("video", view).forEach((v) => onScreen.unobserve(v));
    if (!h) { view.innerHTML = `<div class="wrap"><a class="back" href="#/">‹ All heroes</a><p class="state">Hero not found.</p></div>`; return null; }
    document.title = `${h.localized_name} · Dota 2 Meta`;
    const meta = state.meta.get(h.id);

    view.innerHTML = `
      <section class="hero-stage attr-${esc(h.primary_attr)}">
        <div class="hero-bgname" aria-hidden="true"><span>${esc(h.localized_name)} · ${esc(h.localized_name)} · ${esc(h.localized_name)} · </span><span>${esc(h.localized_name)} · ${esc(h.localized_name)} · ${esc(h.localized_name)} · </span></div>
        <div class="wrap hero-grid">
          <a class="back" href="#/"><span>←</span> All heroes</a>
          <div class="hero-art">
            <div class="hero-halo"></div>
            <video class="hero-video" muted loop playsinline preload="auto" aria-hidden="true"></video>
          </div>
          <div class="hero-info">
            <p class="hero-sub"><i class="attr ${esc(h.primary_attr)}"></i>${esc(ATTR_NAMES[h.primary_attr] || h.primary_attr)} · ${esc(h.attack_type)}</p>
            <h1 class="hero-name">${esc(h.localized_name)}</h1>
            <div class="roles">${(h.roles || []).map((r) => `<span>${esc(r)}</span>`).join("")}</div>
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
        </div>
      </section>

      <div class="wrap panels">
        <section class="panel build">
          <h2>Item build</h2>
          <p class="hint">Items most often bought by ${esc(h.localized_name)} players in recent matches. Bars show relative popularity.</p>
          <div id="build"><div class="skeleton skel-core"></div><div class="skel-rows">${'<span class="skeleton"></span>'.repeat(6)}</div></div>
        </section>
        <aside class="side">
          <section class="panel">
            <h2>Win rate by rank</h2>
            ${renderBracketBars(h)}
          </section>
          <section class="panel">
            <h2>Matchup</h2>
            <p class="hint">From pro matches, at least 10 games.</p>
            <div id="matchups"><div class="skel-rows">${'<span class="skeleton"></span>'.repeat(5)}</div></div>
          </section>
        </aside>
      </div>`;

    setHeroVideo($(".hero-video", view), h);
    onScreen.observe($(".hero-video", view));
    return h;
  }

  function animateHeroIn(view) {
    if (!hasGsap) return;
    heroCtx && heroCtx.revert();
    heroCtx = gsap.context(() => {
      const name = new SplitText(".hero-name", { type: "chars", charsClass: "ch" });
      const tl = gsap.timeline({ defaults: { ease: "expo.out" } });
      tl.from(".hero-art", { xPercent: -30, opacity: 0, scale: 0.85, rotate: -4, duration: 1.4 })
        .from(".hero-halo", { scale: 0, opacity: 0, duration: 1.6 }, 0)
        .from(".hero-sub", { y: 30, opacity: 0, duration: 0.8 }, 0.2)
        .from(name.chars, { yPercent: 120, rotate: 12, opacity: 0, duration: 1.1, stagger: 0.04 }, 0.25)
        .from(".roles span", { y: 20, opacity: 0, scale: 0.7, duration: 0.7, ease: "back.out(2)", stagger: 0.06 }, 0.6)
        .from(".ring, .kpis > div", { y: 40, opacity: 0, duration: 0.9, stagger: 0.08 }, 0.7)
        .from(".back", { x: -30, opacity: 0, duration: 0.8 }, 0.3);

      const fg = $(".ring-fg", view);
      tl.to(fg, { strokeDashoffset: Number(fg.dataset.off), duration: 2, ease: "power3.out" }, 0.9);
      for (const el of $$("[data-to]", view)) {
        const to = Number(el.dataset.to);
        const fmt = el.dataset.fmt === "rank" ? (v) => `#${Math.max(1, Math.round(v))}`
          : el.dataset.fmt === "pct" ? (v) => pct(v) : (v) => Math.round(v).toLocaleString("en-US");
        tl.add(countTo(el, to, fmt, { duration: 2 }), 0.9);
      }

      gsap.to(".hero-bgname span", { xPercent: -100, repeat: -1, duration: 40, ease: "none" });
      gsap.to(".hero-art", { yPercent: 18, ease: "none", scrollTrigger: { trigger: ".hero-stage", start: "top top", end: "bottom top", scrub: true } });

      gsap.from(".panel", { y: 80, opacity: 0, duration: 1, ease: "power3.out", stagger: 0.12, scrollTrigger: { trigger: ".panels", start: "top 85%" } });
      gsap.from(".br-bar i", { scaleY: 0, duration: 1.2, ease: "elastic.out(1, 0.6)", stagger: 0.06, scrollTrigger: { trigger: ".brackets", start: "top 85%" } });
    }, view);
  }

  function animateBuildIn(root) {
    if (!hasGsap || !heroCtx) return;
    heroCtx.add(() => {
      const tl = gsap.timeline({ scrollTrigger: { trigger: root, start: "top 80%" } });
      const path = $(".core-path path", root);
      if (path) tl.from(path, { attr: { d: "M0 5 H0" }, duration: 1.4, ease: "power2.inOut" }, 0);
      tl.from($$(".core figure", root), { y: 60, opacity: 0, rotate: -8, scale: 0.6, duration: 0.9, ease: "back.out(1.8)", stagger: 0.12 }, 0.1);
      const gold = $("[data-gold]", root);
      if (gold) tl.add(countTo(gold, Number(gold.dataset.gold), (v) => Math.round(v).toLocaleString("en-US"), { duration: 1.6 }), 0.3);
      $$(".phase", root).forEach((phase) => {
        const t = gsap.timeline({ scrollTrigger: { trigger: phase, start: "top 88%" } });
        t.from($("h4", phase), { x: -30, opacity: 0, duration: 0.6, ease: "power3.out" })
          .fromTo($$(".item", phase), { x: -40, opacity: 0 }, { x: 0, opacity: 1, duration: 0.6, ease: "power3.out", stagger: 0.06, clearProps: "transform,opacity" }, 0.1)
          .from($$(".bar i", phase), { scaleX: 0, duration: 1, ease: "power3.out", stagger: 0.06 }, 0.3);
      });
    });
    ScrollTrigger.refresh();
  }

  function animateMatchupsIn(root) {
    if (!hasGsap || !heroCtx) return;
    heroCtx.add(() => {
      gsap.fromTo($$(".mu", root), { x: 30, opacity: 0 }, { x: 0, opacity: 1, duration: 0.6, ease: "power3.out", stagger: 0.05, clearProps: "transform,opacity", scrollTrigger: { trigger: root, start: "top 90%" } });
    });
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
    animateBuildIn(build);
    const mus = $("#matchups");
    mus.innerHTML = mu.status === "fulfilled" ? renderMatchups(mu.value) : errorBox(mu.reason);
    animateMatchupsIn(mus);
  }

  // ---------- routing with a page wipe ----------

  let current = null;
  let listScroll = 0;

  function wipe(swap) {
    if (!hasGsap) { swap(); return; }
    const bars = $$(".wipe i");
    gsap.timeline()
      .set(".wipe", { display: "grid" })
      .fromTo(bars, { scaleY: 0, transformOrigin: "50% 100%" }, { scaleY: 1, duration: 0.55, ease: "power4.in", stagger: 0.06 })
      .add(() => swap())
      .to(bars, { scaleY: 0, transformOrigin: "50% 0%", duration: 0.7, ease: "power4.out", stagger: 0.06 }, "+=0.1")
      .set(".wipe", { display: "none" });
  }

  function scrollToY(y) {
    if (lenis) lenis.scrollTo(y, { immediate: true });
    else window.scrollTo(0, y);
  }

  function showList() {
    document.title = "Dota 2 Meta · Hero & Item Build";
    heroCtx && heroCtx.revert();
    heroCtx = null;
    $("#hero-view").hidden = true;
    $("#hero-view").innerHTML = "";
    $("#highlights-view").hidden = true;
    $("#highlights-view").innerHTML = "";
    $("#list-view").hidden = false;
    ScrollTrigger.refresh();
    scrollToY(listScroll);
    moveSegThumb(false);
  }

  function showHero(id) {
    if (current === "list") listScroll = window.scrollY;
    $("#intro-video").pause();
    const h = renderHero(id);
    $("#list-view").hidden = true;
    $("#highlights-view").hidden = true;
    $("#highlights-view").innerHTML = "";
    $("#hero-view").hidden = false;
    scrollToY(0);
    ScrollTrigger.refresh();
    if (!h) return;
    animateHeroIn($("#hero-view"));
    loadHeroData(id);
  }

  function showHighlights() {
    if (current === "list") listScroll = window.scrollY;
    heroCtx && heroCtx.revert();
    heroCtx = null;
    $("#list-view").hidden = true;
    $("#hero-view").hidden = true;
    $("#hero-view").innerHTML = "";
    $("#highlights-view").hidden = false;
    renderHighlightsPage();
    scrollToY(0);
    ScrollTrigger.refresh();
    animateHighlightsIn();
  }

  function route(first = false) {
    const m = location.hash.match(/^#\/hero\/(\d+)/);
    const hl = /^#\/highlights/.test(location.hash);
    const next = m ? `hero:${m[1]}` : hl ? "highlights" : "list";
    if (next === current) return;
    const go = () => { m ? showHero(Number(m[1])) : hl ? showHighlights() : showList(); current = next; };
    if (first) go(); else wipe(go);
  }

  const errorBox = (err) => `<p class="state error">Failed to load data (${esc(err && err.message)}). OpenDota allows 60 requests per minute, please try again shortly.</p>`;

  // ---------- list page motion ----------

  function animateListIn() {
    if (!hasGsap) return;
    const title = new SplitText(".intro-title .split", { type: "chars", charsClass: "ch" });
    const tl = gsap.timeline({ defaults: { ease: "expo.out" } });
    tl.from(".intro-media", { scale: 1.3, opacity: 0, duration: 2 }, 0)
      .from(".intro-outline", { yPercent: 40, opacity: 0, duration: 2 }, 0)
      .from(".intro .eyebrow", { y: 20, opacity: 0, duration: 1 }, 0.2)
      .from(title.chars, { yPercent: 130, rotateX: -90, opacity: 0, duration: 1.3, stagger: 0.035, transformOrigin: "50% 100%",
        // Put the title back together once it lands, so the gold shine paints one line instead of every letter.
        onComplete: () => title.revert() }, 0.25)
      .from(".intro-lead", { y: 30, opacity: 0, duration: 1 }, 0.8)
      .from(".intro-actions .btn", { y: 30, opacity: 0, duration: 1, stagger: 0.1 }, 0.95)
      .from(".intro-now", { x: 40, opacity: 0, duration: 1 }, 1.1)
      .from(".top", { y: -80, opacity: 0, duration: 1 }, 0.4)
      .from(".scroll-cue", { opacity: 0, duration: 1 }, 1.4);

    // Intro parallax: video drifts and zooms, the title lifts away.
    gsap.to(".intro-media", { yPercent: 25, scale: 1.15, ease: "none", scrollTrigger: { trigger: ".intro", start: "top top", end: "bottom top", scrub: true } });
    gsap.to(".intro-content", { yPercent: -30, opacity: 0, ease: "none", scrollTrigger: { trigger: ".intro", start: "30% top", end: "bottom top", scrub: true } });
    gsap.to(".intro-outline", { xPercent: -25, ease: "none", scrollTrigger: { trigger: ".intro", start: "top top", end: "bottom top", scrub: true } });

    // Marquee rows loop forever and speed up with scroll velocity.
    const loops = $$(".marquee-row").map((row, i) => {
      const dir = row.classList.contains("reverse") ? 1 : -1;
      return gsap.fromTo($$(".mq-inner", row), { xPercent: dir < 0 ? 0 : -100 }, { xPercent: dir < 0 ? -100 : 0, duration: 60 + i * 10, ease: "none", repeat: -1 });
    });
    // Only react to scroll while the marquee is on screen, and skew the two rows rather than every tile.
    const rows = $$(".marquee-row");
    let skew = 0, marqueeOn = true;
    ScrollTrigger.create({
      trigger: ".marquee", start: "top bottom", end: "bottom top",
      onToggle: (self) => { marqueeOn = self.isActive; loops.forEach((l) => l.paused(!marqueeOn)); }
    });
    ScrollTrigger.create({
      onUpdate: (self) => {
        if (!marqueeOn) return;
        const v = self.getVelocity();
        const boost = 1 + Math.min(4, Math.abs(v) / 400);
        loops.forEach((l) => gsap.to(l, { timeScale: boost * (v < 0 ? -1 : 1), duration: 0.3, overwrite: true, onComplete: () => gsap.to(l, { timeScale: v < 0 ? -1 : 1, duration: 1.2 }) }));
        const sk = gsap.utils.clamp(-8, 8, v / -250);
        if (Math.abs(sk - skew) > 0.3) { skew = sk; gsap.to(rows, { skewX: sk, duration: 0.4, overwrite: true, onComplete: () => gsap.to(rows, { skewX: 0, duration: 0.8 }) }); }
      }
    });
    gsap.from(".marquee", { opacity: 0, y: 60, duration: 1.2, ease: "power3.out", scrollTrigger: { trigger: ".marquee", start: "top 90%" } });

    // Section titles reveal word by word.
    $$(".split-words").forEach((el) => {
      const s = new SplitText(el, { type: "words", wordsClass: "w" });
      gsap.from(s.words, { yPercent: 110, opacity: 0, rotate: 4, duration: 1, ease: "expo.out", stagger: 0.06, scrollTrigger: { trigger: el, start: "top 85%" } });
    });
    $$(".eyebrow").forEach((el) => gsap.from($(".line", el), { scaleX: 0, transformOrigin: "0 50%", duration: 1, ease: "expo.out", scrollTrigger: { trigger: el, start: "top 90%" } }));

    // Top 5: pinned horizontal scroll on wide screens, swipe row on phones.
    const mm = gsap.matchMedia();
    mm.add("(min-width: 900px)", () => {
      const track = $("#top-track");
      const dist = () => track.scrollWidth - window.innerWidth + 48;
      const tween = gsap.to(track, {
        x: () => -dist(),
        ease: "none",
        scrollTrigger: { trigger: ".top-pin", pin: true, start: "top top", end: () => `+=${dist()}`, scrub: 1, invalidateOnRefresh: true, anticipatePin: 1 }
      });
      $$(".top-card").forEach((card) => {
        gsap.from($(".top-art", card), { scale: 0.6, rotate: -6, opacity: 0.2, ease: "none", scrollTrigger: { trigger: card, containerAnimation: tween, start: "left right", end: "center center", scrub: true } });
        gsap.from($(".top-rank", card), { yPercent: 60, opacity: 0, ease: "none", scrollTrigger: { trigger: card, containerAnimation: tween, start: "left right", end: "left center", scrub: true } });
      });
    });
    mm.add("(max-width: 899px)", () => {
      gsap.from(".top-card", { y: 80, opacity: 0, duration: 1, ease: "power3.out", stagger: 0.12, scrollTrigger: { trigger: "#top-track", start: "top 85%" } });
    });

    gsap.from(".num", { y: 60, opacity: 0, duration: 1, ease: "power3.out", stagger: 0.1, scrollTrigger: { trigger: ".numbers", start: "top 85%" } });
    gsap.from(".controls, .legend", { y: 40, opacity: 0, duration: 1, ease: "power3.out", stagger: 0.1, scrollTrigger: { trigger: ".controls", start: "top 90%" } });

    gsap.from(".hl-card", { y: 70, opacity: 0, duration: 1, ease: "expo.out", stagger: 0.06, clearProps: "transform,opacity", scrollTrigger: { trigger: "#hl-row", start: "top 88%" } });

    // Hero cards flip in, batch by batch, as they scroll into view.
    gsap.set(".card", { opacity: 0, y: 80, rotateX: -35, scale: 0.9 });
    ScrollTrigger.batch(".card", {
      start: "top 92%",
      once: true,
      onEnter: (batch) => gsap.to(batch, { opacity: 1, y: 0, rotateX: 0, scale: 1, duration: 0.9, ease: "expo.out", stagger: 0.05, clearProps: "transform,opacity" })
    });
  }

  // ---------- ambient ----------

  let lenis = null;
  function initSmoothScroll() {
    if (!window.Lenis || reduceMotion) return;
    lenis = new Lenis({ lerp: 0.09, smoothWheel: true });
    lenis.on("scroll", ScrollTrigger.update);
    gsap.ticker.add((t) => lenis.raf(t * 1000));
    gsap.ticker.lagSmoothing(0);
  }

  function initScrollUi() {
    const bar = $(".progress");
    const header = $(".top");
    const onScroll = () => {
      const max = document.documentElement.scrollHeight - innerHeight;
      bar.style.transform = `scaleX(${max > 0 ? scrollY / max : 0})`;
      header.classList.toggle("scrolled", scrollY > 20);
    };
    addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    document.addEventListener("click", (e) => {
      const a = e.target.closest("[data-scroll]");
      if (!a) return;
      e.preventDefault();
      const go = () => {
        const target = $(a.dataset.scroll);
        if (!target) return;
        if (lenis) lenis.scrollTo(target, { offset: -70, duration: 1.6 });
        else target.scrollIntoView({ behavior: "smooth" });
      };
      if (current !== "list") { location.hash = "#/"; setTimeout(go, 1400); } else go();
    });
  }

  // Cursor follower that grows over links and shows a label over hero cards.
  function initCursor() {
    if (!finePointer || !hasGsap) { $(".cursor").remove(); return; }
    document.body.classList.add("has-cursor");
    const dot = $(".cursor-dot"), ringEl = $(".cursor-ring"), label = $(".cursor-ring span");
    const xd = gsap.quickTo(dot, "x", { duration: 0.1 }), yd = gsap.quickTo(dot, "y", { duration: 0.1 });
    const xr = gsap.quickTo(ringEl, "x", { duration: 0.45, ease: "power3" }), yr = gsap.quickTo(ringEl, "y", { duration: 0.45, ease: "power3" });
    addEventListener("pointermove", (e) => {
      xd(e.clientX); yd(e.clientY); xr(e.clientX); yr(e.clientY);
      const card = e.target.closest(".card, .top-card, .mq");
      const link = e.target.closest("a, button, select, input, label, .dd-menu li");
      document.body.classList.toggle("cursor-view", !!card);
      document.body.classList.toggle("cursor-link", !card && !!link);
      label.textContent = card ? "View" : "";
    });
    document.addEventListener("mouseleave", () => gsap.to(".cursor", { opacity: 0 }));
    document.addEventListener("mouseenter", () => gsap.to(".cursor", { opacity: 1 }));
  }

  // 3D tilt and glare that follows the pointer on hero cards.
  function initTilt() {
    if (!finePointer) return;
    let active = null;
    document.addEventListener("pointermove", (e) => {
      const card = e.target.closest(".card");
      if (active && active !== card) gsap.to(active, { rotateX: 0, rotateY: 0, duration: 0.6, ease: "power3.out" });
      active = card;
      if (!card) return;
      const r = card.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      gsap.to(card, { rotateX: (0.5 - y) * 16, rotateY: (x - 0.5) * 18, transformPerspective: 700, duration: 0.4, ease: "power2.out" });
      card.style.setProperty("--mx", `${x * 100}%`);
      card.style.setProperty("--my", `${y * 100}%`);
    });
  }

  // Glowing embers drifting up behind the page.
  function initEmbers() {
    const canvas = $("#embers");
    if (!canvas.getContext) { canvas.remove(); return; }
    const ctx = canvas.getContext("2d");
    const lite = !finePointer || innerWidth < 900;
    // The embers are soft glows, so they gain nothing from a high-DPI canvas.
    const dpr = 1;
    // One glow sprite per hue band, drawn once, then stamped with drawImage (no gradients per frame).
    const sprites = [14, 26, 38].map((hue) => {
      const c = document.createElement("canvas");
      c.width = c.height = 64;
      const g = c.getContext("2d");
      const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, `hsla(${hue}, 100%, 68%, 1)`);
      grad.addColorStop(0.35, `hsla(${hue}, 100%, 55%, .45)`);
      grad.addColorStop(1, `hsla(${hue}, 100%, 50%, 0)`);
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
      return c;
    });
    let w, h, parts = [];
    const spawn = (anywhere) => ({
      x: Math.random() * w, y: anywhere ? Math.random() * h : h + 10,
      r: 0.8 + Math.random() * 2.6, vy: 0.3 + Math.random() * 1.1, vx: (Math.random() - 0.5) * 0.3,
      phase: Math.random() * Math.PI * 2, s: sprites[(Math.random() * sprites.length) | 0], life: 0.5 + Math.random() * 0.5
    });
    let lastW = 0;
    const resize = () => {
      // Mobile browsers fire resize when the address bar slides; only rebuild when the width changes.
      if (innerWidth === lastW && parts.length) { h = canvas.height = innerHeight * dpr; return; }
      lastW = innerWidth;
      w = canvas.width = innerWidth * dpr;
      h = canvas.height = innerHeight * dpr;
      const n = Math.round(Math.min(lite ? 36 : 80, (innerWidth * innerHeight) / (lite ? 16000 : 14000)));
      parts = Array.from({ length: n }, () => spawn(true));
    };
    resize();
    addEventListener("resize", resize);
    let running = !document.hidden, last = 0;
    const step = lite ? 1000 / 30 : 0;
    document.addEventListener("visibilitychange", () => { running = !document.hidden; if (running) requestAnimationFrame(frame); });
    function frame(t) {
      if (!running) return;
      requestAnimationFrame(frame);
      if (step && t - last < step) return;
      const k = last ? Math.min(3, (t - last) / 16.7) : 1;
      last = t;
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";
      for (const p of parts) {
        p.y -= p.vy * dpr * k;
        p.x += (p.vx + Math.sin(t / 900 + p.phase) * 0.3) * dpr * k;
        if (p.y < -10) Object.assign(p, spawn(false));
        ctx.globalAlpha = Math.max(0, Math.min(1, p.y / h + 0.2) * p.life);
        const d = p.r * dpr * 8;
        ctx.drawImage(p.s, p.x - d / 2, p.y - d / 2, d, d);
      }
      ctx.globalAlpha = 1;
    }
    requestAnimationFrame(frame);
  }

  // ---------- preloader ----------

  function startLoader() {
    const num = $("#loader-num"), bar = $("#loader-bar");
    const o = { v: 0 };
    let tween = null;
    const to = (v, d) => {
      if (!hasGsap) { num.textContent = Math.round(v); bar.style.transform = `scaleX(${v / 100})`; return; }
      tween && tween.kill();
      tween = gsap.to(o, { v, duration: d, ease: "power2.out", onUpdate: () => { num.textContent = Math.round(o.v); bar.style.transform = `scaleX(${o.v / 100})`; } });
      return tween;
    };
    if (hasGsap) {
      // The logo "ignites": plate fades in, lava veins spread, then the glyph flares up.
      gsap.timeline()
        .from(".loader-logo", { scale: 0.6, opacity: 0, duration: 0.9, ease: "back.out(1.6)" })
        .from(".loader-logo .d2-veins path", { strokeDasharray: 40, strokeDashoffset: 40, duration: 1.2, ease: "power2.out", stagger: 0.08 }, 0.3)
        .fromTo(".loader-logo .d2-glyph", { opacity: 0.05 }, { opacity: 1, duration: 1.4, ease: "power2.in" }, 0.5);
    }
    to(70, 2.5);
    const started = performance.now();
    return {
      async finish() {
        // Keep the intro on screen long enough to be seen, even when data comes from cache.
        await new Promise((r) => setTimeout(r, Math.max(0, 1800 - (performance.now() - started))));
        return new Promise((resolve) => {
          if (!hasGsap) { $("#loader").remove(); document.body.classList.remove("is-loading"); resolve(); return; }
          to(100, 0.6).then(() => {
            gsap.timeline({ onComplete: () => { $("#loader").remove(); resolve(); } })
              .to(".loader-count, .loader-bar, .loader-text", { y: -30, opacity: 0, duration: 0.5, stagger: 0.05, ease: "power3.in" })
              .to(".loader-logo", { scale: 9, opacity: 0, duration: 0.9, ease: "expo.in" }, "-=0.2")
              .to("#loader", { clipPath: "inset(0 0 100% 0)", duration: 1, ease: "expo.inOut" }, "-=0.35")
              .add(() => document.body.classList.remove("is-loading"), "-=0.8");
          });
        });
      },
      fail(err) {
        $(".loader-text").innerHTML = `<span class="bad">Failed to load data: ${esc(err && err.message)}</span><br>Please reload the page in a moment.`;
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
    initEmbers();
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

    // Wait briefly so the patch number lands in the title before it animates.
    await Promise.race([loadPatch().catch(() => {}), new Promise((r) => setTimeout(r, 800))]);

    state.meta = computeMeta(state.bracket);
    renderIntro();
    renderMarquee();
    renderTop();
    buildCards();
    updateCards();
    applyFilters({ animate: false });
    renderNumbers(true);
    initFilters();

    initSmoothScroll();
    initScrollUi();
    initCursor();
    initTilt();
    initPlayer();

    const firstIsHero = /^#\/(hero\/\d+|highlights)/.test(location.hash);
    await loader.finish();
    if (!firstIsHero) animateListIn();
    route(true);
    if (firstIsHero) {
      // Build list animations once the visitor first returns to the list.
      let done = false;
      addEventListener("hashchange", () => setTimeout(() => {
        if (!done && current === "list") { done = true; animateListIn(); }
      }, 900));
    }
    addEventListener("hashchange", () => route());
  }

  boot();
})();

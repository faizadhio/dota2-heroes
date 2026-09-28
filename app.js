(() => {
  "use strict";

  const API = "https://api.opendota.com/api";
  const CDN = "https://cdn.cloudflare.steamstatic.com";
  const DAY = 24 * 60 * 60 * 1000;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const BRACKETS = ["1", "2", "3", "4", "5", "6", "7", "8"];
  const BRACKET_NAMES = { 1: "Herald", 2: "Guardian", 3: "Crusader", 4: "Archon", 5: "Legend", 6: "Ancient", 7: "Divine", 8: "Immortal" };
  const ATTR_NAMES = { str: "Strength", agi: "Agility", int: "Intelligence", all: "Universal" };
  const PHASES = [
    ["start_game_items", "Item awal", "Dibeli sebelum creep keluar"],
    ["early_game_items", "Early game", "Menit 0 sampai 10"],
    ["mid_game_items", "Mid game", "Menit 10 sampai 25"],
    ["late_game_items", "Late game", "Setelah menit 25"]
  ];
  // Consumables and wards drown out real build items outside the starting phase.
  const CONSUMABLES = new Set([
    "tango", "flask", "clarity", "enchanted_mango", "faerie_fire", "ward_observer", "ward_sentry",
    "ward_dispenser", "dust", "smoke_of_deceit", "tpscroll", "blood_grenade", "tome_of_knowledge",
    "cheese", "aghanims_shard_roshan", "ultimate_scepter_roshan", "refresher_shard", "famango",
    "great_famango", "greater_famango", "royal_jelly", "branches"
  ]);

  const state = { heroes: [], items: {}, attr: "", role: "", bracket: "all", sort: "tier", query: "" };
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
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} untuk ${path}`);
    return res.json();
  }

  async function cached(key, path, slim = (x) => x) {
    const hit = cache.get(key);
    if (hit) return hit;
    const v = slim(await getJSON(path));
    cache.set(key, v);
    return v;
  }

  const loadHeroStats = () => cached("d2.heroStats", "/heroStats");
  const loadPatch = () => cached("d2.patch", "/constants/patch", (list) => list[list.length - 1]);
  const loadItems = () => cached("d2.items", "/constants/items", (all) => {
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
  const heroVideo = (h, ext) => `${CDN}/apps/dota2/videos/dota_react/heroes/renders/${heroSlug(h)}.${ext}`;
  const wrClass = (wr) => (wr >= 0.52 ? "good" : wr <= 0.48 ? "bad" : "");
  const compact = (n) => new Intl.NumberFormat("id-ID", { notation: "compact", maximumFractionDigits: 1 }).format(n);

  // Smoothly count a number up inside an element. fmt turns the raw value into display text.
  function countUp(el, to, fmt = (v) => Math.round(v).toLocaleString("id-ID"), ms = 1200) {
    if (!el) return;
    if (reduceMotion) { el.textContent = fmt(to); return; }
    const from = 0, start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / ms);
      const e = 1 - Math.pow(1 - t, 4);
      el.textContent = fmt(from + (to - from) * e);
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // Swap view content with the View Transitions API when the browser has it.
  function transition(fn) {
    if (!reduceMotion && document.startViewTransition) document.startViewTransition(fn);
    else fn();
  }

  // ---------- list view ----------

  function renderSpotlight(meta) {
    const top = meta.ranked.filter((r) => r.pick > 0).slice(0, 5);
    $("#spot-bracket").textContent = $("#bracket").selectedOptions[0].textContent;
    $("#spotlight").innerHTML = top.map(({ h, wr, pr }, i) => `
      <a class="spot attr-${esc(h.primary_attr)}" href="#/hero/${h.id}" style="--i:${i}">
        <img src="${esc(heroImg(h))}" alt="" loading="lazy">
        <span class="spot-rank">#${i + 1}</span>
        <span class="spot-info">
          <b>${esc(h.localized_name)}</b>
          <small><span class="${wrClass(wr)}">${pct(wr)} WR</span> · ${pct(pr)} PR</small>
        </span>
      </a>`).join("");
  }

  function renderCounters(meta) {
    countUp($("#c-heroes"), state.heroes.length);
    countUp($("#c-picks"), meta.totalPicks, compact);
    countUp($("#c-s"), meta.ranked.filter((r) => r.tier === "S").length);
  }

  function renderList({ intro = false } = {}) {
    const meta = computeMeta(state.bracket);
    if (intro) { renderSpotlight(meta); renderCounters(meta); }

    const q = state.query.trim().toLowerCase();
    const rows = state.heroes
      .filter((h) => !state.attr || h.primary_attr === state.attr)
      .filter((h) => !state.role || (h.roles || []).includes(state.role))
      .filter((h) => !q || h.localized_name.toLowerCase().includes(q))
      .map((h) => meta.get(h.id));

    const sorters = {
      tier: (a, b) => b.score - a.score,
      win: (a, b) => b.wr - a.wr,
      pick: (a, b) => b.pr - a.pr,
      name: (a, b) => a.h.localized_name.localeCompare(b.h.localized_name)
    };
    rows.sort(sorters[state.sort]);
    $("#result-count").textContent = `${rows.length} hero`;

    const grid = $("#grid");
    if (!rows.length) { grid.innerHTML = `<p class="state">Tidak ada hero yang cocok.</p>`; return; }
    grid.innerHTML = rows.map(({ h, wr, pr, tier }, i) => `
      <a class="card attr-${esc(h.primary_attr)} tier-${tier}" href="#/hero/${h.id}" style="--i:${Math.min(i, 24)}">
        <div class="card-img">
          <img src="${esc(heroImg(h))}" alt="" loading="lazy">
          <b class="tier t-${tier}">${tier}</b>
        </div>
        <div class="card-body">
          <div class="card-name"><i class="attr ${esc(h.primary_attr)}" title="${esc(ATTR_NAMES[h.primary_attr])}"></i>${esc(h.localized_name)}</div>
          <div class="card-stats">
            <span class="${wrClass(wr)}" title="Win rate">${pct(wr)} <small>WR</small></span>
            <span title="Pick rate">${pct(pr)} <small>PR</small></span>
          </div>
          <span class="wr-line"><i style="--w:${Math.max(0, Math.min(1, (wr - 0.4) / 0.2))}"></i></span>
        </div>
        <span class="glare" aria-hidden="true"></span>
      </a>`).join("");
  }

  function moveSegThumb() {
    const on = $("#attr-filter button.on");
    const thumb = $(".seg-thumb");
    if (!on || !thumb) return;
    thumb.style.width = `${on.offsetWidth}px`;
    thumb.style.transform = `translateX(${on.offsetLeft - 3}px)`;
  }

  function initFilters() {
    const roles = [...new Set(state.heroes.flatMap((h) => h.roles || []))].sort();
    $("#role").insertAdjacentHTML("beforeend", roles.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join(""));

    let t;
    $("#search").addEventListener("input", (e) => {
      state.query = e.target.value;
      clearTimeout(t);
      t = setTimeout(() => renderList(), 120);
    });
    $("#role").addEventListener("change", (e) => { state.role = e.target.value; renderList(); });
    $("#sort").addEventListener("change", (e) => { state.sort = e.target.value; renderList(); });
    $("#bracket").addEventListener("change", (e) => { state.bracket = e.target.value; renderList({ intro: true }); });
    $("#attr-filter").addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      state.attr = btn.dataset.attr;
      for (const b of $$("#attr-filter button")) b.classList.toggle("on", b === btn);
      moveSegThumb();
      renderList();
    });
    window.addEventListener("resize", moveSegThumb);
    moveSegThumb();
  }

  // 3D tilt and a moving glare that follows the pointer on cards.
  function initTilt() {
    if (reduceMotion || !window.matchMedia("(hover: hover)").matches) return;
    let active = null;
    document.addEventListener("pointermove", (e) => {
      const card = e.target.closest(".card, .spot");
      if (active && active !== card) { active.style.removeProperty("--rx"); active.style.removeProperty("--ry"); }
      active = card;
      if (!card) return;
      const r = card.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      card.style.setProperty("--rx", `${(0.5 - y) * 12}deg`);
      card.style.setProperty("--ry", `${(x - 0.5) * 14}deg`);
      card.style.setProperty("--mx", `${x * 100}%`);
      card.style.setProperty("--my", `${y * 100}%`);
    });
  }

  // ---------- hero view ----------

  function itemTile(id, count, max, i) {
    const it = state.items[id];
    if (!it) return "";
    return `
      <div class="item" style="--i:${i}" title="${esc(it.name)}${it.cost ? ` · ${it.cost} gold` : ""}">
        <img src="${esc(img(it.img))}" alt="${esc(it.name)}" loading="lazy">
        <div class="item-meta">
          <span class="item-name">${esc(it.name)}${it.cost ? `<small>${it.cost}</small>` : ""}</span>
          <span class="bar"><i style="--w:${Math.max(0.06, count / max)}"></i></span>
        </div>
      </div>`;
  }

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
        <div class="core-head"><h3>Build inti</h3><span class="gold"><i></i>${total.toLocaleString("id-ID")} gold</span></div>
        <div class="core-row">
          <span class="core-line" aria-hidden="true"></span>
          ${core.map((id, i) => {
            const it = state.items[id];
            return `<figure style="--i:${i}" title="${esc(it.name)} · ${it.cost} gold"><span class="core-step">${i + 1}</span><img src="${esc(img(it.img))}" alt="${esc(it.name)}"><figcaption>${esc(it.name)}</figcaption></figure>`;
          }).join("")}
        </div>
      </div>` : "";

    const phases = PHASES.map(([key, title, sub], p) => {
      const list = topItems(pop[key], { skipConsumables: key !== "start_game_items" }).slice(0, 6);
      if (!list.length) return "";
      const max = list[0][1];
      return `<div class="phase" style="--p:${p}"><h4><span class="phase-dot"></span>${title}<small>${sub}</small></h4>${list.map(([id, n], i) => itemTile(id, n, max, i + p * 2)).join("")}</div>`;
    }).join("");

    return coreHtml + `<div class="phases">${phases || '<p class="state">Belum ada data item untuk hero ini.</p>'}</div>`;
  }

  function renderMatchups(matchups) {
    const byId = new Map(state.heroes.map((h) => [h.id, h]));
    const rows = (matchups || [])
      .filter((m) => m.games_played >= 10 && byId.has(m.hero_id))
      .map((m) => ({ h: byId.get(m.hero_id), wr: m.wins / m.games_played, n: m.games_played }));
    if (rows.length < 4) return `<p class="state">Data matchup belum cukup.</p>`;
    rows.sort((a, b) => b.wr - a.wr);
    const list = (arr) => arr.map(({ h, wr, n }, i) => `
      <a class="mu" href="#/hero/${h.id}" title="${n} game" style="--i:${i}">
        <img src="${esc(heroImg(h))}" alt="" loading="lazy"><span>${esc(h.localized_name)}</span><b class="${wrClass(wr)}">${pct(wr, 0)}</b>
      </a>`).join("");
    return `
      <div class="mus">
        <div><h4 class="good">Unggul melawan</h4>${list(rows.slice(0, 5))}</div>
        <div><h4 class="bad">Sulit melawan</h4>${list(rows.slice(-5).reverse())}</div>
      </div>`;
  }

  function renderBracketBars(h) {
    const rows = BRACKETS.map((b) => {
      const { pick, win } = bracketStats(h, b);
      return { b, wr: pick ? win / pick : 0 };
    });
    return `<div class="brackets">${rows.map(({ b, wr }, i) => `
      <div class="br" title="${BRACKET_NAMES[b]}: ${pct(wr)}" style="--i:${i}">
        <span class="br-bar ${wrClass(wr)}"><i style="--h:${Math.max(0.04, Math.min(1, (wr - 0.4) / 0.2))}"></i></span>
        <span class="br-val">${pct(wr, 0)}</span>
        <span class="br-name">${BRACKET_NAMES[b].slice(0, 3)}</span>
      </div>`).join("")}</div>`;
  }

  function ring(wr) {
    const c = 2 * Math.PI * 52;
    return `
      <div class="ring ${wrClass(wr)}">
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <circle class="ring-bg" cx="60" cy="60" r="52"/>
          <circle class="ring-fg" cx="60" cy="60" r="52" style="--c:${c};--off:${c * (1 - wr)}"/>
        </svg>
        <div class="ring-val"><b data-to="${wr}">0%</b><small>Win rate</small></div>
      </div>`;
  }

  async function showHero(id) {
    const h = state.heroes.find((x) => x.id === id);
    const view = $("#hero-view");
    if (!h) {
      view.innerHTML = `<a class="back" href="#/">‹ Semua hero</a><p class="state">Hero tidak ditemukan.</p>`;
      $("#list-view").hidden = true;
      view.hidden = false;
      return;
    }

    document.title = `${h.localized_name} · Dota 2 Meta`;
    const meta = computeMeta(state.bracket).get(h.id);
    const bracketLabel = $("#bracket").selectedOptions[0].textContent;

    view.innerHTML = `
      <a class="back" href="#/"><span>‹</span> Semua hero</a>
      <div class="hero-head attr-${esc(h.primary_attr)}">
        <div class="hero-art">
          <span class="hero-halo" aria-hidden="true"></span>
          <video class="hero-video" autoplay muted loop playsinline preload="auto" poster="${esc(heroImg(h))}" aria-hidden="true">
            <source src="${esc(heroVideo(h, "webm"))}" type="video/webm">
            <source src="${esc(heroVideo(h, "mov"))}" type='video/mp4; codecs="hvc1"'>
          </video>
        </div>
        <div class="hero-info">
          <p class="hero-sub"><i class="attr ${esc(h.primary_attr)}"></i>${esc(ATTR_NAMES[h.primary_attr] || h.primary_attr)} · ${esc(h.attack_type)}</p>
          <h1 class="hero-name">${[...h.localized_name].map((ch, i) => `<span style="--i:${i}">${ch === " " ? "&nbsp;" : esc(ch)}</span>`).join("")}</h1>
          <div class="roles">${(h.roles || []).map((r, i) => `<span style="--i:${i}">${esc(r)}</span>`).join("")}</div>
          <div class="hero-stats">
            ${ring(meta.wr)}
            <div class="kpis">
              <div class="kpi-tier"><b class="tier t-${meta.tier}">${meta.tier}</b><small>Tier · ${esc(bracketLabel)}</small></div>
              <div><b data-to="${meta.pr}" data-fmt="pct">0%</b><small>Pick rate</small></div>
              <div><b data-to="${meta.rank}" data-fmt="rank">#0</b><small>dari ${state.heroes.length} hero</small></div>
              ${h.pro_ban != null ? `<div><b data-to="${h.pro_ban}">0</b><small>Ban di pro match</small></div>` : ""}
            </div>
          </div>
        </div>
      </div>

      <div class="panels">
        <section class="panel build reveal">
          <h2>Item build</h2>
          <p class="hint">Item yang paling sering dibeli pemain ${esc(h.localized_name)} di pertandingan terbaru. Bar menunjukkan popularitas relatif.</p>
          <div id="build">${skeletonBuild()}</div>
        </section>
        <aside class="side">
          <section class="panel reveal">
            <h2>Win rate per rank</h2>
            ${renderBracketBars(h)}
          </section>
          <section class="panel reveal">
            <h2>Matchup</h2>
            <p class="hint">Dari pertandingan pro, minimal 10 game.</p>
            <div id="matchups">${skeletonRows(5)}</div>
          </section>
        </aside>
      </div>`;

    $("#list-view").hidden = true;
    view.hidden = false;
    window.scrollTo({ top: 0 });

    // A hero render video that fails to load just leaves the poster image in place.
    const video = $(".hero-video", view);
    video.addEventListener("error", () => video.classList.add("no-video"), true);
    video.addEventListener("loadeddata", () => video.classList.add("playing"));

    for (const el of $$("[data-to]", view)) {
      const to = Number(el.dataset.to);
      const fmt = el.dataset.fmt === "rank" ? (v) => `#${Math.max(1, Math.round(v))}`
        : el.dataset.fmt === "pct" || el.closest(".ring") ? (v) => pct(v)
        : (v) => Math.round(v).toLocaleString("id-ID");
      countUp(el, to, fmt, 1400);
    }
    observeReveals(view);

    const [pop, mu] = await Promise.allSettled([
      cached(`d2.pop.${id}`, `/heroes/${id}/itemPopularity`),
      cached(`d2.mu.${id}`, `/heroes/${id}/matchups`)
    ]);
    if (location.hash !== `#/hero/${id}`) return; // user navigated away while loading
    $("#build").innerHTML = pop.status === "fulfilled" ? renderBuild(pop.value) : errorBox(pop.reason);
    $("#matchups").innerHTML = mu.status === "fulfilled" ? renderMatchups(mu.value) : errorBox(mu.reason);
  }

  const skeletonRows = (n) => `<div class="skel-rows">${'<span class="skeleton"></span>'.repeat(n)}</div>`;
  const skeletonBuild = () => `<div class="skeleton skel-core"></div>${skeletonRows(6)}`;

  function showList() {
    document.title = "Dota 2 Meta · Hero & Item Build";
    $("#hero-view").hidden = true;
    $("#hero-view").innerHTML = "";
    $("#list-view").hidden = false;
    renderList();
    requestAnimationFrame(moveSegThumb);
  }

  let firstRoute = true;
  function route() {
    const m = location.hash.match(/^#\/hero\/(\d+)/);
    const go = () => (m ? showHero(Number(m[1])) : showList());
    if (firstRoute) { firstRoute = false; go(); } else transition(go);
  }

  const errorBox = (err) => `<p class="state error">Gagal memuat data (${esc(err && err.message)}). OpenDota membatasi 60 request per menit, coba lagi sebentar lagi.</p>`;

  // ---------- ambient effects ----------

  function observeReveals(root = document) {
    const els = $$(".reveal:not(.in)", root);
    if (reduceMotion || !("IntersectionObserver" in window)) { els.forEach((el) => el.classList.add("in")); return; }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
    }, { threshold: 0.12 });
    els.forEach((el) => io.observe(el));
  }

  function initScrollProgress() {
    const bar = $(".progress");
    const header = $(".top");
    const onScroll = () => {
      const max = document.documentElement.scrollHeight - innerHeight;
      bar.style.transform = `scaleX(${max > 0 ? scrollY / max : 0})`;
      header.classList.toggle("scrolled", scrollY > 8);
    };
    addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  // Glowing embers drifting up behind the page.
  function initEmbers() {
    const canvas = $("#embers");
    if (reduceMotion || !canvas.getContext) { canvas.remove(); return; }
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let w, h, parts = [];
    const spawn = (anywhere) => ({
      x: Math.random() * w,
      y: anywhere ? Math.random() * h : h + 10,
      r: 0.6 + Math.random() * 2.2,
      vy: 0.25 + Math.random() * 0.9,
      vx: (Math.random() - 0.5) * 0.3,
      phase: Math.random() * Math.PI * 2,
      hue: 12 + Math.random() * 30,
      life: 0.4 + Math.random() * 0.6
    });
    const resize = () => {
      w = canvas.width = innerWidth * dpr;
      h = canvas.height = innerHeight * dpr;
      canvas.style.width = `${innerWidth}px`;
      canvas.style.height = `${innerHeight}px`;
      const n = Math.round(Math.min(90, (innerWidth * innerHeight) / 16000));
      parts = Array.from({ length: n }, () => spawn(true));
    };
    resize();
    addEventListener("resize", resize);
    let running = true;
    document.addEventListener("visibilitychange", () => {
      running = !document.hidden;
      if (running) requestAnimationFrame(frame);
    });
    function frame(t) {
      if (!running) return;
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";
      for (const p of parts) {
        p.y -= p.vy * dpr;
        p.x += (p.vx + Math.sin(t / 900 + p.phase) * 0.25) * dpr;
        if (p.y < -10) Object.assign(p, spawn(false));
        const fade = Math.min(1, p.y / h + 0.15) * p.life;
        const r = p.r * dpr;
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 4);
        g.addColorStop(0, `hsla(${p.hue}, 100%, 65%, ${fade})`);
        g.addColorStop(1, `hsla(${p.hue}, 100%, 50%, 0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 4, 0, Math.PI * 2);
        ctx.fill();
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // ---------- boot ----------

  async function boot() {
    initEmbers();
    initScrollProgress();
    observeReveals();
    $("#grid").innerHTML = Array.from({ length: 18 }, () => `<div class="card skeleton-card"><div class="skeleton"></div><span class="skeleton"></span><span class="skeleton short"></span></div>`).join("");

    loadPatch().then((p) => {
      if (!p) return;
      $("#patch-text").textContent = `Patch ${p.name}`;
      $("#title-patch").textContent = `patch ${p.name}`;
    }).catch(() => { $("#patch-text").textContent = "Patch terbaru"; });

    try {
      const [heroes, items] = await Promise.all([loadHeroStats(), loadItems()]);
      state.heroes = heroes;
      state.items = items;
    } catch (err) {
      $("#grid").innerHTML = errorBox(err);
      $("#spotlight").innerHTML = "";
      return;
    }
    initFilters();
    initTilt();
    renderList({ intro: true });
    window.addEventListener("hashchange", route);
    route();
  }

  boot();
})();

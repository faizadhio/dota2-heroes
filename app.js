(() => {
  "use strict";

  const API = "https://api.opendota.com/api";
  const CDN = "https://cdn.cloudflare.steamstatic.com";
  const DAY = 24 * 60 * 60 * 1000;

  const BRACKETS = ["1", "2", "3", "4", "5", "6", "7", "8"];
  const BRACKET_NAMES = { 1: "Herald", 2: "Guardian", 3: "Crusader", 4: "Archon", 5: "Legend", 6: "Ancient", 7: "Divine", 8: "Immortal" };
  const ATTR_NAMES = { str: "Strength", agi: "Agility", int: "Intelligence", all: "Universal" };
  const ROLE_NAMES = {
    Carry: "Carry", Support: "Support", Nuker: "Nuker", Disabler: "Disabler", Jungler: "Jungler",
    Durable: "Durable", Escape: "Escape", Pusher: "Pusher", Initiator: "Initiator"
  };
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
    if (bracket === "pro") return { pick: h.pro_pick || 0, win: h.pro_win || 0, ban: h.pro_ban || 0 };
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
    return new Map(rows.map((r) => [r.h.id, r]));
  }

  // ---------- helpers ----------

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = (v, d = 1) => `${(v * 100).toFixed(d)}%`;
  const img = (path) => (path ? CDN + path : "");
  const heroSlug = (h) => h.name.replace("npc_dota_hero_", "");
  const heroImg = (h) => img(h.img) || `${CDN}/apps/dota2/images/dota_react/heroes/${heroSlug(h)}.png`;
  const wrClass = (wr) => (wr >= 0.52 ? "good" : wr <= 0.48 ? "bad" : "");

  // ---------- list view ----------

  function renderList() {
    const meta = computeMeta(state.bracket);
    const q = state.query.trim().toLowerCase();
    let rows = state.heroes
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

    const grid = $("#grid");
    if (!rows.length) { grid.innerHTML = `<p class="state">Tidak ada hero yang cocok.</p>`; return; }
    grid.innerHTML = rows.map(({ h, wr, pr, tier }) => `
      <a class="card" href="#/hero/${h.id}">
        <div class="card-img"><img src="${esc(heroImg(h))}" alt="" loading="lazy"><b class="tier t-${tier}">${tier}</b></div>
        <div class="card-body">
          <div class="card-name"><i class="attr ${esc(h.primary_attr)}" title="${esc(ATTR_NAMES[h.primary_attr])}"></i>${esc(h.localized_name)}</div>
          <div class="card-stats">
            <span class="${wrClass(wr)}" title="Win rate">${pct(wr)} <small>WR</small></span>
            <span title="Pick rate">${pct(pr)} <small>PR</small></span>
          </div>
        </div>
      </a>`).join("");
  }

  function initFilters() {
    const roles = [...new Set(state.heroes.flatMap((h) => h.roles || []))].sort();
    $("#role").insertAdjacentHTML("beforeend", roles.map((r) => `<option value="${esc(r)}">${esc(ROLE_NAMES[r] || r)}</option>`).join(""));

    $("#search").addEventListener("input", (e) => { state.query = e.target.value; renderList(); });
    $("#role").addEventListener("change", (e) => { state.role = e.target.value; renderList(); });
    $("#sort").addEventListener("change", (e) => { state.sort = e.target.value; renderList(); });
    $("#bracket").addEventListener("change", (e) => { state.bracket = e.target.value; renderList(); });
    $("#attr-filter").addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      state.attr = btn.dataset.attr;
      for (const b of $("#attr-filter").children) b.classList.toggle("on", b === btn);
      renderList();
    });
  }

  // ---------- hero view ----------

  function itemTile(id, count, max) {
    const it = state.items[id];
    if (!it) return "";
    return `
      <div class="item" title="${esc(it.name)}${it.cost ? ` · ${it.cost} gold` : ""}">
        <img src="${esc(img(it.img))}" alt="${esc(it.name)}" loading="lazy">
        <div class="item-meta">
          <span class="item-name">${esc(it.name)}</span>
          <span class="bar"><i style="width:${Math.max(6, (count / max) * 100)}%"></i></span>
        </div>
      </div>`;
  }

  function topItems(phaseData, { skipConsumables }) {
    return Object.entries(phaseData || {})
      .filter(([id]) => state.items[id] && !(skipConsumables && CONSUMABLES.has(state.items[id].key)))
      .sort((a, b) => b[1] - a[1]);
  }

  function coreBuild(pop) {
    // The most bought non-consumable items from mid and late game, in purchase order.
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
    const coreHtml = core.length ? `
      <div class="core">
        <h3>Build inti</h3>
        <div class="core-row">${core.map((id, i) => {
          const it = state.items[id];
          return `${i ? '<span class="arrow" aria-hidden="true">›</span>' : ""}<figure title="${esc(it.name)}"><img src="${esc(img(it.img))}" alt="${esc(it.name)}"><figcaption>${esc(it.name)}</figcaption></figure>`;
        }).join("")}</div>
      </div>` : "";

    const phases = PHASES.map(([key, title, sub]) => {
      const list = topItems(pop[key], { skipConsumables: key !== "start_game_items" }).slice(0, 6);
      if (!list.length) return "";
      const max = list[0][1];
      return `<div class="phase"><h4>${title}<small>${sub}</small></h4>${list.map(([id, n]) => itemTile(id, n, max)).join("")}</div>`;
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
    const list = (arr) => arr.map(({ h, wr, n }) => `
      <a class="mu" href="#/hero/${h.id}" title="${n} game">
        <img src="${esc(heroImg(h))}" alt="" loading="lazy"><span>${esc(h.localized_name)}</span><b class="${wrClass(wr)}">${pct(wr, 0)}</b>
      </a>`).join("");
    return `
      <div class="mus">
        <div><h4>Unggul melawan</h4>${list(rows.slice(0, 5))}</div>
        <div><h4>Sulit melawan</h4>${list(rows.slice(-5).reverse())}</div>
      </div>`;
  }

  function renderBracketBars(h) {
    const rows = BRACKETS.map((b) => {
      const { pick, win } = bracketStats(h, b);
      return { b, wr: pick ? win / pick : 0 };
    });
    return `<div class="brackets">${rows.map(({ b, wr }) => `
      <div class="br" title="${BRACKET_NAMES[b]}: ${pct(wr)}">
        <span class="br-bar ${wrClass(wr)}"><i style="height:${Math.max(4, Math.min(100, (wr - 0.4) / 0.2 * 100))}%"></i></span>
        <span class="br-val">${pct(wr, 0)}</span>
        <span class="br-name">${BRACKET_NAMES[b].slice(0, 3)}</span>
      </div>`).join("")}</div>`;
  }

  async function showHero(id) {
    const h = state.heroes.find((x) => x.id === id);
    const view = $("#hero-view");
    $("#list-view").hidden = true;
    view.hidden = false;
    window.scrollTo(0, 0);
    if (!h) { view.innerHTML = `<a class="back" href="#/">‹ Semua hero</a><p class="state">Hero tidak ditemukan.</p>`; return; }

    document.title = `${h.localized_name} · Dota 2 Meta`;
    const meta = computeMeta(state.bracket).get(h.id);
    const bracketLabel = $("#bracket").selectedOptions[0].textContent;

    view.innerHTML = `
      <a class="back" href="#/">‹ Semua hero</a>
      <div class="hero-head">
        <img class="hero-portrait" src="${esc(heroImg(h))}" alt="${esc(h.localized_name)}">
        <div class="hero-info">
          <div class="hero-title">
            <h1>${esc(h.localized_name)}</h1>
            <b class="tier t-${meta.tier}" title="Tier di ${esc(bracketLabel)}">${meta.tier}</b>
          </div>
          <p class="hero-sub"><i class="attr ${esc(h.primary_attr)}"></i>${esc(ATTR_NAMES[h.primary_attr] || h.primary_attr)} · ${esc(h.attack_type)} · ${(h.roles || []).map(esc).join(", ")}</p>
          <div class="kpis">
            <div><span class="${wrClass(meta.wr)}">${pct(meta.wr)}</span><small>Win rate · ${esc(bracketLabel)}</small></div>
            <div><span>${pct(meta.pr)}</span><small>Pick rate</small></div>
            <div><span>#${meta.rank}</span><small>dari ${state.heroes.length} hero</small></div>
            ${h.pro_ban != null ? `<div><span>${h.pro_ban}</span><small>Ban di pro match</small></div>` : ""}
          </div>
        </div>
      </div>

      <div class="panels">
        <section class="panel build">
          <h2>Item build</h2>
          <p class="hint">Item yang paling sering dibeli pemain ${esc(h.localized_name)} di pertandingan terbaru. Bar menunjukkan popularitas relatif.</p>
          <div id="build"><p class="state">Memuat item build…</p></div>
        </section>
        <aside class="side">
          <section class="panel">
            <h2>Win rate per rank</h2>
            ${renderBracketBars(h)}
          </section>
          <section class="panel">
            <h2>Matchup</h2>
            <p class="hint">Dari pertandingan pro, minimal 10 game.</p>
            <div id="matchups"><p class="state">Memuat matchup…</p></div>
          </section>
        </aside>
      </div>`;

    const [pop, mu] = await Promise.allSettled([
      cached(`d2.pop.${id}`, `/heroes/${id}/itemPopularity`),
      cached(`d2.mu.${id}`, `/heroes/${id}/matchups`)
    ]);
    if (location.hash !== `#/hero/${id}`) return; // user navigated away while loading
    $("#build").innerHTML = pop.status === "fulfilled" ? renderBuild(pop.value) : errorBox(pop.reason);
    $("#matchups").innerHTML = mu.status === "fulfilled" ? renderMatchups(mu.value) : errorBox(mu.reason);
  }

  function showList() {
    document.title = "Dota 2 Meta · Hero & Item Build";
    $("#hero-view").hidden = true;
    $("#list-view").hidden = false;
    renderList();
  }

  function route() {
    const m = location.hash.match(/^#\/hero\/(\d+)/);
    if (m) showHero(Number(m[1])); else showList();
  }

  const errorBox = (err) => `<p class="state error">Gagal memuat data (${esc(err && err.message)}). OpenDota membatasi 60 request per menit, coba lagi sebentar lagi.</p>`;

  // ---------- boot ----------

  async function boot() {
    loadPatch().then((p) => { if (p) $("#patch").textContent = `Patch ${p.name}`; }).catch(() => { $("#patch").textContent = "Patch terbaru"; });
    try {
      const [heroes, items] = await Promise.all([loadHeroStats(), loadItems()]);
      state.heroes = heroes;
      state.items = items;
    } catch (err) {
      $("#grid").innerHTML = errorBox(err);
      return;
    }
    initFilters();
    window.addEventListener("hashchange", route);
    route();
  }

  boot();
})();

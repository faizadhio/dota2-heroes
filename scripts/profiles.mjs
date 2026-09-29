// Fetches each hero's profile from the data feed behind dota2.com hero pages (lore, abilities, talents,
// base stats, role levels) and writes a trimmed copy to data/profiles/<id>.json. The feed sends no CORS
// headers, so the browser can't read it directly; .github/workflows/snapshot.yml runs this daily.
import { mkdir, writeFile } from "node:fs/promises";

const FEED = "https://www.dota2.com/datafeed";
const OUT = new URL("../data/profiles/", import.meta.url);
const HEADERS = { "user-agent": "Mozilla/5.0 (compatible; dota2-heroes snapshot)" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path, tries = 3) {
  for (let i = 1; ; i++) {
    const res = await fetch(FEED + path, { headers: HEADERS }).catch((err) => ({ ok: false, status: err.message }));
    if (res.ok) return res.json();
    if (i >= tries) throw new Error(`${res.status} for ${path}`);
    await sleep(2000 * i);
  }
}

// Only <b> and <br> survive; everything else in Valve's strings is dropped.
const clean = (s) => String(s || "")
  .replace(/[\r\n\t]+/g, " ")
  .replace(/<(?!\/?b>|br\s*\/?>)[^>]*>/gi, "")
  .replace(/\s{2,}/g, " ")
  .trim();

const num = (v) => Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
const valueText = (sv) => {
  const vals = sv.values_float || [];
  if (!vals.length) return "";
  const uniq = vals.every((v) => v === vals[0]) ? [vals[0]] : vals;
  return uniq.map(num).join(" / ") + (sv.is_percentage ? "%" : "");
};

// Descriptions reference values as %name% (and %% for a literal percent sign).
function fill(text, specials) {
  const byName = new Map(specials.map((sv) => [sv.name.toLowerCase(), sv]));
  return clean(text).replace(/%([a-z0-9_]*)%/gi, (m, key) => {
    if (!key) return "%";
    const sv = byName.get(key.toLowerCase());
    return sv ? valueText(sv) : "?";
  });
}

// Talent names look like "+{s:bonus_curse_dps} Curse of Avernus DPS"; the number lives in the ability the
// talent upgrades, as a bonus named after the talent.
function talentText(t, abilities) {
  const values = {};
  for (const a of abilities) for (const sv of a.special_values || []) {
    for (const b of sv.bonuses || []) if (b.name === t.name) values[sv.name] = b.value;
  }
  for (const sv of t.special_values || []) if (sv.values_float && sv.values_float.length) values[sv.name] = sv.values_float[0];
  return clean(t.name_loc)
    .replace(/\{s:(?:bonus_)?([a-z0-9_]+)\}/gi, (m, key) => {
      const v = values[key] ?? values[`bonus_${key}`];
      return v == null ? "" : num(v);
    })
    .replace(/\+\s*-/g, "-")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function trim(h) {
  const abilities = (h.abilities || [])
    .filter((a) => a.name_loc && !/hidden|empty/i.test(a.name))
    .map((a) => ({
      name: a.name,
      title: clean(a.name_loc),
      desc: fill(a.desc_loc, a.special_values || []),
      lore: clean(a.lore_loc),
      notes: (a.notes_loc || []).map((n) => fill(n, a.special_values || [])).filter(Boolean),
      cooldowns: (a.cooldowns || []).filter((v) => v > 0),
      mana: (a.mana_costs || []).filter((v) => v > 0),
      ult: a.type === 1,
      innate: !!a.ability_is_innate,
      shard: fill(a.shard_loc, a.special_values || []),
      scepter: fill(a.scepter_loc, a.special_values || []),
      fromShard: !!a.ability_is_granted_by_shard,
      fromScepter: !!a.ability_is_granted_by_scepter
    }));
  const talents = (h.talents || []).map((t) => talentText(t, h.abilities || []));
  return {
    tagline: clean(h.npe_desc_loc),
    hype: clean(h.hype_loc),
    bio: clean(h.bio_loc),
    complexity: h.complexity,
    attack: h.attack_capability === 2 ? "Ranged" : "Melee",
    primary: ["str", "agi", "int", "all"][h.primary_attr] || "all",
    str: [h.str_base, h.str_gain], agi: [h.agi_base, h.agi_gain], int: [h.int_base, h.int_gain],
    damage: [h.damage_min, h.damage_max],
    attackRate: h.attack_rate, attackRange: h.attack_range, projectileSpeed: h.projectile_speed,
    armor: h.armor, magicResist: h.magic_resistance,
    moveSpeed: h.movement_speed, turnRate: h.turn_rate, vision: [h.sight_range_day, h.sight_range_night],
    health: [h.max_health, h.health_regen], mana: [h.max_mana, h.mana_regen],
    roles: h.role_levels || [],
    abilities,
    // Pairs from level 10 up: [10a, 10b, 15a, 15b, 20a, 20b, 25a, 25b].
    talents
  };
}

await mkdir(OUT, { recursive: true });
const list = (await get("/herolist?language=english")).result.data.heroes;
let failed = 0;
for (const { id } of list) {
  try {
    await sleep(300);
    const h = (await get(`/herodata?language=english&hero_id=${id}`)).result.data.heroes[0];
    await writeFile(new URL(`${id}.json`, OUT), JSON.stringify(trim(h)));
  } catch (err) {
    failed++;
    console.warn(`hero ${id}: ${err.message} (keeping the previous file)`);
  }
}
console.log(`profiles: ${list.length - failed} of ${list.length} heroes written`);
if (failed > list.length / 4) process.exitCode = 1;

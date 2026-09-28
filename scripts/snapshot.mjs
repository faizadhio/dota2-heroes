// Fetches everything the site needs from OpenDota and writes it to data/ as static JSON.
// Run daily by .github/workflows/snapshot.yml; the site falls back to the live API when data/ is missing or stale.
import { mkdir, writeFile } from "node:fs/promises";

const API = process.env.OPENDOTA_API || "https://api.opendota.com/api";
const OUT = new URL("../data/", import.meta.url);
const GAP = Number(process.env.SNAPSHOT_GAP_MS ?? 1100); // free tier allows 60 requests per minute
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path, tries = 4) {
  for (let i = 1; ; i++) {
    const res = await fetch(API + path).catch((err) => ({ ok: false, status: err.message }));
    if (res.ok) return res.json();
    if (i >= tries) throw new Error(`${res.status} for ${path}`);
    await sleep(res.status === 429 ? 30000 : 3000 * i);
  }
}

const write = (file, data) => writeFile(new URL(file, OUT), JSON.stringify(data));

const HERO_KEYS = ["id", "name", "localized_name", "primary_attr", "attack_type", "roles", "img", "pro_pick", "pro_win", "pro_ban"];
for (let b = 1; b <= 8; b++) HERO_KEYS.push(`${b}_pick`, `${b}_win`);

await mkdir(new URL("heroes/", OUT), { recursive: true });

const heroStats = (await get("/heroStats")).map((h) => Object.fromEntries(HERO_KEYS.map((k) => [k, h[k]])));
await sleep(GAP);

const items = {};
for (const [key, it] of Object.entries(await get("/constants/items"))) {
  if (!it || it.id == null || key.startsWith("recipe_")) continue;
  items[it.id] = { key, name: it.dname || key, img: it.img, cost: it.cost || 0 };
}
await sleep(GAP);

const patches = await get("/constants/patch");
const patch = patches[patches.length - 1];

let failed = 0;
for (const h of heroStats) {
  try {
    await sleep(GAP);
    const itemPopularity = await get(`/heroes/${h.id}/itemPopularity`);
    await sleep(GAP);
    const matchups = (await get(`/heroes/${h.id}/matchups`)).map(({ hero_id, games_played, wins }) => ({ hero_id, games_played, wins }));
    await write(`heroes/${h.id}.json`, { itemPopularity, matchups });
  } catch (err) {
    failed++;
    console.warn(`hero ${h.id}: ${err.message} (keeping the previous file)`);
  }
}
if (failed > heroStats.length / 4) throw new Error(`${failed} heroes failed, not publishing this snapshot`);

await write("heroStats.json", heroStats);
await write("items.json", items);
await write("meta.json", { generatedAt: new Date().toISOString(), patch });
console.log(`snapshot: ${heroStats.length} heroes, ${Object.keys(items).length} items, patch ${patch && patch.name}, ${failed} hero failures`);

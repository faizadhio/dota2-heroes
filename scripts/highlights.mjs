// Collects the latest Dota 2 tournament highlight videos from YouTube and writes them to data/highlights.json.
// Run by .github/workflows/highlights.yml. Sources, tried per channel until one works:
//   1. YouTube Data API, only when a YOUTUBE_API_KEY secret is set (most reliable);
//   2. the channel's public RSS feed;
//   3. the channel's public "Videos" page.
import { mkdir, writeFile } from "node:fs/promises";

const CHANNELS = [
  { id: "UC7VWLs_Ivccq22rM2_xo0Rg", label: "PGL" },
  { id: "UCaYLBJfw6d8XqmNlL204lNg", label: "ESL" },
  { id: "UCAvIC2XmBLLXFPdveirTrmw", label: "BLAST" },
  { id: "UCTQKT5QqO3h7y32G8VzuySQ", label: "Dota 2" }
];
// Tournament channels also upload full broadcasts, interviews and trailers; keep the highlight-style videos.
const HIGHLIGHT = /highlight|best (moments|plays)|top \d+|top plays|moments|recap|rampage|ultra kill/i;
const MAX = 48;
const OUT = new URL("../data/highlights.json", import.meta.url);
const KEY = process.env.YOUTUBE_API_KEY;
const HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
  // Skips the EU cookie consent page.
  cookie: "CONSENT=YES+cb; SOCS=CAI"
};

async function get(url, type = "text") {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${res.status}`);
  return type === "json" ? res.json() : res.text();
}

// ---- 1. Data API ----
async function fromApi({ id, label }) {
  const uploads = "UU" + id.slice(2);
  const list = await get(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${uploads}&key=${KEY}`, "json");
  const items = list.items.map((i) => i.snippet).filter((s) => s.resourceId && HIGHLIGHT.test(s.title));
  if (!items.length) return [];
  const ids = items.map((s) => s.resourceId.videoId);
  const stats = await get(`https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails&id=${ids.join(",")}&key=${KEY}`, "json");
  const byId = new Map(stats.items.map((v) => [v.id, v]));
  return items.map((s) => {
    const v = byId.get(s.resourceId.videoId);
    return { id: s.resourceId.videoId, title: s.title, channel: label, published: s.publishedAt,
      views: Number(v?.statistics?.viewCount || 0), duration: isoDuration(v?.contentDetails?.duration) };
  });
}
function isoDuration(d) {
  const m = d && d.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}

// ---- 2. RSS ----
const decode = (s) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)); return m ? decode(m[1]).trim() : ""; };

async function fromRss({ id, label }) {
  const xml = await get(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`);
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
    id: tag(e, "yt:videoId"),
    title: tag(e, "title"),
    channel: label,
    published: tag(e, "published"),
    views: Number((e.match(/<media:statistics views="(\d+)"/) || [])[1] || 0)
  })).filter((v) => HIGHLIGHT.test(v.title));
}

// ---- 3. Channel page ----
const UNITS = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000 };
const fromAgo = (text, order = 0) => {
  const m = String(text || "").match(/(\d+)\s+(second|minute|hour|day|week|month|year)/);
  return new Date(Date.now() - (m ? +m[1] * UNITS[m[2]] * 1000 : 0) - order * 1000).toISOString();
};
const clock = (t) => String(t || "").split(":").reduce((a, n) => a * 60 + (+n || 0), 0);
const text = (t) => (t && (t.simpleText || (t.runs || []).map((r) => r.text).join(""))) || "";

// YouTube serves either the older videoRenderer or the newer lockupViewModel layout; read both.
function* walk(node) {
  if (!node || typeof node !== "object") return;
  if (node.videoRenderer) {
    const r = node.videoRenderer;
    yield { id: r.videoId, title: text(r.title), ago: text(r.publishedTimeText), views: text(r.viewCountText), length: text(r.lengthText) };
    return;
  }
  if (node.lockupViewModel && /VIDEO/.test(node.lockupViewModel.contentType || "")) {
    const l = node.lockupViewModel;
    const meta = l.metadata?.lockupMetadataViewModel || {};
    // The view count and upload age sit a few levels down and move around between layouts; search the strings.
    const strings = [...JSON.stringify(l).matchAll(/"(?:content|text|label)":"([^"]*)"/g)].map((m) => m[1]);
    yield { id: l.contentId, title: meta.title?.content || "",
      ago: strings.find((p) => /\d+\s+\w+\s+ago$/.test(p)) || "",
      views: strings.find((p) => /^[\d.,]+\s*[KMB]?\s+views?$/i.test(p)) || "",
      length: strings.find((p) => /^\d+(:\d\d)+$/.test(p)) || "" };
    return;
  }
  for (const v of Object.values(node)) yield* walk(v);
}
const count = (s) => { const m = String(s).replace(/,/g, "").match(/([\d.]+)\s*([KMB])?/i); return m ? Math.round(+m[1] * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[2] || "").toLowerCase()] || 1)) : 0; };

async function fromPage({ id, label }) {
  const html = await get(`https://www.youtube.com/channel/${id}/videos?hl=en&gl=US`);
  const m = html.match(/var ytInitialData = (\{[\s\S]*?\});<\/script>/);
  if (!m) throw new Error("no ytInitialData");
  const all = [...walk(JSON.parse(m[1]))];
  if (!all.length) throw new Error("no videos found on the page");
  console.log(`${label}: page lists ${all.length} videos, e.g. "${all[0].title}" (${all[0].views}, ${all[0].ago}, ${all[0].length})`);
  // "3 weeks ago" is coarse, so nudge each video back by its position to keep the page's newest-first order.
  return all.map((r, i) => ({ ...r, i })).filter((r) => r.id && HIGHLIGHT.test(r.title)).map((r) => ({
    id: r.id, title: r.title, channel: label, published: fromAgo(r.ago, r.i), views: count(r.views), duration: clock(r.length)
  }));
}

const sources = [...(KEY ? [["api", fromApi]] : []), ["rss", fromRss], ["page", fromPage]];
const videos = [];
for (const ch of CHANNELS) {
  const tried = [];
  for (const [name, fn] of sources) {
    try {
      const list = (await fn(ch)).filter((v) => /^[\w-]{11}$/.test(v.id));
      console.log(`${ch.label}: ${list.length} highlight videos via ${name}`);
      videos.push(...list);
      break;
    } catch (err) {
      tried.push(`${name} ${err.message}`);
    }
  }
  if (tried.length === sources.length) console.warn(`${ch.label}: failed (${tried.join(", ")})`);
}

// Never replace a good file with an empty one when YouTube is unreachable.
if (!videos.length) {
  console.warn("highlights: nothing fetched, keeping the previous file");
} else {
  const seen = new Set();
  const out = videos
    .filter((v) => !seen.has(v.id) && seen.add(v.id))
    .sort((a, b) => Date.parse(b.published) - Date.parse(a.published))
    .slice(0, MAX);
  await mkdir(new URL("./", OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), videos: out }));
  console.log(`highlights: ${out.length} videos written`);
}

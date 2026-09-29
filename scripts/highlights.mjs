// Collects the latest Dota 2 tournament highlight videos from YouTube channel RSS feeds (no API key needed)
// and writes them to data/highlights.json. Run daily by .github/workflows/snapshot.yml.
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

const decode = (s) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)); return m ? decode(m[1]).trim() : ""; };

async function feed({ id, label }) {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`);
  if (!res.ok) throw new Error(`${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
    id: tag(e, "yt:videoId"),
    title: tag(e, "title"),
    channel: label,
    published: tag(e, "published"),
    views: Number((e.match(/<media:statistics views="(\d+)"/) || [])[1] || 0)
  })).filter((v) => /^[\w-]{11}$/.test(v.id) && HIGHLIGHT.test(v.title));
}

const videos = [];
for (const ch of CHANNELS) {
  try {
    const list = await feed(ch);
    console.log(`${ch.label}: ${list.length} highlight videos`);
    videos.push(...list);
  } catch (err) {
    console.warn(`${ch.label}: ${err.message}`);
  }
}

// Never replace a good file with an empty one when YouTube is unreachable.
if (!videos.length) {
  console.warn("highlights: nothing fetched, keeping the previous file");
} else {
  videos.sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
  await mkdir(new URL("./", OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), videos: videos.slice(0, MAX) }));
  console.log(`highlights: ${Math.min(videos.length, MAX)} videos written`);
}

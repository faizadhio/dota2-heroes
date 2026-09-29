// Offline-capable cache for the static site.
// fonts/ never change, so they are served from cache first. Pages, code and data go to the
// network first (so a deploy shows up right away) and fall back to the cache when the network is slow or offline.
const VERSION = "v2";
const SHELL = `shell-${VERSION}`;
const RUNTIME = `runtime-${VERSION}`;
const PRECACHE = [
  "./", "index.html", "style.css", "app.js",
  "fonts/unbounded-latin-700-normal.woff2", "fonts/unbounded-latin-900-normal.woff2",
  "fonts/chakra-petch-latin-400-normal.woff2", "fonts/chakra-petch-latin-500-normal.woff2",
  "fonts/chakra-petch-latin-600-normal.woff2", "fonts/chakra-petch-latin-700-normal.woff2"
];
const NETWORK_TIMEOUT = 3000;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== RUNTIME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) (await caches.open(SHELL)).put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(RUNTIME);
  const network = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  network.catch(() => {});
  const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT));
  try {
    const res = await Promise.race([network, timeout]);
    if (res) return res;
  } catch { /* offline: fall through to the cache */ }
  const hit = (await cache.match(req, { ignoreSearch: req.mode === "navigate" })) || (await caches.match(req, { ignoreSearch: true }));
  return hit || network;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (url.pathname.includes("/fonts/")) e.respondWith(cacheFirst(req));
    else e.respondWith(networkFirst(req));
  } else if (url.hostname === "api.opendota.com") {
    e.respondWith(networkFirst(req));
  }
  // Steam CDN images and videos are left to the browser's own HTTP cache.
});

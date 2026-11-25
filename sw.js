/* Venus Hub — service worker (offline support)
   • Your own files (index.html, vault.js, today.html …): network first, so edits show up as soon as you're online;
     if the network is down or slow (>6 s) the last copy is used.
   • Libraries from CDNs (FontAwesome, Google Fonts, marked, MathJax, pdf.js …): cached the first time, then served
     from the device. Pinned versions never re-download; unpinned ones (chart.js, marked) refresh quietly.
   • Your notes/data are NOT touched here — they stay in IndexedDB / localStorage as before.
   Bump CACHE_VERSION only if you ever want to wipe and rebuild all caches. */
const CACHE_VERSION = 'v1';
const APP_CACHE = 'venus-app-' + CACHE_VERSION;
const CDN_CACHE = 'venus-cdn-' + CACHE_VERSION;

const CORE = [
  './', './launcher.html', './index.html', './today.html', './prompts.html',
  './tracker.css', './vault.css', './vault.js', './vault-cm.js', './pwa.js',
  './manifest.json', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'
];
const CDN_PRECACHE = [
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css',
  'https://cdn.jsdelivr.net/npm/chart.js',
  'https://cdn.jsdelivr.net/npm/marked/marked.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js',
  'https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js',
  'https://fonts.googleapis.com/css2?family=Nunito:ital,wght@0,400;0,500;0,600;0,700;0,800;1,400;1,600&display=swap',
  'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,600;0,700;1,600;1,700&display=swap',
  'https://fonts.googleapis.com/css2?family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;0,8..60,700;1,8..60,400&display=swap',
  /* PDF reader (vault.js uses pdf.js 6.3.289 — keep in sync with PDFJS_VER there) */
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.min.mjs',
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.worker.min.mjs',
  /* Spreadsheet preview (vault.js SHEETJS_URL) and Mermaid diagrams (vault.js MM_VER) — keep versions in sync with vault.js */
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/mermaid@10.9.3/dist/mermaid.min.js'
];
const CDN_HOSTS = new Set(['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'cdn-icons-png.flaticon.com']);

const isPinned = (url) => /@\d|\/\d+\.\d+\.\d+\//.test(url) || /fonts\.gstatic\.com|flaticon/.test(url);
const appKey = (u) => new Request(u.origin + u.pathname);          // ignore ?v=… so old versions don't pile up
const withTimeout = (p, ms) => ms ? Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]) : p;

async function putCdn(url) {
  const cache = await caches.open(CDN_CACHE);
  if (await cache.match(url, { ignoreVary: true })) return;
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 30000);   // a stalled CDN must never hang us
  try {
    const res = await fetch(new Request(url, { mode: 'cors', credentials: 'omit', signal: ctl.signal }));
    if (res.ok) await cache.put(url, res);
  } finally { clearTimeout(t); }
}

self.addEventListener('install', (e) => {
  // Only your own files are awaited here (fast, same server). CDN libraries are fetched afterwards via the page's
  // "warm" message, so a slow or blocked CDN can never stop the service worker from installing.
  e.waitUntil((async () => {
    const app = await caches.open(APP_CACHE);
    await Promise.allSettled(CORE.map(async (p) => {
      const res = await fetch(new Request(p, { cache: 'reload' }));
      if (res.ok) await app.put(appKey(new URL(res.url)), res);
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('venus-') && k !== APP_CACHE && k !== CDN_CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === 'warm' && Array.isArray(d.urls)) {
    // The page lists every CDN file it actually loaded (fonts, icons…); with the known list they're saved for offline.
    const list = CDN_PRECACHE.concat(d.urls.filter((u) => { try { return CDN_HOSTS.has(new URL(u).hostname); } catch (_) { return false; } }));
    e.waitUntil(Promise.allSettled(Array.from(new Set(list)).map(putCdn)));
  }
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) e.respondWith(sameOrigin(req, url));
  else if (CDN_HOSTS.has(url.hostname)) e.respondWith(cdn(e, req));
});

async function sameOrigin(req, url) {
  const cache = await caches.open(APP_CACHE);
  const key = appKey(url);
  const cached = await cache.match(key);
  try {
    const res = await withTimeout(fetch(req), cached ? 6000 : 0);
    if (res && res.ok && res.type === 'basic') cache.put(key, res.clone());
    return res;
  } catch (err) {
    if (cached) return cached;
    if (req.mode === 'navigate') {
      const fb = await cache.match(new Request(url.origin + url.pathname.replace(/[^/]*$/, 'launcher.html')));
      if (fb) return fb;
    }
    return new Response('Offline and not cached yet.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

async function cdn(e, req) {
  const cache = await caches.open(CDN_CACHE);
  const hit = await cache.match(req.url, { ignoreVary: true });
  if (hit) {
    if (!isPinned(req.url)) e.waitUntil(fetch(new Request(req.url, { mode: 'cors', credentials: 'omit' })).then((r) => r.ok && cache.put(req.url, r)).catch(() => {}));
    return hit;
  }
  try {
    const res = await fetch(new Request(req.url, { mode: 'cors', credentials: 'omit' }));   // CORS copy → cacheable and not "opaque"
    if (res.ok) cache.put(req.url, res.clone());
    return res;
  } catch (_) {
    return fetch(req);   // no CORS from that host: let it through uncached
  }
}

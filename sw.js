// Service Worker der Karteikarten-App: hält die App offline verfügbar.
// Bei jeder Änderung an den App-Dateien VERSION erhöhen.
const VERSION = "sk-1.1.0";
const SHELL = [
  "./", "./index.html", "./app.js", "./manifest.webmanifest",
  "./vendor/supabase.js", "./vendor/tex-svg-full.js",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/maskable-512.png",
];
const FONT_CACHE = "sk-fonts";

self.addEventListener("install", event => {
  event.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== FONT_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Schriften von Google Fonts: einmal laden, dann aus dem Cache
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(caches.open(FONT_CACHE).then(async cache => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === "opaque") cache.put(req, res.clone());
      return res;
    }));
    return;
  }

  // Nur eigene Dateien; Anfragen an die Datenbank laufen immer übers Netz
  if (url.origin !== self.location.origin) return;

  // Seite selbst: zuerst Netz (für Updates), sonst Cache
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put("./index.html", copy));
        return res;
      }).catch(() => caches.match("./index.html"))
    );
    return;
  }

  // Übrige Dateien: sofort aus dem Cache, im Hintergrund auffrischen
  event.respondWith(caches.open(VERSION).then(async cache => {
    const hit = await cache.match(req, { ignoreSearch: true });
    const net = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
    return hit || (await net) || Response.error();
  }));
});

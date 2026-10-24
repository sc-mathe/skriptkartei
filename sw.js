// Service Worker der Karteikarten-App: hält die App offline verfügbar.
// Bei jeder Änderung an den App-Dateien VERSION erhöhen.
const VERSION = "sk-1.4.0";
const SHELL = [
  "./", "./index.html", "./app.js", "./manifest.webmanifest",
  "./vendor/supabase.js", "./vendor/tex-svg-full.js",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/maskable-512.png",
];
const FONT_CACHE = "sk-fonts";

// Beim Installieren immer frisch vom Server laden, nie aus dem Browser-Zwischenspeicher
// (GitHub Pages erlaubt dort 10 Minuten alte Kopien, sonst landet eine alte Version im Cache).
self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await Promise.all(SHELL.map(async url => {
      const res = await fetch(new Request(url, { cache: "reload" }));
      if (!res.ok) throw new Error("Laden fehlgeschlagen: " + url);
      await cache.put(url, res);
    }));
    await self.skipWaiting();
  })());
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
      fetch(req, { cache: "no-cache" }).then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put("./index.html", copy));
        return res;
      }).catch(() => caches.match("./index.html"))
    );
    return;
  }

  // Übrige Dateien kommen aus dem Cache dieser Version. Sie werden nur beim Installieren
  // einer neuen Version ersetzt, damit nie alte und neue Dateien gemischt werden.
  event.respondWith(caches.open(VERSION).then(async cache => {
    const hit = await cache.match(req);
    if (hit) return hit;
    const res = await fetch(req, { cache: "no-cache" });
    if (res.ok) cache.put(req, res.clone());
    return res;
  }));
});

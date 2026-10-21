// NOIR service worker: caches only the app shell for offline use.
// /api calls and other sites are never cached.
const CACHE = "noir-shell-v3";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/icon-192.png", "/icon-512.png"])).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Same-site GET only; /api and /admin always go straight to the live server
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api") || url.pathname.startsWith("/admin")) return;

  // Pages: live first, saved copy only when offline. Only successful pages are saved.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put("/", copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match("/").then((r) => r || Response.error()))
    );
    return;
  }

  // Icons etc.: saved copy first, otherwise live
  event.respondWith(caches.match(req).then((r) => r || fetch(req)));
});

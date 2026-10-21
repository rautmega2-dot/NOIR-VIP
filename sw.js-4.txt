// NOIR service worker (v4): does not intercept or cache any request.
// Every page and /api call goes straight to the live server.
// On activate it deletes all older saved copies from previous versions.
const VERSION = "noir-sw-v4";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

// Empty handler: keeps the app installable without touching any request
self.addEventListener("fetch", () => {});

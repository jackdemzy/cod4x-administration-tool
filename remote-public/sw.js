// COD4X CONTROL remote app (Block 24b). Caches the app shell only; requests to
// /remote/api/ always go to the network and are never stored.
const CACHE = "cod4x-remote-v1";
const SHELL = ["./", "./manifest.webmanifest", "./icon.svg"];
self.addEventListener("install", event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.includes("/remote/api/")) return;
  if (url.pathname.includes("/assets/")) {
    event.respondWith(caches.match(event.request).then(hit => hit || fetch(event.request).then(response => { if (response.ok) { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy)); } return response; })));
    return;
  }
  // The page itself: network first, the cached shell when offline.
  event.respondWith(fetch(event.request).then(response => { if (response.ok && event.request.mode === "navigate") { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put("./", copy)); } return response; }).catch(() => caches.match(event.request).then(hit => hit || caches.match("./"))));
});

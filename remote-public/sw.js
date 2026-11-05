// COD4X CONTROL remote app (Block 24b). Caches the app shell only; requests to
// /remote/api/ always go to the network and are never stored. Block 24c: shows
// push alerts (server name, state, cause; never console lines).
const CACHE = "cod4x-remote-v2";
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
self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: event.data ? event.data.text() : "COD4X CONTROL" }; }
  const title = String(data.title || "COD4X CONTROL").slice(0, 120);
  event.waitUntil(self.registration.showNotification(title, { body: String(data.body || "").slice(0, 300), tag: data.tag || undefined, renotify: Boolean(data.tag), icon: "./icon.svg", badge: "./icon.svg", timestamp: data.t || Date.now(), data: { url: "./" } }));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    const open = list.find(client => new URL(client.url).pathname.startsWith(new URL("./", self.location).pathname));
    return open ? open.focus() : self.clients.openWindow("./");
  }));
});

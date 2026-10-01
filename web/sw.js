"use strict";
// 由 scripts/build-web.mjs 在构建时替换：缓存名随内容哈希变化，旧缓存会在激活时清理。
const CACHE = "week168-__BUILD_HASH__";
const PRECACHE = __PRECACHE__;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("week168-") && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// 应用完全离线：只处理同源 GET，缓存优先，未命中再走网络。
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      if (request.mode === "navigate") return caches.match("./index.html");
      return fetch(request);
    })
  );
});

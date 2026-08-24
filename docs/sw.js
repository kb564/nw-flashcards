"use strict";
const CACHE_NAME = "nw-flashcards-a541d9f77a37c0b3";
const PRECACHE = ["./assets/index-ByzfwEtw.js","./assets/style-Bjos7jOH.css","./icons/icon-192.png","./icons/icon-512.png","./index.html","./manifest.webmanifest"];
self.skipWaiting();
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== "GET") {
    return;
  }
  const scopeUrl = new URL(self.registration.scope);
  if (!url.pathname.startsWith(scopeUrl.pathname)) {
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const target = event.request.mode === "navigate"
      ? new URL("./index.html", self.registration.scope).href
      : new URL(url.pathname.slice(scopeUrl.pathname.length), self.registration.scope).href;
    return (await cache.match(target, { ignoreSearch: true })) || Response.error();
  })());
});

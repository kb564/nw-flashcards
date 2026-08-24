import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else if (entry.name !== "sw.js") files.push(path);
  }
  return files;
}

const files = await listFiles(dist);
const assets = files.map((path) => `./${relative(dist, path).split("\\").join("/")}`).sort();
const digest = createHash("sha256");
for (const path of files.sort()) digest.update(await readFile(path));
const cacheName = `nw-flashcards-${digest.digest("hex").slice(0, 16)}`;
const source = `"use strict";
const CACHE_NAME = ${JSON.stringify(cacheName)};
const PRECACHE = ${JSON.stringify(assets)};
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
`;
await writeFile(resolve(dist, "sw.js"), source, { encoding: "utf8", mode: 0o644 });

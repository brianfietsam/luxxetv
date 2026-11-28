'use strict';
// Makes LuxxeTV installable and shows a friendly page when the PC cannot be reached.
// Nothing else is cached: the app always loads fresh from the PC, so updates show up at once.
const CACHE = 'luxxetv-offline-v2';
const OFFLINE = '/offline.html';
const KEEP = [OFFLINE, '/icons/icon-192.png'];
const STREAMS = /^\/(api|live|share|rec|dl|vodplay)(\/|$)/;           // video, downloads and data go straight to the network
const UNREACHABLE = (status) => status >= 502 && status <= 530;  // a tunnel answering for a PC that is off

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(KEEP)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || STREAMS.test(url.pathname)) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request)
      .then(async (res) => (UNREACHABLE(res.status) ? (await caches.match(OFFLINE)) || res : res))
      .catch(() => caches.match(OFFLINE)));
  } else if (KEEP.includes(url.pathname)) {
    e.respondWith(fetch(e.request).catch(() => caches.match(url.pathname)));
  }
});

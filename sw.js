// sw.js — Dose Certa
// Responsabilidade: cache, clique em notificação, e comunicação com o app.
// Notificações agendadas são gerenciadas pelo OneSignal (OneSignalSDKWorker.js).

const CACHE_VERSION = '27.04.2026-1739';
const CACHE_NAME    = `dosecerta-${CACHE_VERSION}`;
const ASSETS = [
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// ── Instalação ────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

// ── Ativação ──────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k !== CACHE_NAME && !k.startsWith('onesignal'))
          .map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

// ── Cache-first fetch ─────────────────────────────
self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// ── Clique na notificação ─────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url && c.focus);
      if (existing) return existing.focus();
      return clients.openWindow('./');
    })
  );
});

// ── Mensagens do app ──────────────────────────────
self.addEventListener('message', async e => {
  if (e.data?.type === 'UPDATE_MEDS_DATA') {
    try {
      const cache = await caches.open('dosecerta-data');
      await cache.put('meds-data', new Response(JSON.stringify(e.data.data)));
    } catch(err) {}
  }
  if (e.data?.type === 'GET_MEDS_DATA' && e.ports?.[0]) {
    try {
      const cache  = await caches.open('dosecerta-data');
      const cached = await cache.match('meds-data');
      const data   = cached ? await cached.json() : { meds: [], takenToday: {} };
      e.ports[0].postMessage(data);
    } catch(err) {
      e.ports[0].postMessage({ meds: [], takenToday: {} });
    }
  }
});

const CACHE_VERSION = '24.04.2026-1117';
const CACHE_NAME = `medlembrar-${CACHE_VERSION}`;
const ASSETS = ['./index.html', './manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  e.respondWith(caches.match(e.request).then(cached => cached || fetch(e.request)));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow('./index.html'));
});

// ========== PUSH NOTIFICATIONS (NOVO) ==========
self.addEventListener('push', function(event) {
  if (!event.data) return;
  
  let data = {};
  try {
    data = event.data.json();
  } catch(e) {
    data = { title: '💊 Dose Certa', body: event.data.text() };
  }
  
  const title = data.title || '💊 Hora do remédio';
  const options = {
    body: data.body || 'Está na hora de tomar seu remédio!',
    icon: './icon-192.png',
    badge: './icon-192.png',
    vibrate: [200, 100, 200],
    requireInteraction: true,
    tag: data.tag || 'medication'
  };
  
  event.waitUntil(self.registration.showNotification(title, options));
});

// Para notificações enviadas diretamente do app (fallback)
self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
    event.waitUntil(
      self.registration.showNotification(event.data.title, {
        body: event.data.body,
        icon: './icon-192.png',
        badge: './icon-192.png',
        vibrate: [200, 100, 200],
        requireInteraction: true
      })
    );
  }
});

// sw.js — Dose Certa
// Estratégia: SW é backup quando app está em background.
// O loop principal de alertas roda no index.html (foreground).
// SW cuida de: cache, sync events, e notificações quando acionado.

const CACHE_VERSION = '27.04.2026-1144';
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
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();

    if ('periodicSync' in self.registration) {
      try {
        await self.registration.periodicSync.register('medication-check', {
          minInterval: 60 * 1000
        });
      } catch(e) {}
    }
  })());
});

// ── Cache-first fetch ─────────────────────────────
self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// ── Background Sync ───────────────────────────────
self.addEventListener('sync', e => {
  if (e.tag === 'medication-sync') {
    e.waitUntil(verificarENotificar());
  }
});

// ── Periodic Sync ─────────────────────────────────
self.addEventListener('periodicsync', e => {
  if (e.tag === 'medication-check') {
    e.waitUntil(verificarENotificar());
  }
});

// ── Mensagens do app ──────────────────────────────
self.addEventListener('message', async e => {
  switch(e.data?.type) {
    case 'UPDATE_MEDS_DATA':
      await salvarMedsNoCache(e.data.data);
      break;
    case 'CHECK_MEDS':
      await verificarENotificar();
      break;
  }
});

// ── Clique na notificação ─────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({type:'window', includeUncontrolled:true}).then(list => {
      const existing = list.find(c => c.url && c.focus);
      if(existing) return existing.focus();
      return clients.openWindow('./');
    })
  );
});

// ═══════════════════════════════════════════════════
// FUNÇÕES INTERNAS
// ═══════════════════════════════════════════════════

async function salvarMedsNoCache(data) {
  try {
    const cache = await caches.open('dosecerta-data');
    await cache.put('meds-data', new Response(JSON.stringify(data)));
  } catch(e) {}
}

async function obterMeds() {
  const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for(const client of clientsList) {
    try {
      const res = await new Promise(resolve => {
        const ch = new MessageChannel();
        const t = setTimeout(() => resolve(null), 800);
        ch.port1.onmessage = e => { clearTimeout(t); resolve(e.data); };
        client.postMessage({ type: 'GET_MEDS_DATA' }, [ch.port2]);
      });
      if(res?.meds?.length) return res;
    } catch(err) {}
  }

  try {
    const cache  = await caches.open('dosecerta-data');
    const cached = await cache.match('meds-data');
    if(cached) return await cached.json();
  } catch(e) {}

  return { meds: [], takenToday: {} };
}

async function verificarENotificar() {
  const { meds = [], takenToday = {} } = await obterMeds();
  if(!meds.length) return;

  const agora   = new Date();
  const dataStr = agora.toLocaleDateString('pt-BR');
  const nowM    = agora.getHours() * 60 + agora.getMinutes();

  const notifCache = await caches.open('dosecerta-notifs');

  for(const med of meds) {
    if(!med.times?.length) continue;

    for(const horario of med.times) {
      const [h, m]  = horario.split(':').map(Number);
      const tMin    = h * 60 + m;
      const keyBase = `${med.id}_${horario}_${dataStr}`;

      if(takenToday[`${med.id}_${horario}`]) continue;

      // Aviso antecipado: 8-10 min antes (janela diferente do foreground para evitar duplicata)
      const diffAntes = tMin - nowM;
      if(diffAntes >= 8 && diffAntes <= 10) {
        const k = `sw_pre_${keyBase}`;
        if(!(await notifCache.match(k))) {
          await mostrarNotificacao(
            `⏰ Em ${diffAntes} min — ${med.name}`,
            `Prepare-se: ${med.dose} às ${horario}`,
            `sw_pre_${med.id}_${horario}`
          );
          await notifCache.put(k, new Response('1'));
          setTimeout(() => notifCache.delete(k), 15 * 60 * 1000);
        }
      }

      // Alerta no horário: janela de 0-6 min
      if(nowM >= tMin && nowM <= tMin + 6) {
        const k = `sw_now_${keyBase}`;
        if(!(await notifCache.match(k))) {
          await mostrarNotificacao(
            `💊 Hora do remédio!`,
            `${med.name} — ${med.dose} às ${horario}`,
            `sw_now_${med.id}_${horario}`
          );
          await notifCache.put(k, new Response('1'));
          setTimeout(() => notifCache.delete(k), 10 * 60 * 1000);
        }
      }
    }
  }
}

async function mostrarNotificacao(titulo, corpo, tag) {
  if(!self.registration?.showNotification) return;
  try {
    await self.registration.showNotification(titulo, {
      body: corpo,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      vibrate: [200, 100, 200, 100, 200],
      requireInteraction: true,
      tag,
      renotify: false,
      silent: false
    });
  } catch(err) {
    console.error('[SW] Erro ao mostrar notificação:', err);
  }
}

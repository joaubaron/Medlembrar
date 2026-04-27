const CACHE_VERSION = '27.04.2026-1146';
const CACHE_NAME    = `dosecerta-${CACHE_VERSION}`;
const ASSETS = [
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// Configurações
const ALERTA_ANTECIPADO_MIN = 10;
const JANELA_NOTIF_MIN = 6;

// ── Instalação ────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ── Ativação ──────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    // Limpar caches antigos
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    
    // Tomar controle imediato
    await self.clients.claim();
    
    // Inicializar IndexedDB
    await abrirDB();
    
    // Registrar periodic sync (Android)
    if ('periodicSync' in self.registration) {
      try {
        const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
        if (status.state === 'granted') {
          await self.registration.periodicSync.register('medication-check', {
            minInterval: 15 * 60 * 1000 // 15 minutos (mínimo respeitado pelo browser)
          });
          console.log('[SW] PeriodicSync registrado');
        }
      } catch(e) {
        console.log('[SW] PeriodicSync não suportado:', e);
      }
    }
    
    // Tentar usar Notification Triggers API (alarmes exatos)
    await agendarAlarmesDoBanco();
  })());
});

// ── Fetch (cache-first) ───────────────────────────
self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// ── Background Sync (quando voltar online) ────────
self.addEventListener('sync', e => {
  if (e.tag === 'medication-sync') {
    e.waitUntil(verificarENotificar());
  }
});

// ── Periodic Sync (Android) ───────────────────────
self.addEventListener('periodicsync', e => {
  if (e.tag === 'medication-check') {
    e.waitUntil(verificarENotificar());
  }
});

// ── Push (notificação remota) ─────────────────────
self.addEventListener('push', e => {
  e.waitUntil(verificarENotificar());
});

// ── Mensagens do app ──────────────────────────────
self.addEventListener('message', async e => {
  switch(e.data?.type) {
    case 'UPDATE_MEDS_DATA':
      await salvarMedsNoIndexedDB(e.data.data);
      await reagendarAlarmes(e.data.data);
      break;
    case 'CHECK_MEDS':
      await verificarENotificar();
      break;
    case 'GET_MEDS_DATA':
      if (e.ports?.[0]) {
        const data = await obterMedsDoIndexedDB();
        e.ports[0].postMessage(data);
      }
      break;
  }
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

// ═══════════════════════════════════════════════════
// INDEXEDDB — Persistência principal
// ═══════════════════════════════════════════════════

let db = null;

function abrirDB() {
  return new Promise((resolve, reject) => {
    if (db && db.name === 'DoseCertaDB') return resolve(db);
    
    const request = indexedDB.open('DoseCertaDB', 2);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };
    
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      const oldVersion = e.oldVersion;
      
      if (!db.objectStoreNames.contains('medsData')) {
        db.createObjectStore('medsData', { keyPath: 'id' });
      }
      
      if (!db.objectStoreNames.contains('alarms') && oldVersion < 2) {
        db.createObjectStore('alarms', { keyPath: 'id' });
      }
    };
  });
}

async function salvarMedsNoIndexedDB(data) {
  try {
    await abrirDB();
    const tx = db.transaction('medsData', 'readwrite');
    const store = tx.objectStore('medsData');
    
    await store.put({
      id: 'current',
      meds: data.meds || [],
      takenToday: data.takenToday || {},
      updatedAt: Date.now()
    });
    
    await tx.done;
    console.log('[SW] Dados salvos no IndexedDB');
  } catch(e) {
    console.error('[SW] Erro ao salvar IndexedDB:', e);
  }
}

async function obterMedsDoIndexedDB() {
  try {
    await abrirDB();
    const tx = db.transaction('medsData', 'readonly');
    const store = tx.objectStore('medsData');
    const result = await store.get('current');
    
    if (result && result.meds) {
      return {
        meds: result.meds,
        takenToday: result.takenToday || {}
      };
    }
  } catch(e) {
    console.error('[SW] Erro ao ler IndexedDB:', e);
  }
  
  return { meds: [], takenToday: {} };
}

// ═══════════════════════════════════════════════════
// NOTIFICATION TRIGGERS API (ALARMES EXATOS - ANDROID)
// ═══════════════════════════════════════════════════

async function agendarAlarmesDoBanco() {
  if (!('Notification' in self) || !('showTrigger' in Notification.prototype)) {
    console.log('[SW] Notification Triggers API não suportada');
    return;
  }
  
  const { meds = [], takenToday = {} } = await obterMedsDoIndexedDB();
  if (!meds.length) return;
  
  const agora = new Date();
  const hojeStr = agora.toLocaleDateString('pt-BR');
  
  for (const med of meds) {
    if (med.freq === 'asneeded') continue;
    
    for (const horario of (med.times || [])) {
      const [h, m] = horario.split(':').map(Number);
      const dataAlarme = new Date(agora);
      dataAlarme.setHours(h, m, 0, 0);
      
      // Se o horário já passou hoje, agendar para amanhã
      if (dataAlarme < agora) {
        dataAlarme.setDate(dataAlarme.getDate() + 1);
      }
      
      const key = `${med.id}_${horario}`;
      if (takenToday[key]) continue;
      
      // Agendar alarme para o horário exato
      const trigger = new TimestampTrigger(dataAlarme.getTime());
      const tag = `alarme_${med.id}_${horario}`;
      
      try {
        await self.registration.showNotification(`⏰ Alarme: ${med.name}`, {
          body: `${med.dose} às ${horario}`,
          icon: './icons/icon-192.png',
          tag: tag,
          renotify: false,
          silent: false,
          vibrate: [200, 100, 200],
          requireInteraction: true,
          showTrigger: trigger
        });
        console.log(`[SW] Alarme agendado: ${med.name} às ${horario}`);
      } catch(e) {
        console.log(`[SW] Falha ao agendar alarme: ${e.message}`);
      }
    }
  }
}

async function reagendarAlarmes(data) {
  if (!('Notification' in self) || !('showTrigger' in Notification.prototype)) return;
  
  // Cancelar alarmes existentes (não há API direta, então agendamos novos)
  await agendarAlarmesDoBanco();
}

// ═══════════════════════════════════════════════════
// VERIFICAÇÃO PRINCIPAL
// ═══════════════════════════════════════════════════

async function verificarENotificar() {
  console.log('[SW] Verificando notificações...', new Date().toLocaleTimeString());
  
  const { meds = [], takenToday = {} } = await obterMedsDoIndexedDB();
  
  if (!meds.length) {
    console.log('[SW] Nenhum medicamento cadastrado');
    return;
  }
  
  console.log(`[SW] Verificando ${meds.length} medicamentos`);

  const agora = new Date();
  const dataStr = agora.toLocaleDateString('pt-BR');
  const nowM = agora.getHours() * 60 + agora.getMinutes();
  
  const notifCache = await caches.open('dosecerta-notifs');

  for (const med of meds) {
    if (!med.times?.length) continue;

    for (const horario of med.times) {
      const [h, m] = horario.split(':').map(Number);
      const tMin = h * 60 + m;
      const keyBase = `${med.id}_${horario}_${dataStr}`;
      const takenKey = `${med.id}_${horario}`;

      // Pular se já tomou
      if (takenToday[takenKey]) continue;

      // Aviso antecipado: 8-12 min antes
      const diffAntes = tMin - nowM;
      if (diffAntes >= 8 && diffAntes <= 12) {
        const cacheKey = `sw_pre_${keyBase}`;
        if (!(await notifCache.match(cacheKey))) {
          console.log(`[SW] ⏰ Antecipado: ${med.name} em ${diffAntes}min`);
          await mostrarNotificacao(
            `⏰ Em ${diffAntes} min — ${med.name}`,
            `Prepare-se: ${med.dose} às ${horario}`,
            `pre_${med.id}_${horario}`
          );
          await notifCache.put(cacheKey, new Response('1'));
          setTimeout(() => notifCache.delete(cacheKey), 15 * 60 * 1000);
        }
      }

      // Alerta no horário
      if (nowM >= tMin && nowM <= tMin + JANELA_NOTIF_MIN) {
        const cacheKey = `sw_now_${keyBase}`;
        if (!(await notifCache.match(cacheKey))) {
          console.log(`[SW] 💊 Agora: ${med.name} às ${horario}`);
          await mostrarNotificacao(
            `💊 Hora do remédio!`,
            `${med.name} — ${med.dose} às ${horario}`,
            `now_${med.id}_${horario}`
          );
          await notifCache.put(cacheKey, new Response('1'));
          setTimeout(() => notifCache.delete(cacheKey), 10 * 60 * 1000);
        }
      }
    }
  }
}

async function mostrarNotificacao(titulo, corpo, tag) {
  if (!self.registration?.showNotification) return;
  
  try {
    await self.registration.showNotification(titulo, {
      body: corpo,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      vibrate: [200, 100, 200, 100, 200],
      requireInteraction: true,
      tag: tag,
      renotify: false,
      silent: false,
      priority: 'high'
    });
  } catch(err) {
    console.error('[SW] Erro ao mostrar notificação:', err);
  }
}

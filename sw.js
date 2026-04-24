const CACHE_VERSION = '24.04.2026-1401';
const CACHE_NAME = `dosecerta-${CACHE_VERSION}`;
const ASSETS = [
'./index.html',
'./manifest.json',
'./icons/icon-192.png',
'./icons/icon-512.png'
];

// Instalação
self.addEventListener('install', e => {
e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
self.skipWaiting();
});

// Ativação - limpa caches antigos + agenda alarmes
self.addEventListener('activate', e => {
e.waitUntil(async () => {
// Limpa caches antigos
const keys = await caches.keys();
await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));

// Agenda alarmes para todos os horários se suportado
if ('alarms' in self) {
await agendarTodosAlarmes();
}

await self.clients.claim();
}());
});

// Busca em cache
self.addEventListener('fetch', e => {
e.respondWith(caches.match(e.request).then(cached => cached || fetch(e.request)));
});

// Alarme disparado (para navegadores que suportam)
self.addEventListener('alarm', e => {
console.log('🔔 Alarme disparado:', e);
const { medId, medName, dose, horario } = e.detail || {};
if (medId && medName) {
mostrarNotificacao(medName, dose, horario);
} else {
verificarHorariosPendentes();
}
});

// Sincronização em segundo plano
self.addEventListener('sync', e => {
if (e.tag === 'medication-sync') {
e.waitUntil(verificarHorariosPendentes());
}
});

// Sincronização periódica
self.addEventListener('periodicsync', e => {
if (e.tag === 'medication-periodic') {
e.waitUntil(verificarHorariosPendentes());
}
});

// Mensagem do app principal
self.addEventListener('message', async e => {
if (e.data?.type === 'CHECK_MEDS') {
await verificarHorariosPendentes();
}
if (e.data?.type === 'SCHEDULE_ALARMS') {
await agendarTodosAlarmes();
}
});

// Clique na notificação
self.addEventListener('notificationclick', e => {
e.notification.close();
e.waitUntil(clients.openWindow('.'));
});

// ============ FUNÇÕES PRINCIPAIS ============

async function verificarHorariosPendentes() {
console.log('🔍 Verificando horários pendentes...');

let meds = [];
let takenToday = {};

const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
for (const client of clientsList) {
try {
const response = await new Promise(resolve => {
const channel = new MessageChannel();
channel.port1.onmessage = e => resolve(e.data);
client.postMessage({ type: 'GET_MEDS_DATA' }, [channel.port2]);
setTimeout(() => resolve(null), 500);
});
if (response) {
meds = response.meds || [];
takenToday = response.takenToday || {};
break;
}
} catch (err) {
console.warn('Erro ao buscar dados:', err);
}
}

if (!meds.length) {
console.log('Nenhum medicamento encontrado');
return;
}

const agora = new Date();
const hojeStr = agora.toLocaleDateString('pt-BR');
const agoraMinutes = agora.getHours() * 60 + agora.getMinutes();

for (const med of meds) {
const times = med.times || [];
for (const horario of times) {
const key = `${med.id}_${horario}`;

if (takenToday[key]) continue;

const [h, m] = horario.split(':').map(Number);
const tMinutes = h * 60 + m;

if (tMinutes <= agoraMinutes && tMinutes + 5 >= agoraMinutes) {
await mostrarNotificacao(med.name, med.dose, horario);

const notifiedKey = `notified_${key}_${hojeStr}`;
const cache = await caches.open('notifications-cache');
const alreadyNotified = await cache.match(notifiedKey);
if (!alreadyNotified) {
 await cache.put(notifiedKey, new Response('true'));
}
}
}
}
}

async function agendarTodosAlarmes() {
if (!('alarms' in self)) {
console.log('⏰ Alarm API não suportada');
if ('periodicSync' in self.registration) {
try {
await self.registration.periodicSync.register('medication-periodic', {
 minInterval: 15 * 60 * 1000
});
console.log('✅ Sincronização periódica registrada');
} catch (e) {
console.log('Periodic sync não disponível');
}
}
return;
}

let meds = [];
const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
for (const client of clientsList) {
try {
const response = await new Promise(resolve => {
const channel = new MessageChannel();
channel.port1.onmessage = e => resolve(e.data);
client.postMessage({ type: 'GET_MEDS_DATA' }, [channel.port2]);
setTimeout(() => resolve(null), 500);
});
if (response) {
meds = response.meds || [];
break;
}
} catch (err) {}
}

const existingAlarms = await self.alarms.getAll();
for (const alarm of existingAlarms) {
await self.alarms.clear(alarm.name);
}

const agora = new Date();

for (const med of meds) {
for (const horario of med.times || []) {
const [h, m] = horario.split(':').map(Number);
const alarmTime = new Date();
alarmTime.setHours(h, m, 0, 0);

if (alarmTime <= agora) {
alarmTime.setDate(alarmTime.getDate() + 1);
}

const delay = alarmTime.getTime() - agora.getTime();
const alarmName = `${med.id}_${horario}`;

await self.alarms.create(alarmName, {
when: Date.now() + delay,
periodInMinutes: 1440
});

console.log(`⏰ Alarme agendado: ${med.name} às ${horario}`);
}
}

console.log('✅ Todos os alarmes foram agendados!');
}

async function mostrarNotificacao(nome, dose, horario) {
const agora = new Date();
const minuteKey = `${nome}_${horario}_${agora.toISOString().slice(0, 16)}`;
const cache = await caches.open('notifications-cache');
const jaNotificado = await cache.match(minuteKey);

if (!jaNotificado && self.registration.showNotification) {
await self.registration.showNotification('💊 Hora do remédio!', {
body: `${nome} — ${dose} às ${horario}`,
icon: './icons/icon-192.png',
badge: './icons/icon-192.png',
vibrate: [200, 100, 200],
requireInteraction: true,
tag: minuteKey,
data: { nome, dose, horario }
});

await cache.put(minuteKey, new Response('true'));
setTimeout(() => cache.delete(minuteKey), 120000);
}
}

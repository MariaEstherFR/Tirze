// Service worker: recibe las notificaciones push y abre la app al tocarlas.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let datos = {};
  try { datos = e.data ? e.data.json() : {}; } catch (_) { datos = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(datos.title || 'TirzeControl', {
    body: datos.body || '',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: 'aviso-diario',
    data: { url: datos.url || './' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const destino = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ventanas) => {
    for (const v of ventanas) if ('focus' in v) return v.focus();
    return self.clients.openWindow(destino);
  }));
});

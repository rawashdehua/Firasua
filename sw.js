'use strict';
/* يخزّن ملفات التطبيق ومكتبة PeerJS ليعمل التطبيق وتفتح واجهته بدون إنترنت */
const CACHE = 'tawasol-v21';
const SHELL = ['./', 'index.html', 'style.css', 'store.js', 'net.js', 'room.js', 'relay.js', 'voice.js', 'call.js', 'ui-voice.js', 'ui-call.js', 'ui-core.js', 'ui-lock.js', 'ui-chat.js', 'ui-settings.js', 'ui-boot.js', 'manifest.json', 'icon-192.png', 'icon-512.png'];
const LIB = /peerjs(\.min)?\.js(\?.*)?$/;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isLib = LIB.test(url.pathname);
  if (url.origin !== location.origin && !isLib) return; // لا نتدخل في اتصال PeerJS بالخادم
  e.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req).then(res => {
        if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});

/* إشعار دفع فارغ المحتوى من خادم الاحتفاظ: نعرض تنبيهاً عاماً إلا إن كان التطبيق ظاهراً أمام المستخدم */
self.addEventListener('push', e => {
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    if (cs.some(c => c.visibilityState === 'visible')) return;
    return self.registration.showNotification('رسالة جديدة', {
      body: 'افتح التطبيق لقراءتها', tag: 'pc-push', renotify: true, icon: 'icon-192.png', badge: 'icon-192.png', lang: 'ar', dir: 'rtl'
    });
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(cs => (cs[0] ? cs[0].focus() : self.clients.openWindow('./'))));
});

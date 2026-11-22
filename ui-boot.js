'use strict';
/* ===== واجهة التطبيق — الإقلاع ===== */
(() => {
  const U = PC.ui;
  const $ = id => document.getElementById(id);
  const { N, me, roomStore, keyStore, recent, roomName } = U;
  const askPin = (...a) => U.askPin(...a);   // من ملف آخر
  const showLock = (...a) => U.showLock(...a);   // من ملف آخر
  const enter = (...a) => U.enter(...a);   // من ملف آخر

  /* ---- الإقلاع ---- */
  (async () => {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    me.id = PC.ls.get('device') || PC.rand(10); PC.ls.set('device', me.id);
    const qn = new URLSearchParams(location.search).get('n');          // رابط شخصي: index.html?n=فراس
    if (qn && qn.trim()) PC.ls.set('name', N.cleanName(qn));
    const qr = new URLSearchParams(location.search).get('relay');       // رابط الخادم يُحفظ تلقائياً: index.html?relay=https://...workers.dev
    if (qr && PC.relay.valid(qr.trim())) { PC.relay.set(qr); try { history.replaceState(null, '', location.pathname); } catch {} }
    me.name = PC.ls.get('name') || '';
    try { await PC.openDB(); } catch { return showLock('المتصفح لا يدعم التخزين المحلي المطلوب'); }
    if (PC.vault.enabled()) await askPin();
    let rid = roomStore.get(); PC.relay.use(keyStore.get());
    if (!(rid && roomName(rid)) && PC.AUTO_ROOM && PC.ROOMS[PC.AUTO_ROOM] && PC.ls.get('noauto') !== '1') rid = PC.AUTO_ROOM;
    if (!(rid && roomName(rid)) && PC.ls.get('noauto') !== '1') {          // فتح آخر غرفة مستخدمة تلقائياً
      const last = recent.get(PC.ls.get('last'));
      if (last && roomName(last.rid)) { rid = last.rid; keyStore.set(last.rk); PC.relay.use(last.rk); }
    }
    if (rid && roomName(rid)) {
      if (!me.name) { me.name = 'جهاز ' + me.id.slice(0, 4); PC.ls.set('name', me.name); }
      roomStore.set(rid); enter(rid);
    } else showLock();
  })();

})();

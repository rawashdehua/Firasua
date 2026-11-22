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
    /* نافذتان/تبويبان في نفس المتصفح تتشاركان نفس معرّف الجهاز فتتعارضان ولا تتصلان ببعضهما:
       من يجد المعرّف محجوزاً من تبويب آخر يأخذ معرّفاً خاصاً بتبويبه (يبقى عند إعادة التحميل). */
    me.second = false;
    try {
      if (navigator.locks) {
        const got = await new Promise(res => navigator.locks.request('pc-dev-' + me.id, { ifAvailable: true }, lock => { res(!!lock); return lock ? new Promise(() => {}) : undefined; }));
        if (!got) {
          let t = sessionStorage.getItem('pc_tabid');
          if (!t) { t = PC.rand(10); sessionStorage.setItem('pc_tabid', t); }
          me.id = t; me.second = true;
          navigator.locks.request('pc-dev-' + me.id, { ifAvailable: true }, lock => lock ? new Promise(() => {}) : undefined);
        }
      }
    } catch {}
    const qn = new URLSearchParams(location.search).get('n');          // رابط شخصي: index.html?n=فراس
    if (qn && qn.trim()) PC.ls.set('name', N.cleanName(qn));
    const qr = new URLSearchParams(location.search).get('relay');       // رابط الخادم يُحفظ تلقائياً: index.html?relay=https://...workers.dev
    if (qr && PC.relay.valid(qr.trim())) { PC.relay.set(qr); try { history.replaceState(null, '', location.pathname); } catch {} }
    me.name = PC.ls.get('name') || '';
    if (me.second) me.name = N.cleanName((me.name || 'جهاز') + ' ٢');
    try { await PC.openDB(); } catch { return showLock('المتصفح لا يدعم التخزين المحلي المطلوب'); }
    if (PC.vault.enabled()) await askPin();
    let rid = roomStore.get(); PC.relay.use(keyStore.get());
    if (!(rid && roomName(rid)) && PC.AUTO_ROOM && PC.ROOMS[PC.AUTO_ROOM] && PC.ls.get('noauto') !== '1') rid = PC.AUTO_ROOM;
    if (!(rid && roomName(rid)) && PC.ls.get('noauto') !== '1') {          // فتح آخر غرفة مستخدمة تلقائياً
      const last = recent.get(PC.ls.get('last'));
      if (last && roomName(last.rid)) { rid = last.rid; keyStore.set(last.rk); PC.relay.use(last.rk); }
    }
    if (rid && roomName(rid)) {
      if (!me.name) { me.name = 'جهاز ' + me.id.slice(0, 4); if (!me.second) PC.ls.set('name', me.name); }
      roomStore.set(rid); enter(rid);
    } else showLock();
  })();

})();

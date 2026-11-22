'use strict';
/* ===== واجهة التطبيق — الدخول وقفل التطبيق وتثبيت التطبيق ===== */
(() => {
  const U = PC.ui;
  const $ = id => document.getElementById(id);
  const { N, S, me, roomStore, keyStore, myRooms, recent, roomName } = U;
  const renderAll = (...a) => U.renderAll(...a);   // من ملف آخر
  const schedule = (...a) => U.schedule(...a);   // من ملف آخر
  const purgeOld = (...a) => U.purgeOld(...a);   // من ملف آخر

  /* ---- قفل التطبيق ---- */
  let pinTries = 0, pinBlockedUntil = 0, pinResolve = null, hiddenAt = 0;
  const lockDelay = () => +PC.ls.get('lockdelay', '60000');
  const showPinErr = t => { const e = $('pinErr'); e.textContent = t; e.hidden = false; };
  function showPin() {
    S.gate = true; $('pinlock').hidden = false; $('pinIn').value = ''; $('pinErr').hidden = true;
    $('sheet').hidden = true; $('msgSheet').hidden = true;
    setTimeout(() => $('pinIn').focus(), 50);
  }
  const askPin = () => new Promise(res => { pinResolve = res; showPin(); });
  const lockNow = () => { if (PC.vault.enabled() && PC.vault.key && !S.gate) showPin(); };
  async function tryPin() {
    if (Date.now() < pinBlockedUntil) return showPinErr('محاولات كثيرة، انتظر ' + Math.ceil((pinBlockedUntil - Date.now()) / 1000) + ' ثانية');
    const p = $('pinIn').value; if (!p) return;
    $('btnPinOk').disabled = true;
    const ok = await PC.vault.unlock(p);
    $('btnPinOk').disabled = false;
    if (!ok) { if (++pinTries >= 5) { pinTries = 0; pinBlockedUntil = Date.now() + 30000; } return showPinErr('الرمز غير صحيح'); }
    pinTries = 0; $('pinlock').hidden = true; S.gate = false;
    const r = pinResolve; pinResolve = null; if (r) r(); else schedule();
  }
  $('btnPinOk').onclick = tryPin;
  $('pinIn').addEventListener('keydown', e => { if (e.key === 'Enter') tryPin(); });
  $('btnPinForgot').onclick = async () => {
    if (!confirm('سيُمسح كل ما على هذا الجهاز (الرسائل والإعدادات) ولا يمكن استرجاعه. متابعة؟')) return;
    N.stop(); await PC.vault.wipeAll(); location.reload();
  };

  /* ---- شاشة الدخول ---- */
  function showLock(msg) {
    $('app').hidden = true; $('lock').hidden = false;
    $('inName').value = me.name; $('inCode').value = ''; if (S.adding) setAdding(false);
    const e = $('lockErr'); e.hidden = !msg; e.textContent = msg || '';
    $('chkRemember').checked = PC.ls.get('remember') !== '0';
    renderRecent();
  }
  function renderRecent() {
    const ul = $('recentList'); ul.textContent = '';
    const items = recent.list().filter(x => roomName(x.rid));
    $('recentBox').hidden = !items.length;
    for (const it of items) {
      const li = document.createElement('li'), nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = roomName(it.rid);
      const x = document.createElement('button'); x.type = 'button'; x.className = 'x'; x.textContent = '✕'; x.setAttribute('aria-label', 'نسيان الغرفة');
      x.onclick = ev => { ev.stopPropagation(); if (confirm('نسيان هذه الغرفة على هذا الجهاز؟ (الرسائل المحفوظة تبقى، ويلزم الكود للدخول مجدداً)')) { recent.del(it.rid); renderRecent(); } };
      li.onclick = () => joinRecent(it);
      li.append(nm, x); ul.appendChild(li);
    }
  }
  async function joinRecent(it) {
    const name = N.cleanName($('inName').value) || me.name;
    if (!name) return showErr('اكتب اسماً لهذا الجهاز');
    me.name = name; PC.ls.set('name', name); PC.ls.del('noauto');
    roomStore.set(it.rid); keyStore.set(it.rk); PC.relay.use(it.rk); recent.add(it.rid, it.rk);
    enter(it.rid);
  }

  async function join() {
    const name = N.cleanName($('inName').value), code = $('inCode').value.trim();
    if (Date.now() < S.lockedUntil) return showErr('محاولات كثيرة، انتظر قليلاً ثم أعد المحاولة');
    if (!$('inName').value.trim()) return showErr('اكتب اسماً لهذا الجهاز');
    if (!code) return showErr('أدخل كود الغرفة');
    const rid = await PC.roomIdFor(code);
    if (S.adding) {
      if (!/^\d{8}$/.test(code)) return showErr('كود الغرفة الجديدة يجب أن يكون 8 أرقام بالضبط');
      if (!roomName(rid)) { if ($('selRole').value === 'create') PC.room.markHost(rid); const o = myRooms.get(); o[rid] = N.cleanName($('inRoomName').value) || ('غرفة ' + (Object.keys(o).length + 1)); myRooms.set(o); }
    } else if (!roomName(rid)) {
      if (++S.fails >= 5) { S.lockedUntil = Date.now() + 30000; S.fails = 0; }
      return showErr('الكود غير مسجّل. لإنشاء غرفة بكود جديد اضغط «إضافة غرفة جديدة».');
    }
    S.fails = 0; me.name = name;
    PC.ls.set('name', name); roomStore.set(rid); PC.ls.del('noauto');
    const rk = await PC.relay.derive(code); keyStore.set(rk); PC.relay.use(rk);
    if ($('chkRemember').checked) { PC.ls.del('remember'); recent.add(rid, rk); } else { PC.ls.set('remember', '0'); recent.del(rid); }
    enter(rid);
  }
  const showErr = t => { const e = $('lockErr'); e.textContent = t; e.hidden = false; };

  async function enter(rid) {
    $('lock').hidden = true; $('app').hidden = false;
    $('roomTitle').textContent = roomName(rid);
    S.view = '*'; S.unread = {}; S.sys = [];
    S.msgs = await PC.roomMsgs(rid);
    renderAll();
    await N.start(rid, me);
    await PC.room.boot().catch(() => {});
    renderAll(); purgeOld().catch(() => {});
  }

  /* ---- تثبيت التطبيق ---- */
  let deferred = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; $('btnInstall').hidden = false; });
  $('btnInstall').onclick = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $('btnInstall').hidden = true; };
  window.addEventListener('appinstalled', () => ($('btnInstall').hidden = true));
  if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !navigator.standalone) $('iosHint').hidden = false;

  /* ---- إيقاظ الاتصال عند العودة للتطبيق/الشبكة ---- */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); if (PC.vault.enabled() && lockDelay() === 0) lockNow(); return; }
    if (PC.vault.enabled() && hiddenAt && Date.now() - hiddenAt >= lockDelay()) lockNow();
    hiddenAt = 0; S.unread[S.view] = 0; N.wake(); schedule();
  });
  window.addEventListener('online', () => N.wake());

  $('btnJoin').onclick = join;
  function setAdding(on) {
    S.adding = !!on; $('addBox').hidden = !on;
    $('btnAddRoom').textContent = on ? '← رجوع للدخول بكود موجود' : '＋ إضافة غرفة جديدة';
    $('btnJoin').textContent = on ? 'إنشاء الغرفة والاتصال' : 'اتصال';
    $('inCode').placeholder = on ? '8 أرقام' : '••••••••';
    const e = $('lockErr'); e.hidden = true;
  }
  $('btnAddRoom').onclick = () => setAdding(!S.adding);
  $('inCode').addEventListener('keydown', e => { if (e.key === 'Enter') join(); });

  Object.assign(U, { askPin, enter, lockNow, showLock });
})();

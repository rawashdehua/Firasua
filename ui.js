'use strict';
/* ===== الواجهة ===== */
(() => {
  const N = PC.net;
  const $ = id => document.getElementById(id);
  const S = { view: '*', msgs: [], sys: [], unread: {}, raf: 0, fails: 0, lockedUntil: 0 };
  const me = { id: '', name: '' };

  /* ---- مساعدات ---- */
  const toast = (t, ms = 2600) => {
    const el = $('toast'); el.textContent = t; el.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), ms);
  };
  const fmtTime = ts => {
    const d = new Date(ts), now = new Date();
    const t = d.toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === now.toDateString() ? t : d.toLocaleDateString('ar', { day: 'numeric', month: 'short' }) + ' ' + t;
  };
  const nameOf = id => {
    const st = N.conns.get(id), k = N.contacts.get(id);
    return (st && st.name) || (k && k.name) || 'جهاز';
  };
  const addSys = (text, cls = '') => { S.sys.push({ sys: true, ts: Date.now(), text, cls }); S.sys = S.sys.slice(-60); schedule(); };

  /* ---- شاشة الدخول ---- */
  function showLock(msg) {
    $('app').hidden = true; $('lock').hidden = false;
    $('inName').value = me.name; $('inCode').value = '';
    const e = $('lockErr'); e.hidden = !msg; e.textContent = msg || '';
  }

  async function join() {
    const name = N.cleanName($('inName').value), code = $('inCode').value.trim();
    if (Date.now() < S.lockedUntil) return showErr('محاولات كثيرة، انتظر قليلاً ثم أعد المحاولة');
    if (!$('inName').value.trim()) return showErr('اكتب اسماً لهذا الجهاز');
    if (!code) return showErr('أدخل كود الغرفة');
    const rid = await PC.roomIdFor(code);
    if (!PC.ROOMS[rid]) {
      if (++S.fails >= 5) { S.lockedUntil = Date.now() + 30000; S.fails = 0; }
      return showErr('الكود غير صحيح');
    }
    S.fails = 0; me.name = name;
    PC.ls.set('name', name); PC.ls.set('room', rid);
    enter(rid);
  }
  const showErr = t => { const e = $('lockErr'); e.textContent = t; e.hidden = false; };

  async function enter(rid) {
    $('lock').hidden = true; $('app').hidden = false;
    $('roomTitle').textContent = PC.ROOMS[rid];
    S.view = '*'; S.unread = {}; S.sys = [];
    S.msgs = await PC.roomMsgs(rid);
    renderAll();
    await N.start(rid, me);
    renderAll();
  }

  /* ---- الحالة ---- */
  function renderStatus() {
    const el = $('netState');
    let txt, cls = '';
    if (N.libFail) { txt = 'تعذّر تحميل مكتبة الاتصال — تحقق من الإنترنت'; cls = 'off'; }
    else if (!N.libOk) { txt = 'جارٍ تحميل مكتبة الاتصال…'; }
    else if (!N.serverOk) { txt = 'جارٍ الاتصال بالخادم…'; }
    else if (N.conns.size === 0) { txt = 'جاهز — بانتظار الطرف الآخر'; }
    else { txt = 'متصل مع: ' + N.onlineList().map(x => x.name).join('، '); cls = 'on'; }
    el.textContent = txt; el.className = 'state ' + cls;
  }

  /* ---- الشرائح ---- */
  function renderChips() {
    const box = $('chips'); box.textContent = '';
    const mk = (key, label, online) => {
      const b = document.createElement('button'); b.type = 'button';
      b.className = 'chip' + (S.view === key ? ' active' : '');
      if (key !== '*') { const d = document.createElement('span'); d.className = 'dot' + (online ? ' on' : ''); b.appendChild(d); }
      b.appendChild(document.createTextNode(label));
      if (S.unread[key]) { const u = document.createElement('span'); u.className = 'badge'; u.textContent = S.unread[key]; b.appendChild(u); }
      b.onclick = () => { S.view = key; S.unread[key] = 0; renderAll(); };
      box.appendChild(b);
    };
    mk('*', 'الجميع', false);
    [...N.contacts.values()].filter(c => !c.blocked)
      .sort((a, b) => (N.conns.has(b.id) - N.conns.has(a.id)) || a.name.localeCompare(b.name, 'ar'))
      .forEach(c => mk(c.id, nameOf(c.id), N.conns.has(c.id)));
  }

  /* ---- الرسائل ---- */
  const visible = m => {
    if (m.sys) return true;
    if (S.view === '*') return m.to === '*';
    return (m.from === me.id && m.to === S.view) || (m.from === S.view && m.to === me.id);
  };

  function statusOf(m) {
    const n = Object.keys(m.acks || {}).length;
    if (m.to === '*') return n ? ['✓✓ تم التسليم' + (n > 1 ? ' (' + n + ')' : ''), 'ok'] : ['🕓 بانتظار اتصال الطرف الآخر', 'wait'];
    return m.acks && m.acks[m.to] ? ['✓✓ تم التسليم', 'ok'] : ['🕓 بانتظار اتصال الطرف الآخر', 'wait'];
  }

  function renderList() {
    const list = $('list');
    const stick = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    const items = S.msgs.concat(S.sys).filter(visible).sort((a, b) => a.ts - b.ts).slice(-300);
    list.textContent = '';
    if (!items.length) {
      const e = document.createElement('div'); e.className = 'empty';
      e.textContent = S.view === '*' ? 'لا رسائل بعد. اكتب رسالة وستُحفظ على جهازك حتى يتصل الطرف الآخر.' : 'لا رسائل مع هذا الجهاز بعد.';
      list.appendChild(e); return;
    }
    for (const m of items) {
      const el = document.createElement('div');
      if (m.sys) { el.className = 'msg sys ' + m.cls; el.textContent = m.text; list.appendChild(el); continue; }
      const mine = m.from === me.id;
      el.className = 'msg' + (mine ? ' me' : '');
      if (!mine) { const w = document.createElement('div'); w.className = 'who'; w.textContent = m.fromName || nameOf(m.from); el.appendChild(w); }
      const t = document.createElement('div'); t.textContent = m.text; el.appendChild(t);
      const meta = document.createElement('div'); meta.className = 'meta';
      const tm = document.createElement('span'); tm.textContent = fmtTime(m.ts); meta.appendChild(tm);
      if (mine) { const [txt, cls] = statusOf(m); const s = document.createElement('span'); s.className = cls; s.textContent = txt; meta.appendChild(s); }
      el.appendChild(meta); list.appendChild(el);
    }
    if (stick) list.scrollTop = list.scrollHeight;
  }

  function renderAll() { renderStatus(); renderChips(); renderList(); }
  function schedule() { if (!S.raf) S.raf = requestAnimationFrame(() => { S.raf = 0; renderAll(); }); }

  /* ---- أحداث الشبكة ---- */
  N.on('status', schedule);
  N.on('presence', schedule);
  N.on('contacts', () => { schedule(); if (!$('sheet').hidden) renderContacts(); });
  N.on('locked', () => addSys('الغرفة مقفلة من الطرف الآخر ولا تقبل أجهزة جديدة', 'warn'));
  N.on('sys', (t, c) => addSys(t, c));
  N.on('online', ({ id, name, isNew }) => {
    addSys('✅ ' + name + ' متصل الآن — أنتما متصلان', '');
    if (isNew) addSys('⚠ جهاز جديد انضم: ' + name + '. إن لم تكن تعرفه فاحظره من الإعدادات.', 'warn');
    toast(name + ' متصل الآن');
  });
  N.on('offline', ({ name }) => addSys('⛔ ' + name + ' انقطع اتصاله', ''));
  N.on('ack', m => { const i = S.msgs.findIndex(x => x.id === m.id); if (i >= 0) S.msgs[i] = m; schedule(); });
  N.on('msg', m => {
    S.msgs.push(m);
    if (m.from !== me.id) {
      const key = m.to === '*' ? '*' : m.from;
      if (S.view !== key || document.hidden) { S.unread[key] = (S.unread[key] || 0) + 1; }
      if (S.view === key && !document.hidden) S.unread[key] = 0;
      if (document.hidden) notify(m);
      else if (S.view !== key) toast((m.fromName || 'رسالة جديدة') + ': ' + m.text.slice(0, 40));
    }
    schedule();
  });

  function notify(m) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const title = m.fromName || 'رسالة جديدة', opt = { body: m.text.slice(0, 120), tag: 'pc-' + m.from, icon: 'icon-192.png' };
    if (navigator.serviceWorker && navigator.serviceWorker.ready) navigator.serviceWorker.ready.then(r => r.showNotification(title, opt)).catch(() => {});
    else try { new Notification(title, opt); } catch {}
  }

  /* ---- الإدخال ---- */
  const inText = $('inText');
  inText.addEventListener('input', () => { inText.style.height = 'auto'; inText.style.height = Math.min(inText.scrollHeight, 120) + 'px'; });
  inText.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer:fine)').matches) { e.preventDefault(); $('composer').requestSubmit(); }
  });
  $('composer').addEventListener('submit', e => {
    e.preventDefault();
    const t = inText.value.trim(); if (!t) return;
    N.sendText(t, S.view);
    inText.value = ''; inText.style.height = 'auto'; inText.focus();
  });

  /* ---- القائمة ---- */
  function renderContacts() {
    const ul = $('contactList'); ul.textContent = '';
    const all = [...N.contacts.values()];
    if (!all.length) { const li = document.createElement('li'); li.textContent = 'لا أجهزة بعد'; li.className = 'muted'; ul.appendChild(li); return; }
    all.forEach(c => {
      const li = document.createElement('li');
      const dot = document.createElement('span'); dot.className = 'dot' + (N.conns.has(c.id) ? ' on' : ''); li.appendChild(dot);
      const nm = document.createElement('div'); nm.className = 'nm';
      nm.textContent = nameOf(c.id) + (c.blocked ? ' (محظور)' : '');
      const sm = document.createElement('small');
      sm.textContent = N.conns.has(c.id) ? 'متصل الآن' : 'آخر ظهور: ' + fmtTime(c.lastSeen);
      nm.appendChild(sm); li.appendChild(nm);
      const b = document.createElement('button'); b.className = 'small'; b.textContent = c.blocked ? 'إلغاء الحظر' : 'حظر';
      b.onclick = () => N.block(c.id, !c.blocked); li.appendChild(b);
      const f = document.createElement('button'); f.className = 'small danger'; f.textContent = 'نسيان';
      f.onclick = () => { if (confirm('نسيان هذا الجهاز؟ (الرسائل تبقى محفوظة)')) N.forget(c.id); }; li.appendChild(f);
      ul.appendChild(li);
    });
  }
  const openSheet = () => {
    $('setName').value = me.name; $('swLock').checked = N.locked;
    $('myId').textContent = 'معرّف هذا الجهاز: ' + me.id;
    $('btnNotif').textContent = !('Notification' in window) ? 'غير مدعوم' : Notification.permission === 'granted' ? 'مفعّلة' : 'تفعيل';
    renderContacts(); $('sheet').hidden = false;
  };
  $('btnMenu').onclick = openSheet;
  $('btnCloseSheet').onclick = () => ($('sheet').hidden = true);
  $('sheet').addEventListener('click', e => { if (e.target === $('sheet')) $('sheet').hidden = true; });
  $('btnSaveName').onclick = () => {
    if (!$('setName').value.trim()) return;
    N.rename($('setName').value); toast('تم حفظ الاسم');
  };
  $('swLock').onchange = e => { N.setLocked(e.target.checked); toast(e.target.checked ? 'الغرفة مقفلة' : 'تم فتح الغرفة'); };
  $('btnNotif').onclick = async () => {
    if (!('Notification' in window)) return;
    const r = await Notification.requestPermission();
    $('btnNotif').textContent = r === 'granted' ? 'مفعّلة' : 'مرفوضة';
  };
  $('btnExport').onclick = () => PC.exportRoom(N.rid);
  $('btnLeave').onclick = () => {
    if (!confirm('الخروج ونسيان الكود على هذا الجهاز؟ الرسائل المحفوظة تبقى.')) return;
    N.stop(); PC.ls.del('room'); $('sheet').hidden = true; showLock();
  };

  /* ---- تثبيت التطبيق ---- */
  let deferred = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; $('btnInstall').hidden = false; });
  $('btnInstall').onclick = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $('btnInstall').hidden = true; };
  window.addEventListener('appinstalled', () => ($('btnInstall').hidden = true));
  if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !navigator.standalone) $('iosHint').hidden = false;

  /* ---- إيقاظ الاتصال عند العودة للتطبيق/الشبكة ---- */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    S.unread[S.view] = 0; N.wake(); schedule();
  });
  window.addEventListener('online', () => N.wake());

  $('btnJoin').onclick = join;
  $('inCode').addEventListener('keydown', e => { if (e.key === 'Enter') join(); });

  /* ---- الإقلاع ---- */
  (async () => {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    me.id = PC.ls.get('device') || PC.rand(10); PC.ls.set('device', me.id);
    me.name = PC.ls.get('name') || '';
    try { await PC.openDB(); } catch { return showLock('المتصفح لا يدعم التخزين المحلي المطلوب'); }
    const rid = PC.ls.get('room');
    if (rid && PC.ROOMS[rid] && me.name) enter(rid); else showLock();
  })();
})();

'use strict';
/* ===== الواجهة ===== */
(() => {
  const N = PC.net;
  const $ = id => document.getElementById(id);
  const S = { view: '*', msgs: [], sys: [], unread: {}, raf: 0, fails: 0, lockedUntil: 0 };
  const me = { id: '', name: '' };

  /* حفظ الغرفة: دائم على الجهاز، أو للجلسة فقط (يُطلب الكود عند كل فتح للتطبيق) */
  const roomStore = {
    get() { if (PC.REMEMBER_ROOM) return PC.ls.get('room'); try { return sessionStorage.getItem('pc_room'); } catch { return null; } },
    set(v) { if (PC.REMEMBER_ROOM) PC.ls.set('room', v); else try { sessionStorage.setItem('pc_room', v); } catch {} },
    del() { PC.ls.del('room'); try { sessionStorage.removeItem('pc_room'); } catch {} }
  };

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
    PC.ls.set('name', name); roomStore.set(rid); PC.ls.del('noauto');
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
    if (PC.relay && PC.relay.state === 'ok') txt += ' · ☁';
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
    const rev = m.rev || 0, ackd = id => !!(m.acks && m.acks[id]) && ((m.ackRev && m.ackRev[id]) || 0) >= rev;
    const n = m.to === '*' ? Object.keys(m.acks || {}).filter(ackd).length : (ackd(m.to) ? 1 : 0);
    if (n) return ['✓✓ تم التسليم' + (m.to === '*' && n > 1 ? ' (' + n + ')' : ''), 'ok'];
    return m.relayed && (m.relayedRev || 0) >= rev
      ? ['☁ محفوظة على الخادم بانتظار الطرف الآخر', 'wait']
      : ['🕓 بانتظار اتصال الطرف الآخر', 'wait'];
  }

  function renderList() {
    const list = $('list');
    const stick = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    const items = S.msgs.concat(S.sys).filter(m => !m.hidden).filter(visible).sort((a, b) => a.ts - b.ts).slice(-300);
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
      el.className = 'msg' + (mine ? ' me' : '') + (m.deleted ? ' gone' : '');
      el.onclick = () => openMsgSheet(m);
      if (!mine) { const w = document.createElement('div'); w.className = 'who'; w.textContent = m.fromName || nameOf(m.from); el.appendChild(w); }
      const t = document.createElement('div'); t.className = 'txt'; t.textContent = m.deleted ? '🚫 حُذفت هذه الرسالة' : m.text; el.appendChild(t);
      const meta = document.createElement('div'); meta.className = 'meta';
      const tm = document.createElement('span'); tm.textContent = fmtTime(m.ts) + (m.edited && !m.deleted ? ' · معدّلة' : ''); meta.appendChild(tm);
      if (mine) { const [txt, cls] = statusOf(m); const s = document.createElement('span'); s.className = cls; s.textContent = txt; meta.appendChild(s); }
      el.appendChild(meta); list.appendChild(el);
    }
    if (stick) list.scrollTop = list.scrollHeight;
  }

  function renderAll() { renderStatus(); renderChips(); renderList(); }
  function schedule() { if (!S.raf) S.raf = requestAnimationFrame(() => { S.raf = 0; renderAll(); }); }

  /* ---- أحداث الشبكة ---- */
  N.on('status', () => { schedule(); if (!$('sheet').hidden) renderRelayInfo(); });
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
  const refresh = m => { const i = S.msgs.findIndex(x => x.id === m.id); if (i >= 0) S.msgs[i] = m; schedule(); };
  N.on('ack', refresh);
  N.on('upd', refresh);
  N.on('msg', m => {
    S.msgs.push(m);
    if (m.from !== me.id && !m.deleted) {
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
  const cancelEdit = () => { S.editId = null; $('editBar').hidden = true; inText.value = ''; inText.style.height = 'auto'; };
  $('btnCancelEdit').onclick = cancelEdit;
  $('composer').addEventListener('submit', async e => {
    e.preventDefault();
    const t = inText.value.trim(); if (!t) return;
    if (S.editId) {
      const id = S.editId; cancelEdit();
      if (!(await N.editMsg(id, t))) toast('تعذّر تعديل الرسالة');
      inText.focus(); return;
    }
    N.sendText(t, S.view);
    inText.value = ''; inText.style.height = 'auto'; inText.focus();
  });

  /* ---- إجراءات على الرسالة (نقرة على الفقاعة) ---- */
  let sel = null;
  const closeMsgSheet = () => { $('msgSheet').hidden = true; sel = null; };
  function openMsgSheet(m) {
    sel = m;
    const mine = m.from === me.id;
    $('msgPreview').textContent = m.deleted ? 'رسالة محذوفة' : m.text.slice(0, 400);
    $('actCopy').hidden = !!m.deleted;
    $('actEdit').hidden = !(mine && !m.deleted);
    $('actDelAll').hidden = !(mine && !m.deleted);
    $('actHide').hidden = mine && !m.deleted;
    $('msgSheet').hidden = false;
  }
  $('msgSheet').addEventListener('click', e => { if (e.target === $('msgSheet')) closeMsgSheet(); });
  $('actClose').onclick = closeMsgSheet;
  $('actCopy').onclick = async () => {
    const t = sel && sel.text; closeMsgSheet(); if (!t) return;
    try { await navigator.clipboard.writeText(t); }
    catch { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch {} ta.remove(); }
    toast('تم النسخ');
  };
  $('actEdit').onclick = () => {
    const m = sel; closeMsgSheet(); if (!m) return;
    S.editId = m.id; inText.value = m.text; $('editBar').hidden = false;
    inText.style.height = 'auto'; inText.style.height = Math.min(inText.scrollHeight, 120) + 'px'; inText.focus();
  };
  $('actDelAll').onclick = async () => {
    const m = sel; closeMsgSheet(); if (!m) return;
    if (!confirm('حذف هذه الرسالة للجميع؟')) return;
    if (S.editId === m.id) cancelEdit();
    if (!(await N.deleteMsg(m.id))) toast('تعذّر حذف الرسالة');
  };
  $('actHide').onclick = async () => { const m = sel; closeMsgSheet(); if (m) await N.hideMsg(m.id); };

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
  const renderRelayInfo = extra => {
    if (extra !== undefined) S.relayExtra = extra || '';   // رسالة مؤقتة (فحص/خطأ) تبقى حتى تُستبدل
    const rs = PC.relay.state;
    $('relayInfo').textContent = S.relayExtra || ({ off: 'غير مفعّل — الرسائل تنتقل مباشرة فقط.', idle: 'جارٍ الاتصال…', ok: 'يعمل ✓ — تُحفظ نسخة مشفّرة للأجهزة غير المتصلة.', err: 'غير متاح الآن، ستُعاد المحاولة تلقائياً.' }[rs] || rs);
  };
  $('btnRelaySave').onclick = async () => {
    const u = $('relayUrl').value.trim().replace(/\/+$/, '');
    if (!u) { PC.relay.set(''); renderRelayInfo(''); return toast('أُوقف خادم الاحتفاظ'); }
    if (!PC.relay.valid(u)) return toast('الرابط يجب أن يبدأ بـ https://');
    renderRelayInfo('جارٍ فحص الخادم…');
    const r = await PC.relay.check(u);
    if (r === 'ok') { PC.relay.set(u); renderRelayInfo(''); toast('خادم الاحتفاظ يعمل ✓'); }
    else { renderRelayInfo(r === 'auth' ? 'الخادم يعمل لكن الرمز غير مطابق: يجب أن يساوي RELAY_TOKEN قيمة PC.RELAY.token.' : 'تعذّر الوصول للخادم. تأكد من الرابط وأنه يعمل.'); }
  };
  const openSheet = () => {
    $('setName').value = me.name; $('swLock').checked = N.locked;
    $('myId').textContent = 'معرّف هذا الجهاز: ' + me.id;
    $('btnNotif').textContent = !('Notification' in window) ? 'غير مدعوم' : Notification.permission === 'granted' ? 'مفعّلة' : 'تفعيل';
    $('relayUrl').value = PC.relay.url();
    renderRelayInfo('');
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
    N.stop(); roomStore.del(); PC.ls.set('noauto', '1'); $('sheet').hidden = true; showLock();
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
    const qn = new URLSearchParams(location.search).get('n');          // رابط شخصي: index.html?n=فراس
    if (qn && qn.trim()) PC.ls.set('name', N.cleanName(qn));
    me.name = PC.ls.get('name') || '';
    try { await PC.openDB(); } catch { return showLock('المتصفح لا يدعم التخزين المحلي المطلوب'); }
    let rid = roomStore.get();
    if (!(rid && PC.ROOMS[rid]) && PC.AUTO_ROOM && PC.ROOMS[PC.AUTO_ROOM] && PC.ls.get('noauto') !== '1') rid = PC.AUTO_ROOM;
    if (rid && PC.ROOMS[rid]) {
      if (!me.name) { me.name = 'جهاز ' + me.id.slice(0, 4); PC.ls.set('name', me.name); }
      roomStore.set(rid); enter(rid);
    } else showLock();
  })();
})();

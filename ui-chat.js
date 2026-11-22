'use strict';
/* ===== واجهة التطبيق — المحادثة: الرسائل والشرائح والملفات والبحث والإدخال ===== */
(() => {
  const U = PC.ui;
  const $ = id => document.getElementById(id);
  const { N, S, me, toast, fmtTime, nameOf, addSys } = U;
  const renderContacts = (...a) => U.renderContacts(...a);   // من ملف آخر
  const renderRelayInfo = (...a) => U.renderRelayInfo(...a);   // من ملف آخر
  const renderNotif = (...a) => U.renderNotif(...a);   // من ملف آخر

  /* ---- الحالة ---- */
  function renderStatus() {
    const el = $('netState');
    let txt, cls = '';
    if (N.libFail) { txt = 'تعذّر تحميل مكتبة الاتصال — تحقق من الإنترنت'; cls = 'off'; }
    else if (N.netDown) { txt = 'لا يوجد اتصال بالإنترنت — تُحفظ رسائلك وتُرسل عند عودته'; cls = 'off'; }
    else if (!N.libOk) { txt = 'جارٍ تحميل مكتبة الاتصال…'; }
    else if (!N.serverOk) { txt = N.fails >= 2 ? 'تعذّر الوصول لخادم الاتصال (محاولة ' + N.fails + ') — اضغط لإعادة المحاولة' : 'جارٍ الاتصال بالخادم…'; if (N.fails >= 2) cls = 'off'; }
    else if (N.conns.size === 0) { txt = 'جاهز — بانتظار الطرف الآخر'; }
    else { txt = 'متصل مع: ' + N.onlineList().map(x => x.name).join('، '); cls = 'on'; }
    const nowT = Date.now();
    const typers = Object.entries(S.typing).filter(([id, t]) => t.until > nowT && (S.view === '*' ? t.group : (id === S.view && !t.group))).map(([id, t]) => nameOf(id) || t.name);
    if (typers.length) { txt = '✎ ' + typers.join('، ') + ' يكتب…'; cls = 'on'; }
    const talkers = PC.voice.speakers();
    if (talkers.length) { txt = '🎙 ' + talkers.join('، ') + ' يتحدث…'; cls = 'on'; }
    if (PC.relay && PC.relay.state === 'ok') txt += ' · ☁';
    el.textContent = txt; el.className = 'state ' + cls;
  }

  $('statusBox').onclick = () => {                       // اضغط الحالة لإعادة محاولة الاتصال فوراً
    if (N.libFail) return location.reload();
    N.wake(); toast('جارٍ إعادة محاولة الاتصال…', 1500);
  };

  /* ---- الشرائح ---- */
  function renderChips() {
    const box = $('chips'); box.textContent = '';
    const mk = (key, label, online) => {
      const b = document.createElement('button'); b.type = 'button';
      b.className = 'chip' + (S.view === key ? ' active' : '');
      if (key !== '*') { const d = document.createElement('span'); d.className = 'dot' + (online ? ' on' : ''); b.appendChild(d); }
      b.appendChild(document.createTextNode(label));
      if (S.unread[key]) { const u = document.createElement('span'); u.className = 'badge'; u.textContent = S.unread[key]; b.appendChild(u); }
      b.onclick = () => { S.view = key; S.unread[key] = 0; cancelReply(); renderAll(); };
      box.appendChild(b);
    };
    mk('*', 'الجميع', false);
    [...N.contacts.values()].filter(c => !c.blocked)
      .sort((a, b) => (N.conns.has(b.id) - N.conns.has(a.id)) || a.name.localeCompare(b.name, 'ar'))
      .forEach(c => mk(c.id, nameOf(c.id), N.conns.has(c.id)));
  }

  /* ---- الصور والملفات ---- */
  const IMG_OK = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const fmtSize = n => n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  const fileLabel = m => !m.file ? '' : IMG_OK.includes(m.file.type) ? '📷 صورة' : '📎 ' + m.file.name;
  const urlCache = new Map();
  function fileUrl(m) {
    let u = urlCache.get(m.id);
    if (!u) {
      const bin = atob(m.file.data), arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      u = URL.createObjectURL(new Blob([arr], { type: IMG_OK.includes(m.file.type) ? m.file.type : 'application/octet-stream' }));
      urlCache.set(m.id, u);
    }
    return u;
  }
  const audioEls = new Map();                              // عنصر صوت لكل رسالة: يبقى التشغيل سليماً عند إعادة رسم القائمة
  const dropUrl = id => { audioEls.delete(id); const u = urlCache.get(id); if (u) { URL.revokeObjectURL(u); urlCache.delete(id); } };
  function saveFile(m) {
    if (!m.file || !m.file.data) return;
    const a = document.createElement('a'); a.href = fileUrl(m); a.download = m.file.name;
    document.body.appendChild(a); a.click(); a.remove();
  }
  function openViewer(url) { $('viewerImg').src = url; $('viewer').hidden = false; }
  $('viewer').onclick = () => { $('viewer').hidden = true; $('viewerImg').removeAttribute('src'); };

  /* تجهيز مرفق: الصور تُصغَّر (حتى 1280px) وتُضغط JPEG، وغيرها يُرسل كما هو إن لم يتجاوز الحد */
  async function prepFile(file) {
    let blob = file, name = file.name || 'ملف', type = file.type || 'application/octet-stream';
    if (IMG_OK.includes(type) && type !== 'image/gif') {
      try {
        const bmp = await createImageBitmap(file);
        const sc = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
        const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * sc)); c.height = Math.max(1, Math.round(bmp.height * sc));
        const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
        for (const q of [0.72, 0.55, 0.4]) { blob = await new Promise(r => c.toBlob(r, 'image/jpeg', q)); if (blob && blob.size <= PC.MAX_FILE) break; }
        type = 'image/jpeg'; name = name.replace(/\.[^.]+$/, '') + '.jpg';
        if (bmp.close) bmp.close();
      } catch { blob = file; }
    }
    if (!blob || blob.size === 0) throw new Error('empty');
    if (blob.size > PC.MAX_FILE) throw new Error('big');
    const buf = new Uint8Array(await blob.arrayBuffer()); let b = '';
    for (let i = 0; i < buf.length; i += 0x8000) b += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { name, type, size: buf.length, data: btoa(b) };
  }

  /* ---- البحث: تطبيع عربي (التشكيل والهمزات والياء/الألف المقصورة والتاء المربوطة) ---- */
  const FOLD = { 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ى': 'ي', 'ة': 'ه' };
  const fold = t => { let out = '', map = []; for (let i = 0; i < t.length; i++) { const c = t[i]; if (/[\u064B-\u065F\u0670\u0640]/.test(c)) continue; out += FOLD[c] || c.toLowerCase(); map.push(i); } return { out, map }; };
  function fillText(el, text) {
    const q = S.q ? fold(S.q).out : '';
    if (!q) { el.textContent = text; return; }
    const f = fold(text); let from = 0, pos = 0, i;
    while ((i = f.out.indexOf(q, from)) >= 0) {
      const a = f.map[i], b = f.map[i + q.length - 1] + 1;
      if (a > pos) el.append(text.slice(pos, a));
      const mk = document.createElement('mark'); mk.textContent = text.slice(a, b); el.append(mk);
      pos = b; from = i + q.length;
    }
    el.append(text.slice(pos));
  }

  /* ---- الرسائل ---- */
  const visible = m => {
    if (m.sys) return true;
    if (m.purged) return false;
    if (S.view === '*') return m.to === '*';
    return (m.from === me.id && m.to === S.view) || (m.from === S.view && m.to === me.id);
  };

  function statusOf(m) {
    const rev = m.rev || 0, ackd = id => !!(m.acks && m.acks[id]) && ((m.ackRev && m.ackRev[id]) || 0) >= rev;
    const readN = Object.keys(m.read || {}).length;
    if (readN) return ['✓✓ قُرئت' + (m.to === '*' && readN > 1 ? ' (' + readN + ')' : ''), 'read'];
    const n = m.to === '*' ? Object.keys(m.acks || {}).filter(ackd).length : (ackd(m.to) ? 1 : 0);
    if (n) return ['✓✓ تم التسليم' + (m.to === '*' && n > 1 ? ' (' + n + ')' : ''), 'ok'];
    return m.relayed && (m.relayedRev || 0) >= rev
      ? ['☁ محفوظة على الخادم بانتظار الطرف الآخر', 'wait']
      : m.file ? ['🕓 بانتظار اتصال مباشر (الملفات لا تُحفظ على الخادم)', 'wait']
      : ['🕓 بانتظار اتصال الطرف الآخر', 'wait'];
  }

  /* فواصل الأيام وزر «إلى آخر الرسائل» */
  const dayKey = ts => { const d = new Date(ts); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); };
  const dayLabel = ts => {
    const d = new Date(ts), n = new Date(), y = new Date(Date.now() - 86400000);
    if (dayKey(ts) === dayKey(n)) return 'اليوم';
    if (dayKey(ts) === dayKey(y)) return 'أمس';
    return d.toLocaleDateString('ar', { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== n.getFullYear() ? { year: 'numeric' } : {}) });
  };
  function updateDown() {
    const list = $('list'), far = list.scrollHeight - list.scrollTop - list.clientHeight > 160;
    if (!far) S.below = 0;
    $('btnDown').hidden = !far; $('downCount').hidden = !S.below; $('downCount').textContent = S.below || '';
  }
  $('list').addEventListener('scroll', updateDown, { passive: true });
  $('btnDown').onclick = () => { const l = $('list'); S.below = 0; l.scrollTo({ top: l.scrollHeight, behavior: 'smooth' }); setTimeout(updateDown, 400); };

  function renderList() {
    const list = $('list');
    const stick = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    let items = S.msgs.concat(S.sys).filter(m => !m.hidden).filter(visible).sort((a, b) => a.ts - b.ts).slice(-300);
    if (S.q) { const q = fold(S.q).out; items = items.filter(m => !m.sys && !m.deleted && q && fold((m.text || '') + ' ' + (m.file ? m.file.name : '')).out.includes(q)); $('searchCount').textContent = items.length + ' نتيجة'; }
    const keepTop = list.scrollTop;                       // نحفظ موضع التمرير فلا يقفز القارئ للأعلى عند كل تحديث
    list.textContent = '';
    if (!items.length) {
      const e = document.createElement('div'); e.className = 'empty';
      e.textContent = S.q ? 'لا توجد نتائج.' : S.view === '*' ? 'لا رسائل بعد. اكتب رسالة وستُحفظ على جهازك حتى يتصل الطرف الآخر.' : 'لا رسائل مع هذا الجهاز بعد.';
      list.appendChild(e); return;
    }
    let lastDay = '';
    for (const m of items) {
      if (!m.sys) { const dk = dayKey(m.ts); if (dk !== lastDay) { lastDay = dk; const sp = document.createElement('div'); sp.className = 'dsep'; sp.textContent = dayLabel(m.ts); list.appendChild(sp); } }
      const el = document.createElement('div');
      if (m.sys) { el.className = 'msg sys ' + m.cls; el.textContent = m.text; list.appendChild(el); continue; }
      const mine = m.from === me.id;
      el.className = 'msg' + (mine ? ' me' : '') + (m.deleted ? ' gone' : '');
      el.onclick = () => openMsgSheet(m);
      el.dataset.id = m.id;
      if (!mine) { const w = document.createElement('div'); w.className = 'who'; w.textContent = m.fromName || nameOf(m.from); el.appendChild(w); }
      if (m.reply && !m.deleted) {
        const q = document.createElement('div'); q.className = 'quote';
        const qn = document.createElement('b'); qn.textContent = m.reply.name || 'رسالة';
        const qt = document.createElement('span'); qt.textContent = m.reply.text;
        q.append(qn, qt); q.onclick = ev => { ev.stopPropagation(); jumpTo(m.reply.id); }; el.appendChild(q);
      }
      if (m.file && !m.deleted) el.appendChild(renderFile(m));
      if (m.deleted || m.text) { const t = document.createElement('div'); t.className = 'txt'; if (m.deleted) t.textContent = '🚫 حُذفت هذه الرسالة'; else fillText(t, m.text); el.appendChild(t); }
      const meta = document.createElement('div'); meta.className = 'meta';
      const tm = document.createElement('span'); tm.textContent = fmtTime(m.ts) + (m.edited && !m.deleted ? ' · معدّلة' : ''); meta.appendChild(tm);
      if (mine) { const [txt, cls] = statusOf(m); const s = document.createElement('span'); s.className = cls; s.textContent = txt; meta.appendChild(s); }
      el.appendChild(meta); list.appendChild(el);
    }
    const real = items.filter(m => !m.sys), maxTs = real.length ? real[real.length - 1].ts : 0;
    if (stick && !S.q) { list.scrollTop = list.scrollHeight; S.below = 0; }
    else { list.scrollTop = keepTop; if (S.maxTs) S.below = (S.below || 0) + real.filter(m => m.ts > S.maxTs && m.from !== me.id).length; }
    S.maxTs = Math.max(S.maxTs || 0, maxTs); updateDown();
    markSeen(items);
  }

  function renderFile(m) {
    const box = document.createElement('div');
    if (!m.file.data) { box.className = 'fwait'; box.textContent = '⏳ جارٍ استلام ' + (IMG_OK.includes(m.file.type) ? 'الصورة' : m.file.name) + '…'; return box; }
    if (/^audio\//.test(m.file.type)) {
      box.className = 'voice';
      const lab = document.createElement('div'); lab.className = 'vlab';
      lab.textContent = '🎙 رسالة صوتية' + (m.file.dur ? ' · ' + Math.floor(m.file.dur / 60) + ':' + String(m.file.dur % 60).padStart(2, '0') : '');
      let a = audioEls.get(m.id);
      if (!a) { a = document.createElement('audio'); a.controls = true; a.preload = 'metadata'; a.src = fileUrl(m); a.onclick = ev => ev.stopPropagation(); audioEls.set(m.id, a); }
      box.append(lab, a); return box;
    }
    if (IMG_OK.includes(m.file.type)) {
      const im = document.createElement('img'); im.className = 'pic'; im.src = fileUrl(m); im.alt = m.file.name;
      im.onclick = ev => { ev.stopPropagation(); openViewer(im.src); }; box.appendChild(im);
    } else {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'fchip';
      b.textContent = '📎 ' + m.file.name + ' · ' + fmtSize(m.file.size);
      b.onclick = ev => { ev.stopPropagation(); saveFile(m); }; box.appendChild(b);
    }
    return box;
  }

  /* الرسائل الواردة المعروضة فعلاً أمام المستخدم تُعدّ مقروءة */
  function markSeen(items) {
    if (document.hidden || S.gate || $('app').hidden) return;
    const ids = items.filter(m => !m.sys && m.from !== me.id && !m.deleted && !m.readSeen).map(m => m.id);
    if (ids.length) N.viewed(ids);
  }
  function jumpTo(id) {
    const el = [...$('list').children].find(e => e.dataset && e.dataset.id === id);
    if (!el) return toast('الرسالة الأصلية غير موجودة هنا');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1300);
  }

  function renderAll() { renderStatus(); renderChips(); renderList(); }
  function schedule() { if (!S.raf) S.raf = requestAnimationFrame(() => { S.raf = 0; renderAll(); }); }

  /* ---- أحداث الشبكة ---- */
  N.on('status', () => { schedule(); if (!$('sheet').hidden) { renderRelayInfo(); renderNotif(); } });
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
  const refresh = m => { if (m.deleted || m.purged || !m.file) dropUrl(m.id); const i = S.msgs.findIndex(x => x.id === m.id); if (i >= 0) S.msgs[i] = m; schedule(); };
  N.on('ack', refresh);
  N.on('upd', refresh);
  N.on('typing', ({ id, name, group }) => { S.typing[id] = { name, group, until: Date.now() + 4000 }; schedule(); setTimeout(schedule, 4100); });
  N.on('msg', m => {
    S.msgs.push(m);
    if (m.from !== me.id && !m.deleted) {
      const key = m.to === '*' ? '*' : m.from;
      if (S.view !== key || document.hidden) { S.unread[key] = (S.unread[key] || 0) + 1; }
      if (S.view === key && !document.hidden) S.unread[key] = 0;
      if (document.hidden || S.view !== key) beep();
      if (document.hidden) notify(m);
      else if (S.view !== key && !S.gate) toast((m.fromName || 'رسالة جديدة') + ': ' + (m.text || fileLabel(m)).slice(0, 40));
    }
    schedule();
  });

  /* ---- صوت واهتزاز ---- */
  let ac = null;
  const sndOn = () => PC.ls.get('snd') !== '0';
  const unlockAudio = () => { try { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume(); } catch {} };
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  function beep() {
    if (!sndOn()) return;
    try {
      unlockAudio(); const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime;
      o.type = 'sine'; o.frequency.value = 880; g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.15, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + 0.27);
    } catch {}
    try { if (navigator.vibrate) navigator.vibrate(120); } catch {}
  }

  function notify(m) {
    if (!('Notification' in window) || Notification.permission !== 'granted' || PC.ls.get('notif_off') === '1') return;
    const lk = PC.vault.enabled(), title = lk ? 'رسالة جديدة' : (m.fromName || 'رسالة جديدة'), opt = { body: lk ? 'افتح التطبيق لقراءتها' : (m.text || fileLabel(m)).slice(0, 120), tag: 'pc-' + m.from, icon: 'icon-192.png' };
    if (navigator.serviceWorker && navigator.serviceWorker.ready) navigator.serviceWorker.ready.then(r => r.showNotification(title, opt)).catch(() => {});
    else try { new Notification(title, opt); } catch {}
  }

  /* ---- الإدخال ---- */
  const inText = $('inText');
  inText.addEventListener('input', () => { if (inText.value) N.typing(S.view); inText.style.height = 'auto'; inText.style.height = Math.min(inText.scrollHeight, 120) + 'px'; });
  inText.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer:fine)').matches) { e.preventDefault(); $('composer').requestSubmit(); }
  });
  const cancelEdit = () => { S.editId = null; $('editBar').hidden = true; inText.value = ''; inText.style.height = 'auto'; };
  $('btnCancelEdit').onclick = cancelEdit;
  const cancelAttach = () => { S.file = null; $('attachBar').hidden = true; $('attachThumb').hidden = true; $('attachThumb').removeAttribute('src'); };
  $('btnCancelAttach').onclick = cancelAttach;
  $('btnAttach').onclick = () => { if (S.editId) return toast('أنهِ التعديل أولاً'); $('fileIn').click(); };
  $('fileIn').onchange = async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      toast('جارٍ تجهيز المرفق…', 5000); S.file = await prepFile(f); $('toast').hidden = true;
      $('attachTxt').textContent = (IMG_OK.includes(S.file.type) ? '📷 ' : '📎 ') + S.file.name + ' · ' + fmtSize(S.file.size);
      const th = $('attachThumb'); if (IMG_OK.includes(S.file.type)) { th.src = 'data:' + S.file.type + ';base64,' + S.file.data; th.hidden = false; } else th.hidden = true;
      $('attachBar').hidden = false; inText.focus();
    } catch (err) { S.file = null; toast(err.message === 'big' ? 'الحجم أكبر من المسموح (' + fmtSize(PC.MAX_FILE) + ')' : 'تعذّر تجهيز الملف'); }
  };
  const cancelReply = () => { S.reply = null; $('replyBar').hidden = true; };
  $('btnCancelReply').onclick = cancelReply;
  $('composer').addEventListener('submit', async e => {
    e.preventDefault();
    const t = inText.value.trim(); if (!t && !(S.file && !S.editId)) return;
    if (S.editId) {
      const id = S.editId; cancelEdit();
      if (!(await N.editMsg(id, t))) toast('تعذّر تعديل الرسالة');
      inText.focus(); return;
    }
    N.sendText(t, S.view, S.reply, S.file); cancelReply(); cancelAttach();
    inText.value = ''; inText.style.height = 'auto'; inText.focus();
  });

  /* ---- إجراءات على الرسالة (نقرة على الفقاعة) ---- */
  let sel = null;
  const closeMsgSheet = () => { $('msgSheet').hidden = true; sel = null; };
  function openMsgSheet(m) {
    sel = m;
    const mine = m.from === me.id;
    $('msgPreview').textContent = m.deleted ? 'رسالة محذوفة' : (m.file ? fileLabel(m) + (m.text ? '\n' : '') : '') + m.text.slice(0, 400);
    $('actReply').hidden = !!m.deleted;
    $('actCopy').hidden = !!m.deleted || !m.text;
    $('actSave').hidden = !(m.file && m.file.data && !m.deleted);
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
  $('actReply').onclick = () => {
    const m = sel; closeMsgSheet(); if (!m) return;
    cancelEdit();
    S.reply = { id: m.id, from: m.from, name: m.from === me.id ? me.name : (m.fromName || nameOf(m.from)), text: (m.text || fileLabel(m)).slice(0, 120) };
    $('replyTxt').textContent = '↩ رد على ' + S.reply.name + ': ' + S.reply.text;
    $('replyBar').hidden = false; inText.focus();
  };
  $('actSave').onclick = () => { const m = sel; closeMsgSheet(); if (m) saveFile(m); };
  $('actEdit').onclick = () => {
    const m = sel; closeMsgSheet(); if (!m) return;
    cancelReply(); cancelAttach();
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

  /* ---- البحث ---- */
  const closeSearch = () => { S.q = ''; $('inSearch').value = ''; $('searchBar').hidden = true; schedule(); };
  $('btnSearch').onclick = () => { const h = !$('searchBar').hidden; if (h) return closeSearch(); $('searchBar').hidden = false; $('inSearch').focus(); };
  $('btnCloseSearch').onclick = closeSearch;
  $('inSearch').addEventListener('input', e => { S.q = e.target.value.trim(); schedule(); if (!S.q) $('searchCount').textContent = ''; });

  Object.assign(U, { beep, dropUrl, renderAll, schedule, sndOn, visible });
})();

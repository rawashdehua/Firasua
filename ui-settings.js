'use strict';
/* ===== واجهة التطبيق — الإعدادات: القائمة والخادم والقفل والإشعارات وإدارة الغرفة ===== */
(() => {
  const U = PC.ui;
  const $ = id => document.getElementById(id);
  const { N, S, me, roomStore, keyStore, myRooms, toast, fmtTime, nameOf, addSys } = U;
  const lockNow = (...a) => U.lockNow(...a);   // من ملف آخر
  const showLock = (...a) => U.showLock(...a);   // من ملف آخر
  const dropUrl = (...a) => U.dropUrl(...a);   // من ملف آخر
  const visible = (...a) => U.visible(...a);   // من ملف آخر
  const renderAll = (...a) => U.renderAll(...a);   // من ملف آخر
  const schedule = (...a) => U.schedule(...a);   // من ملف آخر
  const sndOn = (...a) => U.sndOn(...a);   // من ملف آخر
  const beep = (...a) => U.beep(...a);   // من ملف آخر

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
    else { renderRelayInfo(r === 'auth' ? 'الخادم يعمل لكن رفض الرمز. إن كان الخادم مضبوطاً بـ RELAY_TOKEN فأزل هذا المتغير (الوضع التلقائي) أو ضعه في PC.RELAY.token.' : 'تعذّر الوصول للخادم. تأكد من الرابط وأنه يعمل.'); }
  };
  /* ---- إعدادات القفل ---- */
  function renderPin() {
    const on = PC.vault.enabled();
    $('pinInfo').textContent = on ? 'القفل مفعّل: المحادثات المحفوظة على هذا الجهاز مشفّرة برمزك.'
      : 'غير مفعّل. فعّله لتشفير المحادثات المحفوظة على هذا الجهاز وطلب رمز عند الفتح. إن نسيت الرمز لا يمكن استرجاع المحادثات.';
    $('pinOld').hidden = !on; $('btnPinOff').hidden = !on; $('btnPinNow').hidden = !on; $('rowLockDelay').hidden = !on;
    $('btnPinSave').textContent = on ? 'تغيير الرمز' : 'تفعيل القفل';
    $('selLock').value = PC.ls.get('lockdelay', '60000');
  }
  $('btnPinSave').onclick = async () => {
    const on = PC.vault.enabled(), n1 = $('pinNew').value, n2 = $('pinNew2').value, old = $('pinOld').value;
    if (n1.length < 4) return toast('الرمز 4 خانات على الأقل');
    if (n1 !== n2) return toast('الرمزان غير متطابقين');
    if (on && !old) return toast('اكتب الرمز الحالي');
    $('btnPinSave').disabled = true; toast('جارٍ التشفير…', 8000);
    try {
      if (on) { if (!(await PC.vault.change(old, n1))) return toast('الرمز الحالي غير صحيح'); }
      else await PC.vault.setup(n1);
      ['pinOld', 'pinNew', 'pinNew2'].forEach(i => ($(i).value = ''));
      toast(on ? 'تم تغيير الرمز ✓' : 'تم تفعيل القفل ✓');
    } catch { toast('تعذّرت العملية'); }
    finally { $('btnPinSave').disabled = false; renderPin(); }
  };
  $('btnPinOff').onclick = async () => {
    const old = $('pinOld').value; if (!old) return toast('اكتب الرمز الحالي');
    $('btnPinOff').disabled = true;
    try { if (await PC.vault.remove(old)) { $('pinOld').value = ''; toast('أُوقف القفل'); } else toast('الرمز الحالي غير صحيح'); }
    catch { toast('تعذّر الإيقاف'); }
    finally { $('btnPinOff').disabled = false; renderPin(); }
  };
  $('btnPinNow').onclick = lockNow;
  $('selLock').onchange = e => PC.ls.set('lockdelay', e.target.value);

  /* ---- حذف محلي: مسح المحادثة والحذف التلقائي (يبقى أثر فارغ لمنع عودة الرسالة إن أُعيد إرسالها) ---- */
  const stub = m => ({ id: m.id, room: m.room, ts: m.ts, from: m.from, to: m.to, fromName: '', text: '', rev: m.rev || 0, purged: 1,
    acks: m.acks || {}, ackRev: m.ackRev || {}, read: m.read || {}, readSeen: m.readSeen || 0, readNotified: m.readNotified || 0 });
  const settled = m => {                       // وصلت لمن تعنيهم؟ (الواردة دائماً مستقرّة)
    if (m.from !== me.id) return true;
    if (m.to !== '*') return !!(m.acks && m.acks[m.to]);
    const ks = [...N.contacts.values()].filter(c => !c.blocked);
    return ks.length > 0 && ks.every(c => m.acks && m.acks[c.id]);
  };
  async function wipe(list) {
    const del = [], put = [];
    for (const m of list) { dropUrl(m.id); if (m.purged) continue; if (settled(m)) put.push(stub(m)); else del.push(m.id); }
    if (put.length) await Promise.all(put.map(PC.putMsg));
    if (del.length) await PC.delMsgs(del);
    S.msgs = await PC.roomMsgs(N.rid); schedule();
    return put.length + del.length;
  }
  async function purgeOld() {
    const age = +PC.ls.get('purge', '0'); if (!age || !N.rid) return;
    const lim = Date.now() - age;
    await wipe(S.msgs.filter(m => !m.purged && m.ts < lim && settled(m)));
  }
  setInterval(() => purgeOld().catch(() => {}), 600000);

  const openSheet = () => {
    $('setName').value = me.name; $('swLock').checked = N.locked; $('swReads').checked = N.readsOn(); $('swSnd').checked = sndOn(); $('selPurge').value = PC.ls.get('purge', '0');
    $('selPtt').value = PC.voice.mode(); $('selFont').value = PC.ls.get('fs') || '16'; $('selTheme').value = PC.ls.get('theme') || 'auto';
    $('myId').textContent = 'معرّف هذا الجهاز: ' + me.id;
    renderNotif();
    $('relayUrl').value = PC.relay.url();
    renderRelayInfo('');
    renderPin(); renderContacts(); renderRooms(); renderHost(); $('sheet').hidden = false;
  };
  $('selPtt').onchange = e => { PC.voice.setMode(e.target.value); };
  $('selFont').onchange = e => { PC.ls.set('fs', e.target.value); U.applyLook(); };
  $('selTheme').onchange = e => { PC.ls.set('theme', e.target.value); U.applyLook(); };
  $('btnMenu').onclick = openSheet;
  $('btnCloseSheet').onclick = () => ($('sheet').hidden = true);
  $('sheet').addEventListener('click', e => { if (e.target === $('sheet')) $('sheet').hidden = true; });
  $('btnSaveName').onclick = () => {
    if (!$('setName').value.trim()) return;
    N.rename($('setName').value); toast('تم حفظ الاسم');
  };
  $('swSnd').onchange = e => { PC.ls.set('snd', e.target.checked ? '1' : '0'); if (e.target.checked) beep(); };
  $('selPurge').onchange = async e => { PC.ls.set('purge', e.target.value); await purgeOld(); toast(e.target.value === '0' ? 'أُوقف الحذف التلقائي' : 'تم ضبط الحذف التلقائي'); };
  $('btnClear').onclick = async () => {
    const list = S.msgs.filter(m => !m.purged && visible(m) && !m.sys);
    if (!list.length) return toast('لا رسائل في هذه المحادثة');
    const pend = list.filter(m => !settled(m)).length;
    if (!confirm('مسح ' + list.length + ' رسالة من هذا الجهاز فقط؟' + (pend ? '\nتنبيه: ' + pend + ' منها لم تُسلَّم بعد وستضيع نهائياً.' : ''))) return;
    const n = await wipe(list); $('sheet').hidden = true; toast('تم مسح ' + n + ' رسالة');
  };
  $('swReads').onchange = e => { PC.ls.set('noread', e.target.checked ? '0' : '1'); if (e.target.checked) N.flushReads(); toast(e.target.checked ? 'سيرى الآخرون «قُرئت» و«يكتب»' : 'أُخفيت حالة القراءة والكتابة'); };
  $('swLock').onchange = e => { N.setLocked(e.target.checked); toast(e.target.checked ? 'الغرفة مقفلة' : 'تم فتح الغرفة'); };
  $('btnNotif').onclick = async () => {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'denied') return renderNotif();
    if (Notification.permission !== 'granted') {
      await Notification.requestPermission(); PC.ls.del('notif_off');
    } else if (PC.ls.get('notif_off') === '1') { PC.ls.del('notif_off'); }
    else { PC.ls.set('notif_off', '1'); await PC.push.off(); }
    renderNotif(); PC.push.sync().then(renderNotif).catch(() => {});
  };
  function renderNotif() {
    const b = $('btnNotif'), i = $('notifInfo');
    if (!('Notification' in window)) { b.textContent = 'غير مدعوم'; b.disabled = true; i.textContent = 'هذا المتصفح لا يدعم الإشعارات. على آيفون ثبّت التطبيق على الشاشة الرئيسية أولاً.'; return; }
    const p = Notification.permission, off = PC.ls.get('notif_off') === '1', st = PC.push.state;
    b.disabled = p === 'denied';
    b.textContent = p === 'denied' ? 'محظورة' : p !== 'granted' ? 'تفعيل' : off ? 'تفعيل' : 'إيقاف';
    i.textContent = p === 'denied' ? 'الإشعارات محظورة من إعدادات المتصفح لهذا الموقع.'
      : p !== 'granted' ? 'اضغط «تفعيل» للسماح بالإشعارات.'
      : off ? 'الإشعارات موقوفة.'
      : st === 'ok' ? 'تعمل حتى والتطبيق مغلق ✓ (يظهر تنبيه عام «رسالة جديدة» بدون نص الرسالة)'
      : st === 'wait' ? 'جارٍ تفعيل إشعارات الخلفية…'
      : st === 'err' ? 'تعذّر تفعيل إشعارات الخلفية؛ ستُعاد المحاولة عند فتح التطبيق.'
      : st === 'nosupport' ? 'تعمل والتطبيق مفتوح في الخلفية فقط (المتصفح لا يدعم إشعارات الخلفية؛ على آيفون ثبّت التطبيق أولاً).'
      : 'تعمل والتطبيق مفتوح في الخلفية فقط. لإشعارات والتطبيق مغلق فعّل «خادم الاحتفاظ» أدناه.';
  }

  $('btnExport').onclick = () => PC.exportRoom(N.rid);
  $('btnLeave').onclick = () => {
    if (!confirm('الخروج من الغرفة؟ تبقى في «غرفك السابقة» للعودة بضغطة، والرسائل المحفوظة تبقى.')) return;
    N.stop(); roomStore.del(); keyStore.del(); PC.relay.use(null); PC.ls.set('noauto', '1'); $('sheet').hidden = true; showLock();
  };

  /* ---- إدارة الغرفة ---- */
  const memberName = id => id === me.id ? me.name + ' (أنت)' : ((N.contacts.get(id) || {}).name || id);
  function renderHost() {
    const st = PC.room.state(), box = $('hostBox');
    box.hidden = !st.body; if (!st.body) return;
    const b = st.body;
    $('hostCtl').hidden = !st.host;
    $('hostInfo').textContent = st.host
      ? 'أنت مضيف هذه الغرفة. التحكم هنا ينفّذه تطبيق كل جهاز؛ ولا يمنع من يملك الكود ويعدّل التطبيق. لإلغاء وصول أحد نهائياً غيّر كود الغرفة.'
      : 'مضيف الغرفة: ' + (b.hostName || '—') + (b.max ? ' · الحد الأقصى ' + b.max + ' مستخدمين' : '') + (b.closed ? ' · الدخول متوقف' : '');
    if (!st.host) return;
    $('selMax').value = String(b.max); if ($('selMax').value !== String(b.max)) { const o = document.createElement('option'); o.value = b.max; o.textContent = b.max; $('selMax').appendChild(o); $('selMax').value = String(b.max); }
    $('swClosed').checked = !!b.closed; $('swMute').checked = !!b.mute;
    const ul = $('memberList'); ul.textContent = '';
    for (const id of b.members) {
      const li = document.createElement('li'), nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = memberName(id); li.appendChild(nm);
      if (id !== me.id) { const x = document.createElement('button'); x.type = 'button'; x.className = 'small danger'; x.textContent = 'إزالة وحظر'; x.onclick = async () => { if (confirm('إزالة هذا الجهاز وحظره من الغرفة؟')) { await PC.room.kick(id); toast('أُزيل الجهاز'); } }; li.appendChild(x); }
      ul.appendChild(li);
    }
    for (const id of b.ban) {
      const li = document.createElement('li'), nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = memberName(id) + ' — محظور'; li.appendChild(nm);
      const x = document.createElement('button'); x.type = 'button'; x.className = 'small'; x.textContent = 'سماح'; x.onclick = async () => { await PC.room.unban(id); }; li.appendChild(x);
      ul.appendChild(li);
    }
  }
  $('selMax').onchange = async () => {
    const r = await PC.room.setMax($('selMax').value);
    if (!r.ok) { toast(r.err === 'count' ? 'عدد الأجهزة الحالية (' + r.count + ') أكبر من الحد؛ أزل أجهزة أولاً' : 'غير مسموح'); renderHost(); }
  };
  $('swMute').onchange = () => PC.room.setMute($('swMute').checked);
  $('swClosed').onchange = () => PC.room.setClosed($('swClosed').checked);
  $('btnWipe').onclick = async () => {
    if (!confirm('حذف كل رسائل هذه الغرفة من جميع الأجهزة (المتصلة الآن وعند اتصال الغائبين)؟ لا يمكن التراجع.')) return;
    await PC.room.wipe(); toast('حُذفت الدردشة للجميع');
  };
  N.on('room', () => { if (!$('sheet').hidden) renderHost(); });
  N.on('wiped', async () => { S.msgs = await PC.roomMsgs(N.rid); S.unread = {}; S.reply = null; renderAll(); toast('حذف المضيف الدردشة'); });
  N.on('refused', r => { if (S.refusedAt && Date.now() - S.refusedAt < 8000) return; S.refusedAt = Date.now(); addSys(r === 'banned' ? 'حظرك المضيف من هذه الغرفة.' : (r === 'full' || r === 'closed') ? 'الغرفة لا تقبل أجهزة جديدة حالياً (ممتلئة أو أوقف المضيف الدخول).' : 'رُفض اتصالك.', 'warn'); });
  function renderRooms() {
    const ul = $('roomList'); ul.textContent = '';
    const o = myRooms.get(), ids = Object.keys(o);
    if (!ids.length) { const li = document.createElement('li'); li.className = 'muted'; li.textContent = 'لا غرف مضافة.'; ul.appendChild(li); return; }
    for (const rid of ids) {
      const li = document.createElement('li'), nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = o[rid] + (rid === N.rid ? ' (الحالية)' : '');
      li.appendChild(nm);
      if (rid !== N.rid) {
        const b = document.createElement('button'); b.className = 'small danger'; b.type = 'button'; b.textContent = 'نسيان';
        b.onclick = async () => {
          if (!confirm('نسيان هذه الغرفة؟ تُحذف رسائلها من هذا الجهاز ويلزم إعادة إضافتها بالكود.')) return;
          const m = myRooms.get(); delete m[rid]; myRooms.set(m);
          try { await PC.delRoom(rid); } catch {}
          renderRooms();
        };
        li.appendChild(b);
      }
      ul.appendChild(li);
    }
  }
  Object.assign(U, { purgeOld, renderContacts, renderNotif, renderRelayInfo });
})();

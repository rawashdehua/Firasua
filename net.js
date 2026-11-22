'use strict';
/* ===== الاتصال المباشر (PeerJS) + الرسائل المعلّقة + الحضور ===== */
(() => {
  const N = PC.net = {
    rid: null, me: null, peer: null, beacon: null, beaconTrying: false,
    conns: new Map(),      // deviceId -> {conn, id, name, last, ready, outgoing}
    contacts: new Map(),   // deviceId -> {key, room, id, name, lastSeen, blocked}
    dialing: new Set(), locked: false, stopped: true, serverOk: false, libOk: false, libFail: false, netDown: false, fails: 0,
    lastDisc: 0, timer: null, restartT: null
  };

  /* ---- أحداث بسيطة ---- */
  const subs = {};
  N.on = (e, fn) => { (subs[e] = subs[e] || []).push(fn); };
  const emit = (e, a, b) => (subs[e] || []).forEach(fn => { try { fn(a, b); } catch (x) { console.error(x); } });

  const validId = id => typeof id === 'string' && /^[a-z0-9]{6,16}$/.test(id);
  const mainId = id => 'pcm-' + N.rid + '-' + id;
  N.mainId = mainId;
  const beaconId = () => 'pcb-' + N.rid;
  const cleanName = x => String(x || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24) || 'جهاز';
  const send = (st, o) => { try { if (st.conn.open) st.conn.send(o); } catch {} };
  const closeConn = c => { try { c.close(); } catch {} };
  const cleanReply = r => (r && typeof r === 'object' && typeof r.id === 'string' && r.id.length <= 40)
    ? { id: r.id, from: validId(r.from) ? r.from : '', name: cleanName(r.name), text: String(r.text || '').slice(0, 120) } : null;
  const cleanFile = f => {
    if (!f || typeof f !== 'object') return null;
    const size = Math.floor(Number(f.size));
    if (!(size > 0 && size <= PC.MAX_FILE)) return null;
    const name = String(f.name || 'ملف').replace(/[\u0000-\u001f\\/:*?"<>|]/g, '').trim().slice(0, 80) || 'ملف';
    const type = typeof f.type === 'string' && f.type.length <= 60 && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(f.type) ? f.type.toLowerCase() : 'application/octet-stream';
    const dur = Math.floor(Number(f.dur));
    return { name, type, size, ...(dur > 0 && dur <= 600 ? { dur } : {}) };
  };
  const strip = m => ({ id: m.id, ts: m.ts, from: m.from, fromName: m.fromName, to: m.to, text: m.deleted ? '' : m.text, rev: m.rev || 0, deleted: m.deleted || 0, edited: m.edited || 0, reply: m.reply || null,
    file: m.file && !m.deleted ? { name: m.file.name, type: m.file.type, size: m.file.size, dur: m.file.dur || 0 } : null });
  /* هل ما زال الجهاز id بحاجة لنسخة هذه الرسالة (لم تصله، أو وصلته نسخة أقدم قبل التعديل/الحذف)؟ */
  const pendingFor = (m, id) => !(m.acks && m.acks[id]) || ((m.ackRev && m.ackRev[id]) || 0) < (m.rev || 0);

  /* ---- تحميل مكتبة PeerJS ---- */
  function loadLib() {
    if (window.Peer) return Promise.resolve(true);
    let i = 0;
    return new Promise(res => {
      const next = () => {
        if (i >= PC.PEER_SRC.length) return res(false);
        const s = document.createElement('script');
        s.src = PC.PEER_SRC[i++]; s.crossOrigin = 'anonymous';
        s.onload = () => (window.Peer ? res(true) : next());
        s.onerror = () => { s.remove(); next(); };
        document.head.appendChild(s);
      };
      next();
    });
  }

  /* ---- الدورة ---- */
  N.start = async (rid, me) => {
    N.stop();
    N.stopped = false; N.rid = rid; N.me = me; N.lastDisc = 0;
    N.locked = PC.ls.get('lock_' + rid) === '1';
    N.contacts = new Map((await PC.roomContacts(rid)).map(c => [c.id, c]));
    emit('contacts');
    emit('status');
    N.libOk = await loadLib();
    N.libFail = !N.libOk;
    if (!N.libOk) { emit('status'); return; }
    openMain();
    N.timer = setInterval(tick, 5000);
  };

  N.stop = () => {
    N.stopped = true;
    clearInterval(N.timer); clearTimeout(N.restartT);
    N.conns.forEach(st => { send(st, { t: 'bye' }); closeConn(st.conn); });
    N.conns.clear(); N.dialing.clear();
    [N.peer, N.beacon].forEach(p => { try { p && p.destroy(); } catch {} });
    N.peer = N.beacon = null; N.beaconTrying = false; N.serverOk = false;
  };

  function restartSoon(ms) {
    if (N.stopped || N.restartT) return;
    N.restartT = setTimeout(() => { N.restartT = null; openMain(); }, ms);
  }

  function openMain() {
    if (N.stopped || !window.Peer) return;
    try { N.peer && N.peer.destroy(); } catch {}
    N.conns.forEach(st => closeConn(st.conn)); N.conns.clear(); N.dialing.clear();
    N.serverOk = false; emit('status'); emit('presence');
    const p = new Peer(mainId(N.me.id), { debug: 0, config: PC.PEER_CFG });
    N.peer = p;
    const wd = setTimeout(() => { if (N.peer === p && !N.serverOk && !N.stopped) { N.fails++; N.lastErr = 'timeout'; emit('status'); restartSoon(Math.min(60000, 4000 * 2 ** Math.min(N.fails - 1, 4))); } }, 12000);   // لا استجابة من الخادم
    p.on('open', () => { clearTimeout(wd); N.lastErr = ''; N.serverOk = true; N.fails = 0; emit('status'); claimBeacon(); discover(); connectKnown(); });
    p.on('connection', c => onConn(c, false));
    p.on('call', c => { if (N.voiceIn) N.voiceIn(c); else { try { c.close(); } catch {} } });   // مكالمة صوتية مباشرة (زر التحدث)
    p.on('disconnected', () => {
      N.serverOk = false; emit('status');
      setTimeout(() => { if (N.peer === p && !p.destroyed) { try { p.reconnect(); } catch {} } }, 2000);
    });
    p.on('error', e => {
      if (e.type === 'peer-unavailable') return;           // جهاز غير متصل الآن: طبيعي
      clearTimeout(wd); N.lastErr = e.type || 'error';
      if (e.type === 'unavailable-id') { N.fails++; emit('status'); return restartSoon(4000); } // الجلسة السابقة ما زالت مسجّلة
      N.serverOk = false; N.fails++; emit('status'); restartSoon(Math.min(60000, 4000 * 2 ** Math.min(N.fails - 1, 4)));   // 4s ثم 8 ثم 16 ثم 32 ثم 60
    });
  }

  /* "المنارة": جهاز واحد يحمل معرّفاً ثابتاً ليجد به القادم الجديد بقية الأجهزة (للتعارف فقط) */
  function claimBeacon() {
    if (N.stopped || N.beacon || N.beaconTrying || !N.serverOk) return;
    N.beaconTrying = true;
    const b = new Peer(beaconId(), { debug: 0, config: PC.PEER_CFG });
    const giveUp = setTimeout(() => { if (N.beacon !== b) { N.beaconTrying = false; try { b.destroy(); } catch {} } }, 10000);
    b.on('open', () => { clearTimeout(giveUp); N.beaconTrying = false; N.beacon = b; });
    b.on('connection', c => {
      c.on('open', () => {
        const ids = [...N.conns.keys()].filter(id => !(N.contacts.get(id) || {}).blocked);
        ids.push(N.me.id);
        try { c.send({ t: 'roster', ids, locked: N.locked }); } catch {}
        setTimeout(() => closeConn(c), 2500);
      });
    });
    const lost = () => { clearTimeout(giveUp); N.beaconTrying = false; if (N.beacon === b) N.beacon = null; try { b.destroy(); } catch {} };
    b.on('error', e => { lost(); if (e.type === 'unavailable-id') setTimeout(() => discover(true), 600); });
    b.on('disconnected', lost);
    b.on('close', () => { if (N.beacon === b) N.beacon = null; });
  }

  function discover(force) {
    if (N.stopped || !N.peer || !N.serverOk || N.beacon || N.beaconTrying) return;   // لا نتعارف مع منارتنا نحن
    if (!force && Date.now() - N.lastDisc < 4000) return;
    N.lastDisc = Date.now();
    const c = N.peer.connect(beaconId(), { reliable: true, serialization: 'json' });
    c.on('data', d => {
      if (!d || d.t !== 'roster' || !Array.isArray(d.ids)) return;
      if (d.locked) { emit('locked'); return; }
      d.ids.slice(0, 30).forEach(id => { if (validId(id) && id !== N.me.id) connectTo(id); });
    });
    setTimeout(() => closeConn(c), 6000);
  }

  function connectTo(id) {
    if (N.stopped || !N.peer || !N.serverOk || N.conns.has(id) || N.dialing.has(id)) return;
    N.dialing.add(id); setTimeout(() => N.dialing.delete(id), 8000);
    onConn(N.peer.connect(mainId(id), { reliable: true, serialization: 'json' }), true);
  }

  /* الأجهزة المعروفة: الجهاز ذو المعرّف الأصغر هو من يبادر، لتفادي اتصالين متقابلين */
  function connectKnown() {
    N.contacts.forEach(c => {
      if (!c.blocked && !N.conns.has(c.id) && N.me.id < c.id) connectTo(c.id);
    });
  }

  function tick() {
    if (N.stopped) return;
    if (!N.peer || N.peer.destroyed) return openMain();
    const now = Date.now();
    N.conns.forEach(st => {
      if (now - st.last > 20000) { closeConn(st.conn); drop(st); }
      else send(st, { t: 'ping' });
    });
    claimBeacon(); connectKnown();
    if (N.conns.size === 0) discover();
  }

  if (typeof window !== 'undefined' && window.addEventListener) {          // حالة الإنترنت تظهر في الحالة، وعودتها تُعيد الاتصال فوراً
    N.netDown = typeof navigator !== 'undefined' && navigator.onLine === false;
    window.addEventListener('offline', () => { N.netDown = true; emit('status'); });
    window.addEventListener('online', () => { N.netDown = false; emit('status'); });
  }
  N.wake = () => {
    if (N.stopped || !N.libOk) return;
    N.fails = 0;
    if (!N.peer || N.peer.destroyed) return openMain();
    if (N.peer.disconnected) { try { N.peer.reconnect(); } catch {} }
    N.lastDisc = 0; tick();
  };

  /* ---- الاتصالات ---- */
  function onConn(c, outgoing) {
    const st = { conn: c, id: null, name: '', last: Date.now(), ready: false, outgoing };
    const t = setTimeout(() => { if (!st.ready) closeConn(c); }, 10000);
    const hello = () => send(st, { t: 'hello', id: N.me.id, name: N.me.name, v: 1 });
    c.on('open', hello);
    c.on('data', d => onData(st, d));
    c.on('close', () => { clearTimeout(t); drop(st); N.dialing.forEach(x => { if (c.peer === mainId(x)) N.dialing.delete(x); }); });
    c.on('error', () => drop(st));
    if (c.open) hello();
  }

  function drop(st) {
    if (!st.ready || N.conns.get(st.id) !== st) return;
    N.conns.delete(st.id);
    for (const [k2, a] of asm) if (a.from === st.id) asm.delete(k2);
    const k = N.contacts.get(st.id);
    if (k) { k.lastSeen = Date.now(); PC.putContact(k); }
    emit('presence'); emit('offline', { id: st.id, name: st.name });
  }

  const asm = new Map();   // تجميع قطع الملفات الواردة: معرّف الرسالة -> {from, n, parts, got}

  function onData(st, d) {
    if (!d || typeof d !== 'object') return;
    if (!st.ready) { if (d.t === 'hello') onHello(st, d); else if (d.t === 'bye' && d.r) emit('refused', d.r); return; }
    st.last = Date.now();
    st.q = (st.q || Promise.resolve()).then(() => dispatch(st, d)).catch(e => console.error(e));   // بالترتيب: الرسالة قبل قطع ملفها
  }

  async function dispatch(st, d) {
    switch (d.t) {
      case 'msg': await onMsg(st, d.m); break;
      case 'fc': await onChunk(st, d); break;
      case 'ack': await onAck(st, d.a); break;
      case 'ping': send(st, { t: 'pong' }); break;
      case 'name': {
        const k = N.contacts.get(st.id);
        st.name = cleanName(d.name);
        if (k) { k.name = st.name; PC.putContact(k); }
        emit('presence'); emit('contacts'); break;
      }
      case 'read': await onRead(st, d.ids); break;
      case 'ptt': emit('ptt', { id: st.id, name: st.name, on: !!d.on }); break;
      case 'typing': emit('typing', { id: st.id, name: st.name, group: !!d.g }); break;
      case 'bye': if (d.r) emit('refused', d.r); closeConn(st.conn); drop(st); break;
      case 'pol': emit('pol', st.id, d.p); break;
    }
  }

  function onHello(st, d) {
    const id = String(d.id || '');
    if (!validId(id) || id === N.me.id || st.conn.peer !== mainId(id)) return closeConn(st.conn); // منع انتحال الهوية
    const known = N.contacts.get(id);
    if (known && known.blocked) { send(st, { t: 'bye', r: 'blocked' }); return closeConn(st.conn); }
    const why = N.admit ? N.admit(id) : null;                       // سياسة المضيف: حدّ العدد / إيقاف الدخول / الحظر
    if (why) {
      send(st, { t: 'bye', r: why }); closeConn(st.conn);
      emit('sys', 'رُفض جهاز حاول الانضمام (' + (why === 'full' ? 'الغرفة ممتلئة' : why === 'banned' ? 'محظور من المضيف' : 'الدخول متوقف') + '): ' + cleanName(d.name), 'warn');
      return;
    }
    if (!known && N.locked) {
      send(st, { t: 'bye', r: 'locked' }); closeConn(st.conn);
      emit('sys', 'رُفض جهاز جديد حاول الانضمام (الغرفة مقفلة): ' + cleanName(d.name), 'warn');
      return;
    }
    const old = N.conns.get(id);
    if (old && old.conn.open && old.conn !== st.conn) {
      const initOf = s => (s.outgoing ? N.me.id : id);
      if (initOf(st) > initOf(old) && Date.now() - old.last < 20000) return closeConn(st.conn);
      closeConn(old.conn); N.conns.delete(id);
    }
    st.id = id; st.name = cleanName(d.name); st.ready = true; st.last = Date.now();
    N.conns.set(id, st);
    const c = { key: N.rid + '|' + id, room: N.rid, id, name: st.name, lastSeen: Date.now(), blocked: false };
    N.contacts.set(id, c); PC.putContact(c);
    emit('presence'); emit('contacts'); emit('online', { id, name: st.name, isNew: !known });
    flush(id); sendReads(id);
  }

  /* ---- الرسائل ---- */
  async function flush(id) {
    const st = N.conns.get(id); if (!st) return;
    for (const m of await PC.roomMsgs(N.rid)) {
      if (m.from !== N.me.id) continue;
      if (m.to !== '*' && m.to !== id) continue;
      if (!pendingFor(m, id)) continue;
      pushTo(st, m);
    }
  }

  /* يخزّن رسالة واردة أو تحديثاً لها (تعديل/حذف) من اتصال مباشر أو من خادم الاحتفاظ.
     يعيد رقم النسخة المحفوظة (للتأكيد) أو -1 إن كانت غير صالحة. */
  async function ingest(fromId, m) {
    if (!m || typeof m !== 'object') return -1;
    if (typeof m.id !== 'string' || m.id.length > 40 || typeof m.text !== 'string' || m.text.length > PC.MAX_TEXT) return -1;
    const fm = cleanFile(m.file);
    if (!m.deleted && !m.text && !fm) return -1;
    if (m.from !== fromId || (m.to !== '*' && m.to !== N.me.id)) return -1;
    if (N.muteCheck && m.file && /^audio\//i.test(String(m.file.type || '')) && N.muteCheck(fromId)) return Math.max(0, Math.floor(Number(m.rev) || 0));   // المضيف كتم الجميع: تُهمل الرسائل الصوتية
    if (N.wipeCut && Number(m.ts) <= N.wipeCut()) return Math.max(0, Math.floor(Number(m.rev) || 0));   // أقدم من آخر حذف للدردشة من المضيف
    const rev = Math.max(0, Math.floor(Number(m.rev) || 0));
    const ex = await PC.getMsg(m.id);
    if (ex) {
      if (ex.from !== fromId) return -1;
      if (ex.purged) return ex.rev || 0;          // مُسحت محلياً: نؤكد الاستلام ولا نُظهرها ثانية
      if (rev > (ex.rev || 0) && !ex.deleted) {
        ex.rev = rev;
        if (m.deleted) { ex.deleted = Number(m.deleted) || Date.now(); ex.text = ''; ex.file = null; }
        else { ex.text = m.text; ex.edited = Number(m.edited) || Date.now(); ex.readSeen = 0; ex.readNotified = 0; }
        await PC.putMsg(ex); emit('upd', ex);
      }
      emit('dup', ex);                              // نافذة ثانية بنفس المتصفح تشارك قاعدة البيانات: قد لا تعرضها بعد
      return ex.rev || 0;
    }
    const k = N.contacts.get(fromId);
    const rec = {
      id: m.id, room: N.rid, ts: Number(m.ts) || Date.now(), from: fromId, fromName: cleanName(m.fromName || (k && k.name)),
      to: m.to, reply: cleanReply(m.reply), file: !m.deleted && fm ? { ...fm, data: null } : null, text: m.deleted ? '' : m.text, rev, deleted: m.deleted ? (Number(m.deleted) || Date.now()) : 0,
      edited: !m.deleted && m.edited ? Number(m.edited) : 0, rts: Date.now()
    };
    await PC.putMsg(rec); emit('msg', rec);
    return rev;
  }

  async function onMsg(st, m) {
    const r = await ingest(st.id, m);
    if (r < 0) return;
    const rec = await PC.getMsg(m.id);
    if (rec && rec.file && !rec.file.data && !rec.deleted && !rec.purged) return;   // ننتظر قطع الملف ثم نؤكد
    send(st, { t: 'ack', a: [{ id: m.id, rev: r }] });
  }

  /* قطعة من ملف: تُجمَّع ثم تُتحقق (صيغة base64 والحجم) قبل الحفظ، ولا يُؤكَّد الاستلام قبل اكتمالها */
  async function onChunk(st, d) {
    if (typeof d.id !== 'string' || typeof d.d !== 'string' || d.d.length > 16000) return;
    const i = Math.floor(Number(d.i)), n = Math.floor(Number(d.n));
    if (!(n >= 1 && n <= 200) || !(i >= 0 && i < n)) return;
    const rec = await PC.getMsg(d.id);
    if (!rec || rec.from !== st.id || !rec.file || rec.file.data || rec.deleted || rec.purged) return;
    let a = asm.get(d.id);
    if (!a || a.n !== n || a.from !== st.id) { a = { from: st.id, n, parts: new Array(n), got: 0 }; asm.set(d.id, a); }
    if (a.parts[i] === undefined) { a.parts[i] = d.d; a.got++; }
    if (a.got < n) return;
    asm.delete(d.id);
    const data = a.parts.join(''), bytes = Math.floor(data.length * 3 / 4);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || Math.abs(bytes - rec.file.size) > 3) return;      // تالف: ننتظر إعادة الإرسال
    rec.file.data = data; await PC.putMsg(rec); emit('upd', rec);
    send(st, { t: 'ack', a: [{ id: rec.id, rev: rec.rev || 0 }] });
  }

  async function markAck(id, by, rev = 0) {
    const m = await PC.getMsg(id);
    if (!m || m.from !== N.me.id || (m.to !== '*' && m.to !== by)) return false;
    m.acks = m.acks || {}; m.ackRev = m.ackRev || {};
    const first = !m.acks[by], newer = (m.ackRev[by] || 0) < rev;
    if (!first && !newer) return false;
    if (first) m.acks[by] = Date.now();
    m.ackRev[by] = Math.max(m.ackRev[by] || 0, rev);
    await PC.putMsg(m); emit('ack', m);
    return true;
  }

  async function onAck(st, a) {
    if (!Array.isArray(a)) return;
    for (const x of a.slice(0, 200)) if (x && typeof x.id === 'string') await markAck(x.id, st.id, Number(x.rev) || 0);
  }

  N.sendText = async (text, to, reply, file) => {
    text = String(text || '').trim().slice(0, PC.MAX_TEXT);
    const fm = file ? cleanFile(file) : null;
    if (file && (!fm || typeof file.data !== 'string' || !file.data)) return null;
    if (!text && !fm) return null;
    const m = { id: PC.rand(16), room: N.rid, ts: Date.now(), from: N.me.id, fromName: N.me.name, to, text, rev: 0, acks: {}, ackRev: {}, reply: cleanReply(reply), file: fm ? { ...fm, data: file.data } : null };
    await PC.putMsg(m); emit('msg', m);
    pushMsg(m);
    return m;
  };

  function pushTo(st, m) {
    send(st, { t: 'msg', m: strip(m) });
    if (m.file && m.file.data && !m.deleted) {
      const dd = m.file.data, n = Math.ceil(dd.length / 12000);
      for (let i = 0; i < n; i++) send(st, { t: 'fc', id: m.id, i, n, d: dd.slice(i * 12000, (i + 1) * 12000) });
    }
  }
  function pushMsg(m) {
    if (m.to === '*') N.conns.forEach(st => pushTo(st, m));
    else { const st = N.conns.get(m.to); if (st) pushTo(st, m); }
  }

  /* تعديل رسالتي: يصل للأجهزة المتصلة فوراً، وللبقية عند اتصالها (أو عبر خادم الاحتفاظ) */
  N.editMsg = async (id, text) => {
    text = String(text || '').trim().slice(0, PC.MAX_TEXT);
    const m = await PC.getMsg(id);
    if (!m || m.from !== N.me.id || m.deleted || (!text && !m.file)) return null;
    if (m.text === text) return m;
    m.text = text; m.edited = Date.now(); m.rev = (m.rev || 0) + 1; m.read = {};
    await PC.putMsg(m); emit('upd', m); pushMsg(m);
    return m;
  };

  /* حذف رسالتي للجميع: يبقى أثر «حُذفت هذه الرسالة» ويُمسح النص عند الطرف الآخر */
  N.deleteMsg = async id => {
    const m = await PC.getMsg(id);
    if (!m || m.from !== N.me.id || m.deleted) return null;
    m.deleted = Date.now(); m.text = ''; m.file = null; m.rev = (m.rev || 0) + 1;
    await PC.putMsg(m); emit('upd', m); pushMsg(m);
    return m;
  };

  /* إخفاء عندي فقط: رسالة وردتني، أو أثر رسالة محذوفة */
  N.hideMsg = async id => {
    const m = await PC.getMsg(id);
    if (!m || (m.from === N.me.id && !m.deleted)) return null;
    m.hidden = 1; await PC.putMsg(m); emit('upd', m);
    return m;
  };

  /* ---- إعدادات ---- */
  N.setLocked = v => { N.locked = !!v; PC.ls.set('lock_' + N.rid, v ? '1' : '0'); };
  N.rename = name => {
    N.me.name = cleanName(name); PC.ls.set('name', N.me.name);
    N.conns.forEach(st => send(st, { t: 'name', name: N.me.name }));
  };
  N.block = (id, v) => {
    const k = N.contacts.get(id); if (!k) return;
    k.blocked = !!v; PC.putContact(k);
    const st = N.conns.get(id);
    if (v && st) { send(st, { t: 'bye', r: 'blocked' }); closeConn(st.conn); drop(st); }
    emit('contacts');
  };
  N.forget = id => {
    const st = N.conns.get(id);
    if (st) { send(st, { t: 'bye' }); closeConn(st.conn); drop(st); }
    N.contacts.delete(id); PC.delContact(N.rid + '|' + id);
    emit('contacts'); emit('presence');
  };
  N.sendTo = (id, o) => { const st = N.conns.get(id); if (st) send(st, o); };
  N.broadcast = o => N.conns.forEach(st => send(st, o));
  N.kick = (id, r) => { const st = N.conns.get(id); if (st) { send(st, { t: 'bye', r: r || 'banned' }); closeConn(st.conn); drop(st); } };
  N.onlineList = () => [...N.conns.values()].map(s => ({ id: s.id, name: s.name }));
  N.cleanName = cleanName;

  /* ---- «قُرئت» و«يكتب الآن» (يمكن إيقافهما من الإعدادات: لا يُرسل شيء) ---- */
  const readsOn = () => PC.ls.get('noread') !== '1';
  N.readsOn = readsOn;

  async function sendReads(only) {
    if (!readsOn() || N.stopped) return;
    const by = new Map();
    for (const m of await PC.roomMsgs(N.rid)) {
      if (m.from === N.me.id || m.deleted || !m.readSeen || m.readNotified) continue;
      if (only && m.from !== only) continue;
      if (!N.conns.has(m.from)) continue;
      if (!by.has(m.from)) by.set(m.from, []);
      by.get(m.from).push(m.id);
    }
    for (const [from, ids] of by) {
      const st = N.conns.get(from); if (!st) continue;
      for (let i = 0; i < ids.length; i += 100) send(st, { t: 'read', ids: ids.slice(i, i + 100) });
      for (const id of ids) await N.patchMsg(id, x => { x.readNotified = Date.now(); });
    }
  }

  /* الواجهة تستدعيها حين تُعرض رسائل واردة أمام المستخدم فعلاً */
  N.viewed = async ids => {
    let any = false;
    for (const id of ids.slice(0, 200)) {
      const m = await PC.getMsg(id);
      if (!m || m.from === N.me.id || m.readSeen) continue;
      m.readSeen = Date.now(); await PC.putMsg(m); emit('upd', m); any = true;
    }
    if (any) { await sendReads(); emit('readq'); }
  };
  N.pendingReads = async () => !readsOn() ? [] :
    (await PC.roomMsgs(N.rid)).filter(m => m.from !== N.me.id && !m.deleted && m.readSeen && !m.readNotified && !N.conns.has(m.from) && validId(m.from))
      .slice(0, 200).map(m => ({ id: m.id, from: m.from }));
  N.markNotified = async ids => { for (const id of ids) await N.patchMsg(id, x => { x.readNotified = Date.now(); }); };
  N.markReadBy = async (id, by) => {
    const m = await PC.getMsg(id);
    if (!m || m.from !== N.me.id || (m.to !== '*' && m.to !== by)) return false;
    m.read = m.read || {}; if (m.read[by]) return false;
    m.read[by] = Date.now(); await PC.putMsg(m); emit('upd', m); return true;
  };
  async function onRead(st, ids) {
    if (Array.isArray(ids)) for (const id of ids.slice(0, 100)) if (typeof id === 'string') await N.markReadBy(id, st.id);
  }

  N.flushReads = () => sendReads();
  let lastTyping = 0;
  N.typing = to => {
    if (!readsOn() || Date.now() - lastTyping < 2500) return;
    lastTyping = Date.now();
    const o = { t: 'typing', g: to === '*' ? 1 : 0 };
    if (to === '*') N.conns.forEach(st => send(st, o)); else { const st = N.conns.get(to); if (st) send(st, o); }
  };

  /* واجهة خادم الاحتفاظ (relay.js) */
  N.emit = emit;
  N.pendingFor = pendingFor;
  N.ingest = ingest;
  N.markAck = markAck;
  N.validId = validId;
  N.relayContact = (id, name) => {
    let c = N.contacts.get(id); if (c) return c;
    c = { key: N.rid + '|' + id, room: N.rid, id, name: cleanName(name), lastSeen: Date.now(), blocked: false };
    N.contacts.set(id, c); PC.putContact(c); emit('contacts'); return c;
  };
  N.patchMsg = async (id, fn) => {   // قراءة ثم تعديل ثم حفظ، ويُعاد رسم الحالة
    const m = await PC.getMsg(id); if (!m) return;
    fn(m); await PC.putMsg(m); emit('ack', m);
  };
})();

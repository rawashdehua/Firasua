'use strict';
/* ===== الاتصال المباشر (PeerJS) + الرسائل المعلّقة + الحضور ===== */
(() => {
  const N = PC.net = {
    rid: null, me: null, peer: null, beacon: null, beaconTrying: false,
    conns: new Map(),      // deviceId -> {conn, id, name, last, ready, outgoing}
    contacts: new Map(),   // deviceId -> {key, room, id, name, lastSeen, blocked}
    dialing: new Set(), locked: false, stopped: true, serverOk: false, libOk: false, libFail: false,
    lastDisc: 0, timer: null, restartT: null
  };

  /* ---- أحداث بسيطة ---- */
  const subs = {};
  N.on = (e, fn) => { (subs[e] = subs[e] || []).push(fn); };
  const emit = (e, a, b) => (subs[e] || []).forEach(fn => { try { fn(a, b); } catch (x) { console.error(x); } });

  const validId = id => typeof id === 'string' && /^[a-z0-9]{6,16}$/.test(id);
  const mainId = id => 'pcm-' + N.rid + '-' + id;
  const beaconId = () => 'pcb-' + N.rid;
  const cleanName = x => String(x || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24) || 'جهاز';
  const send = (st, o) => { try { if (st.conn.open) st.conn.send(o); } catch {} };
  const closeConn = c => { try { c.close(); } catch {} };
  const strip = m => ({ id: m.id, ts: m.ts, from: m.from, fromName: m.fromName, to: m.to, text: m.deleted ? '' : m.text, rev: m.rev || 0, deleted: m.deleted || 0, edited: m.edited || 0 });
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
    p.on('open', () => { N.serverOk = true; emit('status'); claimBeacon(); discover(); connectKnown(); });
    p.on('connection', c => onConn(c, false));
    p.on('disconnected', () => {
      N.serverOk = false; emit('status');
      setTimeout(() => { if (N.peer === p && !p.destroyed) { try { p.reconnect(); } catch {} } }, 2000);
    });
    p.on('error', e => {
      if (e.type === 'peer-unavailable') return;           // جهاز غير متصل الآن: طبيعي
      if (e.type === 'unavailable-id') return restartSoon(4000); // الجلسة السابقة ما زالت مسجّلة
      N.serverOk = false; emit('status'); restartSoon(5000);
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

  N.wake = () => {
    if (N.stopped || !N.libOk) return;
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
    const k = N.contacts.get(st.id);
    if (k) { k.lastSeen = Date.now(); PC.putContact(k); }
    emit('presence'); emit('offline', { id: st.id, name: st.name });
  }

  function onData(st, d) {
    if (!d || typeof d !== 'object') return;
    if (!st.ready) { if (d.t === 'hello') onHello(st, d); return; }
    st.last = Date.now();
    switch (d.t) {
      case 'msg': onMsg(st, d.m); break;
      case 'ack': onAck(st, d.a); break;
      case 'ping': send(st, { t: 'pong' }); break;
      case 'name': {
        const k = N.contacts.get(st.id);
        st.name = cleanName(d.name);
        if (k) { k.name = st.name; PC.putContact(k); }
        emit('presence'); emit('contacts'); break;
      }
      case 'bye': closeConn(st.conn); drop(st); break;
    }
  }

  function onHello(st, d) {
    const id = String(d.id || '');
    if (!validId(id) || id === N.me.id || st.conn.peer !== mainId(id)) return closeConn(st.conn); // منع انتحال الهوية
    const known = N.contacts.get(id);
    if (known && known.blocked) { send(st, { t: 'bye', r: 'blocked' }); return closeConn(st.conn); }
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
    flush(id);
  }

  /* ---- الرسائل ---- */
  async function flush(id) {
    const st = N.conns.get(id); if (!st) return;
    for (const m of await PC.roomMsgs(N.rid)) {
      if (m.from !== N.me.id) continue;
      if (m.to !== '*' && m.to !== id) continue;
      if (!pendingFor(m, id)) continue;
      send(st, { t: 'msg', m: strip(m) });
    }
  }

  /* يخزّن رسالة واردة أو تحديثاً لها (تعديل/حذف) من اتصال مباشر أو من خادم الاحتفاظ.
     يعيد رقم النسخة المحفوظة (للتأكيد) أو -1 إن كانت غير صالحة. */
  async function ingest(fromId, m) {
    if (!m || typeof m !== 'object') return -1;
    if (typeof m.id !== 'string' || m.id.length > 40 || typeof m.text !== 'string' || m.text.length > PC.MAX_TEXT) return -1;
    if (!m.deleted && !m.text) return -1;
    if (m.from !== fromId || (m.to !== '*' && m.to !== N.me.id)) return -1;
    const rev = Math.max(0, Math.floor(Number(m.rev) || 0));
    const ex = await PC.getMsg(m.id);
    if (ex) {
      if (ex.from !== fromId) return -1;
      if (rev > (ex.rev || 0) && !ex.deleted) {
        ex.rev = rev;
        if (m.deleted) { ex.deleted = Number(m.deleted) || Date.now(); ex.text = ''; }
        else { ex.text = m.text; ex.edited = Number(m.edited) || Date.now(); }
        await PC.putMsg(ex); emit('upd', ex);
      }
      return ex.rev || 0;
    }
    const k = N.contacts.get(fromId);
    const rec = {
      id: m.id, room: N.rid, ts: Number(m.ts) || Date.now(), from: fromId, fromName: cleanName(m.fromName || (k && k.name)),
      to: m.to, text: m.deleted ? '' : m.text, rev, deleted: m.deleted ? (Number(m.deleted) || Date.now()) : 0,
      edited: !m.deleted && m.edited ? Number(m.edited) : 0, rts: Date.now()
    };
    await PC.putMsg(rec); emit('msg', rec);
    return rev;
  }

  async function onMsg(st, m) {
    const r = await ingest(st.id, m);
    if (r >= 0) send(st, { t: 'ack', a: [{ id: m.id, rev: r }] });
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

  N.sendText = async (text, to) => {
    text = String(text || '').trim().slice(0, PC.MAX_TEXT);
    if (!text) return null;
    const m = { id: PC.rand(16), room: N.rid, ts: Date.now(), from: N.me.id, fromName: N.me.name, to, text, rev: 0, acks: {}, ackRev: {} };
    await PC.putMsg(m); emit('msg', m);
    pushMsg(m);
    return m;
  };

  function pushMsg(m) {
    if (m.to === '*') N.conns.forEach(st => send(st, { t: 'msg', m: strip(m) }));
    else { const st = N.conns.get(m.to); if (st) send(st, { t: 'msg', m: strip(m) }); }
  }

  /* تعديل رسالتي: يصل للأجهزة المتصلة فوراً، وللبقية عند اتصالها (أو عبر خادم الاحتفاظ) */
  N.editMsg = async (id, text) => {
    text = String(text || '').trim().slice(0, PC.MAX_TEXT);
    const m = await PC.getMsg(id);
    if (!m || m.from !== N.me.id || m.deleted || !text) return null;
    if (m.text === text) return m;
    m.text = text; m.edited = Date.now(); m.rev = (m.rev || 0) + 1;
    await PC.putMsg(m); emit('upd', m); pushMsg(m);
    return m;
  };

  /* حذف رسالتي للجميع: يبقى أثر «حُذفت هذه الرسالة» ويُمسح النص عند الطرف الآخر */
  N.deleteMsg = async id => {
    const m = await PC.getMsg(id);
    if (!m || m.from !== N.me.id || m.deleted) return null;
    m.deleted = Date.now(); m.text = ''; m.rev = (m.rev || 0) + 1;
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
  N.onlineList = () => [...N.conns.values()].map(s => ({ id: s.id, name: s.name }));
  N.cleanName = cleanName;

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

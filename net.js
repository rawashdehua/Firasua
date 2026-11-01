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
  const strip = m => ({ id: m.id, ts: m.ts, from: m.from, fromName: m.fromName, to: m.to, text: m.text });

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
    const p = new Peer(mainId(N.me.id), { debug: 0 });
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
    const b = new Peer(beaconId(), { debug: 0 });
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
    b.on('error', e => { lost(); if (e.type === 'unavailable-id') setTimeout(discover, 800); });
    b.on('disconnected', lost);
    b.on('close', () => { if (N.beacon === b) N.beacon = null; });
  }

  function discover() {
    if (N.stopped || !N.peer || !N.serverOk || N.beacon) return;
    if (Date.now() - N.lastDisc < 4000) return;
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
      case 'ack': onAck(st, d.ids); break;
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
      if (m.acks && m.acks[id]) continue;
      send(st, { t: 'msg', m: strip(m) });
    }
  }

  async function onMsg(st, m) {
    if (!m || typeof m !== 'object') return;
    if (typeof m.id !== 'string' || m.id.length > 40 || typeof m.text !== 'string' || !m.text || m.text.length > PC.MAX_TEXT) return;
    if (m.from !== st.id || (m.to !== '*' && m.to !== N.me.id)) return;
    const ex = await PC.getMsg(m.id);
    if (!ex) {
      const rec = { id: m.id, room: N.rid, ts: Number(m.ts) || Date.now(), from: st.id, fromName: cleanName(m.fromName || st.name), to: m.to, text: m.text, rts: Date.now() };
      await PC.putMsg(rec); emit('msg', rec);
    } else if (ex.from !== st.id) return;
    send(st, { t: 'ack', ids: [m.id] });
  }

  async function onAck(st, ids) {
    if (!Array.isArray(ids)) return;
    for (const id of ids.slice(0, 200)) {
      if (typeof id !== 'string') continue;
      const m = await PC.getMsg(id);
      if (!m || m.from !== N.me.id || (m.to !== '*' && m.to !== st.id)) continue;
      m.acks = m.acks || {}; if (m.acks[st.id]) continue;
      m.acks[st.id] = Date.now();
      await PC.putMsg(m); emit('ack', m);
    }
  }

  N.sendText = async (text, to) => {
    text = String(text || '').trim().slice(0, PC.MAX_TEXT);
    if (!text) return;
    const m = { id: PC.rand(16), room: N.rid, ts: Date.now(), from: N.me.id, fromName: N.me.name, to, text, acks: {} };
    await PC.putMsg(m); emit('msg', m);
    if (to === '*') N.conns.forEach(st => send(st, { t: 'msg', m: strip(m) }));
    else { const st = N.conns.get(to); if (st) send(st, { t: 'msg', m: strip(m) }); }
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
})();

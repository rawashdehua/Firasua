'use strict';
/* ===== عميل خادم الاحتفاظ (اختياري) =====
   يعمل عند وجود رابط: من الإعدادات داخل التطبيق (يُحفظ على الجهاز) أو PC.RELAY.url في store.js.
   الرسائل تُشفَّر على الجهاز قبل رفعها، والخادم لا يرى نصها. */
(() => {
  const N = PC.net, R = PC.RELAY || {};
  const DAY = 86400000;
  let key = null, keyRid = null, busy = false;

  const url = () => (PC.ls.get('relay_url') || R.url || '').trim().replace(/\/+$/, '');
  const on = () => !!(url() && R.token && R.secret);
  PC.relay = { state: on() ? 'idle' : 'off', lastOk: 0, url };
  const setState = s => { if (PC.relay.state !== s) { PC.relay.state = s; N.emit('status'); } };

  /* رابط مقبول: https، أو http على الجهاز نفسه فقط (للتجربة) */
  PC.relay.valid = u => /^https:\/\/[^\s/]+/i.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(u);

  /* ---- التشفير: AES-GCM، المفتاح من (secret + معرّف الغرفة) ---- */
  const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = t => Uint8Array.from(atob(t), c => c.charCodeAt(0));
  async function ensureKey() {
    if (key && keyRid === N.rid) return;
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(R.secret), 'PBKDF2', false, ['deriveKey']);
    key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: new TextEncoder().encode('pc1-relay:' + N.rid), iterations: 60000, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    keyRid = N.rid;
  }
  async function enc(obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
    const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
    return b64(out);
  }
  async function dec(text) {
    try {
      const u = unb64(text);
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.subarray(0, 12) }, key, u.subarray(12));
      return JSON.parse(new TextDecoder().decode(pt));
    } catch { return null; }
  }

  /* ---- الطلبات ---- */
  async function api(path, body) {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 12000);
    try {
      const res = await fetch(url() + path, {
        method: body ? 'POST' : 'GET', signal: ac.signal,
        headers: { 'x-token': R.token, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
      });
      if (!res.ok) throw new Error('http ' + res.status);
      return await res.json();
    } finally { clearTimeout(t); }
  }

  /* فحص سريع للرابط: هل الخادم يعمل ويقبل الرمز؟  يعيد 'ok' | 'auth' | 'down' */
  PC.relay.check = async candidate => {
    const base = (candidate || url()).replace(/\/+$/, '');
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 10000);
    try {
      const h = await fetch(base + '/health', { signal: ac.signal });
      if (!h.ok) return 'down';
      const rid = N.rid || '0'.repeat(20);
      const r = await fetch(base + '/pull?room=' + rid + '&me=' + (N.me ? N.me.id : 'probe00000'), { signal: ac.signal, headers: { 'x-token': R.token } });
      return r.status === 401 ? 'auth' : r.ok ? 'ok' : 'down';
    } catch { return 'down'; } finally { clearTimeout(t); }
  };

  PC.relay.set = u => {
    u = (u || '').trim().replace(/\/+$/, '');
    if (u) PC.ls.set('relay_url', u); else PC.ls.del('relay_url');
    key = null; setState(on() ? 'idle' : 'off'); N.emit('status');
    if (on()) poll();
  };

  /* ---- الرفع ---- */
  function needsRelay(m) {
    if (m.from !== N.me.id || Date.now() - m.ts > 13 * DAY) return false;
    if (m.relayed && (m.relayedRev || 0) >= (m.rev || 0) && Date.now() - m.relayed < 30 * 60000) return false;
    if (m.to !== '*') return N.pendingFor(m, m.to) && !N.conns.has(m.to);
    const targets = [...N.contacts.values()].filter(c => !c.blocked);
    if (!targets.length) return !Object.keys(m.acks || {}).length;
    return targets.some(c => N.pendingFor(m, c.id) && !N.conns.has(c.id));
  }

  async function upload(m) {
    await ensureKey();
    const data = await enc({ text: m.text, fromName: m.fromName, deleted: m.deleted || 0, edited: m.edited || 0 });
    await api('/put', { room: N.rid, id: m.id, from: m.from, to: m.to, ts: m.ts, rev: m.rev || 0, data });
    const rev = m.rev || 0;
    await N.patchMsg(m.id, x => { x.relayed = Date.now(); x.relayedRev = rev; });
  }

  async function sweep() {
    let n = 0;
    for (const m of await PC.roomMsgs(N.rid)) {
      if (n >= 20) break;
      if (needsRelay(m)) { await upload(m); n++; }
    }
  }

  /* ---- الاستلام ---- */
  async function poll() {
    if (!on() || !N.rid || N.stopped || busy) return;
    busy = true;
    try {
      await ensureKey();
      await sweep();
      const r = await api('/pull?room=' + N.rid + '&me=' + N.me.id);
      const took = [], done = [];
      for (const it of r.items || []) {
        const rev = Number(it.rev) || 0;
        took.push({ id: it.id, rev });
        if (!N.validId(it.from)) continue;
        const k = N.contacts.get(it.from);
        if ((k && k.blocked) || (!k && N.locked)) continue;
        const p = await dec(it.data); if (!p) continue;
        const ok = await N.ingest(it.from, { id: it.id, from: it.from, to: it.to, ts: it.ts, rev, text: p.text, fromName: p.fromName, deleted: p.deleted, edited: p.edited });
        if (ok >= 0 && !k) N.relayContact(it.from, p.fromName);
      }
      for (const x of r.receipts || []) { done.push(x.k); if (N.validId(x.by)) await N.markAck(x.id, x.by, Number(x.rev) || 0); }
      if (took.length || done.length) await api('/ack', { room: N.rid, me: N.me.id, items: took, rids: done });
      PC.relay.lastOk = Date.now(); setState('ok');
    } catch { setState('err'); }
    finally { busy = false; }
  }

  /* ---- ربط مع الإرسال والتعديل والحذف ---- */
  const wrap = name => {
    const orig = N[name];
    N[name] = async (...a) => {
      const m = await orig(...a);
      if (m && on() && needsRelay(m)) { try { await upload(m); setState('ok'); } catch { setState('err'); } }
      return m;
    };
  };
  ['sendText', 'editMsg', 'deleteMsg'].forEach(wrap);

  setInterval(poll, R.pollMs || 15000);
  setTimeout(poll, 2500);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  window.addEventListener('online', poll);
  N.on('online', () => poll());   // عند اتصال أحد مباشرة نحدّث الإيصالات والرسائل
})();

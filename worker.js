/* خادم احتفاظ بالرسائل المشفّرة على Cloudflare Workers + Durable Objects (نفس واجهة relay-server.js تماماً).
   لا يرى نص الرسائل (مشفّرة من الجهاز)، ويرى الأوقات ومعرّفات الأجهزة والغرفة المشتقة فقط.
   كل رمز (مشتق من كود الغرفة داخل التطبيق) له فضاء مستقل؛ أو ضع RELAY_TOKEN كسرّ في Cloudflare لرمز واحد ثابت. */
const TTL = 14 * 86400000, MAX_ROOM_MSGS = 500, MAX_BODY = 24 * 1024, MAX_DATA = 12000;
const TOK = /^[a-f0-9]{64}$/, RID = /^[a-f0-9]{20}$/, DEV = /^[a-z0-9]{6,16}$/, MID = /^[A-Za-z0-9_-]{1,40}$/;
const PUSH_HOSTS = /(^|\.)(googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/i;
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,x-token', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'cache-control': 'no-store' };
const json = (obj, status = 200) => new Response(status === 204 ? null : JSON.stringify(obj), { status, headers: { ...CORS, 'content-type': 'application/json; charset=utf-8' } });
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const b64u = u8 => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const okEndpoint = (e, any) => { try { const u = new URL(e); if (e.length > 1000) return false; if (any) return u.protocol === 'https:' || u.protocol === 'http:'; return u.protocol === 'https:' && PUSH_HOSTS.test(u.hostname); } catch { return false; } };

/* تحديد معدل بسيط لكل عنوان (لكل نسخة تشغيل) */
const hits = new Map(); let hitsAt = 0;
const limited = ip => { const now = Date.now(); if (now - hitsAt > 60000) { hits.clear(); hitsAt = now; } const n = (hits.get(ip) || 0) + 1; hits.set(ip, n); return n > 240; };

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return json({}, 204);
    const u = new URL(req.url), path = u.pathname;
    if (path === '/health') return json({ ok: true });
    if (limited(req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'x')) return json({ error: 'rate' }, 429);
    const tk = req.headers.get('x-token') || '';
    const fixed = env.RELAY_TOKEN || '';
    if (fixed ? tk !== fixed : !TOK.test(tk)) return json({ error: 'auth' }, 401);
    const ns = fixed ? 'f' : hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('ns:' + tk))).slice(0, 16);

    if (req.method === 'GET' && path === '/push-key') {
      const r = await env.META.get(env.META.idFromName('meta')).fetch('https://do/key');
      return json(await r.json());
    }
    const call = (room, op, init) => env.ROOMS.get(env.ROOMS.idFromName(ns + ':' + room)).fetch('https://do/' + op + (init && init.q ? init.q : ''), init && init.body ? { method: 'POST', body: init.body } : undefined);
    const bad = () => json({ error: 'bad' }, 400);
    const relay = async r => json(await r.json(), r.status);

    try {
      if (req.method === 'GET' && path === '/pull') {
        const room = u.searchParams.get('room'), me = u.searchParams.get('me');
        if (!RID.test(room) || !DEV.test(me)) return bad();
        return relay(await call(room, 'pull', { q: '?me=' + me }));
      }
      if (req.method !== 'POST' || !['/put', '/read', '/push-sub', '/push-unsub', '/ack'].includes(path)) return json({ error: 'nf' }, 404);
      const text = await req.text(); if (text.length > MAX_BODY) return bad();
      let b; try { b = JSON.parse(text || '{}'); } catch { return bad(); }
      if (!b || typeof b !== 'object' || !RID.test(b.room)) return bad();
      if (path === '/put') {
        if (!MID.test(b.id) || !DEV.test(b.from) || !(b.to === '*' || DEV.test(b.to)) || typeof b.data !== 'string' || b.data.length > MAX_DATA) return bad();
      } else if (!DEV.test(b.me)) return bad();
      if (path === '/read' && !Array.isArray(b.reads)) return bad();
      if (path === '/push-sub' && !(typeof b.endpoint === 'string' && okEndpoint(b.endpoint, env.PUSH_ALLOW_ANY === '1'))) return bad();
      b._any = env.PUSH_ALLOW_ANY === '1';
      return relay(await call(b.room, path.slice(1), { body: JSON.stringify(b) }));
    } catch { return bad(); }
  }
};

/* ---- غرفة واحدة = Durable Object واحد (تخزين دائم) ---- */
export class Room {
  constructor(state, env) {
    this.state = state; this.env = env; this.msgs = new Map(); this.x = { rcpt: {}, subs: {} }; this.lastPush = new Map();
    state.blockConcurrencyWhile(async () => {
      for (const [k, v] of await state.storage.list({ prefix: 'm:' })) this.msgs.set(k.slice(2), v);
      this.x = (await state.storage.get('x')) || this.x; this.x.subs = this.x.subs || {};
    });
  }
  saveX() { return this.state.storage.put('x', this.x); }
  async arm() { if (!(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(Date.now() + 6 * 3600000); }

  async alarm() {
    const lim = Date.now() - TTL;
    for (const [id, m] of [...this.msgs]) if (m.ts <= lim) { this.msgs.delete(id); await this.state.storage.delete('m:' + id); }
    for (const [d, s] of Object.entries(this.x.subs)) if (s.ts < Date.now() - 60 * 86400000) delete this.x.subs[d];
    for (const k of Object.keys(this.x.rcpt)) { this.x.rcpt[k] = this.x.rcpt[k].filter(y => y.ts > lim); if (!this.x.rcpt[k].length) delete this.x.rcpt[k]; }
    if (!this.msgs.size && !Object.keys(this.x.rcpt).length && !Object.keys(this.x.subs).length) { await this.state.storage.deleteAll(); return; }
    await this.saveX(); await this.state.storage.setAlarm(Date.now() + 6 * 3600000);
  }

  async fetch(req) {
    const u = new URL(req.url), op = u.pathname.slice(1);
    if (op === 'pull') return this.pull(u.searchParams.get('me'));
    const b = await req.json();
    switch (op) {
      case 'put': return this.put(b);
      case 'read': return this.read(b);
      case 'push-sub': return this.pushSub(b);
      case 'push-unsub': { if (this.x.subs[b.me]) { delete this.x.subs[b.me]; await this.saveX(); } return Response.json({ ok: true }); }
      case 'ack': return this.ack(b);
    }
    return Response.json({ error: 'nf' }, { status: 404 });
  }

  async put(b) {
    const rev = Math.max(0, Math.floor(Number(b.rev) || 0)), ex = this.msgs.get(b.id);
    if (ex) {
      if (ex.from !== b.from || rev <= (ex.rev || 0)) return Response.json({ ok: true, dup: true });
      ex.rev = rev; ex.data = b.data; ex.taken = {};                 // تعديل/حذف: يُعاد تسليمه لمن استلم النسخة القديمة
      await this.state.storage.put('m:' + b.id, ex); await this.arm(); return Response.json({ ok: true, updated: true });
    }
    const m = { id: b.id, from: b.from, to: b.to, ts: Number(b.ts) || Date.now(), rev, data: b.data, taken: {} };
    this.msgs.set(b.id, m); await this.state.storage.put('m:' + b.id, m);
    if (this.msgs.size > MAX_ROOM_MSGS) {
      const old = [...this.msgs.values()].sort((p, q) => p.ts - q.ts).slice(0, this.msgs.size - MAX_ROOM_MSGS);
      for (const o of old) { this.msgs.delete(o.id); await this.state.storage.delete('m:' + o.id); }
    }
    await this.arm();
    if (rev === 0) this.state.waitUntil(this.notify(b.from, b.to, b._any).catch(() => {}));
    return Response.json({ ok: true });
  }

  async read(b) {                                                    // إيصالات «قُرئت» لمرسلين غير متصلين
    for (const x of b.reads.slice(0, 200)) {
      if (!x || !MID.test(x.id) || !DEV.test(x.to) || x.to === b.me) continue;
      const list = this.x.rcpt[x.to] || (this.x.rcpt[x.to] = []), k = x.id + '|' + b.me + '|r';
      if (list.length < 1500 && !list.some(y => y.k === k)) list.push({ k, id: x.id, by: b.me, read: 1, ts: Date.now() });
    }
    await this.saveX(); await this.arm(); return Response.json({ ok: true });
  }

  async pushSub(b) {
    if (!this.x.subs[b.me] && Object.keys(this.x.subs).length >= 50) return Response.json({ error: 'full' }, { status: 400 });
    this.x.subs[b.me] = { endpoint: b.endpoint, ts: Date.now() };
    await this.saveX(); await this.arm(); return Response.json({ ok: true });
  }

  pull(me) {
    const items = [...this.msgs.values()].filter(m => m.from !== me && (m.to === '*' || m.to === me) && !m.taken[me]).sort((a, b) => a.ts - b.ts).slice(0, 200)
      .map(m => ({ id: m.id, from: m.from, to: m.to, ts: m.ts, rev: m.rev || 0, data: m.data }));
    return Response.json({ items, receipts: (this.x.rcpt[me] || []).slice(0, 500) });
  }

  async ack(b) {
    for (const x of (Array.isArray(b.items) ? b.items : []).slice(0, 300)) {
      if (!x || typeof x.id !== 'string') continue;
      const rev = Math.max(0, Math.floor(Number(x.rev) || 0)), m = this.msgs.get(x.id);
      if (!m || !(m.to === '*' || m.to === b.me) || m.from === b.me) continue;
      if (rev < (m.rev || 0)) continue;                              // تأكيد لنسخة أقدم: ما زال هناك تحديث لم يُستلم
      if (!m.taken[b.me]) {
        m.taken[b.me] = Date.now();
        const list = this.x.rcpt[m.from] || (this.x.rcpt[m.from] = []), k = m.id + '|' + b.me + '|' + rev;
        if (!list.some(y => y.k === k)) list.push({ k, id: m.id, by: b.me, rev, ts: Date.now() });
        if (m.to === b.me) { this.msgs.delete(m.id); await this.state.storage.delete('m:' + m.id); }   // رسالة خاصة استُلمت: تُحذف
        else await this.state.storage.put('m:' + m.id, m);
      }
    }
    const gone = new Set(Array.isArray(b.rids) ? b.rids : []);
    if (gone.size && this.x.rcpt[b.me]) { this.x.rcpt[b.me] = this.x.rcpt[b.me].filter(x => !gone.has(x.k)); if (!this.x.rcpt[b.me].length) delete this.x.rcpt[b.me]; }
    await this.saveX(); return Response.json({ ok: true });
  }

  /* إشعار Web Push فارغ المحتوى (لا يمرّ أي نص عبر خدمة الدفع) */
  async notify(from, to, any) {
    const subs = this.x.subs, targets = (to === '*' ? Object.keys(subs).filter(d => d !== from) : (subs[to] ? [to] : [])).slice(0, 10);
    const meta = this.env.META.get(this.env.META.idFromName('meta'));
    for (const d of targets) {
      const now = Date.now(); if (now - (this.lastPush.get(d) || 0) < 8000) continue;
      this.lastPush.set(d, now);
      const ep = subs[d].endpoint;
      if (!okEndpoint(ep, any)) continue;
      const r = await (await meta.fetch('https://do/jwt', { method: 'POST', body: JSON.stringify({ aud: new URL(ep).origin, sub: this.env.VAPID_SUBJECT || 'mailto:admin@example.com' }) })).json();
      let code = 0;
      try { code = (await fetch(ep, { method: 'POST', body: '', headers: { Authorization: 'vapid t=' + r.jwt + ', k=' + r.pub, TTL: '86400', Urgency: 'high' } })).status; } catch {}
      if ((code === 404 || code === 410) && subs[d] && subs[d].endpoint === ep) { delete subs[d]; await this.saveX(); }
    }
  }
}

/* ---- مفاتيح VAPID: تُولَّد مرة واحدة وتُحفظ دائماً ---- */
export class Meta {
  constructor(state) { this.state = state; this.jwts = new Map(); this.k = null; }
  async keys() {
    if (this.k) return this.k;
    let v = await this.state.storage.get('vapid');
    if (!v) {
      const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      v = { pub: b64u(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))), jwk: await crypto.subtle.exportKey('jwk', kp.privateKey) };
      await this.state.storage.put('vapid', v);
    }
    this.k = { pub: v.pub, priv: await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) };
    return this.k;
  }
  async fetch(req) {
    const { pub, priv } = await this.keys(), op = new URL(req.url).pathname;
    if (op === '/key') return Response.json({ key: pub });
    const { aud, sub } = await req.json(), c = this.jwts.get(aud);
    if (c && c.exp > Date.now() + 600000) return Response.json({ jwt: c.t, pub });
    const exp = Date.now() + 12 * 3600000, enc = new TextEncoder();
    const h = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))), p = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(exp / 1000), sub })));
    const sig = b64u(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, enc.encode(h + '.' + p))));
    const t = h + '.' + p + '.' + sig; this.jwts.set(aud, { t, exp });
    return Response.json({ jwt: t, pub });
  }
}

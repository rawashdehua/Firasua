'use strict';
/* خادم احتفاظ اختياري بالرسائل المشفّرة للأجهزة غير المتصلة (بدون أي مكتبات خارجية).
   التشغيل:  RELAY_TOKEN=الرمز node relay-server.js
   متغيرات اختيارية: PORT (8787) · DATA_FILE (relay-data.json) · TTL_DAYS (14)
   إشعارات الخلفية (Web Push): VAPID_SUBJECT = mailto:بريدك أو رابط موقعك (يُنصح بضبطه)
   الخادم لا يرى نص الرسائل (مشفّرة AES-GCM من الجهاز)، ويرى فقط معرّف الغرفة المشتق ومعرّفات الأجهزة والأوقات. */
const http = require('http'), https = require('https'), fs = require('fs'), crypto = require('crypto');

const TOKEN = process.env.RELAY_TOKEN || '';
const PORT = +process.env.PORT || 8787;
const FILE = process.env.DATA_FILE || 'relay-data.json';
const TTL = (+process.env.TTL_DAYS || 14) * 86400000;
const MAX_ROOM_MSGS = 3000, MAX_BODY = 24 * 1024, MAX_DATA = 12000;

/* بدون RELAY_TOKEN: وضع التطبيق التلقائي — كل رمز (مشتق من كود الغرفة في التطبيق) له فضاء مستقل لا يصل إليه غيره */
const OPEN = !TOKEN;
const TOK = /^[a-f0-9]{64}$/;

let db = { rooms: {} }, dirty = false;
try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
if (!db.rooms) db.rooms = {};
const room = rid => db.rooms[rid] || (db.rooms[rid] = { msgs: [], rcpt: {}, subs: {} });

/* ---- Web Push (VAPID) بدون مكتبات: إشعار فارغ المحتوى، فلا يمرّ أي نص عبر خدمة الدفع ---- */
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const ALLOW_ANY_PUSH = process.env.PUSH_ALLOW_ANY === '1';             // للاختبار المحلي فقط
const PUSH_HOSTS = /(^|\.)(googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/i;
/* على الاستضافة المجانية يُمسح القرص: مرّر المفتاحين كمتغيرات بيئة لتبقى الاشتراكات صالحة (VAPID_PUB و VAPID_PRIV بصيغة PEM مع \n) */
if (process.env.VAPID_PUB && process.env.VAPID_PRIV) db.vapid = { pub: process.env.VAPID_PUB, priv: process.env.VAPID_PRIV.replace(/\\n/g, '\n') };
/* VAPID_SEED: مفاتيح ثابتة تُشتق من نص سرّي (يولّده Render تلقائياً) فلا تتعطل الإشعارات عند مسح القرص */
if (process.env.VAPID_SEED) {
  const d = crypto.createHash('sha256').update('vapid:' + process.env.VAPID_SEED).digest(), ec = crypto.createECDH('prime256v1');
  ec.setPrivateKey(d);
  const pub = ec.getPublicKey(), pk = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: d.toString('base64url'), x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  db.vapid = { pub: pub.toString('base64url'), priv: pk.export({ format: 'pem', type: 'pkcs8' }) };
}
if (!db.vapid) {
  const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = kp.publicKey.export({ format: 'jwk' });
  db.vapid = {
    pub: Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')]).toString('base64url'),
    priv: kp.privateKey.export({ format: 'pem', type: 'pkcs8' })
  };
  fs.writeFile(FILE, JSON.stringify(db), () => {});
}
const b64u = x => Buffer.from(x).toString('base64url');
const jwtCache = new Map();
function vapidJwt(aud) {
  const c = jwtCache.get(aud); if (c && c.exp > Date.now() + 600000) return c.t;
  const exp = Date.now() + 12 * 3600000;
  const h = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' })), p = b64u(JSON.stringify({ aud, exp: Math.floor(exp / 1000), sub: SUBJECT }));
  const sig = crypto.sign('sha256', Buffer.from(h + '.' + p), { key: db.vapid.priv, dsaEncoding: 'ieee-p1363' });
  const t = h + '.' + p + '.' + b64u(sig); jwtCache.set(aud, { t, exp }); return t;
}
function okEndpoint(e) {
  try { const u = new URL(e); if (e.length > 1000) return false;
    if (ALLOW_ANY_PUSH) return u.protocol === 'https:' || u.protocol === 'http:';
    return u.protocol === 'https:' && PUSH_HOSTS.test(u.hostname); } catch { return false; }
}
function pushOnce(endpoint) {
  return new Promise(resolve => {
    const u = new URL(endpoint), lib = u.protocol === 'http:' ? http : https;
    const rq = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname + u.search, method: 'POST', timeout: 8000,
      headers: { Authorization: 'vapid t=' + vapidJwt(u.origin) + ', k=' + db.vapid.pub, TTL: '86400', Urgency: 'high', 'Content-Length': '0' }
    }, res => { res.resume(); resolve(res.statusCode); });
    rq.on('timeout', () => { rq.destroy(); resolve(0); });
    rq.on('error', () => resolve(0));
    rq.end();
  });
}
const lastPush = new Map();
function notifyPush(rid, from, to) {
  const r = db.rooms[rid]; if (!r || !r.subs) return;
  const targets = to === '*' ? Object.keys(r.subs).filter(d => d !== from) : (r.subs[to] ? [to] : []);
  for (const d of targets) {
    const key = rid + '|' + d, now = Date.now();
    if (now - (lastPush.get(key) || 0) < 8000) continue;      // لا نكرّر الإشعار إن كان آخر واحد حديثاً
    lastPush.set(key, now);
    const ep = r.subs[d].endpoint;
    pushOnce(ep).then(code => {
      if (code === 404 || code === 410) { if (r.subs[d] && r.subs[d].endpoint === ep) { delete r.subs[d]; dirty = true; } }
    });
  }
}
setInterval(() => { const lim = Date.now() - 600000; for (const [k, t] of lastPush) if (t < lim) lastPush.delete(k); }, 600000);

const RID = /^[a-f0-9]{20}$/, DEV = /^[a-z0-9]{6,16}$/, MID = /^[A-Za-z0-9_-]{1,40}$/;

function save() {
  if (!dirty) return; dirty = false;
  fs.writeFile(FILE + '.tmp', JSON.stringify(db), err => { if (!err) fs.rename(FILE + '.tmp', FILE, () => {}); });
}
function purge() {
  const lim = Date.now() - TTL;
  for (const [rid, r] of Object.entries(db.rooms)) {
    r.msgs = r.msgs.filter(m => m.ts > lim);
    r.subs = r.subs || {};
    for (const [d, x] of Object.entries(r.subs)) if (x.ts < Date.now() - 60 * 86400000) delete r.subs[d];
    for (const k of Object.keys(r.rcpt)) { r.rcpt[k] = r.rcpt[k].filter(x => x.ts > lim); if (!r.rcpt[k].length) delete r.rcpt[k]; }
    if (!r.msgs.length && !Object.keys(r.rcpt).length && !Object.keys(r.subs).length) delete db.rooms[rid];
  }
  dirty = true;
}
setInterval(save, 5000); setInterval(purge, 3600000); purge();

/* تحديد معدل بسيط لكل عنوان */
const hits = new Map();
setInterval(() => hits.clear(), 60000);
const limited = ip => { const n = (hits.get(ip) || 0) + 1; hits.set(ip, n); return n > 240; };

const send = (res, code, obj) => {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type,x-token',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(obj));
};
const body = req => new Promise((ok, no) => {
  let s = '';
  req.on('data', c => { s += c; if (s.length > MAX_BODY) { no(new Error('big')); req.destroy(); } });
  req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch (e) { no(e); } });
  req.on('error', no);
});

http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/health') return send(res, 200, { ok: true });
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    if (limited(ip)) return send(res, 429, { error: 'rate' });
    const tk = String(req.headers['x-token'] || '');
    if (OPEN ? !TOK.test(tk) : tk !== TOKEN) return send(res, 401, { error: 'auth' });
    const NS = OPEN ? crypto.createHash('sha256').update('ns:' + tk).digest('hex').slice(0, 16) + ':' : '';

    if (req.method === 'POST' && u.pathname === '/put') {
      const b = await body(req);
      if (!RID.test(b.room) || !MID.test(b.id) || !DEV.test(b.from) || !(b.to === '*' || DEV.test(b.to))
        || typeof b.data !== 'string' || b.data.length > MAX_DATA) return send(res, 400, { error: 'bad' });
      const r = room(NS + b.room), rev = Math.max(0, Math.floor(Number(b.rev) || 0));
      const ex = r.msgs.find(m => m.id === b.id);
      if (ex) {
        if (ex.from !== b.from || rev <= (ex.rev || 0)) return send(res, 200, { ok: true, dup: true });
        ex.rev = rev; ex.data = b.data; ex.taken = {};            // تعديل/حذف: يُعاد تسليمه لمن استلم النسخة القديمة
        dirty = true; return send(res, 200, { ok: true, updated: true });
      }
      r.msgs.push({ id: b.id, from: b.from, to: b.to, ts: Number(b.ts) || Date.now(), rev, data: b.data, taken: {} });
      if (r.msgs.length > MAX_ROOM_MSGS) r.msgs.splice(0, r.msgs.length - MAX_ROOM_MSGS);
      dirty = true; send(res, 200, { ok: true });
      if (rev === 0) notifyPush(NS + b.room, b.from, b.to);
      return;
    }

    if (req.method === 'POST' && u.pathname === '/read') {      // إيصالات «قُرئت» لمرسلين غير متصلين
      const b = await body(req);
      if (!RID.test(b.room) || !DEV.test(b.me) || !Array.isArray(b.reads)) return send(res, 400, { error: 'bad' });
      const r = room(NS + b.room);
      for (const x of b.reads.slice(0, 200)) {
        if (!x || !MID.test(x.id) || !DEV.test(x.to) || x.to === b.me) continue;
        const list = r.rcpt[x.to] || (r.rcpt[x.to] = []), k = x.id + '|' + b.me + '|r';
        if (list.length < 1500 && !list.some(y => y.k === k)) list.push({ k, id: x.id, by: b.me, read: 1, ts: Date.now() });
      }
      dirty = true; return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && u.pathname === '/push-key') return send(res, 200, { key: db.vapid.pub });

    if (req.method === 'POST' && u.pathname === '/push-sub') {
      const b = await body(req);
      if (!RID.test(b.room) || !DEV.test(b.me) || typeof b.endpoint !== 'string' || !okEndpoint(b.endpoint)) return send(res, 400, { error: 'bad' });
      const r = room(NS + b.room); r.subs = r.subs || {};
      if (!r.subs[b.me] && Object.keys(r.subs).length >= 50) return send(res, 400, { error: 'full' });
      r.subs[b.me] = { endpoint: b.endpoint, ts: Date.now() };
      dirty = true; return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && u.pathname === '/push-unsub') {
      const b = await body(req);
      if (!RID.test(b.room) || !DEV.test(b.me)) return send(res, 400, { error: 'bad' });
      const r = db.rooms[NS + b.room]; if (r && r.subs && r.subs[b.me]) { delete r.subs[b.me]; dirty = true; }
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && u.pathname === '/pull') {
      const rid = u.searchParams.get('room'), me = u.searchParams.get('me');
      if (!RID.test(rid) || !DEV.test(me)) return send(res, 400, { error: 'bad' });
      const r = db.rooms[NS + rid] || { msgs: [], rcpt: {} };
      const items = r.msgs.filter(m => m.from !== me && (m.to === '*' || m.to === me) && !m.taken[me]).slice(0, 200)
        .map(m => ({ id: m.id, from: m.from, to: m.to, ts: m.ts, rev: m.rev || 0, data: m.data }));
      return send(res, 200, { items, receipts: (r.rcpt[me] || []).slice(0, 500) });
    }

    if (req.method === 'POST' && u.pathname === '/ack') {
      const b = await body(req);
      if (!RID.test(b.room) || !DEV.test(b.me)) return send(res, 400, { error: 'bad' });
      const r = room(NS + b.room);
      for (const x of (Array.isArray(b.items) ? b.items : []).slice(0, 300)) {
        if (!x || typeof x.id !== 'string') continue;
        const rev = Math.max(0, Math.floor(Number(x.rev) || 0));
        const i = r.msgs.findIndex(m => m.id === x.id && (m.to === '*' || m.to === b.me) && m.from !== b.me);
        if (i < 0) continue;
        const m = r.msgs[i];
        if (rev < (m.rev || 0)) continue;                 // تأكيد لنسخة أقدم: ما زال هناك تحديث لم يُستلم
        if (!m.taken[b.me]) {
          m.taken[b.me] = Date.now();
          const list = r.rcpt[m.from] || (r.rcpt[m.from] = []);
          const k = m.id + '|' + b.me + '|' + rev;
          if (!list.some(y => y.k === k)) list.push({ k, id: m.id, by: b.me, rev, ts: Date.now() });
          if (m.to === b.me) r.msgs.splice(i, 1);          // رسالة خاصة استُلمت: تُحذف من الخادم
        }
      }
      const gone = new Set(Array.isArray(b.rids) ? b.rids : []);
      if (gone.size && r.rcpt[b.me]) { r.rcpt[b.me] = r.rcpt[b.me].filter(x => !gone.has(x.k)); if (!r.rcpt[b.me].length) delete r.rcpt[b.me]; }
      dirty = true; return send(res, 200, { ok: true });
    }

    send(res, 404, { error: 'nf' });
  } catch (e) { try { send(res, 400, { error: 'bad' }); } catch {} }
}).listen(PORT, () => console.log('relay on :' + PORT));

process.on('SIGTERM', () => { dirty = true; save(); setTimeout(() => process.exit(0), 300); });

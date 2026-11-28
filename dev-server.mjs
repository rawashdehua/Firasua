// تشغيل محلي للتجربة بدون Cloudflare: يحاكي Durable Objects في الذاكرة (للاختبار فقط، البيانات تضيع عند الإيقاف).
// node dev-server.mjs   (متغيرات: PORT، RELAY_TOKEN، PUSH_ALLOW_ANY=1، VAPID_SUBJECT)
import http from 'node:http';
import worker, { Room, Meta } from './worker.js';

function makeState() {
  const m = new Map(); let alarm = null;
  return {
    storage: {
      async get(k) { return m.has(k) ? structuredClone(m.get(k)) : undefined; },
      async put(k, v) { m.set(k, structuredClone(v)); },
      async delete(k) { m.delete(k); },
      async deleteAll() { m.clear(); },
      async list({ prefix = '' } = {}) { return new Map([...m].filter(([k]) => k.startsWith(prefix)).sort().map(([k, v]) => [k, structuredClone(v)])); },
      async getAlarm() { return alarm; }, async setAlarm(t) { alarm = t; }
    },
    blockConcurrencyWhile: fn => fn(), waitUntil: p => p
  };
}
const ns = (Cls, env) => {
  const inst = new Map();
  return {
    idFromName: n => n,
    get: id => ({ fetch: async (url, init) => {
      if (!inst.has(id)) inst.set(id, new Cls(makeState(), env));
      const o = inst.get(id); await o.state?.ready;
      return o.fetch(new Request(url, init));
    } })
  };
};
const env = { RELAY_TOKEN: process.env.RELAY_TOKEN || '', PUSH_ALLOW_ANY: process.env.PUSH_ALLOW_ANY || '', VAPID_SUBJECT: process.env.VAPID_SUBJECT || '' };
env.ROOMS = ns(Room, env); env.META = ns(Meta, env);

http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const r = await worker.fetch(new Request('http://x' + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(+process.env.PORT || 8787, () => console.log('cf-dev relay on :' + (process.env.PORT || 8787)));

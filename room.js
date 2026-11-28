/* إدارة الغرفة: المضيف (من أنشأ الغرفة) يحدّد عدد المستخدمين ويوقف دخول الجدد ويزيل أجهزة ويحذف الدردشة للجميع.
   السياسة نصّ JSON موقّع بمفتاح المضيف (ECDSA P-256) ويتبادله كل جهاز عند كل اتصال؛ لا يقبل أحد سياسة إلا بتوقيع المضيف الذي ثبّته أول مرة.
   تنبيه: التنفيذ تعاوني من جهة التطبيق؛ لا يمنع من يملك الكود ويعدّل التطبيق نفسه. تغيير الكود هو الإلغاء الحقيقي. */
(() => {
  const N = PC.net;
  const te = new TextEncoder();
  const b64u = u8 => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64u = t => Uint8Array.from(atob(t.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const ALG = { name: 'ECDSA', namedCurve: 'P-256' }, SIG = { name: 'ECDSA', hash: 'SHA-256' };
  const kPol = () => 'rp_' + N.rid, kHost = () => 'rh_' + N.rid, kWipe = () => 'rw_' + N.rid, kMk = () => 'mkhost_' + N.rid;
  const J = k => { try { return JSON.parse(PC.ls.get(k)); } catch { return null; } };

  const R = PC.room = {};
  let cache = { rid: null, pol: null, hostKey: null };
  function load() {
    if (cache.rid !== N.rid) cache = { rid: N.rid, pol: J(kPol()), hostKey: J(kHost()) };
    return cache;
  }
  const restricted = b => !!b && (!!b.closed || b.max > 0);

  /* ---- التحقق من سياسة واردة ---- */
  async function verify(p) {
    if (!p || typeof p !== 'object' || typeof p.pub !== 'string' || typeof p.b !== 'string' || typeof p.s !== 'string') return null;
    if (p.pub.length > 120 || p.b.length > 6000 || p.s.length > 200) return null;
    try {
      const key = await crypto.subtle.importKey('raw', unb64u(p.pub), ALG, false, ['verify']);
      if (!(await crypto.subtle.verify(SIG, key, unb64u(p.s), te.encode(p.b)))) return null;
      const b = JSON.parse(p.b);
      if (!b || typeof b !== 'object' || !N.validId(b.hostId) || !Number.isFinite(b.ts)) return null;
      const ids = a => Array.isArray(a) && a.length <= 80 && a.every(N.validId);
      if (!ids(b.members) || !ids(b.ban || [])) return null;
      b.ban = b.ban || [];
      b.max = Math.max(0, Math.min(99, Math.floor(Number(b.max) || 0)));
      b.closed = !!b.closed; b.mute = !!b.mute; b.wipe = Number(b.wipe) || 0;
      b.hostName = N.cleanName(b.hostName || '');
      return b;
    } catch { return null; }
  }

  /* ---- إرسال/تطبيق ---- */
  function sendPol(id) { const c = load(); if (c.pol) N.sendTo(id, { t: 'pol', p: c.pol }); }
  const wipedAt = () => Number(PC.ls.get(kWipe())) || 0;
  N.wipeCut = wipedAt;

  async function wipeLocal(ts) {
    PC.ls.set(kWipe(), String(ts));
    const ids = (await PC.roomMsgs(N.rid)).map(m => m.id);
    if (ids.length) await PC.delMsgs(ids);
    N.emit('wiped');
  }

  function enforce(b, hostId) {
    for (const id of [...N.conns.keys()]) {
      if (b.ban.includes(id)) N.kick(id, 'banned');
      else if (restricted(b) && !b.members.includes(id) && id !== hostId) N.kick(id, 'closed');
    }
  }

  async function onPol(fromId, p) {
    const c = load();
    if (c.hostKey) return;                                              // أنا المضيف: لا أقبل سياسة غيري
    const b = await verify(p); if (!b) return;
    if (c.pol) {
      if (c.pol.pub !== p.pub) { if (!R.warned) { R.warned = 1; N.emit('sys', 'جهاز يدّعي أنه مضيف هذه الغرفة بمفتاح مختلف؛ تم تجاهله.', 'warn'); } return; }
      const cur = JSON.parse(c.pol.b);
      if (b.ts <= cur.ts) return;
    }
    cache.pol = { pub: p.pub, b: p.b, s: p.s };                          // أول سياسة صحيحة تُثبَّت (ثقة عند أول استخدام)
    PC.ls.set(kPol(), JSON.stringify(cache.pol));
    if (b.wipe > wipedAt()) await wipeLocal(b.wipe);
    enforce(b, b.hostId);
    N.emit('room');
  }
  N.on('pol', (id, p) => { onPol(id, p).catch(() => {}); });
  N.on('online', ({ id }) => sendPol(id));

  /* ---- قبول الأجهزة (متزامن) ---- */
  N.admit = id => {
    const c = load(); if (!c.pol) return null;
    let b; try { b = JSON.parse(c.pol.b); } catch { return null; }
    if ((b.ban || []).includes(id)) return 'banned';
    if (c.hostKey) {
      if (id === N.me.id || b.members.includes(id)) return null;
      if (b.closed) return 'closed';
      if (b.max > 0 && b.members.length >= b.max) return 'full';
      commit(x => { if (!x.members.includes(id)) x.members.push(id); }).catch(() => {});
      return null;
    }
    if (restricted(b) && id !== b.hostId && !b.members.includes(id)) return 'closed';
    return null;
  };

  /* ---- أوامر المضيف ---- */
  async function sign(body) {
    const c = load(), priv = await crypto.subtle.importKey('jwk', c.hostKey.priv, ALG, false, ['sign']);
    const b = JSON.stringify(body);
    const s = b64u(new Uint8Array(await crypto.subtle.sign(SIG, priv, te.encode(b))));
    return { pub: c.hostKey.pub, b, s };
  }
  let chain = Promise.resolve();
  function commit(fn) {                                                  // تسلسل التعديلات حتى لا تتداخل
    const run = async () => {
      const c = load(); if (!c.hostKey || !c.pol) throw new Error('not host');
      const body = JSON.parse(c.pol.b); fn(body); body.ts = Math.max(Date.now(), body.ts + 1);
      const p = await sign(body);
      cache.pol = p; PC.ls.set(kPol(), JSON.stringify(p));
      N.broadcast({ t: 'pol', p });
      N.emit('room');
      return body;
    };
    chain = chain.then(run, run);
    return chain;
  }

  R.init = async () => {                                                  // إنشاء غرفة جديدة: أنا المضيف
    if (load().hostKey) return;
    const kp = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
    const hk = { pub: b64u(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))), priv: await crypto.subtle.exportKey('jwk', kp.privateKey) };
    PC.ls.set(kHost(), JSON.stringify(hk)); cache.hostKey = hk; cache.rid = N.rid;
    const body = { hostId: N.me.id, hostName: N.me.name, max: 0, closed: false, mute: false, members: [N.me.id], ban: [], wipe: 0, ts: Date.now() };
    const p = await sign(body); cache.pol = p; PC.ls.set(kPol(), JSON.stringify(p));
    N.emit('room');
  };
  R.boot = async () => { if (PC.ls.get(kMk()) === '1') { PC.ls.del(kMk()); if (!load().hostKey) await R.init(); } load(); };
  R.markHost = rid => PC.ls.set('mkhost_' + rid, '1');

  /* ---- تحديد المضيف تلقائياً في الغرف المضافة: لا مضيف بعد؟ الأقدم دخولاً يصبح المضيف عند أول اتصال ----
     (التعادل بالمعرّف). من لديه سياسة موقّعة يرسلها للجميع فيعرف الآخرون أنهم ضيوف. */
  const myTs = () => Number(PC.ls.get('rf_' + N.rid)) || Infinity;
  const pending = () => !PC.ROOMS[N.rid] && !!PC.ls.get('rf_' + N.rid) && !load().pol && !load().hostKey;
  N.on('online', ({ id }) => { if (pending()) N.sendTo(id, { t: 'pq', ts: myTs() === Infinity ? 0 : myTs() }); });
  N.on('pq', (id, ts) => {
    if (!pending()) { sendPol(id); return; }
    const mine = myTs(), theirs = ts > 0 ? ts : Infinity;
    if (mine < theirs || (mine === theirs && N.me.id < id)) {
      R.init().then(() => commit(b => { for (const x of N.conns.keys()) if (!b.members.includes(x)) b.members.push(x); })).catch(() => {});
    }
  });

  R.state = () => {
    const c = load(); let body = null; try { body = c.pol ? JSON.parse(c.pol.b) : null; } catch {}
    return { host: !!c.hostKey, body };
  };
  R.setMax = async n => {
    n = Math.max(0, Math.min(99, Math.floor(Number(n) || 0)));
    const st = R.state(); if (!st.host) return { ok: false, err: 'host' };
    if (n > 0 && st.body.members.length > n) return { ok: false, err: 'count', count: st.body.members.length };
    await commit(b => { b.max = n; }); return { ok: true };
  };
  R.setMute = async v => { if (!R.state().host) return { ok: false, err: 'host' }; await commit(b => { b.mute = !!v; }); return { ok: true }; };
  /* هل الصوت مكتوم عن هذا المرسل؟ (المضيف مستثنى دائماً) */
  R.mutedFor = id => { const { body } = R.state(); return !!(body && body.mute && id !== body.hostId); };
  N.muteCheck = id => R.mutedFor(id);
  R.setClosed = async v => { if (!R.state().host) return { ok: false, err: 'host' }; await commit(b => { b.closed = !!v; }); return { ok: true }; };
  R.kick = async id => {
    if (!R.state().host || id === N.me.id) return { ok: false };
    await commit(b => { b.members = b.members.filter(x => x !== id); if (!b.ban.includes(id)) b.ban.push(id); });
    N.kick(id, 'banned'); return { ok: true };
  };
  R.unban = async id => { if (!R.state().host) return { ok: false }; await commit(b => { b.ban = b.ban.filter(x => x !== id); }); return { ok: true }; };
  R.wipe = async () => {
    if (!R.state().host) return { ok: false };
    const ts = Date.now(); await commit(b => { b.wipe = ts; }); await wipeLocal(ts); return { ok: true };
  };
})();

'use strict';
/* ===== الإعدادات + التخزين المحلي (IndexedDB) ===== */
const PC = window.PC = {};

/* الغرف المسموحة: معرّف الغرفة = SHA-256('pc1:'+الكود) أول 20 خانة.
   الأكواد نفسها غير مكتوبة هنا. لإضافة كود جديد:
   node -e "console.log(require('crypto').createHash('sha256').update('pc1:'+'الكود').digest('hex').slice(0,20))" */
PC.ROOMS = {
  '5c8f09aef18291fa078e': 'الغرفة ١',
  'f86626801d4f454ea22f': 'الغرفة ٢'
};
PC.SALT = 'pc1:';

/* الدخول: لكل غرفة كود ثابت خاص بها (المسجّلة أعلاه فقط). كود غير مسجّل يُرفض ولا تُنشأ به غرفة.
   AUTO_ROOM: ضع معرّف غرفة ليدخلها التطبيق مباشرة بدون كود (null = الكود مطلوب، وهو الافتراضي).
   REMEMBER_ROOM: false = يُطلب الكود عند كل فتح للتطبيق (تحديث الصفحة لا يطلبه ثانية)،
                  true  = يتذكر الجهاز الغرفة حتى تضغط «خروج ونسيان الكود». */
PC.AUTO_ROOM = null;
PC.REMEMBER_ROOM = false;

/* خوادم TURN (اختياري): تُستخدم عند فشل الاتصال المباشر في الشبكات الصارمة.
   مثال: { urls: ['turn:YOUR_HOST:3478', 'turns:YOUR_HOST:5349'], username: 'USER', credential: 'PASS' }
   إن تُركت فارغة تُستخدم الإعدادات الافتراضية لـ PeerJS. انتبه: أي بيانات هنا يراها كل من يفتح التطبيق. */
PC.TURN = [];
PC.PEER_CFG = PC.TURN.length
  ? { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, ...PC.TURN], iceCandidatePoolSize: 4 }
  : undefined;

/* خادم الاحتفاظ بالرسائل (Cloudflare Worker من مجلد cloudflare). يعمل تلقائياً: الرمز والسرّ يُشتقّان من كود الغرفة.
   url: ضع رابط الـ Worker هنا (https://tawasol-relay.اسمك.workers.dev) ليعمل على كل الأجهزة، أو افتح التطبيق مرة بالرابط
   index.html?relay=https://... فيُحفظ تلقائياً، أو الصقه في الإعدادات. اتركه فارغاً لتعطيل الخادم.
   token/secret: اتركهما فارغين (تلقائي). ضعهما فقط إن ضبطت RELAY_TOKEN على الخادم، أو للدخول التلقائي AUTO_ROOM بلا كود. */
PC.RELAY = {
  url: 'https://tawasol-relay.firas-tawasol-2027.workers.dev',
  token: '',
  secret: '',
  pollMs: 15000
};
PC.MAX_TEXT = 4000;
PC.MAX_FILE = 1000000;          // أقصى حجم لملف/صورة (بايت) بعد الضغط؛ يُرسل مباشرة بين الأجهزة فقط

/* مكتبة PeerJS: نجرّب نسخة محلية أولاً (peerjs.min.js بجانب الملفات) ثم شبكتي توزيع */
PC.PEER_SRC = [
  'peerjs.min.js',
  'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js',
  'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js'
];

PC.ls = {
  get(k, d = null) { try { const v = localStorage.getItem('pc_' + k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pc_' + k, v); } catch {} },
  del(k) { try { localStorage.removeItem('pc_' + k); } catch {} }
};

PC.rand = (n = 10) => {
  const a = new Uint8Array(n); crypto.getRandomValues(a);
  return Array.from(a, b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
};

PC.roomIdFor = async code => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(PC.SALT + code));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('').slice(0, 20);
};

/* ---- IndexedDB ---- */
PC.db = null;
PC.openDB = () => new Promise((res, rej) => {
  const rq = indexedDB.open('pchat1', 1);
  rq.onupgradeneeded = () => {
    const d = rq.result;
    if (!d.objectStoreNames.contains('msgs')) d.createObjectStore('msgs', { keyPath: 'id' }).createIndex('room', 'room');
    if (!d.objectStoreNames.contains('contacts')) d.createObjectStore('contacts', { keyPath: 'key' }).createIndex('room', 'room');
  };
  rq.onsuccess = () => { PC.db = rq.result; res(); };
  rq.onerror = () => rej(rq.error);
});

PC.tx = (store, mode, fn) => new Promise((res, rej) => {
  const t = PC.db.transaction(store, mode), s = t.objectStore(store);
  const out = fn(s);
  t.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
  t.onerror = t.onabort = () => rej(t.error);
});

/* ---- قفل التطبيق وتشفير المحادثات المحلية ----
   الرمز → PBKDF2 (200 ألف دورة) → مفتاح AES-GCM. يُشفَّر كل حقل في الرسالة عدا (id, room, ts) اللازمة للفهرسة.
   الرمز لا يُخزَّن، ويُخزَّن فقط ملح وبصمة تحقق مشفّرة. أسماء الأجهزة المعروفة غير مشفّرة. */
const V = PC.vault = { key: null, gate: Promise.resolve() };
{
  const ITER = 200000, te = new TextEncoder(), td = new TextDecoder();
  const b64 = u8 => { let t = ''; for (let i = 0; i < u8.length; i += 0x8000) t += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(t); };
  const unb64 = t => Uint8Array.from(atob(t), c => c.charCodeAt(0));
  V.enabled = () => PC.ls.get('vault') === '1';
  const derive = async (pass, salt) => {
    const base = await crypto.subtle.importKey('raw', te.encode(pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  };
  const encWith = async (key, obj) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(obj))));
    const o = new Uint8Array(12 + ct.length); o.set(iv); o.set(ct, 12); return b64(o);
  };
  const decWith = async (key, t) => {
    try { const u = unb64(t); return JSON.parse(td.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.subarray(0, 12) }, key, u.subarray(12)))); } catch { return null; }
  };
  /* يعيد المفتاح إن صحّ الرمز، وإلا false */
  V.verify = async pass => {
    if (!V.enabled()) return false;
    try { const k = await derive(pass, unb64(PC.ls.get('vsalt'))); return (await decWith(k, PC.ls.get('vchk'))) === 'ok' ? k : false; } catch { return false; }
  };
  V.unlock = async pass => { const k = await V.verify(pass); if (!k) return false; V.key = k; return true; };

  const PLAIN = ['id', 'room', 'ts'];
  const seal = async m => {
    if (V.enabled() && !V.key) throw new Error('locked');
    if (!V.key) return m;
    const rest = {}; for (const k in m) if (!PLAIN.includes(k)) rest[k] = m[k];
    return { id: m.id, room: m.room, ts: m.ts, enc: await encWith(V.key, rest) };
  };
  const unseal = async r => {
    if (!r || !r.enc) return r;
    if (!V.key) return null;
    const rest = await decWith(V.key, r.enc);
    return rest ? { id: r.id, room: r.room, ts: r.ts, ...rest } : null;
  };

  /* تحويل كل الرسائل بين مفتاحين (null = بلا تشفير) داخل معاملة واحدة، مع إيقاف القراءة والكتابة مؤقتاً */
  async function reencrypt(oldKey, newKey, commit) {
    let release; const prev = V.gate; V.gate = new Promise(r => (release = r));
    try {
      await prev;
      const raws = await new Promise((res, rej) => { const rq = PC.db.transaction('msgs').objectStore('msgs').getAll(); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
      const out = [];
      for (const r of raws) {
        let m = r;
        if (r.enc) { const rest = await decWith(oldKey, r.enc); if (!rest) throw new Error('decrypt'); m = { id: r.id, room: r.room, ts: r.ts, ...rest }; }
        if (newKey) { const rest = {}; for (const k in m) if (!PLAIN.includes(k)) rest[k] = m[k]; out.push({ id: m.id, room: m.room, ts: m.ts, enc: await encWith(newKey, rest) }); }
        else out.push(m);
      }
      await PC.tx('msgs', 'readwrite', st => { out.forEach(x => st.put(x)); });
      commit();
    } finally { release(); }
  }

  V.setup = async pass => {
    const salt = crypto.getRandomValues(new Uint8Array(16)), k = await derive(pass, salt), chk = await encWith(k, 'ok');
    await reencrypt(null, k, () => { PC.ls.set('vsalt', b64(salt)); PC.ls.set('vchk', chk); PC.ls.set('vault', '1'); V.key = k; });
  };
  V.change = async (oldPass, newPass) => {
    const ok = await V.verify(oldPass); if (!ok) return false;
    const salt = crypto.getRandomValues(new Uint8Array(16)), k = await derive(newPass, salt), chk = await encWith(k, 'ok');
    await reencrypt(ok, k, () => { PC.ls.set('vsalt', b64(salt)); PC.ls.set('vchk', chk); V.key = k; });
    return true;
  };
  V.remove = async pass => {
    const ok = await V.verify(pass); if (!ok) return false;
    await reencrypt(ok, null, () => { PC.ls.del('vault'); PC.ls.del('vsalt'); PC.ls.del('vchk'); V.key = null; });
    return true;
  };
  /* نسيان الرمز: لا استرجاع، نمسح بيانات هذا الجهاز كاملة */
  V.wipeAll = () => new Promise(res => {
    try { PC.db && PC.db.close(); } catch {}
    const done = () => {
      try { Object.keys(localStorage).filter(k => k.startsWith('pc_')).forEach(k => localStorage.removeItem(k)); sessionStorage.clear(); } catch {}
      res();
    };
    try { const rq = indexedDB.deleteDatabase('pchat1'); rq.onsuccess = rq.onerror = rq.onblocked = done; } catch { done(); }
  });

  PC.putMsg = async m => { await V.gate; const rec = await seal(m); return PC.tx('msgs', 'readwrite', st => st.put(rec)); };
  PC.getMsg = async id => {
    await V.gate;
    const raw = await new Promise((res, rej) => { const rq = PC.db.transaction('msgs').objectStore('msgs').get(id); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
    return unseal(raw);
  };
  PC.roomMsgs = async room => {
    await V.gate;
    const raws = await new Promise((res, rej) => { const rq = PC.db.transaction('msgs').objectStore('msgs').index('room').getAll(room); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
    return (await Promise.all(raws.map(unseal))).filter(Boolean).sort((a, b) => a.ts - b.ts);
  };
}
PC.delMsgs = ids => PC.tx('msgs', 'readwrite', s => { ids.forEach(id => s.delete(id)); });
/* نسيان غرفة مضافة: حذف رسائلها وأجهزتها المعروفة من هذا الجهاز */
PC.delRoom = async room => {
  const ids = (await PC.roomMsgs(room)).map(m => m.id); if (ids.length) await PC.delMsgs(ids);
  for (const c of await PC.roomContacts(room)) await PC.delContact(c.key);
};
PC.putContact = c => PC.tx('contacts', 'readwrite', s => s.put(c));
PC.delContact = key => PC.tx('contacts', 'readwrite', s => s.delete(key));
PC.roomContacts = room => new Promise((res, rej) => {
  const rq = PC.db.transaction('contacts').objectStore('contacts').index('room').getAll(room);
  rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
});

/* تصدير نسخة احتياطية لرسائل الغرفة الحالية */
PC.exportRoom = async room => {
  const msgs = await PC.roomMsgs(room);
  const blob = new Blob([JSON.stringify({ v: 1, room, exported: Date.now(), msgs }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'tawasol-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
};

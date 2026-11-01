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

/* خادم الاحتفاظ بالرسائل (اختياري، معطّل ما دام url فارغاً). انظر README.txt.
   token = نفس قيمة RELAY_TOKEN على الخادم · secret = سرّ تشفير الرسائل قبل رفعها.
   انتبه: القيمتان تظهران لمن يملك ملفات التطبيق، فاحتفظ بالتطبيق لأجهزتك فقط. */
PC.RELAY = {
  url: '',                                   // مثال: 'https://my-relay.onrender.com'
  token: 'kFql7qZyWXuYhdWlsy3Snw6a',
  secret: '7CgZPP8UqLQdMkXMu9hyUGXHVN24lCiR',
  pollMs: 15000
};
PC.MAX_TEXT = 4000;

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

PC.putMsg = m => PC.tx('msgs', 'readwrite', s => s.put(m));
PC.getMsg = id => new Promise((res, rej) => {
  const rq = PC.db.transaction('msgs').objectStore('msgs').get(id);
  rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
});
PC.roomMsgs = room => new Promise((res, rej) => {
  const rq = PC.db.transaction('msgs').objectStore('msgs').index('room').getAll(room);
  rq.onsuccess = () => res(rq.result.sort((a, b) => a.ts - b.ts)); rq.onerror = () => rej(rq.error);
});
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

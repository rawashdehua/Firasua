'use strict';
/* ===== واجهة التطبيق — الأساسيات المشتركة: الحالة والتخزين والمساعدات ===== */
(() => {
  const U = PC.ui = {};
  /* المظهر المحفوظ يُطبَّق فوراً لتفادي الوميض */
  const applyLook = () => {
    const r = document.documentElement, t = PC.ls.get('theme') || 'auto', f = PC.ls.get('fs') || '16';
    if (t === 'auto') r.removeAttribute('data-theme'); else r.dataset.theme = t;
    r.style.setProperty('--fs', (/^(16|18|20)$/.test(f) ? f : '16') + 'px');
  };
  applyLook(); U.applyLook = applyLook;
  const schedule = (...a) => U.schedule(...a);   // من ملف المحادثة
  const N = PC.net;
  const $ = id => document.getElementById(id);
  const S = { view: '*', msgs: [], sys: [], unread: {}, raf: 0, fails: 0, lockedUntil: 0, reply: null, typing: {}, gate: false, q: '', file: null };
  const me = { id: '', name: '' };

  /* حفظ الغرفة: دائم على الجهاز، أو للجلسة فقط (يُطلب الكود عند كل فتح للتطبيق) */
  const roomStore = {
    get() { if (PC.REMEMBER_ROOM) return PC.ls.get('room'); try { return sessionStorage.getItem('pc_room'); } catch { return null; } },
    set(v) { if (PC.REMEMBER_ROOM) PC.ls.set('room', v); else try { sessionStorage.setItem('pc_room', v); } catch {} },
    del() { PC.ls.del('room'); try { sessionStorage.removeItem('pc_room'); } catch {} }
  };
  /* مفتاح الخادم المشتق من الكود يُحفظ بجانب الغرفة بالطريقة نفسها (جلسة أو دائم) */
  const keyStore = {
    get() { try { return JSON.parse(PC.REMEMBER_ROOM ? PC.ls.get('rk') : sessionStorage.getItem('pc_rk')); } catch { return null; } },
    set(v) { const t = JSON.stringify(v); if (PC.REMEMBER_ROOM) PC.ls.set('rk', t); else try { sessionStorage.setItem('pc_rk', t); } catch {} },
    del() { PC.ls.del('rk'); try { sessionStorage.removeItem('pc_rk'); } catch {} }
  };

  /* غرف يضيفها المستخدم بكود من 8 أرقام: نحفظ بصمة الكود واسم الغرفة فقط (لا الكود نفسه) */
  const myRooms = {
    get() { try { const o = JSON.parse(PC.ls.get('myrooms') || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } },
    set(o) { PC.ls.set('myrooms', JSON.stringify(o)); }
  };
  /* الغرف السابقة: نحفظ بصمة الغرفة ومفتاح الخادم المشتق (لا الكود نفسه) فيكفي الضغط للدخول */
  const recent = {
    list() { try { const a = JSON.parse(PC.ls.get('recent') || '[]'); return Array.isArray(a) ? a.filter(x => x && typeof x.rid === 'string') : []; } catch { return []; } },
    save(a) { PC.ls.set('recent', JSON.stringify(a.slice(0, 10))); },
    add(rid, rk) { const a = this.list().filter(x => x.rid !== rid); a.unshift({ rid, rk, ts: Date.now() }); this.save(a); PC.ls.set('last', rid); },
    del(rid) { this.save(this.list().filter(x => x.rid !== rid)); if (PC.ls.get('last') === rid) PC.ls.del('last'); },
    get(rid) { return this.list().find(x => x.rid === rid) || null; }
  };
  const roomName = rid => PC.ROOMS[rid] || myRooms.get()[rid] || '';

  /* ---- مساعدات ---- */
  const toast = (t, ms = 2600) => {
    const el = $('toast'); el.textContent = t; el.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), ms);
  };
  const fmtTime = ts => {
    const d = new Date(ts), now = new Date();
    const t = d.toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === now.toDateString() ? t : d.toLocaleDateString('ar', { day: 'numeric', month: 'short' }) + ' ' + t;
  };
  const nameOf = id => {
    const st = N.conns.get(id), k = N.contacts.get(id);
    return (st && st.name) || (k && k.name) || 'جهاز';
  };
  const addSys = (text, cls = '') => { S.sys.push({ sys: true, ts: Date.now(), text, cls }); S.sys = S.sys.slice(-60); schedule(); };

  Object.assign(U, { N, S, me, roomStore, keyStore, myRooms, recent, roomName, toast, fmtTime, nameOf, addSys, $ });
})();

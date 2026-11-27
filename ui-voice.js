'use strict';
/* ===== واجهة التطبيق — الصوت: زر التحدث (🎙) وزر السماعة (🎧) وتسجيل الرسائل الصوتية ===== */
(() => {
  const U = PC.ui, V = PC.voice;
  const $ = id => document.getElementById(id);
  const { N, S, me, toast } = U;
  const schedule = (...a) => U.schedule(...a);
  const muted = () => PC.room.mutedFor(me.id);
  const fmt = s => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  const micError = err => toast(err && err.name === 'InCall' ? 'أنت في مكالمة الآن' : err && err.name === 'Muted' ? 'المضيف كتم الصوت للجميع' : err && err.name === 'NotAllowedError' ? 'اسمح باستخدام الميكروفون من إعدادات المتصفح' : 'تعذّر تشغيل الميكروفون');

  function renderVoiceBtns() {
    const ok = V.supported(), m = muted();
    for (const id of ['btnPtt', 'btnMic']) { $(id).hidden = !ok; $(id).classList.toggle('muted', m); }
    $('btnSpk').hidden = !ok;
    $('btnSpk').textContent = V.deaf() ? '🔇' : '🎧';
    $('btnSpk').setAttribute('aria-pressed', V.deaf() ? 'true' : 'false');
    $('btnPtt').title = m ? 'المضيف كتم الصوت للجميع' : V.mode() === 'live' ? 'اضغط مطولاً للتحدث مباشرة' : 'اضغط مطولاً لتسجيل رسالة صوتية';
    $('btnPtt').textContent = V.mode() === 'live' ? '🎙' : '⏺';
  }
  N.on('status', renderVoiceBtns); N.on('room', renderVoiceBtns); N.on('presence', renderVoiceBtns);
  N.on('talk', () => { renderVoiceBtns(); schedule(); });
  $('selPtt').addEventListener('change', renderVoiceBtns);
  $('btnSpk').onclick = () => { V.setDeaf(!V.deaf()); renderVoiceBtns(); toast(V.deaf() ? 'كُتم صوت التحدث المباشر عندك' : 'عاد صوت التحدث المباشر', 1500); };
  document.addEventListener('pointerdown', () => V.resume(), { passive: true });   // المتصفحات تشترط لمسة قبل تشغيل الصوت

  async function sendRecorded(out) {
    if (muted()) return toast('المضيف كتم الصوت للجميع');
    if (out.dur < 1 || out.blob.size < 200) return toast('التسجيل قصير جداً');
    if (out.blob.size > PC.MAX_FILE) return toast('التسجيل أكبر من المسموح');
    const file = await V.toFile(out);
    if (!(await N.sendText('', S.view, null, file))) return toast('تعذّر إرسال الرسالة الصوتية');
    toast('أُرسلت الرسالة الصوتية', 1500);
  }

  /* ---- زر الرأس: اضغط مطولاً (مباشر أو تسجيل حسب الإعدادات) ---- */
  const btn = $('btnPtt');
  let pressing = false, pressAt = 0, rec = null;
  btn.addEventListener('pointerdown', async e => {
    e.preventDefault(); if (pressing) return;
    if (muted()) return toast('المضيف كتم الصوت للجميع');
    if (PC.call.cur) return toast('أنت في مكالمة الآن');
    pressing = true; pressAt = Date.now();
    try { btn.setPointerCapture(e.pointerId); } catch {}
    try {
      if (V.mode() === 'live') { await V.talkStart(S.view); if (!pressing) V.talkStop(); else btn.classList.add('on'); }
      else { const r = await V.record(); if (!pressing) r.cancel(); else { rec = r; btn.classList.add('on'); r.onAuto = () => release(); } }
    } catch (err) { pressing = false; btn.classList.remove('on'); micError(err); }
  });
  async function release() {
    if (!pressing) return; pressing = false; btn.classList.remove('on');
    if (V.mode() === 'live') { V.talkStop(); return; }
    const r = rec; rec = null; if (!r) return;
    if (Date.now() - pressAt < 600) { r.cancel(); return toast('اضغط مطولاً للتسجيل ثم اترك الزر للإرسال'); }
    await sendRecorded(await r.stop());
  }
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(ev => btn.addEventListener(ev, release));
  btn.addEventListener('contextmenu', e => e.preventDefault());

  /* ---- زر بجانب الإرسال: تسجيل رسالة صوتية (اضغط للبدء ثم ➤ للإرسال) ---- */
  let rec2 = null, tick = 0;
  const hideRec = () => { clearInterval(tick); $('recBar').hidden = true; };
  async function finishRec(send) {
    const r = rec2; if (!r) return; rec2 = null; hideRec();
    if (!send) return r.cancel();
    await sendRecorded(await r.stop());
  }
  $('btnMic').onclick = async () => {
    if (rec2) return;
    if (muted()) return toast('المضيف كتم الصوت للجميع');
    if (S.editId) return toast('أنهِ تعديل الرسالة أولاً');
    try {
      const r = await V.record(); rec2 = r; r.onAuto = () => finishRec(true);
      $('recBar').hidden = false; $('recTime').textContent = '0:00';
      tick = setInterval(() => { $('recTime').textContent = fmt(Math.round((Date.now() - r.t0) / 1000)); }, 500);
    } catch (err) { micError(err); }
  };
  $('btnRecSend').onclick = () => finishRec(true);
  $('btnRecCancel').onclick = () => finishRec(false);
  N.on('wiped', hideRec);

  renderVoiceBtns();
  Object.assign(U, { renderVoiceBtns });
})();

'use strict';
/* ===== واجهة المكالمات: اختيار الجهاز، شاشة الرنين، شاشة المكالمة ===== */
(() => {
  const U = PC.ui, C = PC.call;
  const $ = id => document.getElementById(id);
  const { N, S, toast, nameOf, addSys } = U;
  const fmt = s => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  let clock = 0, ringT = 0, ac = null;
  const REASONS = { busy: 'مشغول بمكالمة أخرى', rejected: 'رفض المكالمة', noanswer: 'لم يرد', lost: 'انقطع الاتصال', failed: 'تعذّر إقامة المكالمة', nomedia: 'تعذّر تشغيل الكاميرا/الميكروفون عنده' };

  /* ---- رنين بسيط ---- */
  function beep() {
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      const o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = 520; g.gain.value = 0.08; o.connect(g); g.connect(ac.destination);
      o.start(); o.stop(ac.currentTime + 0.35);
    } catch {}
    try { navigator.vibrate && navigator.vibrate([300, 150, 300]); } catch {}
  }
  const ringStart = () => { ringStop(); beep(); ringT = setInterval(beep, 2000); };
  const ringStop = () => { clearInterval(ringT); ringT = 0; try { navigator.vibrate && navigator.vibrate(0); } catch {} };

  /* ---- الشاشة ---- */
  function render() {
    const c = C.cur, box = $('callBox');
    if (!c) { box.hidden = true; ringStop(); clearInterval(clock); const r = $('callRemote'), l = $('callLocal'); r.srcObject = null; l.srcObject = null; return; }
    box.hidden = false;
    $('callName').textContent = c.name || nameOf(c.id);
    const ringing = c.dir === 'in' && c.state === 'ring';
    $('cbIn').hidden = !ringing; $('cbLive').hidden = ringing;
    $('cCam').hidden = !c.video; $('cFlip').hidden = !c.video;
    $('cMic').classList.toggle('off', !C.micOn()); $('cMic').textContent = C.micOn() ? '🎙' : '🔇';
    $('cCam').classList.toggle('off', !C.camOn());
    const stat = c.state === 'conn' ? fmt(Math.round((Date.now() - c.t0) / 1000))
      : ringing ? (c.video ? 'مكالمة فيديو واردة…' : 'مكالمة صوتية واردة…')
      : c.state === 'ring' ? 'جارٍ الاتصال…' : 'جارٍ إقامة المكالمة…';
    $('callStat').textContent = stat;
    const r = $('callRemote'), l = $('callLocal');
    if (c.remote && r.srcObject !== c.remote) { r.srcObject = c.remote; r.play().catch(() => {}); }
    if (c.local && c.video && l.srcObject !== c.local) { l.srcObject = c.local; l.play().catch(() => {}); }
    l.hidden = !c.video; l.classList.toggle('off', !C.camOn());
    r.classList.toggle('off', !c.video);                       // مكالمة صوتية: لا صورة، يبقى الصوت يُشغَّل
    clearInterval(clock);
    if (c.state === 'conn') clock = setInterval(() => { $('callStat').textContent = fmt(Math.round((Date.now() - c.t0) / 1000)); }, 1000);
    if (ringing) { if (!ringT) ringStart(); } else ringStop();
  }
  N.on('call', render);
  N.on('callend', i => {
    const who = i.name || 'جهاز';
    if (i.reason === 'missed') addSys('📞 مكالمة فائتة من ' + who, 'warn');
    else if (i.was === 'conn') addSys('📞 انتهت المكالمة مع ' + who + ' · ' + fmt(i.dur));
    else if (i.reason === 'declined' || i.reason === 'hangup' || i.reason === 'remote') { if (i.dir === 'in' && i.reason === 'remote') addSys('📞 مكالمة فائتة من ' + who, 'warn'); }
    else if (REASONS[i.reason]) toast(who + ': ' + REASONS[i.reason]);
  });

  /* ---- بدء مكالمة ---- */
  const errMsg = e => e && e.name === 'NotAllowedError' ? 'اسمح بالكاميرا/الميكروفون من إعدادات المتصفح' : e && e.name === 'Busy' ? 'أنت في مكالمة الآن' : e && e.name === 'Offline' ? 'الجهاز غير متصل الآن' : 'تعذّر بدء المكالمة';
  async function dial(id, video) {
    $('callPick').hidden = true;
    try { await C.start(id, video); } catch (e) { toast(errMsg(e)); }
  }
  $('btnCall').onclick = () => {
    if (!C.supported()) return toast('المتصفح لا يدعم المكالمات');
    if (C.cur) return render();
    const on = N.onlineList();
    if (!on.length) return toast('لا أحد متصل الآن للاتصال به');
    const ul = $('cpList'); ul.textContent = '';
    on.forEach(d => {
      const li = document.createElement('li'); const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = nameOf(d.id);
      const a = document.createElement('button'); a.type = 'button'; a.className = 'small'; a.textContent = '📞 صوت'; a.onclick = () => dial(d.id, false);
      const v = document.createElement('button'); v.type = 'button'; v.className = 'small'; v.textContent = '🎥 فيديو'; v.onclick = () => dial(d.id, true);
      li.append(nm, a, v); ul.appendChild(li);
    });
    $('callPick').hidden = false;
  };
  $('cpClose').onclick = () => { $('callPick').hidden = true; };
  $('callPick').addEventListener('click', e => { if (e.target === $('callPick')) $('callPick').hidden = true; });

  $('cAccept').onclick = async () => { try { await C.accept(); } catch (e) { toast(errMsg(e)); } };
  $('cDecline').onclick = () => C.decline();
  $('cEnd').onclick = () => C.end('hangup');
  $('cMic').onclick = () => C.toggleMic();
  $('cCam').onclick = () => C.toggleCam();
  $('cFlip').onclick = () => C.flip().catch(() => toast('تعذّر تبديل الكاميرا'));
  N.on('callring', () => { try { if (document.hidden && window.Notification && Notification.permission === 'granted') new Notification('مكالمة واردة', { tag: 'call' }); } catch {} });
  Object.assign(U, { renderCall: render });
})();

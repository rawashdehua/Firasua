/* الصوت: (1) تسجيل رسالة صوتية تُرسل كملف، (2) زر التحدث المباشر (ووكي توكي) عبر مكالمة WebRTC من PeerJS دون تسجيل.
   الاستقبال لا يُشغَّل إلا أثناء إشارة «يتحدث الآن» من المرسل، ويُكتم إن كتم المضيف الجميع أو كتم المستخدم السماعة. */
(() => {
  const N = PC.net, V = PC.voice = {};
  V.MAX_MS = 120000;                                       // أقصى مدة للرسالة الصوتية (≈ 360KB بمعدل 24kbps)
  V.mode = () => PC.ls.get('pttmode') === 'record' ? 'record' : 'live';
  V.setMode = m => PC.ls.set('pttmode', m === 'record' ? 'record' : 'live');
  V.deaf = () => PC.ls.get('deaf') === '1';
  V.supported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

  /* ---------- تسجيل رسالة صوتية ---------- */
  const pickMime = () => ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find(t => MediaRecorder.isTypeSupported(t)) || '';
  V.record = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO });
    const mime = pickMime(), opts = { audioBitsPerSecond: 24000 }; if (mime) opts.mimeType = mime;
    const rec = new MediaRecorder(stream, opts), chunks = [], t0 = Date.now();
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    let timer;
    const fin = new Promise(res => { rec.onstop = () => { clearTimeout(timer); stream.getTracks().forEach(t => t.stop()); res(); }; });
    const ctl = {
      t0, onAuto: null,
      async stop() {
        if (rec.state === 'recording') rec.stop();
        await fin;
        const type = String(rec.mimeType || mime || 'audio/webm').split(';')[0];
        return { blob: new Blob(chunks, { type }), type, dur: Math.max(1, Math.round((Date.now() - t0) / 1000)) };
      },
      cancel() { if (rec.state === 'recording') rec.stop(); }
    };
    rec.start(1000);
    timer = setTimeout(() => { if (rec.state === 'recording') { rec.stop(); fin.then(() => ctl.onAuto && ctl.onAuto()); } }, V.MAX_MS);
    return ctl;
  };
  V.toFile = async ({ blob, type, dur }) => {
    const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(blob); });
    const ext = /mp4/.test(type) ? 'm4a' : /ogg/.test(type) ? 'ogg' : 'webm';
    return { name: 'رسالة صوتية.' + ext, type, size: blob.size, dur, data: b64 };
  };

  /* ---------- حالة الاستقبال والمتحدثون ---------- */
  const inb = new Map();                                   // id → { audio, call, on }
  const speaking = new Map();                              // id → { name, until }
  V.speakers = () => [...speaking.values()].filter(s => s.until > Date.now()).map(s => s.name);
  const mutedFor = id => !!(PC.room && PC.room.mutedFor(id));
  const gate = id => { const x = inb.get(id); if (x) x.audio.muted = !(x.on && !V.deaf() && !mutedFor(id)); };
  V.regate = () => { inb.forEach((_, id) => gate(id)); N.emit('talk'); };
  V.setDeaf = v => { PC.ls.set('deaf', v ? '1' : '0'); V.regate(); };
  V.resume = () => inb.forEach(x => { if (x.audio.paused) x.audio.play().catch(() => {}); });

  N.on('ptt', ({ id, name, on }) => {
    if (mutedFor(id)) return;
    const x = inb.get(id); if (x) { x.on = on; gate(id); }
    if (on) { speaking.set(id, { name, until: Date.now() + 45000 }); setTimeout(() => N.emit('talk'), 45100); } else speaking.delete(id);
    N.emit('talk');
  });
  const drop = id => {
    const x = inb.get(id); if (x) { try { x.call.close(); } catch {} x.audio.srcObject = null; inb.delete(id); }
    const c = out.get(id); if (c) { try { c.close(); } catch {} out.delete(id); }
    if (speaking.delete(id)) N.emit('talk');
  };
  N.on('offline', d => { if (d && d.id) drop(d.id); });
  N.on('room', () => V.regate());

  /* مكالمة واردة: لا تُقبل إلا من جهاز متصل بنا فعلاً في هذه الغرفة */
  N.voiceIn = (call, tries = 0) => {
    const pre = 'pcm-' + N.rid + '-', pid = String(call.peer || '');
    if (!pid.startsWith(pre)) { try { call.close(); } catch {} return; }
    const id = pid.slice(pre.length), st = N.conns.get(id);
    if (!st || !st.ready) { if (tries < 3) setTimeout(() => N.voiceIn(call, tries + 1), 800); else { try { call.close(); } catch {} } return; }
    if (inb.has(id)) { try { inb.get(id).call.close(); } catch {} }
    call.answer();                                          // نستقبل فقط؛ نتحدث عبر مكالمتنا نحن
    call.on('stream', s => {
      const audio = new Audio(); audio.autoplay = true; audio.playsInline = true; audio.srcObject = s; audio.muted = true;
      const x = { audio, call, on: speaking.has(id) }; inb.set(id, x); gate(id);
      audio.play().catch(() => { N.emit('talk'); });
    });
    const gone = () => { const x = inb.get(id); if (x && x.call === call) { x.audio.srcObject = null; inb.delete(id); } };
    call.on('close', gone); call.on('error', gone);
  };

  /* ---------- الإرسال المباشر ---------- */
  const out = new Map();                                    // id → call
  let mic = null, micP = null;
  const getMic = () => micP || (micP = navigator.mediaDevices.getUserMedia({ audio: AUDIO }).then(s => { mic = s; s.getAudioTracks().forEach(t => { t.enabled = false; }); return s; }).catch(e => { micP = null; throw e; }));
  const readyIds = to => [...N.conns].filter(([id, st]) => st.ready && (to === '*' || !to || id === to)).map(([id]) => id);
  V.talking = false;
  V.talkStart = async to => {
    if (V.talking) return;
    if (PC.call && PC.call.cur) throw Object.assign(new Error('incall'), { name: 'InCall' });
    if (PC.room && PC.room.mutedFor(N.me.id)) throw Object.assign(new Error('muted'), { name: 'Muted' });
    const s = await getMic();
    V.talking = true;
    s.getAudioTracks().forEach(t => { t.enabled = true; });
    for (const id of readyIds(to)) {
      const c = out.get(id);
      if (!c || c.closedFlag) {
        try {
          const call = N.peer.call(N.mainId(id), s, { metadata: { v: 1 } });
          call.on('close', () => { call.closedFlag = true; if (out.get(id) === call) out.delete(id); });
          call.on('error', () => { call.closedFlag = true; if (out.get(id) === call) out.delete(id); });
          out.set(id, call);
        } catch {}
      }
      N.sendTo(id, { t: 'ptt', on: 1 });
    }
    N.emit('talk');
  };
  V.talkStop = () => {
    if (!V.talking) return;
    V.talking = false;
    if (mic) mic.getAudioTracks().forEach(t => { t.enabled = false; });
    for (const id of N.conns.keys()) N.sendTo(id, { t: 'ptt', on: 0 });
    N.emit('talk');
  };
  V.reset = () => {
    V.talkStop();
    [...inb.keys(), ...out.keys()].forEach(drop);
    if (mic) { mic.getTracks().forEach(t => t.stop()); mic = null; micP = null; }
    speaking.clear();
  };
  V._inb = inb; V._out = out;                               // للاختبار والتشخيص فقط
  const stop0 = N.stop;
  N.stop = function (...a) { try { V.reset(); } catch {} return stop0.apply(N, a); };
})();

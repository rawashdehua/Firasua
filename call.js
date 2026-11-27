/* مكالمات صوتية وفيديو بين جهازين: الإشارة (رنين/قبول/رفض/إنهاء) عبر قناة البيانات الحالية،
   والوسائط عبر مكالمة WebRTC من PeerJS مباشرة بين الجهازين (مشفّرة DTLS-SRTP). مكالمة واحدة في كل مرة. */
(() => {
  const N = PC.net, C = PC.call = {};
  const RING_MS = 45000;
  C.cur = null;                                              // { cid, id, name, video, dir, state:'ring'|'wait'|'conn', local, remote, call, t0 }
  C.supported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const rid = () => Math.random().toString(36).slice(2, 12);
  const media = video => navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: video ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } } : false
  });
  const changed = () => N.emit('call');

  function cleanup() {
    const c = C.cur; if (!c) return;
    clearTimeout(c.timer); C.cur = null;
    try { c.call && c.call.close(); } catch {}
    try { c.local && c.local.getTracks().forEach(t => t.stop()); } catch {}
  }
  function end(reason, notify = true) {
    const c = C.cur; if (!c) return;
    if (notify) N.sendTo(c.id, { t: 'cl', k: 'end', cid: c.cid, r: reason || '' });
    const info = { reason: reason || '', name: c.name, id: c.id, video: c.video, dir: c.dir, dur: c.t0 ? Math.round((Date.now() - c.t0) / 1000) : 0, was: c.state };
    cleanup(); N.emit('callend', info); changed();
  }
  C.end = reason => end(reason || 'hangup');

  /* ---- بدء مكالمة ---- */
  C.start = async (id, video) => {
    if (C.cur) throw Object.assign(new Error('busy'), { name: 'Busy' });
    const st = N.conns.get(id); if (!st || !st.ready) throw Object.assign(new Error('offline'), { name: 'Offline' });
    if (PC.voice && PC.voice.talking) PC.voice.talkStop();
    const local = await media(!!video);
    if (C.cur) { local.getTracks().forEach(t => t.stop()); throw Object.assign(new Error('busy'), { name: 'Busy' }); }
    const c = C.cur = { cid: rid(), id, name: st.name, video: !!video, dir: 'out', state: 'ring', local, remote: null, call: null, t0: 0 };
    c.timer = setTimeout(() => { if (C.cur === c && c.state !== 'conn') end('noanswer'); }, RING_MS);
    N.sendTo(id, { t: 'cl', k: 'offer', cid: c.cid, video: !!video });
    changed();
  };

  /* ---- استقبال: قبول/رفض ---- */
  C.accept = async () => {
    const c = C.cur; if (!c || c.dir !== 'in' || c.state !== 'ring') return;
    try { c.local = await media(c.video); } catch (e) { N.sendTo(c.id, { t: 'cl', k: 'reject', cid: c.cid, r: 'nomedia' }); cleanup(); changed(); throw e; }
    if (C.cur !== c) { c.local.getTracks().forEach(t => t.stop()); return; }
    clearTimeout(c.timer); c.state = 'wait';
    c.timer = setTimeout(() => { if (C.cur === c && c.state !== 'conn') end('failed'); }, 20000);
    N.sendTo(c.id, { t: 'cl', k: 'accept', cid: c.cid });
    changed();
  };
  C.decline = () => { const c = C.cur; if (!c || c.dir !== 'in' || c.state !== 'ring') return; N.sendTo(c.id, { t: 'cl', k: 'reject', cid: c.cid, r: 'declined' }); cleanup(); N.emit('callend', { reason: 'declined', name: c.name, id: c.id, dir: 'in', dur: 0, was: 'ring', video: c.video }); changed(); };

  function attach(c, call) {
    c.call = call;
    call.on('stream', s => { c.remote = s; if (c.state !== 'conn') { c.state = 'conn'; c.t0 = Date.now(); clearTimeout(c.timer); } changed(); });
    const gone = () => { if (C.cur === c) end('lost', false); };
    call.on('close', gone); call.on('error', gone);
  }

  /* ---- إشارات واردة ---- */
  N.on('cl', ({ id, name, k, cid, video }) => {
    const c = C.cur;
    if (k === 'offer') {
      if (typeof cid !== 'string' || cid.length > 20) return;
      const talking = PC.voice && PC.voice.talking;
      if (c || talking) { N.sendTo(id, { t: 'cl', k: 'reject', cid, r: 'busy' }); return; }
      const n = C.cur = { cid, id, name, video: !!video, dir: 'in', state: 'ring', local: null, remote: null, call: null, t0: 0 };
      n.timer = setTimeout(() => { if (C.cur === n && n.state === 'ring') { N.emit('callend', { reason: 'missed', name, id, dir: 'in', dur: 0, was: 'ring', video: n.video }); cleanup(); changed(); } }, RING_MS);
      N.emit('callring', { id, name, video: !!video }); changed(); return;
    }
    if (!c || c.cid !== cid || c.id !== id) return;
    if (k === 'accept' && c.dir === 'out' && c.state === 'ring') {
      c.state = 'wait'; clearTimeout(c.timer);
      c.timer = setTimeout(() => { if (C.cur === c && c.state !== 'conn') end('failed'); }, 20000);
      try { attach(c, N.peer.call(N.mainId(id), c.local, { metadata: { kind: 'call', cid } })); } catch { end('failed'); }
      changed();
    } else if (k === 'end') { end('remote', false); }
  });
  /* reject يحمل السبب: نعيد تعريفه بوضوح */
  N.on('cl', ({ id, k, cid, r }) => {
    const c = C.cur; if (k !== 'reject' || !c || c.cid !== cid || c.id !== id) return;
    end(r === 'busy' ? 'busy' : r === 'nomedia' ? 'nomedia' : 'rejected', false);
  });

  /* مكالمة وسائط واردة: لا تُقبل إلا للمكالمة الجارية وبمعرّفها */
  C.mediaIn = call => {
    const c = C.cur, pre = 'pcm-' + N.rid + '-', pid = String(call.peer || '');
    const md = call.metadata || {};
    if (!c || c.dir !== 'in' || c.state !== 'wait' || md.cid !== c.cid || pid !== pre + c.id) { try { call.close(); } catch {} return; }
    attach(c, call); call.answer(c.local);
  };

  N.on('offline', ({ id }) => { if (C.cur && C.cur.id === id) end('lost', false); });
  C.toggleMic = () => { const c = C.cur; if (!c || !c.local) return false; const t = c.local.getAudioTracks(); const on = !(t[0] && t[0].enabled); t.forEach(x => { x.enabled = on; }); changed(); return on; };
  C.micOn = () => { const c = C.cur; const t = c && c.local && c.local.getAudioTracks()[0]; return !t || t.enabled; };
  C.toggleCam = () => { const c = C.cur; if (!c || !c.local) return false; const t = c.local.getVideoTracks(); const on = !(t[0] && t[0].enabled); t.forEach(x => { x.enabled = on; }); changed(); return on; };
  C.camOn = () => { const c = C.cur; const t = c && c.local && c.local.getVideoTracks()[0]; return !!t && t.enabled; };
  C.flip = async () => {                                     // تبديل الكاميرا الأمامية/الخلفية
    const c = C.cur; if (!c || !c.video || !c.local) return;
    const old = c.local.getVideoTracks()[0]; if (!old) return;
    const face = (old.getSettings && old.getSettings().facingMode) === 'environment' ? 'user' : 'environment';
    const ns = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: face } } });
    const nt = ns.getVideoTracks()[0];
    const sender = c.call && c.call.peerConnection && c.call.peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender) await sender.replaceTrack(nt);
    c.local.removeTrack(old); old.stop(); c.local.addTrack(nt); changed();
  };
  const stop0 = N.stop;
  N.stop = function (...a) { try { if (C.cur) end('hangup'); } catch {} return stop0.apply(N, a); };
})();

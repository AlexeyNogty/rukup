'use strict';
// Звонки: аудио, видео и демонстрация экрана поверх WebRTC. Сигналинг идёт через сервер (WebSocket, сообщения t:'rtc').
// Hub (определяется в app.js): Hub.send(obj), Hub.toast(text)
const Call = (() => {
  let ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  // Умеренные параметры: камера 640×360 до 24 к/с, шумоподавление и эхо-подавление — звонок идёт даже на слабом Wi-Fi
  const MEDIA = {
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 } },
  };

  // c — состояние звонка, которое читает интерфейс
  const c = {
    state: 'idle',        // idle | calling | ringing | connecting | active
    peer: null,           // { id, name, role }
    media: 'audio',
    micOn: false, camOn: false, sharing: false,
    remoteCam: false, remoteSharing: false,
    remoteStream: null, remoteScreen: null,
    startedAt: 0,
  };
  let pc = null, local = null, screen = null, screenSender = null, camSender = null;
  let remoteScreenId = null;
  let neg = { polite: false, making: false, ignore: false };
  let pending = [];
  let discTimer = null;
  const listeners = new Set();
  const emit = () => listeners.forEach((f) => { try { f(); } catch (e) { console.error(e); } });
  const sendRtc = (data) => Hub.send({ t: 'rtc', data });

  function stopStream(s) { if (s) s.getTracks().forEach((t) => { try { t.stop(); } catch { /* уже остановлен */ } }); }

  function cleanup() {
    clearTimeout(discTimer);
    stopStream(local); stopStream(screen);
    if (pc) { try { pc.close(); } catch { /* уже закрыт */ } }
    pc = null; local = null; screen = null; screenSender = null; camSender = null; remoteScreenId = null; pending = [];
    Object.assign(c, { state: 'idle', peer: null, media: 'audio', micOn: false, camOn: false, sharing: false, remoteCam: false, remoteSharing: false, remoteStream: null, remoteScreen: null, startedAt: 0 });
  }

  async function getLocal(media) {
    local = null;
    const md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) { Hub.toast('Камера и микрофон недоступны: откройте сайт по адресу localhost или https'); return; }
    const tries = media === 'video' ? [{ audio: MEDIA.audio, video: MEDIA.video }, { audio: MEDIA.audio, video: false }] : [{ audio: MEDIA.audio, video: false }];
    for (const constraints of tries) {
      try { local = await md.getUserMedia(constraints); break; } catch { /* пробуем проще */ }
    }
    if (!local) Hub.toast('Нет доступа к микрофону — вы будете только слышать собеседника');
    c.micOn = !!(local && local.getAudioTracks().length);
    c.camOn = !!(local && local.getVideoTracks().length);
  }

  function createPc(polite) {
    neg = { polite, making: false, ignore: false };
    pc = new RTCPeerConnection({ ...ICE, iceCandidatePoolSize: 2 });
    pc.onicecandidate = (e) => { if (e.candidate) sendRtc({ candidate: e.candidate }); };
    pc.onnegotiationneeded = async () => {
      try { neg.making = true; await pc.setLocalDescription(); sendRtc({ description: pc.localDescription }); }
      catch (e) { console.error('negotiation', e); } finally { neg.making = false; }
    };
    pc.ontrack = (e) => {
      const s = e.streams[0];
      if (!s) return;
      if (s.id === remoteScreenId) c.remoteScreen = s; else c.remoteStream = s;
      e.track.onunmute = emit;
      emit();
    };
    // Обрыв сети: через 3 с пробуем «перезапустить» маршрут (ICE restart), не бросая звонок
    pc.onconnectionstatechange = () => {
      if (!pc) return;
      const st = pc.connectionState;
      clearTimeout(discTimer);
      if (st === 'disconnected') discTimer = setTimeout(() => { if (pc && pc.connectionState !== 'connected') restartIce(); }, 3000);
      if (st === 'failed') { Hub.toast('Связь прервалась — пробуем восстановить'); restartIce(); }
    };
    pc.onsignalingstatechange = () => { if (pc && pc.signalingState === 'stable') tuneAll(); };
    if (local) {
      local.getTracks().forEach((t) => { const s = pc.addTrack(t, local); if (t.kind === 'video') camSender = s; });
    }
    if (!local || !local.getAudioTracks().length) pc.addTransceiver('audio', { direction: 'recvonly' });
    sendRtc({ cam: c.camOn });
    const queued = pending; pending = [];
    queued.forEach(onSignal);
  }

  async function onSignal(d) {
    if (d.cam !== undefined) { c.remoteCam = !!d.cam; return emit(); }
    if (d.share !== undefined) {
      if (d.share) { remoteScreenId = d.streamId || null; c.remoteSharing = true; }
      else { remoteScreenId = null; c.remoteSharing = false; c.remoteScreen = null; }
      return emit();
    }
    if (!pc) { pending.push(d); return; }
    try {
      if (d.description) {
        const collision = d.description.type === 'offer' && (neg.making || pc.signalingState !== 'stable');
        neg.ignore = !neg.polite && collision;
        if (neg.ignore) return;
        await pc.setRemoteDescription(d.description);
        if (d.description.type === 'offer') { await pc.setLocalDescription(); sendRtc({ description: pc.localDescription }); }
      } else if (d.candidate) {
        try { await pc.addIceCandidate(d.candidate); } catch (e) { if (!neg.ignore) throw e; }
      }
    } catch (e) { console.error('signal', e); }
  }

  function restartIce() { try { if (pc) pc.restartIce(); } catch { /* соединение закрыто */ } }
  // Потолок битрейта: камера до 0,7 Мбит/с, показ браузера до 2,5 Мбит/с при 12 к/с (текст читаем, канал не забиваем)
  async function tune(sender, { maxBitrate, maxFramerate, degradation }) {
    if (!sender) return;
    try {
      const prm = sender.getParameters();
      if (!prm.encodings || !prm.encodings.length) prm.encodings = [{}];
      prm.encodings[0].maxBitrate = maxBitrate;
      if (maxFramerate) prm.encodings[0].maxFramerate = maxFramerate;
      if (degradation) prm.degradationPreference = degradation;
      await sender.setParameters(prm);
    } catch { /* не критично: браузер подберёт сам */ }
  }
  function tuneAll() {
    tune(camSender, { maxBitrate: 700_000, maxFramerate: 24 });
    tune(screenSender, { maxBitrate: 2_500_000, maxFramerate: 12, degradation: 'maintain-resolution' });
  }

  function markActive() { c.state = 'active'; c.startedAt = Date.now(); emit(); }

  const api = {
    state: c,
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    setIce(list) { if (Array.isArray(list) && list.length) ICE = { iceServers: list }; },
    localStream: () => local,
    screenStream: () => screen,

    // Занятие начинается после согласия ученика: сервер сообщает обеим сторонам, кто «вежливая» сторона согласования
    async begin(peer, polite, ice) {
      if (c.state !== 'idle') cleanup();
      api.setIce(ice);
      Object.assign(c, { state: 'connecting', peer, media: 'audio' }); emit();
      await getLocal('audio');
      if (c.state !== 'connecting') { stopStream(local); local = null; return; }
      createPc(polite); markActive();
    },
    async invite(peer, media) {
      if (c.state !== 'idle') return;
      Object.assign(c, { state: 'calling', peer, media }); emit();
      await getLocal(media);
      if (c.state !== 'calling') { stopStream(local); local = null; return; } // за время запроса доступа отменили
      if (!Hub.send({ t: 'call_invite', to: peer.id, media })) { stopStream(local); local = null; cleanup(); emit(); } // нет связи — не зависаем на «Вызываем…»
    },
    async accept() {
      if (c.state !== 'ringing') return;
      c.state = 'connecting'; emit();
      await getLocal(c.media);
      if (c.state !== 'connecting') { stopStream(local); local = null; return; }
      Hub.send({ t: 'call_accept' });
    },
    decline() { if (c.state === 'ringing') { Hub.send({ t: 'call_decline' }); cleanup(); emit(); } },
    hangup() {
      if (c.state === 'idle') return;
      if (c.state === 'ringing') return api.decline();
      Hub.send({ t: 'hangup' });
      if (c.state === 'calling') { cleanup(); emit(); }
    },
    reset() { const was = c.state !== 'idle'; cleanup(); if (was) emit(); },

    toggleMic() {
      const t = local && local.getAudioTracks()[0];
      if (!t) return Hub.toast('Микрофон недоступен');
      t.enabled = !t.enabled; c.micOn = t.enabled; emit();
    },
    async toggleCam() {
      if (c.state !== 'active' || !pc) return;
      if (c.camOn) {
        const t = local && local.getVideoTracks()[0];
        if (t) { t.stop(); local.removeTrack(t); }
        if (camSender) { try { await camSender.replaceTrack(null); } catch { /* не критично */ } }
        c.camOn = false; sendRtc({ cam: false }); return emit();
      }
      try {
        const v = await navigator.mediaDevices.getUserMedia({ video: MEDIA.video });
        const t = v.getVideoTracks()[0];
        if (!local) local = new MediaStream();
        local.addTrack(t);
        if (camSender) await camSender.replaceTrack(t); else camSender = pc.addTrack(t, local);
        c.camOn = true; sendRtc({ cam: true }); emit();
      } catch { Hub.toast('Нет доступа к камере'); }
    },
    async toggleShare() {
      if (c.state !== 'active' || !pc) return;
      if (c.sharing) return api.stopShare();
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return Hub.toast('Демонстрация экрана здесь недоступна');
      try { screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false }); }
      catch { screen = null; return; }
      const track = screen.getVideoTracks()[0];
      try { track.contentHint = 'detail'; } catch { /* необязательно */ } // для текста важнее чёткость, чем плавность
      sendRtc({ share: true, streamId: screen.id });
      screenSender = pc.addTrack(track, screen);
      track.onended = () => api.stopShare();
      c.sharing = true; emit();
    },
    stopShare() {
      if (!c.sharing) return;
      sendRtc({ share: false });
      try {
        const tr = pc && pc.getTransceivers().find((x) => x.sender === screenSender);
        if (tr && typeof tr.stop === 'function') tr.stop(); else if (pc && screenSender) pc.removeTrack(screenSender);
      } catch { /* соединение уже закрыто */ }
      stopStream(screen); screen = null; screenSender = null; c.sharing = false; emit();
    },

    // сообщения с сервера
    handle(m) {
      switch (m.t) {
        case 'call_ringing': break;
        case 'call_failed': cleanup(); emit(); Hub.toast(m.reason || 'Звонок не удался'); break;
        case 'call_incoming':
          if (c.state !== 'idle') { Hub.send({ t: 'call_decline' }); break; }
          Object.assign(c, { state: 'ringing', peer: m.from, media: m.media }); emit();
          Hub.onCallIncoming(m.from);
          break;
        case 'call_cancelled': case 'call_taken':
          if (c.state === 'ringing' || c.state === 'connecting') { cleanup(); emit(); } // звонивший отменил, пока мы отвечали
          break;
        case 'call_accepted': createPc(false); markActive(); break;   // мы звонили
        case 'call_started': createPc(true); markActive(); break;     // мы отвечали
        case 'call_ended': { cleanup(); emit(); Hub.onCallEnded(m.summary, m.reason); break; }
        case 'rtc': if (m.data) onSignal(m.data); break;
      }
    },
  };
  return api;
})();

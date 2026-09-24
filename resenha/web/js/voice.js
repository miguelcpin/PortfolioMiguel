// Voz, câmera e compartilhamento de tela via WebRTC em malha (cada pessoa conecta
// direto em cada outra). Com até 10 pessoas isso dá latência menor que passar por
// um servidor de mídia, e o servidor não precisa processar áudio nenhum.
//
// Usa o padrão "perfect negotiation" do WebRTC para aguentar renegociações
// (ligar câmera / tela no meio da chamada) dos dois lados ao mesmo tempo.

import { buildMicChain, noiseMode } from './mic-processing.js';

const AUDIO_BITRATE = 128_000; // Discord grátis: 64 kbps
const CAMERA_BITRATE = 1_500_000;
const SCREEN_BITRATE = 4_000_000;

export class VoiceClient extends EventTarget {
  constructor(socket) {
    super();
    this.socket = socket;
    this.iceServers = [];
    this.channelId = null;
    this.peers = new Map(); // socketId -> Peer
    this.localStream = null; // microfone (já processado)
    this.rawMicStream = null;
    this.micChain = null; // RNNoise -> ganho -> noise gate
    this.cameraStream = null;
    this.screenStream = null;
    this.muted = false;
    this.deafened = false;
    this.speaking = new Map(); // key -> boolean  (key = 'local' ou socketId)
    this.userVolumes = new Map(); // userId -> 0..1
    this.settings = {
      inputDeviceId: 'default',
      outputDeviceId: 'default',
      noiseSuppression: 'ai', // 'ai' (RNNoise) | 'browser' | 'off'
      noiseGate: true,
      gateThreshold: -50, // dB
      echoCancellation: true,
      autoGainControl: true,
      inputGain: 1,
      pushToTalk: false,
      pushToTalkKey: 'KeyV',
    };
    this.pttActive = false;
    this.facingMode = 'user';
    this.audioCtx = null;
    this.meters = new Map(); // key -> { analyser, data }
    this.meterTimer = null;

    socket.on('voice:peer-joined', ({ socketId, userId }) => {
      if (!this.channelId) return;
      // Quem chega é que inicia a conexão; aqui só registramos o par (ele vai mandar a oferta)
      this.ensurePeer(socketId, userId);
    });
    socket.on('voice:peer-left', ({ socketId }) => this.removePeer(socketId));
    socket.on('voice:signal', ({ from, userId, data }) => {
      if (!this.channelId) return;
      const peer = this.ensurePeer(from, userId);
      peer.queue = peer.queue.then(() => this.handleSignal(peer, data)).catch((e) => console.warn('[voz] sinal', e));
    });
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  get inCall() {
    return !!this.channelId;
  }

  // ---------- entrar / sair ----------
  async join(channelId) {
    if (this.channelId === channelId) return;
    if (this.channelId) this.leave(false);
    await this.startMic();
    const res = await new Promise((resolve) =>
      this.socket.emit('voice:join', { channelId, muted: this.muted, deafened: this.deafened }, resolve),
    );
    if (res?.error) {
      this.stopMic();
      throw new Error(res.error);
    }
    this.channelId = channelId;
    for (const p of res.peers) {
      const peer = this.ensurePeer(p.socketId, p.userId);
      this.attachLocalTracks(peer); // dispara negotiationneeded -> oferta
    }
    this.startMeters();
    this.emit('change');
  }

  leave(notify = true) {
    if (!this.channelId) return;
    if (notify) this.socket.emit('voice:leave');
    for (const id of [...this.peers.keys()]) this.removePeer(id);
    this.stopCamera(false);
    this.stopScreen(false);
    this.stopMic();
    this.stopMeters();
    this.channelId = null;
    this.emit('change');
  }

  // Reconexão do socket: o servidor esqueceu a gente, então entra de novo
  async rejoin() {
    const cid = this.channelId;
    if (!cid) return;
    this.leave(false);
    try {
      await this.join(cid);
    } catch (e) {
      console.warn('[voz] falha ao reconectar', e);
    }
  }

  // ---------- microfone ----------
  micConstraints() {
    const s = this.settings;
    return {
      deviceId: s.inputDeviceId && s.inputDeviceId !== 'default' ? { exact: s.inputDeviceId } : undefined,
      echoCancellation: s.echoCancellation,
      // Com o RNNoise ligado, o filtro do navegador só piora a voz (processaria duas vezes)
      noiseSuppression: noiseMode(s) === 'browser',
      autoGainControl: s.autoGainControl,
      channelCount: 1,
      sampleRate: 48000,
    };
  }

  async startMic() {
    const ctx = this.ctx();
    let raw;
    try {
      raw = await navigator.mediaDevices.getUserMedia({ audio: this.micConstraints() });
    } catch (e) {
      // Dispositivo salvo sumiu? tenta o padrão
      raw = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    this.rawMicStream = raw;
    // Passa pelo WebAudio: supressão de ruído (RNNoise), ganho de entrada e noise gate
    this.micChain?.dispose();
    this.micChain = await buildMicChain(ctx, raw, this.settings);
    this.micGain = this.micChain.gain;
    const dest = ctx.createMediaStreamDestination();
    this.micChain.output.connect(dest);
    this.localStream = dest.stream;
    this.addMeter('local', this.localStream);
    this.applyMicEnabled();
  }

  stopMic() {
    this.rawMicStream?.getTracks().forEach((t) => t.stop());
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.micChain?.dispose();
    this.micChain = null;
    this.micGain = null;
    this.rawMicStream = null;
    this.localStream = null;
    this.meters.delete('local');
  }

  async restartMic() {
    if (!this.channelId) return;
    const old = this.localStream;
    this.rawMicStream?.getTracks().forEach((t) => t.stop());
    await this.startMic();
    const track = this.localStream.getAudioTracks()[0];
    for (const peer of this.peers.values()) {
      const sender = peer.pc.getSenders().find((s) => s.track && old && old.getTracks().includes(s.track));
      if (sender) await sender.replaceTrack(track);
    }
    old?.getTracks().forEach((t) => t.stop());
  }

  setInputGain(v) {
    this.settings.inputGain = v;
    if (this.micGain) this.micGain.gain.value = v;
  }

  setNoiseGate(enabled, threshold = this.settings.gateThreshold) {
    this.settings.noiseGate = enabled;
    this.settings.gateThreshold = threshold;
    this.micChain?.setGate(enabled, threshold);
  }

  applyMicEnabled() {
    const enabled = !this.muted && !this.deafened && (!this.settings.pushToTalk || this.pttActive);
    this.localStream?.getAudioTracks().forEach((t) => (t.enabled = enabled));
  }

  setPushToTalkActive(active) {
    if (this.pttActive === active) return;
    this.pttActive = active;
    this.applyMicEnabled();
  }

  setMuted(muted) {
    this.muted = muted;
    if (!muted && this.deafened) this.deafened = false;
    this.applyMicEnabled();
    this.applyDeafen();
    this.socket.emit('voice:update', { muted: this.muted, deafened: this.deafened });
    this.emit('change');
  }

  setDeafened(deafened) {
    this.deafened = deafened;
    this.applyMicEnabled();
    this.applyDeafen();
    this.socket.emit('voice:update', { muted: this.muted, deafened: this.deafened });
    this.emit('change');
  }

  applyDeafen() {
    for (const peer of this.peers.values()) this.applyPeerVolume(peer);
  }

  setUserVolume(userId, v) {
    this.userVolumes.set(userId, v);
    for (const peer of this.peers.values()) if (peer.userId === userId) this.applyPeerVolume(peer);
  }

  applyPeerVolume(peer) {
    const vol = this.deafened ? 0 : this.userVolumes.get(peer.userId) ?? 1;
    for (const el of peer.audioEls) el.volume = Math.max(0, Math.min(1, vol));
  }

  async setOutputDevice(deviceId) {
    this.settings.outputDeviceId = deviceId;
    for (const peer of this.peers.values()) for (const el of peer.audioEls) this.applySink(el);
  }

  applySink(el) {
    const id = this.settings.outputDeviceId;
    if (el.setSinkId) el.setSinkId(id === 'default' ? '' : id).catch((e) => console.warn('[voz] setSinkId', e));
  }

  ctx() {
    if (!this.audioCtx) this.audioCtx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
    return this.audioCtx;
  }

  // ---------- câmera / tela ----------
  cameraConstraints() {
    return { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode: this.facingMode };
  }

  async startCamera() {
    this.cameraStream = await navigator.mediaDevices.getUserMedia({ video: this.cameraConstraints() });
    const track = this.cameraStream.getVideoTracks()[0];
    track.onended = () => this.stopCamera();
    for (const peer of this.peers.values()) this.addTrackTo(peer, track, this.cameraStream, CAMERA_BITRATE);
    this.socket.emit('voice:update', { cameraStreamId: this.cameraStream.id });
    this.emit('change');
  }

  // Celular: alterna câmera frontal/traseira sem renegociar (replaceTrack)
  async flipCamera() {
    if (!this.cameraStream) return;
    const old = this.cameraStream.getVideoTracks()[0];
    this.facingMode = this.facingMode === 'user' ? 'environment' : 'user';
    old.stop(); // alguns celulares não abrem duas câmeras ao mesmo tempo
    const fresh = await navigator.mediaDevices.getUserMedia({ video: this.cameraConstraints() });
    const track = fresh.getVideoTracks()[0];
    track.onended = () => this.stopCamera();
    for (const peer of this.peers.values()) {
      const sender = peer.pc.getSenders().find((x) => x.track === old);
      if (sender) await sender.replaceTrack(track);
    }
    // Mesmo MediaStream (mesmo id), para os outros continuarem achando a câmera
    this.cameraStream.removeTrack(old);
    this.cameraStream.addTrack(track);
    this.emit('change');
  }

  stopCamera(notify = true) {
    if (!this.cameraStream) return;
    this.removeStreamFromPeers(this.cameraStream);
    this.cameraStream.getTracks().forEach((t) => t.stop());
    this.cameraStream = null;
    if (notify) {
      this.socket.emit('voice:update', { cameraStreamId: null });
      this.emit('change');
    }
  }

  async startScreen() {
    // No app desktop o seletor de janela/tela é mostrado antes (ver app.js)
    this.screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 }, width: { max: 1920 }, height: { max: 1080 } },
      audio: true,
    });
    const video = this.screenStream.getVideoTracks()[0];
    if ('contentHint' in video) video.contentHint = 'detail';
    video.onended = () => this.stopScreen();
    for (const peer of this.peers.values()) {
      for (const t of this.screenStream.getTracks()) this.addTrackTo(peer, t, this.screenStream, t.kind === 'video' ? SCREEN_BITRATE : AUDIO_BITRATE);
    }
    this.socket.emit('voice:update', { screenStreamId: this.screenStream.id });
    this.emit('change');
  }

  stopScreen(notify = true) {
    if (!this.screenStream) return;
    this.removeStreamFromPeers(this.screenStream);
    this.screenStream.getTracks().forEach((t) => t.stop());
    this.screenStream = null;
    if (notify) {
      this.socket.emit('voice:update', { screenStreamId: null });
      this.emit('change');
    }
  }

  removeStreamFromPeers(stream) {
    const tracks = stream.getTracks();
    for (const peer of this.peers.values()) {
      for (const sender of peer.pc.getSenders()) {
        if (sender.track && tracks.includes(sender.track)) {
          try {
            peer.pc.removeTrack(sender);
          } catch {}
        }
      }
    }
  }

  // ---------- conexões ----------
  ensurePeer(socketId, userId) {
    let peer = this.peers.get(socketId);
    if (peer) return peer;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: 'max-bundle' });
    peer = {
      socketId,
      userId,
      pc,
      polite: this.socket.id > socketId, // desempate determinístico
      makingOffer: false,
      ignoreOffer: false,
      queue: Promise.resolve(),
      streams: new Map(), // streamId -> MediaStream
      audioEls: [],
      audioStreams: new Set(),
      tracksAttached: false,
    };
    this.peers.set(socketId, peer);

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this.signal(peer, { description: pc.localDescription });
      } catch (e) {
        console.warn('[voz] oferta', e);
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => candidate && this.signal(peer, { candidate });
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') pc.restartIce();
      this.emit('change');
    };
    pc.ontrack = ({ track, streams }) => {
      const stream = streams[0] || new MediaStream([track]);
      peer.streams.set(stream.id, stream);
      if (track.kind === 'audio') this.playRemoteAudio(peer, stream);
      track.addEventListener('ended', () => this.emit('change'));
      stream.onremovetrack = () => {
        if (!stream.getTracks().length) peer.streams.delete(stream.id);
        this.emit('change');
      };
      this.emit('change');
    };
    return peer;
  }

  attachLocalTracks(peer) {
    if (peer.tracksAttached) return;
    peer.tracksAttached = true;
    if (this.localStream) {
      for (const t of this.localStream.getAudioTracks()) this.addTrackTo(peer, t, this.localStream, AUDIO_BITRATE);
    }
    if (this.cameraStream) {
      for (const t of this.cameraStream.getTracks()) this.addTrackTo(peer, t, this.cameraStream, CAMERA_BITRATE);
    }
    if (this.screenStream) {
      for (const t of this.screenStream.getTracks()) this.addTrackTo(peer, t, this.screenStream, t.kind === 'video' ? SCREEN_BITRATE : AUDIO_BITRATE);
    }
  }

  addTrackTo(peer, track, stream, maxBitrate) {
    const sender = peer.pc.addTrack(track, stream);
    // Aplica o bitrate assim que der (precisa da negociação ter começado)
    const apply = async () => {
      try {
        const params = sender.getParameters();
        if (!params.encodings?.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = maxBitrate;
        if (track.kind === 'video') params.degradationPreference = track.contentHint === 'detail' ? 'maintain-resolution' : 'balanced';
        await sender.setParameters(params);
      } catch {}
    };
    setTimeout(apply, 1500);
    return sender;
  }

  playRemoteAudio(peer, stream) {
    // Toca por <audio> (e não por WebAudio) para o cancelamento de eco do Chromium funcionar
    if (peer.audioStreams.has(stream.id)) return;
    peer.audioStreams.add(stream.id);
    const el = new Audio();
    el.autoplay = true;
    el.srcObject = stream;
    this.applySink(el);
    peer.audioEls.push(el);
    this.applyPeerVolume(peer);
    el.play().catch(() => {});
    // Medidor de fala só do microfone (primeiro stream de áudio do par)
    if (!this.meters.has(peer.socketId)) this.addMeter(peer.socketId, stream);
  }

  async handleSignal(peer, { description, candidate }) {
    const pc = peer.pc;
    if (description) {
      const collision = description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
      peer.ignoreOffer = !peer.polite && collision;
      if (peer.ignoreOffer) return;
      await pc.setRemoteDescription(description);
      if (description.type === 'offer') {
        this.attachLocalTracks(peer);
        await pc.setLocalDescription();
        this.signal(peer, { description: pc.localDescription });
      }
    } else if (candidate) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (e) {
        if (!peer.ignoreOffer) throw e;
      }
    }
  }

  signal(peer, data) {
    this.socket.emit('voice:signal', { to: peer.socketId, data: JSON.parse(JSON.stringify(data)) });
  }

  removePeer(socketId) {
    const peer = this.peers.get(socketId);
    if (!peer) return;
    for (const el of peer.audioEls) {
      el.pause();
      el.srcObject = null;
    }
    peer.pc.close();
    this.peers.delete(socketId);
    this.meters.delete(socketId);
    this.speaking.delete(socketId);
    this.emit('change');
  }

  // Stream de vídeo remoto (câmera ou tela) de um participante
  remoteStream(socketId, streamId) {
    const s = streamId && this.peers.get(socketId)?.streams.get(streamId);
    return s && s.getVideoTracks().some((t) => t.readyState === 'live') ? s : null;
  }

  connectionState(socketId) {
    return this.peers.get(socketId)?.pc.connectionState || 'new';
  }

  async ping(socketId) {
    const pc = this.peers.get(socketId)?.pc;
    if (!pc) return null;
    const stats = await pc.getStats();
    for (const r of stats.values()) {
      if (r.type === 'candidate-pair' && r.nominated && r.currentRoundTripTime != null) return Math.round(r.currentRoundTripTime * 1000);
    }
    return null;
  }

  // ---------- indicador de quem está falando ----------
  addMeter(key, stream) {
    try {
      const ctx = this.ctx();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      this.meters.set(key, { analyser, data: new Uint8Array(analyser.fftSize), hold: 0 });
    } catch (e) {
      console.warn('[voz] medidor', e);
    }
  }

  level(key) {
    const m = this.meters.get(key);
    if (!m) return 0;
    m.analyser.getByteTimeDomainData(m.data);
    let sum = 0;
    for (const v of m.data) sum += (v - 128) ** 2;
    return Math.sqrt(sum / m.data.length) / 128;
  }

  startMeters() {
    this.stopMeters();
    this.meterTimer = setInterval(() => {
      let changed = false;
      for (const [key, m] of this.meters) {
        const lvl = this.level(key);
        const localSilenced = key === 'local' && !this.localStream?.getAudioTracks()[0]?.enabled;
        if (lvl > 0.035 && !localSilenced) m.hold = 4;
        else m.hold = Math.max(0, m.hold - 1);
        const speaking = m.hold > 0;
        if (this.speaking.get(key) !== speaking) {
          this.speaking.set(key, speaking);
          changed = true;
        }
      }
      if (changed) this.emit('speaking');
    }, 80);
  }

  stopMeters() {
    clearInterval(this.meterTimer);
    this.speaking.clear();
  }

  isSpeaking(socketId) {
    return socketId === this.socket.id ? !!this.speaking.get('local') : !!this.speaking.get(socketId);
  }
}

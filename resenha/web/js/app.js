import { icons } from './icons.js';
import {
  $, $$, h, escapeHtml, avatarHtml, statusClass, STATUS_LABEL, formatTime, formatTimestamp, formatDay, formatSize,
  toast, openModal, askText, confirmDialog, contextMenu, closeContextMenu, playBlip, storage,
  isTouch, isMobile, bindMenu,
} from './util.js';
import { renderMarkdown, mentionsUser, isEmojiOnly } from './markdown.js';
import { VoiceClient } from './voice.js';
import { openSettings } from './settings.js';
import { isNative, abs, serverBase, setServerBase, serverLabel } from './config.js';

const desktop = window.desktop || null;
if (desktop) {
  document.body.classList.add('desktop');
  if (desktop.platform === 'darwin') document.body.classList.add('mac');
}
$$('[data-icon]').forEach((el) => (el.innerHTML = icons[el.dataset.icon]));

const EMOJIS = '😀 😂 🤣 😅 😊 😍 🥰 😘 😎 🤩 🥳 😏 😒 😢 😭 😡 🤬 🤯 😱 🤔 🙄 😴 🤮 🤡 💀 👻 👽 🤖 💩 👍 👎 👏 🙌 🙏 💪 🤝 ✌️ 🤞 👀 🧠 ❤️ 🧡 💛 💚 💙 💜 🖤 💔 💯 🔥 ✨ ⭐ 🎉 🎮 🕹️ 🏆 ⚽ 🍕 🍔 🍺 ☕ 🎵 🎧 📸 💻 📱 ✅ ❌ ⚠️ ❓ 💤 🚀 🌈 🐐 🐸 🐶 🐱 🦆'.split(' ');
const GROUP_MS = 7 * 60 * 1000;

// ---------- estado ----------
const S = {
  token: storage.get('token', null),
  me: null,
  serverName: '',
  serverIcon: null,
  users: new Map(),
  channels: [],
  voice: {}, // channelId -> [{socketId,userId,muted,deafened,cameraStreamId,screenStreamId}]
  current: null, // canal de texto aberto
  view: 'text', // 'text' | 'voice'
  voiceViewChannel: null,
  focusTile: null,
  fullTile: null, // vídeo aberto em tela cheia (câmera ou tela compartilhada)
  messages: new Map(),
  hasMore: new Map(),
  loadingOlder: false,
  lastMessageIds: {},
  lastRead: {},
  mentions: {},
  typing: new Map(), // channelId -> Map(userId -> timeout)
  replyTo: null,
  pending: [], // anexos sendo enviados
  collapsed: storage.get('collapsed', {}),
  iceServers: [],
  maxUploadMb: 500,
  connected: false,
  prefs: storage.get('prefs', { sounds: true, notifications: true, showMembers: true }),
};

let socket = null;
let voice = null;
let everConnected = false;

// ======================================================================
// Autenticação
// ======================================================================
let authMode = 'login';

async function showAuth() {
  $('#app').hidden = true;
  $('#auth').hidden = false;
  // No app Android a interface vem embutida: o usuário informa o servidor aqui
  $('#server-row').hidden = !isNative;
  if (isNative) $('#auth-form').server.value = serverBase();
  $('#auth-server').textContent = '';
  await refreshHealth();
  setAuthMode(authMode);
}

async function refreshHealth() {
  if (isNative && !serverBase()) return;
  try {
    const info = await (await fetch(abs('api/health'))).json();
    S.health = info;
    if (info.users === 0) setAuthMode('register');
    if (desktop || isNative) {
      $('#auth-server').innerHTML = `Servidor: <b>${escapeHtml(info.serverName)}</b> (${escapeHtml(serverLabel().replace(/^https?:\/\//, ''))}) · ${info.users}/${info.maxUsers} pessoas${desktop ? ' · <a href="#" id="change-server">trocar servidor</a>' : ''}`;
    }
    $('#change-server')?.addEventListener('click', (e) => {
      e.preventDefault();
      desktop.changeServer();
    });
  } catch {}
}

// Normaliza e testa o endereço digitado (só no app nativo)
async function checkServer(raw) {
  let v = raw.trim().replace(/\/+$/, '');
  if (!v) throw new Error('Informe o endereço do servidor.');
  if (!/^https?:\/\//i.test(v)) v = (/^(localhost|\d+\.\d+\.\d+\.\d+)(:\d+)?$/.test(v) ? 'http://' : 'https://') + v;
  const origin = new URL(v).origin;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const info = await (await fetch(origin + '/api/health', { signal: ctrl.signal })).json();
    if (info.app !== 'resenha') throw new Error('Esse endereço não é um servidor do Resenha.');
    return { origin, info };
  } catch (e) {
    if (e.message.includes('Resenha')) throw e;
    throw new Error('Não foi possível conectar. Confira o endereço e se o servidor está ligado.');
  } finally {
    clearTimeout(timer);
  }
}

function setAuthMode(mode) {
  authMode = mode;
  const reg = mode === 'register';
  $('#auth-title').textContent = reg ? 'Criar uma conta' : 'Boas-vindas de volta!';
  $('#auth-sub').textContent = reg ? `Entre para a ${S.health?.serverName || 'Resenha'}` : 'Estamos muito animados em te ver novamente!';
  $('#auth-submit').textContent = reg ? 'Continuar' : 'Entrar';
  $('#auth-switch-text').textContent = reg ? 'Já tem uma conta?' : 'Precisando de uma conta?';
  $('#auth-switch').textContent = reg ? 'Entrar' : 'Registre-se';
  $('#invite-row').hidden = !(reg && S.health?.needsInvite !== false);
  $('#auth-form').password.autocomplete = reg ? 'new-password' : 'current-password';
  $('#auth-error').hidden = true;
}

$('#auth-switch').addEventListener('click', (e) => {
  e.preventDefault();
  setAuthMode(authMode === 'login' ? 'register' : 'login');
});

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { username: f.username.value.trim(), password: f.password.value, inviteCode: f.inviteCode.value.trim() };
  $('#auth-submit').disabled = true;
  try {
    if (isNative && f.server.value.trim() !== serverBase()) {
      const { origin, info } = await checkServer(f.server.value);
      setServerBase(origin);
      S.health = info;
      f.server.value = origin;
      // Servidor novo sem ninguém: vira cadastro e mostra o campo de convite
      if (authMode === 'login' && info.users === 0) {
        setAuthMode('register');
        return;
      }
      $('#invite-row').hidden = !(authMode === 'register' && info.needsInvite);
    }
    const res = await fetch(abs(authMode === 'login' ? 'api/login' : 'api/register'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro desconhecido.');
    S.token = data.token;
    storage.set('token', data.token);
    f.password.value = '';
    connect();
  } catch (err) {
    $('#auth-error').textContent = err.message === 'Failed to fetch' ? 'Não foi possível falar com o servidor.' : err.message;
    $('#auth-error').hidden = false;
  } finally {
    $('#auth-submit').disabled = false;
  }
});

export async function logout() {
  try {
    await fetch(abs('api/logout'), { method: 'POST', headers: { Authorization: `Bearer ${S.token}` } });
  } catch {}
  voice?.leave();
  socket?.disconnect();
  socket = null;
  S.token = null;
  storage.set('token', null);
  $('.settings')?.remove();
  showAuth();
}

// ======================================================================
// Conexão
// ======================================================================
function connect() {
  socket = window.io(serverBase() || undefined, { auth: { token: S.token }, transports: ['websocket', 'polling'] });
  voice = new VoiceClient(socket);
  Object.assign(voice.settings, storage.get('voiceSettings', {}));
  voice.userVolumes = new Map(Object.entries(storage.get('userVolumes', {})));
  voice.screenVolumes = new Map(Object.entries(storage.get('screenVolumes', {})));
  voice.addEventListener('change', () => {
    renderChannels();
    renderVoicePanel();
    renderUserPanel();
    if (S.view === 'voice') renderVoiceView();
  });
  voice.addEventListener('speaking', updateSpeaking);

  socket.on('connect_error', (err) => {
    if (err.message === 'unauthorized') {
      socket.disconnect();
      S.token = null;
      storage.set('token', null);
      showAuth();
    }
  });

  socket.on('connect', () => {
    S.connected = true;
    renderConnectionBanner();
  });

  socket.on('disconnect', () => {
    S.connected = false;
    renderConnectionBanner();
  });

  socket.on('init', (d) => {
    const reconnect = everConnected;
    everConnected = true;
    S.me = d.me;
    S.serverName = d.serverName;
    S.serverIcon = d.serverIcon;
    S.users = new Map(d.users.map((u) => [u.id, u]));
    S.channels = d.channels;
    S.voice = d.voice;
    S.lastMessageIds = d.lastMessageIds;
    S.iceServers = d.iceServers;
    S.maxUploadMb = d.maxUploadMb;
    voice.iceServers = d.iceServers;
    S.lastRead = storage.get(`lastRead:${S.me.id}`, null);
    if (!S.lastRead) {
      // Primeira vez: tudo que já existe conta como lido
      S.lastRead = { ...d.lastMessageIds };
      saveLastRead();
    }

    $('#auth').hidden = true;
    $('#app').hidden = false;
    document.body.classList.toggle('hide-members', !S.prefs.showMembers);

    if (!S.current || !getChannel(S.current)) {
      const saved = storage.get('currentChannel', null);
      S.current = getChannel(saved)?.type === 'text' ? saved : textChannels()[0]?.id;
    }
    if (reconnect) {
      // Recarrega o canal atual para pegar o que perdemos
      S.messages.clear();
      S.hasMore.clear();
      voice.rejoin();
    }
    renderAll();
    openChannel(S.current, true);
    if (S.prefs.notifications && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  });

  socket.on('kicked', () => {
    toast('Você foi removido do servidor.', 'error');
    logout();
  });

  socket.on('user:new', (u) => {
    S.users.set(u.id, { ...u, online: false });
    renderMembers();
  });
  socket.on('user:update', (u) => {
    S.users.set(u.id, u);
    if (u.id === S.me?.id) S.me = { ...S.me, ...u };
    renderMembers();
    renderChannels();
    renderUserPanel();
    if (S.view === 'text') rerenderMessagesKeepScroll();
  });
  socket.on('user:remove', ({ id }) => {
    S.users.delete(id);
    renderMembers();
  });

  socket.on('server:update', ({ serverName, serverIcon }) => {
    S.serverName = serverName;
    S.serverIcon = serverIcon;
    renderGuilds();
  });

  socket.on('channels', (channels) => {
    S.channels = channels;
    if (!getChannel(S.current)) openChannel(textChannels()[0]?.id);
    if (S.voiceViewChannel && !getChannel(S.voiceViewChannel)) {
      S.view = 'text';
      renderView();
    }
    renderChannels();
    renderHeader();
  });

  socket.on('voice:state', ({ channelId, members }) => {
    if (members.length) S.voice[channelId] = members;
    else delete S.voice[channelId];
    renderChannels();
    if (S.view === 'voice') renderVoiceView();
    if (voice.channelId === channelId) maybeJoinLeaveSound(members);
  });

  socket.on('message:new', onMessageNew);
  socket.on('message:update', (msg) => {
    const list = S.messages.get(msg.channelId);
    const idx = list?.findIndex((m) => m.id === msg.id) ?? -1;
    if (idx < 0) return;
    list[idx] = msg;
    if (msg.channelId === S.current) {
      const el = $(`.msg[data-id="${msg.id}"]`);
      if (el && !el.querySelector('.edit-box')) {
        const fresh = messageEl(msg, list[idx - 1]);
        el.replaceWith(fresh);
      }
    }
  });
  socket.on('message:delete', ({ channelId, id }) => {
    const list = S.messages.get(channelId);
    if (!list) return;
    const idx = list.findIndex((m) => m.id === id);
    if (idx >= 0) list.splice(idx, 1);
    if (channelId === S.current) rerenderMessagesKeepScroll();
  });

  socket.on('typing', ({ channelId, userId }) => {
    if (!S.typing.has(channelId)) S.typing.set(channelId, new Map());
    const m = S.typing.get(channelId);
    clearTimeout(m.get(userId));
    m.set(userId, setTimeout(() => {
      m.delete(userId);
      renderTyping();
    }, 8000));
    renderTyping();
  });
}

let lastVoiceCount = 0;
function maybeJoinLeaveSound(members) {
  if (!S.prefs.sounds) return;
  if (members.length > lastVoiceCount && lastVoiceCount > 0) playBlip([520, 780]);
  else if (members.length < lastVoiceCount) playBlip([780, 520]);
  lastVoiceCount = members.length;
}

function renderConnectionBanner() {
  let b = $('.banner-offline');
  if (S.connected || !everConnected) return b?.remove();
  if (!b) {
    b = h('<div class="banner-offline">Conexão perdida. Tentando reconectar…</div>');
    $('#main').prepend(b);
  }
}

// ======================================================================
// Helpers
// ======================================================================
const getChannel = (id) => S.channels.find((c) => c.id === id);
const textChannels = () => S.channels.filter((c) => c.type === 'text').sort((a, b) => a.position - b.position);
const voiceChannels = () => S.channels.filter((c) => c.type === 'voice').sort((a, b) => a.position - b.position);
const user = (id) => S.users.get(id) || { id, username: 'Usuário removido', color: '#4e5058' };
const isUnread = (cid) => S.lastMessageIds[cid] && (!S.lastRead[cid] || S.lastMessageIds[cid] > S.lastRead[cid]);

function saveLastRead() {
  storage.set(`lastRead:${S.me.id}`, S.lastRead);
}

function emitAck(event, data) {
  return new Promise((resolve) => socket.emit(event, data, (res) => resolve(res || {})));
}

function markRead(cid) {
  if (!cid || !S.lastMessageIds[cid]) return;
  if (S.lastRead[cid] === S.lastMessageIds[cid] && !S.mentions[cid]) return;
  S.lastRead[cid] = S.lastMessageIds[cid];
  delete S.mentions[cid];
  saveLastRead();
  renderChannels();
}

function renderAll() {
  renderGuilds();
  renderChannels();
  renderUserPanel();
  renderVoicePanel();
  renderMembers();
  renderHeader();
  renderView();
}

// ======================================================================
// Barra de servidores
// ======================================================================
function renderGuilds() {
  const icon = $('#guild-icon');
  icon.innerHTML = S.serverIcon
    ? `<img src="${escapeHtml(abs(S.serverIcon))}" alt="">`
    : escapeHtml(S.serverName.split(/\s+/).map((w) => w[0]).join('').slice(0, 3));
  icon.title = S.serverName;
  $('#server-name').textContent = S.serverName;
  document.title = S.serverName;
}

$('#server-header').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  const items = [];
  if (S.me.isAdmin) {
    items.push({ label: 'Configurações do servidor', icon: 'gear', action: () => openSettings(ctx(), 'server') });
    items.push({ label: 'Criar canal de texto', icon: 'hash', action: () => createChannel('text') });
    items.push({ label: 'Criar canal de voz', icon: 'speaker', action: () => createChannel('voice') });
    items.push('-');
  }
  items.push({ label: S.prefs.showMembers ? 'Esconder lista de membros' : 'Mostrar lista de membros', icon: 'members', action: toggleMembers });
  items.push({ label: 'Configurações de usuário', icon: 'gear', action: () => openSettings(ctx(), 'account') });
  contextMenu(r.left + 10, r.bottom + 4, items);
});

function toggleMembers() {
  S.prefs.showMembers = !S.prefs.showMembers;
  storage.set('prefs', S.prefs);
  document.body.classList.toggle('hide-members', !S.prefs.showMembers);
}

async function createChannel(type) {
  const name = await askText({
    title: type === 'text' ? 'Criar canal de texto' : 'Criar canal de voz',
    label: 'Nome do canal',
    placeholder: type === 'text' ? 'novo-canal' : 'Nova sala',
    confirm: 'Criar canal',
  });
  if (!name) return;
  const res = await emitAck('channel:create', { name, type });
  if (res.error) toast(res.error, 'error');
  else if (type === 'text') openChannel(res.channel.id);
}

// ======================================================================
// Lista de canais
// ======================================================================
function renderChannels() {
  const list = $('#channel-list');
  if (!S.me) return;
  const scroll = list.scrollTop;
  list.innerHTML = '';

  const cat = (key, label, type) => {
    const el = h(`<div class="category ${S.collapsed[key] ? 'collapsed' : ''}">
      <span class="cat-name">${icons.chevron}${label}</span>
      ${S.me.isAdmin ? `<button class="cat-add" title="Criar canal">${icons.plus}</button>` : ''}
    </div>`);
    el.addEventListener('click', (e) => {
      if (e.target.closest('.cat-add')) return createChannel(type);
      S.collapsed[key] = !S.collapsed[key];
      storage.set('collapsed', S.collapsed);
      renderChannels();
    });
    list.append(el);
    return !S.collapsed[key];
  };

  const showText = cat('text', 'Canais de texto', 'text');
  for (const c of textChannels()) {
    const active = S.view === 'text' && c.id === S.current;
    const unread = isUnread(c.id) && c.id !== S.current;
    if (!showText && !active && !unread) continue;
    const el = h(`<div class="channel ${active ? 'active' : ''} ${unread ? 'unread' : ''}" data-id="${c.id}">
      ${icons.hash}<span class="name">${escapeHtml(c.name)}</span>
      ${S.mentions[c.id] ? `<span class="badge">${S.mentions[c.id]}</span>` : ''}
    </div>`);
    el.addEventListener('click', () => {
      openChannel(c.id);
      showMain();
    });
    bindMenu(el, (e) => channelMenu(e, c));
    list.append(el);
  }

  const showVoice = cat('voice', 'Canais de voz', 'voice');
  for (const c of voiceChannels()) {
    const members = S.voice[c.id] || [];
    const active = S.view === 'voice' && S.voiceViewChannel === c.id;
    if (!showVoice && !members.length && voice?.channelId !== c.id) continue;
    const el = h(`<div class="channel ${active ? 'active' : ''}" data-id="${c.id}">${icons.speaker}<span class="name">${escapeHtml(c.name)}</span></div>`);
    el.addEventListener('click', () => {
      joinVoice(c.id);
      showMain();
    });
    bindMenu(el, (e) => channelMenu(e, c));
    list.append(el);
    if (members.length) {
      const wrap = h('<div class="voice-members"></div>');
      for (const m of members) {
        const u = user(m.userId);
        const row = h(`<div class="voice-member ${voice?.isSpeaking(m.socketId) && !m.muted ? 'speaking' : ''}" data-speak="${m.socketId}">
          ${avatarHtml(u, 24)}
          <span class="vm-name">${escapeHtml(u.username)}</span>
          <span class="vm-icons">
            ${m.screenStreamId ? '<span class="live-badge">Ao vivo</span>' : ''}
            ${m.cameraStreamId ? icons.video : ''}
            ${m.muted || m.deafened ? `<span class="red">${icons.micOff}</span>` : ''}
            ${m.deafened ? `<span class="red">${icons.headphonesOff}</span>` : ''}
          </span>
        </div>`);
        row.addEventListener('click', (e) => showProfile(u, e));
        bindMenu(row, (e) => userMenu(e, u));
        wrap.append(row);
      }
      list.append(wrap);
    }
  }
  list.scrollTop = scroll;
  desktop?.setBadge?.(Object.values(S.mentions).reduce((a, b) => a + b, 0));
}

function channelMenu(e, c) {
  e.preventDefault();
  const items = [];
  if (c.type === 'text') items.push({ label: 'Marcar como lido', action: () => markRead(c.id) });
  if (S.me.isAdmin) {
    items.push({ label: 'Renomear canal', icon: 'edit', action: async () => {
      const name = await askText({ title: 'Renomear canal', label: 'Nome do canal', value: c.name });
      if (!name) return;
      const res = await emitAck('channel:rename', { id: c.id, name });
      if (res.error) toast(res.error, 'error');
    } });
    items.push({ label: 'Excluir canal', icon: 'trash', danger: true, action: async () => {
      if (!(await confirmDialog({ title: 'Excluir canal', text: `Tem certeza que quer excluir ${c.type === 'text' ? '#' : ''}${c.name}? Isso não pode ser desfeito.`, confirm: 'Excluir canal' }))) return;
      const res = await emitAck('channel:delete', { id: c.id });
      if (res.error) toast(res.error, 'error');
    } });
  }
  if (items.length) contextMenu(e.clientX, e.clientY, items);
}

function userMenu(e, u, { screen = false } = {}) {
  e.preventDefault();
  e.stopPropagation();
  const items = [{ label: 'Perfil', action: () => showProfile(u, e) }, { label: 'Mencionar', action: () => insertText(`@${u.username} `) }];
  if (u.id !== S.me.id) {
    const slider = h(`<div class="menu-slider">Volume do usuário<input type="range" min="0" max="100" value="${Math.round((voice.userVolumes.get(u.id) ?? 1) * 100)}"></div>`);
    $('input', slider).addEventListener('input', (ev) => {
      voice.setUserVolume(u.id, ev.target.value / 100);
      storage.set('userVolumes', Object.fromEntries(voice.userVolumes));
    });
    // Som da tela compartilhada tem volume próprio (jogo/vídeo alto sem abaixar a voz)
    const sharing = (S.voice[voice.channelId] || []).some((m) => m.userId === u.id && m.screenStreamId);
    const screenSlider = sharing && h(`<div class="menu-slider">Volume da transmissão<input type="range" min="0" max="100" value="${Math.round((voice.screenVolumes.get(u.id) ?? 1) * 100)}"></div>`);
    screenSlider && $('input', screenSlider).addEventListener('input', (ev) => {
      voice.setScreenVolume(u.id, ev.target.value / 100);
      storage.set('screenVolumes', Object.fromEntries(voice.screenVolumes));
    });
    // No quadrado da tela, o volume da transmissão vem primeiro
    items.push('-', ...(screenSlider ? (screen ? [{ custom: screenSlider }, { custom: slider }] : [{ custom: slider }, { custom: screenSlider }]) : [{ custom: slider }]));
  }
  if (S.me.isAdmin && u.id !== S.me.id) {
    items.push('-', { label: `Expulsar ${u.username}`, danger: true, action: () => kickUser(u) });
  }
  contextMenu(e.clientX, e.clientY, items);
}

export async function kickUser(u) {
  if (!(await confirmDialog({ title: `Expulsar ${u.username}`, text: 'A conta será apagada e libera uma vaga no servidor. As mensagens antigas continuam.', confirm: 'Expulsar' }))) return;
  const res = await emitAck('user:kick', { id: u.id });
  if (res.error) toast(res.error, 'error');
}

// ======================================================================
// Painéis de baixo (voz conectada + usuário)
// ======================================================================
function renderVoicePanel() {
  const p = $('#voice-panel');
  if (!voice?.inCall) {
    p.hidden = true;
    return;
  }
  const c = getChannel(voice.channelId);
  const states = [...voice.peers.values()].map((pe) => pe.pc.connectionState);
  const connecting = states.some((s) => s === 'new' || s === 'connecting');
  const failed = states.some((s) => s === 'failed' || s === 'disconnected');
  p.hidden = false;
  p.innerHTML = `
    <div class="vp-top">
      <div>
        <div class="vp-status ${connecting || failed ? 'connecting' : ''}">${icons.signal}${failed ? 'Reconectando…' : connecting ? 'Conectando…' : 'Voz conectada'}</div>
        <div class="vp-channel">${escapeHtml(c?.name || '')} / ${escapeHtml(S.serverName)}</div>
      </div>
      <button class="icon-btn" id="vp-hang" title="Desconectar">${icons.hangup}</button>
    </div>
    <div class="vp-buttons">
      <button id="vp-cam" class="${voice.cameraStream ? 'on' : ''}" title="${voice.cameraStream ? 'Desligar câmera' : 'Ligar câmera'}">${icons.video}</button>
      ${canShareScreen ? `<button id="vp-screen" class="${voice.screenStream ? 'on' : ''}" title="${voice.screenStream ? 'Parar transmissão' : 'Compartilhar tela'}">${icons.screen}</button>` : ''}
    </div>`;
  $('#vp-hang').addEventListener('click', leaveVoice);
  $('.vp-channel', p).addEventListener('click', () => {
    openVoiceView(voice.channelId);
    showMain();
  });
  $('#vp-cam').addEventListener('click', toggleCamera);
  $('#vp-screen')?.addEventListener('click', toggleScreen);
}

function renderUserPanel() {
  if (!S.me) return;
  const me = { ...(S.users.get(S.me.id) || S.me), online: true };
  const muted = voice?.muted || voice?.deafened;
  const p = $('#user-panel');
  p.innerHTML = `
    <div class="up-user" id="up-user">
      ${avatarHtml(me, 32, true)}
      <div class="up-names"><div class="n1">${escapeHtml(me.username)}</div><div class="n2">${escapeHtml(me.customStatus || STATUS_LABEL[me.status] || 'Disponível')}</div></div>
    </div>
    <button class="icon-btn ${muted ? 'red' : ''}" id="up-mute" title="${muted ? 'Reativar microfone' : 'Silenciar'} (Ctrl+Shift+M)">${muted ? icons.micOff : icons.mic}</button>
    <button class="icon-btn ${voice?.deafened ? 'red' : ''}" id="up-deaf" title="${voice?.deafened ? 'Reativar áudio' : 'Ensurdecer'} (Ctrl+Shift+D)">${voice?.deafened ? icons.headphonesOff : icons.headphones}</button>
    <button class="icon-btn" id="up-settings" title="Configurações de usuário">${icons.gear}</button>`;
  $('#up-mute').addEventListener('click', toggleMute);
  $('#up-deaf').addEventListener('click', toggleDeafen);
  $('#up-settings').addEventListener('click', () => openSettings(ctx(), 'account'));
  $('#up-user').addEventListener('click', (e) => statusMenu(e));
}

function statusMenu(e) {
  closeContextMenu();
  const r = e.currentTarget.getBoundingClientRect();
  const pop = h('<div class="popout status-menu"></div>');
  for (const s of ['online', 'idle', 'dnd', 'invisible']) {
    const b = h(`<button class="menu-item"><span class="status-swatch ${s}"></span>${STATUS_LABEL[s]}</button>`);
    b.addEventListener('click', () => {
      socket.emit('user:update', { status: s });
      close();
    });
    pop.append(b);
  }
  pop.append(h('<div class="menu-sep"></div>'));
  const custom = h('<button class="menu-item">Definir status personalizado</button>');
  custom.addEventListener('click', async () => {
    close();
    const text = await askText({ title: 'Status personalizado', label: 'O que está rolando?', value: S.me.customStatus || '', placeholder: 'Jogando CS 🔫' });
    socket.emit('user:update', { customStatus: text || '' });
  });
  pop.append(custom);
  document.body.append(pop);
  pop.style.left = r.left + 'px';
  pop.style.top = r.top - pop.offsetHeight - 8 + 'px';
  const outside = (ev) => !pop.contains(ev.target) && close();
  const close = () => {
    pop.remove();
    document.removeEventListener('mousedown', outside, true);
  };
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
}

function toggleMute() {
  if (!voice) return;
  voice.setMuted(!(voice.muted || voice.deafened));
  storage.set('voiceMute', { muted: voice.muted, deafened: voice.deafened });
  if (S.prefs.sounds) playBlip(voice.muted ? [600, 400] : [400, 600]);
}

function toggleDeafen() {
  if (!voice) return;
  voice.setDeafened(!voice.deafened);
  storage.set('voiceMute', { muted: voice.muted, deafened: voice.deafened });
  if (S.prefs.sounds) playBlip(voice.deafened ? [500, 300] : [300, 500]);
}

// ======================================================================
// Voz
// ======================================================================
async function joinVoice(channelId) {
  openVoiceView(channelId);
  if (voice.channelId === channelId) return;
  const saved = storage.get('voiceMute', { muted: false, deafened: false });
  voice.muted = saved.muted;
  voice.deafened = saved.deafened;
  lastVoiceCount = 0;
  try {
    await voice.join(channelId);
    lastVoiceCount = (S.voice[channelId] || []).length;
    if (S.prefs.sounds) playBlip([520, 780]);
  } catch (e) {
    console.error(e);
    toast(e.name === 'NotAllowedError' ? 'Permissão de microfone negada.' : e.name === 'NotFoundError' ? 'Nenhum microfone encontrado.' : e.message || 'Não foi possível entrar na voz.', 'error');
  }
}

function leaveVoice() {
  voice.leave();
  if (S.prefs.sounds) playBlip([780, 520]);
  if (S.view === 'voice') renderVoiceView();
}

async function toggleCamera() {
  try {
    if (voice.cameraStream) voice.stopCamera();
    else await voice.startCamera();
  } catch (e) {
    toast(e.name === 'NotAllowedError' ? 'Permissão de câmera negada.' : 'Não foi possível abrir a câmera.', 'error');
  }
}

async function toggleScreen() {
  if (voice.screenStream) return voice.stopScreen();
  try {
    let wantAudio = true;
    if (desktop?.getSources) {
      const picked = await pickScreenSource();
      if (!picked) return;
      wantAudio = picked.audio;
      await desktop.selectSource(picked.id, picked.audio);
    }
    const { audio } = await voice.startScreen();
    if (!audio && wantAudio) {
      toast(desktop ? 'Transmitindo sem som: o áudio do computador só funciona no Windows.' : 'Transmitindo sem som. Para enviar o áudio, pare e compartilhe de novo marcando "Compartilhar áudio" no seletor do navegador.', 'info');
    }
  } catch (e) {
    if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') toast('Não foi possível compartilhar a tela.', 'error');
  }
}

// Seletor de tela/janela no app desktop (no navegador o próprio navegador mostra um)
async function pickScreenSource() {
  const sources = await desktop.getSources();
  return new Promise((resolve) => {
    let chosen = null;
    let tab = 'screen';
    const m = openModal(
      `<div class="modal-body">
        <h2>Compartilhar tela</h2>
        <div class="tabs"><button class="tab active" data-tab="screen">Telas</button><button class="tab" data-tab="window">Janelas</button></div>
        <div class="source-grid"></div>
        <div class="switch-row"><div class="sr-text"><b>Compartilhar áudio</b><small>Transmite o som do computador junto (Windows)</small></div><label class="switch"><input type="checkbox" id="share-audio" ${desktop.platform === 'win32' ? 'checked' : ''}><span></span></label></div>
      </div>
      <div class="modal-footer"><button class="btn link" data-close>Cancelar</button></div>`,
      { className: 'wide', onClose: () => resolve(chosen) },
    );
    const grid = $('.source-grid', m.el);
    const draw = () => {
      grid.innerHTML = '';
      for (const s of sources.filter((x) => (tab === 'screen' ? x.id.startsWith('screen') : !x.id.startsWith('screen')))) {
        const b = h(`<button class="source"><img src="${s.thumbnail}" alt=""><span>${escapeHtml(s.name)}</span></button>`);
        b.addEventListener('click', () => {
          chosen = { id: s.id, audio: $('#share-audio', m.el).checked };
          m.close();
        });
        grid.append(b);
      }
    };
    $$('.tab', m.el).forEach((t) => t.addEventListener('click', () => {
      tab = t.dataset.tab;
      $$('.tab', m.el).forEach((x) => x.classList.toggle('active', x === t));
      draw();
    }));
    draw();
  });
}

function openVoiceView(channelId) {
  S.view = 'voice';
  S.voiceViewChannel = channelId;
  S.focusTile = null;
  renderView();
  renderChannels();
}

const videoCache = new Map(); // key -> <video>
function videoFor(key, stream, { mirror = false } = {}) {
  let v = videoCache.get(key);
  if (!v) {
    v = document.createElement('video');
    v.autoplay = true;
    v.playsInline = true;
    v.muted = true; // áudio sai pelos <audio> do VoiceClient
    videoCache.set(key, v);
  }
  if (v.srcObject !== stream) v.srcObject = stream;
  v.style.transform = mirror ? 'scaleX(-1)' : '';
  v.play().catch(() => {});
  return v;
}

function renderVoiceView() {
  const view = $('#voice-view');
  const cid = S.voiceViewChannel;
  const c = getChannel(cid);
  if (!c) return;
  const members = S.voice[cid] || [];
  const inThis = voice.channelId === cid;

  if (!inThis) {
    exitFullTile(false);
    view.innerHTML = `<div class="vv-empty">
      <h2>${escapeHtml(c.name)}</h2>
      <div>${members.length ? `${members.length} pessoa(s) na sala` : 'Ninguém está na sala ainda.'}</div>
      <button class="btn green" id="vv-join">Entrar na voz</button>
    </div>`;
    $('#vv-join').addEventListener('click', () => joinVoice(cid));
    return;
  }

  // Monta a lista de "tiles": uma por pessoa + uma extra para cada tela compartilhada
  const tiles = [];
  for (const m of members) {
    const u = user(m.userId);
    const mine = m.socketId === socket.id;
    const cam = mine ? voice.cameraStream : voice.remoteStream(m.socketId, m.cameraStreamId);
    tiles.push({ key: `${m.socketId}:cam`, m, u, stream: cam, mirror: mine && voice.facingMode === 'user', label: u.username });
    if (m.screenStreamId) {
      const scr = mine ? voice.screenStream : voice.remoteStream(m.socketId, m.screenStreamId);
      tiles.push({ key: `${m.socketId}:screen`, m, u, stream: scr, screen: true, label: `${u.username} (tela)` });
    }
  }

  // Tela cheia: só o vídeo escolhido, por cima de tudo
  const full = S.fullTile && tiles.find((t) => t.key === S.fullTile && t.stream);
  if (S.fullTile && !full) exitFullTile(false); // a transmissão acabou
  if (full) {
    renderFullTile(full);
    dropUnusedVideos(tiles);
    return;
  }

  const focused = tiles.find((t) => t.key === S.focusTile);
  const main = focused ? [focused] : tiles;
  const rest = focused ? tiles.filter((t) => t !== focused) : [];

  const tileEl = (t) => {
    const connState = t.m.socketId === socket.id ? 'connected' : voice.connectionState(t.m.socketId);
    const el = h(`<div class="vv-tile ${!t.screen && voice.isSpeaking(t.m.socketId) && !t.m.muted ? 'speaking' : ''}" ${t.screen ? '' : `data-speak="${t.m.socketId}"`}>
      <div class="vt-name">${t.m.muted || t.m.deafened ? icons.micOff : ''}${escapeHtml(t.label)}</div>
      ${connState !== 'connected' ? `<div class="vt-state">${connState === 'failed' ? 'Falhou' : 'Conectando…'}</div>` : ''}
      ${t.screen && t.stream && t.m.socketId !== socket.id ? `<button class="vt-vol" title="Volume da transmissão">${icons.speaker}</button>` : ''}
      ${t.stream ? `<button class="vt-full" title="Tela cheia">${icons.expand}</button>` : ''}
    </div>`);
    if (t.stream) el.prepend(videoFor(t.key, t.stream, { mirror: t.mirror }));
    else if (t.screen) el.prepend(h('<div class="muted">Carregando transmissão…</div>'));
    else el.prepend(h(`<div class="vt-avatar">${avatarHtml(t.u, 80)}</div>`));
    el.addEventListener('click', (e) => {
      if (e.target.closest('.vt-full')) {
        enterFullTile(t.key);
        return;
      }
      if (e.target.closest('.vt-vol')) {
        userMenu(e, t.u, { screen: true });
        return;
      }
      S.focusTile = S.focusTile === t.key ? null : t.key;
      renderVoiceView();
    });
    bindMenu(el, (e) => userMenu(e, t.u, { screen: !!t.screen }));
    return el;
  };

  const grid = h(`<div class="vv-grid ${focused ? 'focus' : ''}"></div>`);
  main.forEach((t) => grid.append(tileEl(t)));

  const controls = h(`<div class="vv-controls">
    <button id="vv-cam" class="${voice.cameraStream ? 'on' : ''}" title="Câmera">${icons.video}</button>
    ${voice.cameraStream && isTouch ? `<button id="vv-flip" title="Trocar câmera">${icons.flip}</button>` : ''}
    ${canShareScreen ? `<button id="vv-screen" class="${voice.screenStream ? 'on' : ''}" title="Compartilhar tela">${icons.screen}</button>` : ''}
    <button id="vv-mute" class="${voice.muted || voice.deafened ? 'muted' : ''}" title="Microfone">${voice.muted || voice.deafened ? icons.micOff : icons.mic}</button>
    <button id="vv-deaf" class="${voice.deafened ? 'muted' : ''}" title="Áudio">${voice.deafened ? icons.headphonesOff : icons.headphones}</button>
    <button id="vv-hang" class="hang" title="Desconectar">${icons.hangup}</button>
  </div>`);

  // Guarda os vídeos antes de limpar para não piscar
  view.innerHTML = '';
  view.append(grid);
  if (rest.length) {
    const strip = h('<div class="vv-strip"></div>');
    rest.forEach((t) => strip.append(tileEl(t)));
    view.append(strip);
  }
  view.append(controls);
  $('#vv-cam').addEventListener('click', toggleCamera);
  $('#vv-screen')?.addEventListener('click', toggleScreen);
  $('#vv-flip')?.addEventListener('click', () => voice.flipCamera().catch(() => toast('Não foi possível trocar a câmera.', 'error')));
  $('#vv-mute').addEventListener('click', toggleMute);
  $('#vv-deaf').addEventListener('click', toggleDeafen);
  $('#vv-hang').addEventListener('click', leaveVoice);

  // Tamanho medido de verdade depois de montar (a faixa e os controles já ocupam o espaço deles)
  layoutGrid(grid, !!focused);
  dropUnusedVideos(tiles);
}

// Escolhe quantas colunas deixam cada vídeo (16:9) o maior possível sem sair da área,
// tanto com o celular em pé quanto deitado. A última linha fica centralizada (flex-wrap).
// No destaque, o vídeo ocupa a área toda. Tamanhos em px para não depender de height: 100%.
function layoutGrid(grid, focused = false) {
  const n = grid.children.length;
  if (!n) return;
  const cs = getComputedStyle(grid);
  const gap = parseFloat(cs.columnGap) || 8;
  const W = grid.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const H = grid.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  if (W <= 0 || H <= 0) return;
  if (focused) {
    for (const el of grid.children) {
      el.style.width = Math.floor(W) + 'px';
      el.style.height = Math.floor(H) + 'px';
    }
    return;
  }
  let best = 0;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const w = Math.min((W - (cols - 1) * gap) / cols, ((H - (rows - 1) * gap) / rows) * (16 / 9));
    best = Math.max(best, w);
  }
  const w = Math.max(48, Math.floor(best));
  for (const el of grid.children) el.style.width = w + 'px';
}

// Remove vídeos que não estão mais em uso
function dropUnusedVideos(tiles) {
  const live = new Set(tiles.filter((t) => t.stream).map((t) => t.key));
  for (const [k, v] of videoCache) if (!live.has(k)) {
    v.srcObject = null;
    videoCache.delete(k);
  }
}

// ---------- tela cheia de um vídeo ----------
let skipPop = false;

function enterFullTile(key) {
  S.fullTile = key;
  renderVoiceView();
  // "Voltar" do celular minimiza em vez de sair da chamada
  history.pushState({ vvFull: true }, '');
  // Esconde as barras do navegador (Android/desktop; no iPhone fica só a sobreposição)
  const root = document.documentElement;
  if (root.requestFullscreen && !document.fullscreenElement) {
    root.requestFullscreen({ navigationUI: 'hide' })
      .then(() => {
        // Gira para o formato do vídeo, como no YouTube (só funciona em tela cheia no Android)
        const v = videoCache.get(key);
        if (v?.videoWidth && screen.orientation?.lock) {
          screen.orientation.lock(v.videoWidth >= v.videoHeight ? 'landscape' : 'portrait').catch(() => {});
        }
      })
      .catch(() => {});
  }
}

function exitFullTile(rerender = true, fromHistory = false) {
  if (!S.fullTile) return;
  S.fullTile = null;
  $('#vv-full')?.remove();
  try {
    screen.orientation?.unlock?.();
  } catch {}
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (!fromHistory && history.state?.vvFull) {
    skipPop = true;
    history.back();
  }
  if (rerender && S.view === 'voice') renderVoiceView();
}

function renderFullTile(t) {
  let ov = $('#vv-full');
  if (!ov) {
    ov = h(`<div id="vv-full">
      <div class="vf-name"></div>
      <button class="vf-vol" title="Volume da transmissão">${icons.speaker}</button>
      <button class="vf-exit" title="Sair da tela cheia">${icons.shrink}</button>
    </div>`);
    $('.vf-exit', ov).addEventListener('click', (e) => {
      e.stopPropagation();
      exitFullTile();
    });
    $('.vf-vol', ov).addEventListener('click', (e) => {
      e.stopPropagation();
      clearTimeout(ov._hideTimer);
      const cur = ov._tile;
      if (cur) userMenu(e, cur.u, { screen: true });
    });
    // Toque no vídeo mostra/esconde o botão, como num player
    ov.addEventListener('click', () => {
      ov.classList.toggle('hide-ui');
      clearTimeout(ov._hideTimer);
      if (!ov.classList.contains('hide-ui')) ov._hideTimer = setTimeout(() => ov.classList.add('hide-ui'), 3000);
    });
    ov._hideTimer = setTimeout(() => ov.classList.add('hide-ui'), 3000);
    document.body.append(ov);
  }
  $('.vf-name', ov).textContent = t.label;
  ov._tile = t;
  // Volume só faz sentido para a tela de outra pessoa
  $('.vf-vol', ov).hidden = !(t.screen && t.m.socketId !== socket.id);
  const v = videoFor(t.key, t.stream, { mirror: t.mirror });
  if (v.parentElement !== ov) ov.prepend(v);
}

document.addEventListener('fullscreenchange', () => {
  // Saiu da tela cheia pelo sistema (gesto, Esc): minimiza também
  if (!document.fullscreenElement && S.fullTile) exitFullTile();
});

window.addEventListener('resize', () => S.view === 'voice' && renderVoiceView());

function updateSpeaking() {
  const cid = voice.channelId;
  const members = S.voice[cid] || [];
  for (const m of members) {
    const on = voice.isSpeaking(m.socketId) && !m.muted && !m.deafened;
    $$(`[data-speak="${m.socketId}"]`).forEach((el) => el.classList.toggle('speaking', on));
  }
}

// ======================================================================
// Cabeçalho / visão
// ======================================================================
function renderHeader() {
  const head = $('#chat-header');
  if (S.view === 'voice') {
    const c = getChannel(S.voiceViewChannel);
    head.innerHTML = `${navButton()}${icons.speaker}<span class="ch-title">${escapeHtml(c?.name || '')}</span><span class="spacer"></span>`;
    bindNavButton();
    return;
  }
  const c = getChannel(S.current);
  head.innerHTML = `${navButton()}${icons.hash}<span class="ch-title">${escapeHtml(c?.name || '')}</span><span class="spacer"></span>
    <button class="icon-btn ${S.prefs.showMembers ? 'on' : ''}" id="toggle-members" title="Lista de membros">${icons.members}</button>`;
  bindNavButton();
  $('#toggle-members').addEventListener('click', () => {
    if (isMobile()) return setMembersDrawer(true);
    toggleMembers();
    renderHeader();
  });
}

function renderView() {
  const voiceMode = S.view === 'voice';
  $('#chat').hidden = voiceMode;
  $('#voice-view').hidden = !voiceMode;
  $('#member-list').hidden = voiceMode;
  renderHeader();
  if (voiceMode) renderVoiceView();
  else exitFullTile(false);
}

// ======================================================================
// Mensagens
// ======================================================================
async function openChannel(cid, force = false) {
  if (!cid) return;
  const changed = cid !== S.current || S.view !== 'text';
  S.current = cid;
  S.view = 'text';
  storage.set('currentChannel', cid);
  if (changed) {
    S.replyTo = null;
    renderComposerExtra();
  }
  renderView();
  renderChannels();
  const c = getChannel(cid);
  $('#composer-input').placeholder = `Conversar em #${c?.name || ''}`;
  $('#drop-channel').textContent = c?.name || '';
  renderTyping();

  if (!S.messages.has(cid) || force) {
    $('#messages').innerHTML = '';
    const res = await emitAck('message:list', { channelId: cid });
    if (res.error) return toast(res.error, 'error');
    // Mensagens que chegaram enquanto carregava
    const extra = (S.messages.get(cid) || []).filter((m) => !res.messages.some((x) => x.id === m.id));
    S.messages.set(cid, [...res.messages, ...extra]);
    S.hasMore.set(cid, res.hasMore);
  }
  if (S.current !== cid) return;
  renderMessages();
  scrollToBottom();
  markRead(cid);
  if (!matchMedia('(pointer: coarse)').matches) $('#composer-input').focus();
}

function renderMessages() {
  const box = $('#messages');
  const list = S.messages.get(S.current) || [];
  const c = getChannel(S.current);
  box.innerHTML = '';
  if (S.hasMore.get(S.current)) {
    box.append(h('<div class="load-more">Carregando mensagens antigas…</div>'));
  } else {
    box.append(h(`<div class="chat-start"><div class="big-hash">${icons.hash}</div><h1>Boas-vindas a #${escapeHtml(c?.name || '')}!</h1><div class="muted">Este é o começo do canal #${escapeHtml(c?.name || '')}.</div></div>`));
  }
  const frag = document.createDocumentFragment();
  list.forEach((m, i) => frag.append(...messageEls(m, list[i - 1])));
  box.append(frag);
}

function rerenderMessagesKeepScroll() {
  const box = $('#messages');
  const fromBottom = box.scrollHeight - box.scrollTop;
  renderMessages();
  box.scrollTop = box.scrollHeight - fromBottom;
}

function isNearBottom() {
  const box = $('#messages');
  return box.scrollHeight - box.scrollTop - box.clientHeight < 150;
}

function scrollToBottom() {
  const box = $('#messages');
  box.scrollTop = box.scrollHeight;
}

// Separador de dia + a mensagem
function messageEls(msg, prev) {
  const out = [];
  if (!prev || new Date(prev.createdAt).toDateString() !== new Date(msg.createdAt).toDateString()) {
    out.push(h(`<div class="day-divider"><span>${formatDay(msg.createdAt)}</span></div>`));
  }
  out.push(messageEl(msg, prev));
  return out;
}

function messageEl(msg, prev) {
  const u = user(msg.authorId);
  const sameDay = prev && new Date(prev.createdAt).toDateString() === new Date(msg.createdAt).toDateString();
  const head = !prev || prev.authorId !== msg.authorId || msg.createdAt - prev.createdAt > GROUP_MS || !sameDay || msg.replyTo;
  const mentioned = msg.authorId !== S.me.id && mentionsUser(msg.content, S.me);
  const list = S.messages.get(msg.channelId) || [];
  const reply = msg.replyTo && list.find((m) => m.id === msg.replyTo);

  const el = h(`<div class="msg ${head ? 'head' : ''} ${mentioned ? 'mentioned' : ''}" data-id="${msg.id}"></div>`);
  let html = '';
  if (msg.replyTo) {
    const ru = reply && user(reply.authorId);
    html += `<div class="reply-ref" data-jump="${msg.replyTo}">${reply ? `${avatarHtml(ru, 16)}<span class="rr-author">@${escapeHtml(ru.username)}</span><span class="rr-text">${escapeHtml(reply.content || (reply.attachments.length ? 'Clique para ver o anexo' : ''))}</span>` : '<span class="rr-text"><i>Mensagem original foi apagada ou não está carregada</i></span>'}</div>`;
  }
  if (head) {
    html += `<div class="avatar-wrap" data-user="${u.id}">${avatarHtml(u, 40)}</div>
      <div class="meta"><span class="author" data-user="${u.id}" style="color:${u.isAdmin ? escapeHtml(u.color) : ''}">${escapeHtml(u.username)}</span>${u.isAdmin ? '<span class="admin-tag">ADM</span>' : ''}<span class="time" title="${new Date(msg.createdAt).toLocaleString('pt-BR')}">${formatTimestamp(msg.createdAt)}</span></div>`;
  } else {
    html += `<span class="side-time">${formatTime(msg.createdAt)}</span>`;
  }
  if (msg.content) {
    html += `<div class="content ${isEmojiOnly(msg.content) ? 'jumbo' : ''}">${renderMarkdown(msg.content, { users: [...S.users.values()], meId: S.me.id })}${msg.editedAt ? `<span class="edited" title="${new Date(msg.editedAt).toLocaleString('pt-BR')}">(editado)</span>` : ''}</div>`;
  }
  if (msg.attachments?.length) html += `<div class="attachments">${msg.attachments.map(attachmentHtml).join('')}</div>`;
  const reactions = Object.entries(msg.reactions || {});
  if (reactions.length) {
    html += `<div class="reactions">${reactions.map(([emoji, ids]) => `<button class="reaction ${ids.includes(S.me.id) ? 'mine' : ''}" data-emoji="${escapeHtml(emoji)}" title="${escapeHtml(ids.map((id) => user(id).username).join(', '))}">${escapeHtml(emoji)}<span class="r-count">${ids.length}</span></button>`).join('')}</div>`;
  }
  const mine = msg.authorId === S.me.id;
  html += `<div class="msg-actions">
    <button data-act="react" title="Adicionar reação">${icons.smile}</button>
    <button data-act="reply" title="Responder">${icons.reply}</button>
    ${mine ? `<button data-act="edit" title="Editar">${icons.edit}</button>` : ''}
    ${mine || S.me.isAdmin ? `<button data-act="delete" class="danger" title="Excluir">${icons.trash}</button>` : ''}
  </div>`;
  el.innerHTML = html;
  bindMenu(el, (e) => messageMenu(e, msg));
  return el;
}

function attachmentHtml(a) {
  const url = escapeHtml(abs(a.url));
  if (a.type.startsWith('image/')) return `<img class="att-image" src="${url}" alt="${escapeHtml(a.name)}" loading="lazy" data-full="${url}">`;
  if (a.type.startsWith('video/')) return `<video class="att-video" src="${url}" controls preload="metadata"></video>`;
  const audio = a.type.startsWith('audio/') ? `<audio src="${url}" controls preload="none"></audio>` : '';
  return `<div class="att-file">${icons.file}<div class="af-info"><a class="af-name" href="${url}" download="${escapeHtml(a.name)}" target="_blank">${escapeHtml(a.name)}</a><div class="af-size">${formatSize(a.size)}</div>${audio}</div><a class="icon-btn" href="${url}" download="${escapeHtml(a.name)}" target="_blank" title="Baixar">${icons.download}</a></div>`;
}

// Delegação de eventos da lista de mensagens
$('#messages').addEventListener('click', (e) => {
  const t = e.target;
  const msgEl = t.closest('.msg');
  const msg = msgEl && findMsg(msgEl.dataset.id);
  const act = t.closest('[data-act]')?.dataset.act;
  if (act && msg) {
    if (act === 'react') return emojiPicker(t.closest('button'), (emoji) => socket.emit('reaction:toggle', { channelId: msg.channelId, id: msg.id, emoji }));
    if (act === 'reply') return startReply(msg);
    if (act === 'edit') return startEdit(msg);
    if (act === 'delete') return deleteMessage(msg, e.shiftKey);
  }
  const reaction = t.closest('.reaction');
  if (reaction && msg) return socket.emit('reaction:toggle', { channelId: msg.channelId, id: msg.id, emoji: reaction.dataset.emoji });
  const uid = t.closest('[data-user]')?.dataset.user;
  if (uid && S.users.has(uid)) return showProfile(S.users.get(uid), e);
  if (t.classList.contains('att-image')) return lightbox(t.dataset.full);
  if (t.classList.contains('spoiler')) return t.classList.add('shown');
  const jump = t.closest('[data-jump]')?.dataset.jump;
  if (jump) return jumpTo(jump);
});

$('#messages').addEventListener('scroll', async () => {
  const box = $('#messages');
  if (box.scrollTop < 200 && S.hasMore.get(S.current) && !S.loadingOlder) {
    S.loadingOlder = true;
    const cid = S.current;
    const list = S.messages.get(cid);
    const res = await emitAck('message:list', { channelId: cid, before: list[0]?.id });
    S.loadingOlder = false;
    if (res.error || cid !== S.current) return;
    S.messages.set(cid, [...res.messages, ...list]);
    S.hasMore.set(cid, res.hasMore);
    rerenderMessagesKeepScroll();
  }
  if (isNearBottom()) markRead(S.current);
});

function findMsg(id) {
  return (S.messages.get(S.current) || []).find((m) => m.id === id);
}

function jumpTo(id) {
  const el = $(`.msg[data-id="${id}"]`);
  if (!el) return toast('Mensagem não está carregada.');
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.add('highlight');
  setTimeout(() => el.classList.remove('highlight'), 1500);
}

function messageMenu(e, msg) {
  if (window.getSelection()?.toString()) return; // deixa copiar texto selecionado
  e.preventDefault();
  const mine = msg.authorId === S.me.id;
  const items = [
    { label: 'Adicionar reação', icon: 'smile', action: () => emojiPicker({ getBoundingClientRect: () => ({ left: e.clientX, top: e.clientY, bottom: e.clientY, right: e.clientX }) }, (emoji) => socket.emit('reaction:toggle', { channelId: msg.channelId, id: msg.id, emoji })) },
    { label: 'Responder', icon: 'reply', action: () => startReply(msg) },
  ];
  if (mine) items.push({ label: 'Editar mensagem', icon: 'edit', action: () => startEdit(msg) });
  if (msg.content) items.push({ label: 'Copiar texto', action: () => navigator.clipboard.writeText(msg.content) });
  if (mine || S.me.isAdmin) items.push('-', { label: 'Excluir mensagem', icon: 'trash', danger: true, action: () => deleteMessage(msg) });
  contextMenu(e.clientX, e.clientY, items);
}

async function deleteMessage(msg, skipConfirm = false) {
  if (!skipConfirm && !(await confirmDialog({ title: 'Excluir mensagem', text: 'Tem certeza que deseja excluir esta mensagem? (Dica: segure Shift ao clicar na lixeira para pular esta confirmação.)', confirm: 'Excluir' }))) return;
  const res = await emitAck('message:delete', { channelId: msg.channelId, id: msg.id });
  if (res.error) toast(res.error, 'error');
}

function startReply(msg) {
  S.replyTo = msg;
  renderComposerExtra();
  $('#composer-input').focus();
}

function startEdit(msg) {
  const el = $(`.msg[data-id="${msg.id}"]`);
  const content = el?.querySelector('.content');
  if (!el) return;
  const box = h(`<div class="edit-box"><textarea rows="1"></textarea><div class="edit-hint">Esc para <a data-cancel>cancelar</a> • Enter para <a data-save>salvar</a></div></div>`);
  const ta = $('textarea', box);
  ta.value = msg.content;
  if (content) content.replaceWith(box);
  else el.querySelector('.attachments')?.before(box);
  const autosize = () => {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  };
  const cancel = () => {
    const list = S.messages.get(msg.channelId);
    const idx = list.findIndex((m) => m.id === msg.id);
    el.replaceWith(messageEl(list[idx], list[idx - 1]));
    $('#composer-input').focus();
  };
  const save = async () => {
    const text = ta.value.trim();
    if (text === msg.content) return cancel();
    if (!text && !msg.attachments.length) return deleteMessage(msg);
    const res = await emitAck('message:edit', { channelId: msg.channelId, id: msg.id, content: text });
    if (res.error) toast(res.error, 'error');
    else {
      msg.content = text;
      msg.editedAt = Date.now();
    }
    cancel();
  };
  ta.addEventListener('input', autosize);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cancel();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      save();
    }
  });
  $('[data-cancel]', box).addEventListener('click', cancel);
  $('[data-save]', box).addEventListener('click', save);
  autosize();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function onMessageNew(msg) {
  S.lastMessageIds[msg.channelId] = msg.id;
  const list = S.messages.get(msg.channelId);
  if (list && !list.some((m) => m.id === msg.id)) {
    list.push(msg);
    if (msg.channelId === S.current && S.view === 'text') {
      const stick = isNearBottom() || msg.authorId === S.me.id;
      $('#messages').append(...messageEls(msg, list[list.length - 2]));
      if (stick) scrollToBottom();
    }
  }
  // Parou de digitar
  const typing = S.typing.get(msg.channelId);
  if (typing?.has(msg.authorId)) {
    clearTimeout(typing.get(msg.authorId));
    typing.delete(msg.authorId);
    renderTyping();
  }
  if (msg.authorId === S.me.id) {
    S.lastRead[msg.channelId] = msg.id;
    saveLastRead();
    return;
  }
  const viewing = msg.channelId === S.current && S.view === 'text' && document.hasFocus() && isNearBottom();
  if (viewing) {
    markRead(msg.channelId);
    return;
  }
  const mentioned = mentionsUser(msg.content, S.me);
  if (mentioned) S.mentions[msg.channelId] = (S.mentions[msg.channelId] || 0) + 1;
  renderChannels();
  notify(msg, mentioned);
}

function notify(msg, mentioned) {
  if (S.me.status === 'dnd' && !mentioned) return;
  if (S.prefs.sounds) playBlip(mentioned ? [880, 1100, 880] : [660, 880]);
  if (!S.prefs.notifications || !('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.hasFocus() && !mentioned) return;
  const u = user(msg.authorId);
  const c = getChannel(msg.channelId);
  const title = `${u.username} (#${c?.name})`;
  const opts = {
    body: msg.content || (msg.attachments.length ? `📎 ${msg.attachments[0].name}` : ''),
    silent: true,
    tag: msg.channelId,
    icon: 'icons/icon-192.png',
    data: { channelId: msg.channelId },
  };
  // Android/PWA só aceitam notificação pelo service worker
  if (swRegistration) return swRegistration.showNotification(title, opts).catch(() => {});
  try {
    const n = new Notification(title, opts);
    n.onclick = () => {
      window.focus();
      desktop?.focus?.();
      openChannel(msg.channelId);
      showMain();
    };
  } catch {}
}

window.addEventListener('focus', () => S.view === 'text' && isNearBottom() && markRead(S.current));

function renderTyping() {
  const box = $('#typing');
  const m = S.typing.get(S.current);
  const names = m ? [...m.keys()].filter((id) => id !== S.me?.id).map((id) => `<b>${escapeHtml(user(id).username)}</b>`) : [];
  if (!names.length) return (box.innerHTML = '');
  const text = names.length === 1 ? `${names[0]} está digitando…` : names.length <= 3 ? `${names.slice(0, -1).join(', ')} e ${names.at(-1)} estão digitando…` : 'Várias pessoas estão digitando…';
  box.innerHTML = `<span class="typing-dots"><i></i><i></i><i></i></span><span>${text}</span>`;
}

function lightbox(url) {
  openModal(`<img src="${escapeHtml(url)}" alt=""><a href="${escapeHtml(url)}" target="_blank" download>Abrir original</a>`, { className: 'lightbox' });
}

// ======================================================================
// Compositor
// ======================================================================
const input = $('#composer-input');
let lastTypingEmit = 0;

function autosizeInput() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, innerHeight * 0.5) + 'px';
}

function insertText(text) {
  const start = input.selectionStart;
  input.setRangeText(text, start, input.selectionEnd, 'end');
  input.focus();
  autosizeInput();
}

input.addEventListener('input', () => {
  autosizeInput();
  updateMentionPopup();
  if (input.value && Date.now() - lastTypingEmit > 3000) {
    lastTypingEmit = Date.now();
    socket?.emit('typing', { channelId: S.current });
  }
});

input.addEventListener('keydown', (e) => {
  if (mentionKeydown(e)) return;
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isTouch) {
    e.preventDefault();
    sendMessage();
  } else if (e.key === 'Escape') {
    if (S.replyTo) {
      S.replyTo = null;
      renderComposerExtra();
    }
  } else if (e.key === 'ArrowUp' && !input.value) {
    const list = S.messages.get(S.current) || [];
    const last = [...list].reverse().find((m) => m.authorId === S.me.id);
    if (last) {
      e.preventDefault();
      startEdit(last);
    }
  }
});

input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault();
    files.forEach(queueUpload);
  }
});

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage();
});
$('#attach-btn').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', (e) => {
  [...e.target.files].forEach(queueUpload);
  e.target.value = '';
});
$('#emoji-btn').addEventListener('click', (e) => emojiPicker(e.currentTarget, (emoji) => insertText(emoji)));

async function sendMessage() {
  const content = input.value.trim();
  if (S.pending.some((p) => !p.done)) return toast('Espere os arquivos terminarem de enviar.');
  const attachments = S.pending.filter((p) => p.result).map((p) => p.result);
  if (!content && !attachments.length) return;
  if (content.length > 4000) return toast('Mensagem muito longa (máximo 4000 caracteres).', 'error');
  const replyTo = S.replyTo?.id;
  input.value = '';
  autosizeInput();
  S.pending = [];
  S.replyTo = null;
  renderComposerExtra();
  closeMentionPopup();
  const res = await emitAck('message:send', { channelId: S.current, content, attachments, replyTo });
  if (res.error) {
    toast(res.error, 'error');
    input.value = content;
    autosizeInput();
  }
}

function renderComposerExtra() {
  const box = $('#composer-extra');
  box.innerHTML = '';
  if (S.pending.length) {
    const wrap = h('<div class="pending-files"></div>');
    for (const p of S.pending) {
      const el = h(`<div class="pending-file">
        <div class="pf-thumb">${p.preview ? `<img src="${p.preview}" alt="">` : icons.file}</div>
        <div class="pf-name">${escapeHtml(p.file.name)}</div>
        <div class="pf-bar"><i style="width:${Math.round(p.progress * 100)}%"></i></div>
        <button type="button" class="pf-remove" title="Remover">${icons.trash}</button>
      </div>`);
      p.el = el;
      $('.pf-remove', el).addEventListener('click', () => {
        p.xhr?.abort();
        S.pending = S.pending.filter((x) => x !== p);
        renderComposerExtra();
      });
      wrap.append(el);
    }
    box.append(wrap);
  }
  if (S.replyTo) {
    const bar = h(`<div class="reply-bar"><span>Respondendo a <b>${escapeHtml(user(S.replyTo.authorId).username)}</b></span><button type="button" title="Cancelar">${icons.close}</button></div>`);
    $('button', bar).addEventListener('click', () => {
      S.replyTo = null;
      renderComposerExtra();
    });
    box.append(bar);
  }
}

function queueUpload(file) {
  if (file.size > S.maxUploadMb * 1024 * 1024) return toast(`${file.name} passa do limite de ${S.maxUploadMb} MB.`, 'error');
  if (S.pending.length >= 10) return toast('Máximo de 10 arquivos por mensagem.', 'error');
  const p = { file, progress: 0, done: false, result: null, preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : null };
  S.pending.push(p);
  renderComposerExtra();
  const xhr = new XMLHttpRequest();
  p.xhr = xhr;
  xhr.open('POST', abs('api/upload'));
  xhr.setRequestHeader('Authorization', `Bearer ${S.token}`);
  xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
  xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
  xhr.upload.onprogress = (e) => {
    p.progress = e.loaded / e.total;
    const bar = p.el?.querySelector('.pf-bar i');
    if (bar) bar.style.width = Math.round(p.progress * 100) + '%';
  };
  xhr.onload = () => {
    p.done = true;
    try {
      const data = JSON.parse(xhr.responseText);
      if (xhr.status !== 200) throw new Error(data.error);
      p.result = data;
      p.progress = 1;
    } catch (err) {
      toast(err.message || 'Falha no envio.', 'error');
      S.pending = S.pending.filter((x) => x !== p);
    }
    renderComposerExtra();
  };
  xhr.onerror = () => {
    p.done = true;
    toast(`Falha ao enviar ${file.name}.`, 'error');
    S.pending = S.pending.filter((x) => x !== p);
    renderComposerExtra();
  };
  xhr.send(file);
}

// Arrastar e soltar
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files') || S.view !== 'text' || $('#app').hidden) return;
  dragDepth++;
  $('#drop-overlay').hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('#drop-overlay').hidden = true;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').hidden = true;
  if (S.view === 'text' && !$('#app').hidden) [...(e.dataTransfer?.files || [])].forEach(queueUpload);
});

// Autocompletar @menção
let mentionState = null;
function updateMentionPopup() {
  const before = input.value.slice(0, input.selectionStart);
  const m = before.match(/(^|\s)@([\p{L}\p{N}_.-]{0,32})$/u);
  if (!m) return closeMentionPopup();
  const q = m[2].toLowerCase();
  const matches = [...S.users.values()].filter((u) => u.username.toLowerCase().startsWith(q)).slice(0, 8);
  if ('everyone'.startsWith(q)) matches.push({ id: 'everyone', username: 'everyone', color: '#5865f2' });
  if (!matches.length) return closeMentionPopup();
  mentionState = { matches, sel: 0, start: input.selectionStart - m[2].length - 1 };
  drawMentionPopup();
}

function drawMentionPopup() {
  const pop = $('#mention-popup');
  pop.hidden = false;
  pop.innerHTML = '<div class="mp-title">Membros</div>';
  mentionState.matches.forEach((u, i) => {
    const el = h(`<div class="mp-item ${i === mentionState.sel ? 'sel' : ''}">${avatarHtml(u, 24)}<span>${escapeHtml(u.username)}</span></div>`);
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      mentionState.sel = i;
      applyMention();
    });
    pop.append(el);
  });
}

function mentionKeydown(e) {
  if (!mentionState) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = mentionState.matches.length;
    mentionState.sel = (mentionState.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    drawMentionPopup();
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    applyMention();
    return true;
  }
  if (e.key === 'Escape') {
    closeMentionPopup();
    return true;
  }
  return false;
}

function applyMention() {
  const u = mentionState.matches[mentionState.sel];
  input.setRangeText(`@${u.username} `, mentionState.start, input.selectionStart, 'end');
  closeMentionPopup();
  input.focus();
}

function closeMentionPopup() {
  mentionState = null;
  $('#mention-popup').hidden = true;
}

// Seletor de emoji
function emojiPicker(anchor, onPick) {
  closeContextMenu();
  $('.emoji-picker')?.remove();
  const pop = h(`<div class="popout emoji-picker"><div class="ep-title">Emojis</div><div class="ep-grid">${EMOJIS.map((e) => `<button type="button">${e}</button>`).join('')}</div></div>`);
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.right - pop.offsetWidth, innerWidth - pop.offsetWidth - 8)) + 'px';
  pop.style.top = Math.max(8, r.top - pop.offsetHeight - 8) + 'px';
  const close = () => {
    pop.remove();
    document.removeEventListener('mousedown', outside, true);
  };
  const outside = (e) => !pop.contains(e.target) && close();
  pop.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    onPick(b.textContent);
    if (!e.shiftKey) close();
  });
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
}

// ======================================================================
// Membros e perfis
// ======================================================================
function renderMembers() {
  const box = $('#member-list');
  if (!S.me) return;
  const all = [...S.users.values()].sort((a, b) => a.username.localeCompare(b.username));
  const on = all.filter((u) => u.online || u.id === S.me.id);
  const off = all.filter((u) => !(u.online || u.id === S.me.id));
  box.innerHTML = '';
  const group = (label, list, online) => {
    if (!list.length) return;
    box.append(h(`<div class="member-group">${label} — ${list.length}</div>`));
    for (const u of list) {
      const shown = u.id === S.me.id ? { ...u, online: true } : u;
      const inVoice = Object.entries(S.voice).find(([, ms]) => ms.some((m) => m.userId === u.id));
      const sub = u.customStatus || (inVoice ? `🔊 ${getChannel(inVoice[0])?.name || ''}` : '');
      const el = h(`<div class="member ${online ? 'online' : 'offline'}">
        ${avatarHtml(shown, 32, true)}
        <div class="m-text"><div class="m-name" style="${u.isAdmin ? `color:${escapeHtml(u.color)}` : ''}">${escapeHtml(u.username)}</div>${sub ? `<div class="m-sub">${escapeHtml(sub)}</div>` : ''}</div>
      </div>`);
      el.addEventListener('click', (e) => showProfile(u, e));
      bindMenu(el, (e) => userMenu(e, u));
      box.append(el);
    }
  };
  group('Online', on, true);
  group('Offline', off, false);
}

function showProfile(u, e) {
  $('.profile-card')?.remove();
  const self = u.id === S.me.id;
  const shown = self ? { ...u, online: true } : u;
  const pop = h(`<div class="popout profile-card">
    <div class="pc-banner" style="background:${escapeHtml(u.color)}"></div>
    <div class="pc-avatar">${avatarHtml(shown, 80, true)}</div>
    <div class="pc-body">
      <div class="pc-name">${escapeHtml(u.username)}${u.isAdmin ? '<span class="admin-tag">ADM</span>' : ''}</div>
      <div class="pc-status">${escapeHtml(u.customStatus || STATUS_LABEL[statusClass(shown)] || '')}</div>
      <div class="pc-section">Membro desde</div>
      <div class="pc-text">${u.createdAt ? formatDay(u.createdAt) : '—'}</div>
      ${self ? '' : '<button class="btn secondary" style="width:100%;margin-top:12px" data-mention>Mencionar</button>'}
    </div>
  </div>`);
  document.body.append(pop);
  const x = e.clientX ?? 100;
  const y = e.clientY ?? 100;
  pop.style.left = Math.min(x + 12, innerWidth - pop.offsetWidth - 12) + 'px';
  pop.style.top = Math.max(12, Math.min(y - 40, innerHeight - pop.offsetHeight - 12)) + 'px';
  $('[data-mention]', pop)?.addEventListener('click', () => {
    close();
    if (S.view !== 'text') openChannel(S.current);
    insertText(`@${u.username} `);
  });
  const close = () => {
    pop.remove();
    document.removeEventListener('mousedown', outside, true);
  };
  const outside = (ev) => !pop.contains(ev.target) && close();
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
}

// ======================================================================
// Atalhos de teclado e push-to-talk
// ======================================================================
window.addEventListener('keydown', (e) => {
  if (!voice) return;
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyM') {
    e.preventDefault();
    toggleMute();
  } else if (e.ctrlKey && e.shiftKey && e.code === 'KeyD') {
    e.preventDefault();
    toggleDeafen();
  } else if (voice.settings.pushToTalk && e.code === voice.settings.pushToTalkKey && !isTypingTarget(e.target)) {
    voice.setPushToTalkActive(true);
  }
});
window.addEventListener('keyup', (e) => {
  if (voice?.settings.pushToTalk && e.code === voice.settings.pushToTalkKey) voice.setPushToTalkActive(false);
});
window.addEventListener('blur', () => voice?.setPushToTalkActive(false));

function isTypingTarget(t) {
  return t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable);
}

// ======================================================================
// Celular: um painel por vez (canais <-> conversa), membros em gaveta
// ======================================================================
const canShareScreen = !!navigator.mediaDevices?.getDisplayMedia && !isTouch;

function navButton() {
  return `<button class="icon-btn mobile-only" id="nav-btn" title="Canais">${icons.menu}</button>`;
}

function bindNavButton() {
  $('#nav-btn')?.addEventListener('click', () => (history.state?.r === 'main' ? history.back() : showNav()));
}

function showMain() {
  if (!isMobile()) return;
  setMembersDrawer(false);
  if (!$('#app').classList.contains('nav-open')) return;
  $('#app').classList.remove('nav-open');
  // Botão/gesto "voltar" do celular volta para a lista de canais
  history.pushState({ r: 'main' }, '');
}

function showNav() {
  setMembersDrawer(false);
  $('#app').classList.add('nav-open');
}

function setMembersDrawer(open) {
  document.body.classList.toggle('members-open', open);
}

function setupMobile() {
  if (isMobile()) $('#app').classList.add('nav-open');
  window.addEventListener('popstate', () => {
    if (skipPop) {
      skipPop = false;
      return;
    }
    // Botão/gesto "voltar" com um vídeo em tela cheia: só minimiza
    if (S.fullTile) {
      exitFullTile(true, true);
      return;
    }
    if (!isMobile()) return;
    if (document.body.classList.contains('members-open')) {
      setMembersDrawer(false);
      history.pushState({ r: 'main' }, '');
      return;
    }
    showNav();
  });
  $('#scrim').addEventListener('click', () => setMembersDrawer(false));
  if (isTouch) {
    document.body.classList.add('touch');
    $('#send-btn').hidden = false;
    $('#send-btn').addEventListener('click', () => {
      sendMessage();
      input.focus();
    });
  }
  // Deslizar para os lados, igual ao Discord no celular
  let sx = 0;
  let sy = 0;
  let tracking = false;
  document.addEventListener('touchstart', (e) => {
    tracking = isMobile() && e.touches.length === 1 && !e.target.closest('.modal-layer, .settings, .context-menu, .popout, pre, video, input[type=range]');
    if (!tracking) return;
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (!tracking) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx;
    const dy = t.clientY - sy;
    if (Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
    const navOpen = $('#app').classList.contains('nav-open');
    const membersOpen = document.body.classList.contains('members-open');
    if (dx > 0) {
      if (membersOpen) setMembersDrawer(false);
      else if (!navOpen) history.state?.r === 'main' ? history.back() : showNav();
    } else if (navOpen) showMain();
    else if (S.view === 'text' && !membersOpen) setMembersDrawer(true);
  }, { passive: true });
}

// ======================================================================
// PWA: instalar pelo navegador (celular e PC) + notificações
// ======================================================================
let swRegistration = null;
let installPrompt = null;

function setupPwa() {
  if (!isNative && !desktop && 'serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').then((reg) => (swRegistration = reg)).catch((e) => console.warn('[pwa]', e));
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'open-channel' && getChannel(e.data.channelId)) {
        openChannel(e.data.channelId);
        showMain();
      }
    });
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    maybeShowInstallBanner();
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    $('.install-banner')?.remove();
  });
  // iPhone não tem prompt: mostra instrução
  if (isIos() && !isStandalone()) setTimeout(maybeShowInstallBanner, 3000);
}

export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function maybeShowInstallBanner() {
  if ($('.install-banner') || storage.get('installDismissed', false) || isStandalone() || desktop || isNative) return;
  if (!installPrompt && !isIos()) return;
  const banner = h(`<div class="install-banner">
    ${icons.install}
    <span>${installPrompt ? 'Instale o Resenha neste dispositivo para usar como app.' : 'Para instalar: toque em <b>Compartilhar</b> e depois em <b>Adicionar à Tela de Início</b>.'}</span>
    ${installPrompt ? '<button class="btn primary" data-install>Instalar</button>' : ''}
    <button class="icon-btn" data-dismiss title="Fechar">${icons.close}</button>
  </div>`);
  $('[data-install]', banner)?.addEventListener('click', installApp);
  $('[data-dismiss]', banner).addEventListener('click', () => {
    storage.set('installDismissed', true);
    banner.remove();
  });
  $('#main').prepend(banner);
}

export async function installApp() {
  if (!installPrompt) return false;
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  if (outcome === 'accepted') {
    installPrompt = null;
    $('.install-banner')?.remove();
  }
  return true;
}

// ======================================================================
// Contexto para o módulo de configurações
// ======================================================================
function ctx() {
  return {
    S, socket, voice, desktop, emitAck, logout, kickUser, user,
    isNative, installApp, canInstall: () => !!installPrompt, isIos, isStandalone,
    saveVoiceSettings: () => storage.set('voiceSettings', voice.settings),
    savePrefs: () => storage.set('prefs', S.prefs),
    rerender: renderAll,
  };
}

// ======================================================================
// Início
// ======================================================================
setupMobile();
setupPwa();
if (S.token && (!isNative || serverBase())) connect();
else showAuth();

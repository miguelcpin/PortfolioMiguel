const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { Db } = require('./db');

// ---------- configuração (.env simples, sem dependência) ----------
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const PORT = Number(process.env.PORT) || 3000;
const INVITE_CODE = process.env.INVITE_CODE || '';
const MAX_USERS = Number(process.env.MAX_USERS) || 10;
const MAX_UPLOAD = (Number(process.env.MAX_UPLOAD_MB) || 500) * 1024 * 1024;
const DATA_DIR = path.resolve(path.join(__dirname, '..'), process.env.DATA_DIR || './data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const WEB_DIR = path.join(__dirname, '..', '..', 'web');

if (!INVITE_CODE) {
  console.warn('[aviso] INVITE_CODE não definido: qualquer pessoa com o endereço pode criar conta (até o limite de ' + MAX_USERS + ').');
}

const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
if (process.env.TURN_URLS) {
  ICE_SERVERS.push({
    urls: process.env.TURN_URLS.split(',').map((s) => s.trim()).filter(Boolean),
    username: process.env.TURN_USERNAME,
    credential: process.env.TURN_CREDENTIAL,
  });
}

// TURN da Cloudflare: retransmite voz/vídeo quando a conexão direta falha (4G, redes com NAT
// simétrico). A chave fica só aqui no servidor; o app recebe credenciais que expiram.
const CF_TURN_KEY_ID = process.env.CF_TURN_KEY_ID || '';
const CF_TURN_API_TOKEN = process.env.CF_TURN_API_TOKEN || '';
const CF_TURN_TTL = 24 * 3600; // segundos
let cfTurn = null; // { servers, expiresAt }
let cfTurnPending = null;

async function fetchCloudflareTurn() {
  const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(CF_TURN_KEY_ID)}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CF_TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: CF_TURN_TTL }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Cloudflare TURN respondeu ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { iceServers } = await res.json();
  // A porta alternativa 53 é bloqueada pelos navegadores e só atrasaria a conexão
  const servers = (iceServers || []).map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)) }));
  cfTurn = { servers, expiresAt: Date.now() + CF_TURN_TTL * 1000 };
  return servers;
}

// ---------- trava de gastos do TURN ----------
// A Cloudflare dá 1.000 GB/mês grátis e depois cobra no cartão, sem cortar o serviço.
// Com CF_ACCOUNT_ID + CF_ANALYTICS_TOKEN, o servidor confere o consumo do mês e para de
// entregar TURN ao passar de TURN_MONTHLY_LIMIT_GB, bem antes da cota grátis acabar.
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || '';
const CF_ANALYTICS_TOKEN = process.env.CF_ANALYTICS_TOKEN || '';
const TURN_LIMIT_BYTES = (Number(process.env.TURN_MONTHLY_LIMIT_GB) || 800) * 1e9;
const TURN_USAGE_EVERY = 15 * 60 * 1000;
const TURN_USAGE_MAX_AGE = 6 * 3600 * 1000; // sem conferir há 6 h: não arrisca
const turnGuard = !!(CF_ACCOUNT_ID && CF_ANALYTICS_TOKEN);
const turnUsage = { bytes: null, checkedAt: 0, error: null };

async function checkTurnUsage() {
  const now = new Date();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  try {
    const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${CF_ANALYTICS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query($acct: string!, $since: Time!) { viewer { accounts(filter: { accountTag: $acct }) {
          callsTurnUsageAdaptiveGroups(filter: { datetimeMinute_geq: $since }, limit: 1) { sum { egressBytes } } } } }`,
        variables: { acct: CF_ACCOUNT_ID, since },
      }),
      signal: AbortSignal.timeout(10000),
    });
    const json = await res.json();
    if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; '));
    const groups = json.data?.viewer?.accounts?.[0]?.callsTurnUsageAdaptiveGroups;
    if (!groups) throw new Error('resposta sem dados de uso');
    turnUsage.bytes = groups.reduce((n, g) => n + (g.sum?.egressBytes || 0), 0);
    turnUsage.checkedAt = Date.now();
    turnUsage.error = null;
    // Passou do limite e ainda há credencial entregue: corta (cfTurn vira null, avisa uma vez)
    if (turnUsage.bytes >= TURN_LIMIT_BYTES && cfTurn) {
      console.warn(`[turn] limite do mês atingido (${(turnUsage.bytes / 1e9).toFixed(1)} GB): TURN desligado até o mês que vem`);
      revokeCloudflareTurn();
    }
  } catch (e) {
    turnUsage.error = e.message;
    console.warn('[turn] não consegui ler o consumo:', e.message);
  }
}

// Bloqueado se passou do limite ou se não dá para saber o consumo (sem dados recentes)
function turnBlocked() {
  if (!turnGuard) return false;
  if (!turnUsage.checkedAt || Date.now() - turnUsage.checkedAt > TURN_USAGE_MAX_AGE) return true;
  return turnUsage.bytes >= TURN_LIMIT_BYTES;
}

// Tenta invalidar as credenciais já entregues. Nos testes a Cloudflare aceitou (204), mas a
// credencial seguiu funcionando: conte com até CF_TURN_TTL (24 h) de uso depois da trava
// disparar. A folga entre o limite (800 GB) e a cota grátis (1.000 GB) cobre isso.
async function revokeCloudflareTurn() {
  const username = cfTurn?.servers.find((s) => s.username)?.username;
  cfTurn = null;
  if (!username) return;
  try {
    await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(CF_TURN_KEY_ID)}/credentials/${encodeURIComponent(username)}/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CF_TURN_API_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.warn('[turn] falha ao revogar credencial:', e.message);
  }
}

if (turnGuard && CF_TURN_KEY_ID) {
  checkTurnUsage();
  setInterval(checkTurnUsage, TURN_USAGE_EVERY).unref();
}

function turnStatus() {
  return {
    enabled: !!(CF_TURN_KEY_ID && CF_TURN_API_TOKEN),
    guard: turnGuard,
    usedGb: turnUsage.bytes == null ? null : +(turnUsage.bytes / 1e9).toFixed(2),
    limitGb: TURN_LIMIT_BYTES / 1e9,
    blocked: turnBlocked(),
    checkedAt: turnUsage.checkedAt || null,
    error: turnUsage.error,
  };
}

// Servidores ICE para uma chamada. Renova as credenciais com folga (quem entra agora
// tem pelo menos 12 h de chamada). Se a Cloudflare falhar, segue só com STUN.
async function getIceServers() {
  if (!CF_TURN_KEY_ID || !CF_TURN_API_TOKEN) return ICE_SERVERS;
  if (turnBlocked()) return ICE_SERVERS;
  if (!cfTurn || cfTurn.expiresAt - Date.now() < 12 * 3600 * 1000) {
    cfTurnPending ??= fetchCloudflareTurn()
      .catch((e) => console.warn('[turn]', e.message))
      .finally(() => (cfTurnPending = null));
    await cfTurnPending;
  }
  return cfTurn && cfTurn.expiresAt > Date.now() ? [...ICE_SERVERS, ...cfTurn.servers] : ICE_SERVERS;
}

const db = new Db(DATA_DIR, { serverName: process.env.SERVER_NAME || 'Resenha' });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- HTTP ----------
const app = express();
app.disable('x-powered-by');
const json = express.json({ limit: '100kb' });
app.use((req, res, next) => {
  // O app desktop carrega a interface a partir deste servidor; o navegador também pode.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Filename');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Anti força bruta bem simples
const attempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 60_000);
  list.push(now);
  attempts.set(ip, list);
  return list.length > 20;
}

const USERNAME_RE = /^[\p{L}\p{N}_.-]{2,32}$/u;

app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'resenha', serverName: db.data.serverName, users: db.data.users.length, maxUsers: MAX_USERS, needsInvite: !!INVITE_CODE });
});

app.post('/api/register', json, (req, res) => {
  if (tooManyAttempts(req.ip)) return res.status(429).json({ error: 'Muitas tentativas. Espere um minuto.' });
  const { username, password, inviteCode } = req.body || {};
  if (INVITE_CODE && inviteCode !== INVITE_CODE) return res.status(403).json({ error: 'Código de convite inválido.' });
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Nome de usuário deve ter 2 a 32 caracteres (letras, números, _ . -).' });
  }
  if (typeof password !== 'string' || password.length < 6) return res.status(400).json({ error: 'A senha precisa ter pelo menos 6 caracteres.' });
  if (db.data.users.length >= MAX_USERS) return res.status(403).json({ error: `Servidor cheio (máximo de ${MAX_USERS} pessoas).` });
  if (db.findUserByName(username)) return res.status(409).json({ error: 'Esse nome de usuário já existe.' });
  const user = db.createUser(username, password);
  const token = db.createSession(user.id);
  io.emit('user:new', db.publicUser(user));
  res.json({ token, user: db.publicUser(user) });
});

app.post('/api/login', json, (req, res) => {
  if (tooManyAttempts(req.ip)) return res.status(429).json({ error: 'Muitas tentativas. Espere um minuto.' });
  const { username, password } = req.body || {};
  const user = typeof username === 'string' && db.findUserByName(username);
  if (!user || typeof password !== 'string' || !db.checkPassword(user, password)) {
    return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  }
  res.json({ token: db.createSession(user.id), user: db.publicUser(user) });
});

function authUser(req) {
  const h = req.headers.authorization || '';
  return db.userFromToken(h.replace(/^Bearer\s+/i, ''));
}

app.post('/api/logout', (req, res) => {
  const h = req.headers.authorization || '';
  db.deleteSession(h.replace(/^Bearer\s+/i, ''));
  res.json({ ok: true });
});

// Upload: corpo bruto, streaming direto pro disco (sem limite ridículo de 10 MB)
app.post('/api/upload', (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado.' });
  const size = Number(req.headers['content-length'] || 0);
  if (size > MAX_UPLOAD) return res.status(413).json({ error: `Arquivo maior que ${MAX_UPLOAD / 1024 / 1024} MB.` });

  let name = 'arquivo';
  try {
    name = decodeURIComponent(req.headers['x-filename'] || 'arquivo');
  } catch {}
  name = path.basename(name).replace(/[^\p{L}\p{N}_.\- ()]/gu, '_').slice(0, 120) || 'arquivo';
  const id = crypto.randomBytes(16).toString('hex');
  const dir = path.join(UPLOAD_DIR, id);
  fs.mkdirSync(dir);
  const dest = path.join(dir, name);
  const out = fs.createWriteStream(dest);
  let received = 0;
  let aborted = false;

  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > MAX_UPLOAD && !aborted) {
      aborted = true;
      req.unpipe(out);
      out.destroy();
      fs.rmSync(dir, { recursive: true, force: true });
      res.status(413).json({ error: 'Arquivo grande demais.' });
      req.destroy();
    }
  });
  req.pipe(out);
  out.on('finish', () => {
    if (aborted) return;
    const type = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0];
    res.json({ id, name, size: received, type, url: `/uploads/${id}/${encodeURIComponent(name)}` });
  });
  out.on('error', () => {
    if (!aborted) res.status(500).json({ error: 'Falha ao salvar o arquivo.' });
  });
});

// IDs de 128 bits aleatórios: não dá pra adivinhar o link de um arquivo
// Só imagem/vídeo/áudio abrem no app; o resto (html, svg...) é sempre baixado, para não rodar script aqui
const INLINE_TYPES = /\.(png|jpe?g|gif|webp|avif|bmp|mp4|webm|mov|m4v|mp3|ogg|oga|wav|m4a|flac|opus)$/i;
app.use('/uploads', express.static(UPLOAD_DIR, {
  maxAge: '30d',
  immutable: true,
  dotfiles: 'deny',
  setHeaders(res, filePath) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!INLINE_TYPES.test(filePath)) res.setHeader('Content-Disposition', 'attachment');
  },
}));
app.use(express.static(WEB_DIR, { index: 'index.html' }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e6,
  pingInterval: 10_000,
  pingTimeout: 20_000,
});

// ---------- estado em memória ----------
// voice: channelId -> Map(socketId -> { userId, muted, deafened, cameraStreamId, screenStreamId })
const voice = new Map();
// presença: userId -> Set(socketId)
const online = new Map();

function voiceSnapshot() {
  const out = {};
  for (const [cid, members] of voice) {
    out[cid] = [...members.entries()].map(([socketId, s]) => ({ socketId, ...s }));
  }
  return out;
}

function broadcastVoice(channelId) {
  const members = voice.get(channelId);
  io.emit('voice:state', {
    channelId,
    members: members ? [...members.entries()].map(([socketId, s]) => ({ socketId, ...s })) : [],
  });
}

function leaveVoice(socket) {
  const cid = socket.data.voiceChannel;
  if (!cid) return;
  const members = voice.get(cid);
  if (members) {
    members.delete(socket.id);
    if (!members.size) voice.delete(cid);
  }
  socket.data.voiceChannel = null;
  socket.to(`voice:${cid}`).emit('voice:peer-left', { socketId: socket.id });
  socket.leave(`voice:${cid}`);
  broadcastVoice(cid);
}

function isOnline(userId) {
  return (online.get(userId)?.size || 0) > 0;
}

function presenceOf(u) {
  return { ...db.publicUser(u), online: isOnline(u.id) && u.status !== 'invisible' };
}

function clampText(s, max) {
  return typeof s === 'string' ? s.slice(0, max) : '';
}

function sanitizeAttachments(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 10).filter((a) => a && typeof a.id === 'string' && /^[a-f0-9]{32}$/.test(a.id)).map((a) => ({
    id: a.id,
    name: clampText(a.name, 120),
    size: Number(a.size) || 0,
    type: clampText(a.type, 100),
    url: `/uploads/${a.id}/${encodeURIComponent(clampText(a.name, 120))}`,
  }));
}

io.use((socket, next) => {
  const user = db.userFromToken(socket.handshake.auth?.token);
  if (!user) return next(new Error('unauthorized'));
  socket.data.userId = user.id;
  next();
});

io.on('connection', (socket) => {
  const userId = socket.data.userId;
  const me = () => db.getUser(userId);
  if (!me()) return socket.disconnect();

  if (!online.has(userId)) online.set(userId, new Set());
  online.get(userId).add(socket.id);
  io.emit('user:update', presenceOf(me()));

  socket.emit('init', {
    me: db.publicUser(me()),
    serverName: db.data.serverName,
    serverIcon: db.data.serverIcon,
    users: db.data.users.map(presenceOf),
    channels: db.data.channels,
    voice: voiceSnapshot(),
    lastMessageIds: db.lastMessageIds(),
    iceServers: ICE_SERVERS,
    maxUploadMb: MAX_UPLOAD / 1024 / 1024,
  });

  const requireAdmin = (ack) => {
    if (!me()?.isAdmin) {
      if (typeof ack === 'function') ack({ error: 'Só o administrador pode fazer isso.' });
      return false;
    }
    return true;
  };

  // ----- mensagens -----
  socket.on('message:list', ({ channelId, before } = {}, ack) => {
    if (typeof ack !== 'function') return;
    if (!db.getChannel(channelId)) return ack({ error: 'Canal não existe.' });
    ack(db.listMessages(channelId, before));
  });

  socket.on('message:send', ({ channelId, content, attachments, replyTo } = {}, ack) => {
    const channel = db.getChannel(channelId);
    if (!channel || channel.type !== 'text') return ack?.({ error: 'Canal inválido.' });
    const text = clampText(content, 4000).trim();
    const files = sanitizeAttachments(attachments);
    if (!text && !files.length) return ack?.({ error: 'Mensagem vazia.' });
    const reply = replyTo && db.findMessage(channelId, replyTo) ? replyTo : null;
    const msg = db.addMessage(channelId, userId, text, files, reply);
    io.emit('message:new', msg);
    ack?.({ ok: true, message: msg });
  });

  socket.on('message:edit', ({ channelId, id, content } = {}, ack) => {
    const msg = db.findMessage(channelId, id);
    if (!msg || msg.authorId !== userId) return ack?.({ error: 'Não permitido.' });
    const text = clampText(content, 4000).trim();
    if (!text && !msg.attachments.length) return ack?.({ error: 'Mensagem vazia.' });
    msg.content = text;
    msg.editedAt = Date.now();
    db.save();
    io.emit('message:update', msg);
    ack?.({ ok: true });
  });

  socket.on('message:delete', ({ channelId, id } = {}, ack) => {
    const msg = db.findMessage(channelId, id);
    if (!msg || (msg.authorId !== userId && !me().isAdmin)) return ack?.({ error: 'Não permitido.' });
    db.deleteMessage(channelId, id);
    io.emit('message:delete', { channelId, id });
    ack?.({ ok: true });
  });

  socket.on('reaction:toggle', ({ channelId, id, emoji } = {}) => {
    const msg = db.findMessage(channelId, id);
    if (!msg || typeof emoji !== 'string' || !emoji || emoji.length > 16) return;
    const list = (msg.reactions[emoji] ||= []);
    const idx = list.indexOf(userId);
    if (idx >= 0) list.splice(idx, 1);
    else if (Object.keys(msg.reactions).length <= 20) list.push(userId);
    if (!list.length) delete msg.reactions[emoji];
    db.save();
    io.emit('message:update', msg);
  });

  socket.on('typing', ({ channelId } = {}) => {
    if (db.getChannel(channelId)) socket.broadcast.emit('typing', { channelId, userId });
  });

  // ----- perfil -----
  socket.on('user:update', (patch = {}, ack) => {
    const u = me();
    if (typeof patch.color === 'string' && /^#[0-9a-f]{6}$/i.test(patch.color)) u.color = patch.color;
    if (patch.avatar === null || (typeof patch.avatar === 'string' && /^\/uploads\/[a-f0-9]{32}\//.test(patch.avatar))) u.avatar = patch.avatar;
    if (['online', 'idle', 'dnd', 'invisible'].includes(patch.status)) u.status = patch.status;
    if (typeof patch.customStatus === 'string') u.customStatus = patch.customStatus.slice(0, 128);
    db.save();
    io.emit('user:update', presenceOf(u));
    ack?.({ ok: true });
  });

  socket.on('user:password', ({ current, next } = {}, ack) => {
    const u = me();
    if (typeof current !== 'string' || !db.checkPassword(u, current)) return ack?.({ error: 'Senha atual incorreta.' });
    if (typeof next !== 'string' || next.length < 6) return ack?.({ error: 'A nova senha precisa ter pelo menos 6 caracteres.' });
    const { salt, hash } = db.hashPassword(next);
    u.salt = salt;
    u.passHash = hash;
    db.save();
    ack?.({ ok: true });
  });

  // ----- administração -----
  socket.on('channel:create', ({ name, type } = {}, ack) => {
    if (!requireAdmin(ack)) return;
    type = type === 'voice' ? 'voice' : 'text';
    let clean = clampText(name, 50).trim();
    if (type === 'text') clean = clean.toLowerCase().replace(/\s+/g, '-');
    if (!clean) return ack?.({ error: 'Nome inválido.' });
    const channel = db.createChannel(clean, type);
    io.emit('channels', db.data.channels);
    ack?.({ ok: true, channel });
  });

  socket.on('channel:rename', ({ id, name } = {}, ack) => {
    if (!requireAdmin(ack)) return;
    const channel = db.getChannel(id);
    let clean = clampText(name, 50).trim();
    if (channel?.type === 'text') clean = clean.toLowerCase().replace(/\s+/g, '-');
    if (!channel || !clean) return ack?.({ error: 'Nome inválido.' });
    channel.name = clean;
    db.save();
    io.emit('channels', db.data.channels);
    ack?.({ ok: true });
  });

  socket.on('channel:delete', ({ id } = {}, ack) => {
    if (!requireAdmin(ack)) return;
    const channel = db.getChannel(id);
    if (!channel) return ack?.({ error: 'Canal não existe.' });
    if (db.data.channels.filter((c) => c.type === channel.type).length <= 1) {
      return ack?.({ error: 'Precisa sobrar pelo menos um canal desse tipo.' });
    }
    for (const s of io.sockets.sockets.values()) if (s.data.voiceChannel === id) leaveVoice(s);
    db.deleteChannel(id);
    io.emit('channels', db.data.channels);
    ack?.({ ok: true });
  });

  socket.on('turn:status', async (_ = {}, ack) => {
    if (!requireAdmin(ack)) return;
    if (turnGuard && Date.now() - turnUsage.checkedAt > 60 * 1000) await checkTurnUsage();
    ack?.(turnStatus());
  });

  socket.on('server:update', ({ name, icon } = {}, ack) => {
    if (!requireAdmin(ack)) return;
    if (typeof name === 'string' && name.trim()) db.data.serverName = name.trim().slice(0, 50);
    if (icon === null || (typeof icon === 'string' && /^\/uploads\/[a-f0-9]{32}\//.test(icon))) db.data.serverIcon = icon;
    db.save();
    io.emit('server:update', { serverName: db.data.serverName, serverIcon: db.data.serverIcon });
    ack?.({ ok: true });
  });

  socket.on('user:kick', ({ id } = {}, ack) => {
    if (!requireAdmin(ack)) return;
    const target = db.getUser(id);
    if (!target || target.id === userId) return ack?.({ error: 'Não permitido.' });
    db.data.users = db.data.users.filter((u) => u.id !== id);
    for (const [token, s] of Object.entries(db.data.sessions)) if (s.userId === id) delete db.data.sessions[token];
    db.save();
    for (const s of io.sockets.sockets.values()) {
      if (s.data.userId === id) {
        s.emit('kicked');
        s.disconnect(true);
      }
    }
    io.emit('user:remove', { id });
    ack?.({ ok: true });
  });

  // ----- voz / vídeo (WebRTC em malha, o servidor só faz a sinalização) -----
  socket.on('voice:join', async ({ channelId, muted, deafened } = {}, ack) => {
    const channel = db.getChannel(channelId);
    if (!channel || channel.type !== 'voice') return ack?.({ error: 'Canal de voz inválido.' });
    // Credenciais do TURN novas a cada entrada (as antigas podem ter expirado)
    const iceServers = await getIceServers();
    if (!socket.connected) return;
    leaveVoice(socket);
    const members = voice.get(channelId) || new Map();
    const peers = [...members.entries()].map(([socketId, s]) => ({ socketId, userId: s.userId }));
    members.set(socket.id, { userId, muted: !!muted, deafened: !!deafened, cameraStreamId: null, screenStreamId: null });
    voice.set(channelId, members);
    socket.data.voiceChannel = channelId;
    socket.join(`voice:${channelId}`);
    socket.to(`voice:${channelId}`).emit('voice:peer-joined', { socketId: socket.id, userId });
    broadcastVoice(channelId);
    ack?.({ ok: true, peers, iceServers });
  });

  socket.on('voice:leave', () => leaveVoice(socket));

  socket.on('voice:update', (patch = {}) => {
    const cid = socket.data.voiceChannel;
    const s = cid && voice.get(cid)?.get(socket.id);
    if (!s) return;
    for (const k of ['muted', 'deafened']) if (k in patch) s[k] = !!patch[k];
    for (const k of ['cameraStreamId', 'screenStreamId']) {
      if (k in patch) s[k] = typeof patch[k] === 'string' ? patch[k].slice(0, 100) : null;
    }
    broadcastVoice(cid);
  });

  socket.on('voice:signal', ({ to, data } = {}) => {
    const target = io.sockets.sockets.get(to);
    const cid = socket.data.voiceChannel;
    // Só repassa sinalização entre pessoas no mesmo canal de voz
    if (!target || !cid || target.data.voiceChannel !== cid) return;
    target.emit('voice:signal', { from: socket.id, userId, data });
  });

  socket.on('disconnect', () => {
    leaveVoice(socket);
    const set = online.get(userId);
    set?.delete(socket.id);
    const u = me();
    if (u && !isOnline(userId)) io.emit('user:update', presenceOf(u));
  });
});

function shutdown() {
  db.flush();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  console.log(`Resenha rodando em http://localhost:${PORT}`);
  console.log(`Dados em ${DATA_DIR}`);
});

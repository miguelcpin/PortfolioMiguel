// Banco de dados em arquivo JSON. Para até 10 pessoas isso é mais que suficiente,
// não precisa instalar nada e o backup é só copiar a pasta data/.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COLORS = ['#5865f2', '#57f287', '#fee75c', '#eb459e', '#ed4245', '#f0b232', '#23a55a', '#00a8fc', '#9b59b6', '#e67e22'];

function newId() {
  // Ordenável por tempo + aleatório
  return Date.now().toString(36).padStart(9, '0') + crypto.randomBytes(5).toString('hex');
}

class Db {
  constructor(dir, defaults) {
    this.dir = dir;
    this.file = path.join(dir, 'db.json');
    fs.mkdirSync(dir, { recursive: true });
    this.data = this.load(defaults);
    this.saveTimer = null;
  }

  load(defaults) {
    if (fs.existsSync(this.file)) {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      data.sessions ||= {};
      data.messages ||= {};
      return data;
    }
    const general = { id: newId(), name: 'geral', type: 'text', position: 0 };
    const memes = { id: newId(), name: 'memes', type: 'text', position: 1 };
    const voice = { id: newId(), name: 'Geral', type: 'voice', position: 0 };
    const games = { id: newId(), name: 'Jogando', type: 'voice', position: 1 };
    return {
      serverName: defaults.serverName,
      serverIcon: null,
      users: [],
      sessions: {},
      channels: [general, memes, voice, games],
      messages: { [general.id]: [], [memes.id]: [] },
    };
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 500);
  }

  flush() {
    clearTimeout(this.saveTimer);
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  // ---------- usuários ----------
  hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return { salt, hash };
  }

  createUser(username, password) {
    const { salt, hash } = this.hashPassword(password);
    const user = {
      id: newId(),
      username,
      salt,
      passHash: hash,
      color: COLORS[this.data.users.length % COLORS.length],
      avatar: null,
      status: 'online',
      customStatus: '',
      isAdmin: this.data.users.length === 0,
      createdAt: Date.now(),
    };
    this.data.users.push(user);
    this.save();
    return user;
  }

  findUserByName(username) {
    const lower = username.toLowerCase();
    return this.data.users.find((u) => u.username.toLowerCase() === lower);
  }

  getUser(id) {
    return this.data.users.find((u) => u.id === id);
  }

  checkPassword(user, password) {
    const { hash } = this.hashPassword(password, user.salt);
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.passHash, 'hex'));
  }

  publicUser(u) {
    return {
      id: u.id,
      username: u.username,
      color: u.color,
      avatar: u.avatar,
      status: u.status,
      customStatus: u.customStatus,
      isAdmin: u.isAdmin,
    };
  }

  // ---------- sessões ----------
  // O token de login leva, criptografados, os dados da própria conta. Se o servidor
  // perder os dados (ex.: reinício no plano grátis do Render), a conta é recriada
  // a partir do token na próxima vez que a pessoa abrir o app: ela continua logada.
  setSessionSecret(secret) {
    this.sessionKey = crypto.scryptSync(String(secret), 'resenha-session-v1', 32);
  }

  createSession(userId) {
    const u = this.getUser(userId);
    const payload = JSON.stringify({
      v: 1,
      id: u.id,
      username: u.username,
      salt: u.salt,
      passHash: u.passHash,
      color: u.color,
      avatar: u.avatar,
      customStatus: u.customStatus,
      isAdmin: u.isAdmin,
      createdAt: u.createdAt,
    });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.sessionKey, iv);
    const enc = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
    return 'r1.' + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64url');
  }

  readToken(token) {
    if (typeof token !== 'string' || !token.startsWith('r1.') || token.length > 4000) return null;
    try {
      const raw = Buffer.from(token.slice(3), 'base64url');
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.sessionKey, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      const json = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  // maxUsers: limite de contas; uploadExists(url): se o arquivo do avatar ainda existe
  userFromToken(token, { maxUsers = Infinity, uploadExists = () => false } = {}) {
    const t = this.readToken(token);
    if (!t || (this.data.revoked || []).includes(t.id)) return null;
    const existing = this.getUser(t.id);
    if (existing) {
      // Senha trocada depois deste token: ele não vale mais
      return existing.passHash === t.passHash ? existing : null;
    }
    // Conta sumiu (servidor reiniciou): recria, se o nome estiver livre e houver vaga
    if (this.findUserByName(t.username) || this.data.users.length >= maxUsers) return null;
    const user = {
      id: t.id,
      username: t.username,
      salt: t.salt,
      passHash: t.passHash,
      color: t.color,
      avatar: t.avatar && uploadExists(t.avatar) ? t.avatar : null,
      status: 'online',
      customStatus: t.customStatus || '',
      isAdmin: !!t.isAdmin,
      createdAt: t.createdAt || Date.now(),
      restoredAt: Date.now(),
    };
    this.data.users.push(user);
    this.save();
    return user;
  }

  deleteSession() {
    // Tokens não ficam guardados no servidor: sair = o app apaga o token do aparelho
  }

  // ---------- canais ----------
  getChannel(id) {
    return this.data.channels.find((c) => c.id === id);
  }

  createChannel(name, type) {
    const position = Math.max(-1, ...this.data.channels.filter((c) => c.type === type).map((c) => c.position)) + 1;
    const channel = { id: newId(), name, type, position };
    this.data.channels.push(channel);
    if (type === 'text') this.data.messages[channel.id] = [];
    this.save();
    return channel;
  }

  deleteChannel(id) {
    this.data.channels = this.data.channels.filter((c) => c.id !== id);
    delete this.data.messages[id];
    this.save();
  }

  // ---------- mensagens ----------
  listMessages(channelId, before, limit = 50) {
    const all = this.data.messages[channelId] || [];
    let end = all.length;
    if (before) {
      const idx = all.findIndex((m) => m.id === before);
      if (idx >= 0) end = idx;
    }
    const start = Math.max(0, end - limit);
    return { messages: all.slice(start, end), hasMore: start > 0 };
  }

  lastMessageIds() {
    const out = {};
    for (const [cid, list] of Object.entries(this.data.messages)) {
      if (list.length) out[cid] = list[list.length - 1].id;
    }
    return out;
  }

  findMessage(channelId, id) {
    return (this.data.messages[channelId] || []).find((m) => m.id === id);
  }

  addMessage(channelId, authorId, content, attachments, replyTo) {
    const msg = {
      id: newId(),
      channelId,
      authorId,
      content,
      attachments,
      replyTo: replyTo || null,
      reactions: {},
      createdAt: Date.now(),
      editedAt: null,
    };
    (this.data.messages[channelId] ||= []).push(msg);
    this.save();
    return msg;
  }

  deleteMessage(channelId, id) {
    const list = this.data.messages[channelId] || [];
    const idx = list.findIndex((m) => m.id === id);
    if (idx >= 0) list.splice(idx, 1);
    this.save();
  }
}

module.exports = { Db, newId };

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

  createSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    this.data.sessions[token] = { userId, createdAt: Date.now() };
    this.save();
    return token;
  }

  userFromToken(token) {
    const s = token && this.data.sessions[token];
    return s ? this.getUser(s.userId) : null;
  }

  deleteSession(token) {
    delete this.data.sessions[token];
    this.save();
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

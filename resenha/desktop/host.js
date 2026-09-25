// "Hospedar neste PC": roda o servidor do Resenha dentro do próprio app desktop.
// O Electron já traz o Node.js, então quem hospeda não precisa instalar mais nada.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const HOST_FILE = path.join(app.getPath('userData'), 'host.json');
const DATA_DIR = path.join(app.getPath('userData'), 'servidor-dados');

let running = null; // módulo do servidor em execução
let lastError = '';

// No instalador o servidor e a interface vão junto do app; em desenvolvimento, usa as pastas do repositório
function bundled(...p) {
  const inside = path.join(__dirname, ...p);
  return fs.existsSync(inside) ? inside : path.join(__dirname, '..', ...p);
}
const serverEntry = () => bundled('server', 'src', 'index.js');
const webDir = () => bundled('web');

function readHost() {
  try {
    return JSON.parse(fs.readFileSync(HOST_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeHost(cfg) {
  fs.mkdirSync(path.dirname(HOST_FILE), { recursive: true });
  fs.writeFileSync(HOST_FILE, JSON.stringify(cfg, null, 2));
}

function randomInvite() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(8), (b) => chars[b % chars.length]).join('');
}

// Esquece o servidor carregado (para poder ligar de novo, ex.: em outra porta)
function forgetModule() {
  const dir = path.dirname(serverEntry());
  for (const key of Object.keys(require.cache)) if (key.startsWith(dir)) delete require.cache[key];
}

async function start(cfg) {
  if (running) return running;
  Object.assign(process.env, {
    RESENHA_EMBEDDED: '1',
    PORT: String(cfg.port),
    INVITE_CODE: cfg.inviteCode,
    SERVER_NAME: cfg.serverName,
    MAX_USERS: '10',
    DATA_DIR,
    WEB_DIR: webDir(),
  });
  forgetModule();
  const mod = require(serverEntry());
  try {
    await new Promise((resolve, reject) => {
      if (mod.server.listening) return resolve();
      mod.server.once('listening', resolve);
      mod.server.once('error', reject);
    });
  } catch (e) {
    forgetModule();
    lastError = e.code === 'EADDRINUSE' ? `A porta ${cfg.port} já está em uso (outro servidor aberto?). Feche-o ou escolha outra porta.` : e.message;
    throw new Error(lastError);
  }
  lastError = '';
  running = mod;
  return mod;
}

async function stop() {
  if (!running) return;
  const mod = running;
  running = null;
  await mod.close();
  forgetModule();
}

function flush() {
  try {
    running?.flush();
  } catch {}
}

// Endereços para passar aos amigos
function addresses(port) {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      const [x, y] = a.address.split('.').map(Number);
      const kind = x === 100 && y >= 64 && y <= 127 ? 'tailscale' : x === 10 || (x === 192 && y === 168) || (x === 172 && y >= 16 && y <= 31) ? 'lan' : 'outro';
      out.push({ url: `http://${a.address}:${port}`, kind, iface: name });
    }
  }
  return out;
}

function setAutostart(on) {
  try {
    app.setLoginItemSettings({ openAtLogin: !!on, openAsHidden: true, args: ['--hidden'] });
  } catch {}
}

function info() {
  const cfg = readHost();
  return {
    enabled: !!cfg.enabled,
    running: !!running,
    port: cfg.port || 3000,
    inviteCode: cfg.inviteCode || '',
    serverName: cfg.serverName || 'Resenha',
    autostart: !!cfg.autostart,
    error: lastError,
    dataDir: DATA_DIR,
    addresses: running ? addresses(cfg.port) : [],
  };
}

module.exports = { readHost, writeHost, randomInvite, start, stop, flush, info, setAutostart };

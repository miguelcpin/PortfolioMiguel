// App desktop do Resenha. Ele é só uma "casca": a interface vem do servidor,
// então quando você atualiza o servidor todo mundo recebe a versão nova sem reinstalar.
const { app, BrowserWindow, ipcMain, desktopCapturer, session, shell, Menu, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const pkg = require('./package.json');
const host = require('./host');

const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');
const ICON = path.join(__dirname, 'build', 'icon.png');
const isMac = process.platform === 'darwin';

let win = null;
let tray = null;
let quitting = false;
let pendingSource = null; // fonte escolhida no seletor de tela
const startHidden = process.argv.includes('--hidden'); // aberto junto com o Windows

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function serverUrl() {
  return readConfig().serverUrl || pkg.resenha?.defaultServer || '';
}

const startupServer = serverUrl();
const needsSecureFlag = (origin) => origin.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin);

function normalizeUrl(u) {
  u = String(u || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  const parsed = new URL(u);
  return parsed.origin;
}

// Só a página do servidor configurado (ou a tela local de conexão) pode usar as APIs do app
function trusted(frame) {
  try {
    const url = frame?.url || '';
    if (url.startsWith('file://')) return true;
    const srv = serverUrl();
    return !!srv && new URL(url).origin === new URL(srv).origin;
  } catch {
    return false;
  }
}

function loadApp(error) {
  const srv = serverUrl();
  if (!srv || error) {
    win.loadFile(path.join(__dirname, 'connect.html'), { query: error ? { error, server: srv } : {} });
  } else {
    win.loadURL(srv + '/');
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 500,
    backgroundColor: '#313338',
    icon: ICON,
    title: 'Resenha',
    show: false,
    titleBarStyle: 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 10, y: 4 } } : { titleBarOverlay: { color: '#1e1f22', symbolColor: '#b5bac1', height: 22 } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // mantém a voz funcionando com a janela minimizada
      spellcheck: true,
    },
  });
  win.webContents.session.setSpellCheckerLanguages(['pt-BR', 'en-US']);

  win.once('ready-to-show', () => !startHidden && win.show());

  // Links externos abrem no navegador
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const srv = serverUrl();
    if (url.startsWith('file://')) return;
    if (!srv || new URL(url).origin !== new URL(srv).origin) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });

  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame && !url.startsWith('file://') && code !== -3) {
      loadApp(`Não foi possível conectar ao servidor (${desc}).`);
    }
  });

  // F12 / Ctrl+Shift+I abre as ferramentas de desenvolvedor; Ctrl+R recarrega
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    const mod = input.control || input.meta;
    if (input.key === 'F12' || (mod && input.shift && input.key.toLowerCase() === 'i')) win.webContents.toggleDevTools();
    if (mod && !input.shift && input.key.toLowerCase() === 'r') win.webContents.reload();
  });

  // Fechar a janela só esconde (igual ao Discord): a chamada continua rodando
  win.on('close', (e) => {
    if (!quitting && tray) {
      e.preventDefault();
      win.hide();
    }
  });

  bootApp();
}

// Se este PC hospeda o servidor, liga ele antes de abrir a interface
async function bootApp() {
  const cfg = host.readHost();
  if (cfg.enabled) {
    try {
      await host.start(cfg);
    } catch (e) {
      updateTray();
      return win.loadFile(path.join(__dirname, 'connect.html'), { query: { error: e.message, host: '1', ...(e.code === 'EADDRINUSE' ? { busy: String(cfg.port) } : {}) } });
    }
    updateTray();
  }
  loadApp();
}

function updateTray() {
  if (!tray) return;
  const i = host.info();
  tray.setToolTip(i.running ? `Resenha: servidor ligado (${i.addresses.map((a) => a.url).join(', ') || 'localhost:' + i.port})` : 'Resenha');
  const items = [{ label: 'Abrir Resenha', click: showWindow }, { type: 'separator' }];
  if (i.running) {
    items.push({ label: `Servidor ligado (porta ${i.port})`, enabled: false });
    items.push({
      label: 'Desligar servidor',
      click: async () => {
        await host.stop();
        host.writeHost({ ...host.readHost(), enabled: false });
        host.setAutostart(false);
        writeConfig({ ...readConfig(), serverUrl: '' });
        updateTray();
        win.loadFile(path.join(__dirname, 'connect.html'));
      },
    });
    items.push({ type: 'separator' });
  } else if (host.readHost().inviteCode) {
    items.push({ label: 'Ligar servidor neste PC', click: () => { showWindow(); win.loadFile(path.join(__dirname, 'connect.html'), { query: { host: '1' } }); } });
    items.push({ type: 'separator' });
  }
  items.push({ label: 'Sair do Resenha', click: () => { quitting = true; app.quit(); } });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(ICON).resize({ width: isMac ? 18 : 16, height: isMac ? 18 : 16 });
    tray = new Tray(img);
    tray.setToolTip('Resenha');
    tray.on('click', showWindow);
    updateTray();
  } catch (e) {
    tray = null; // sem bandeja (alguns Linux): fechar a janela fecha o app
  }
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function setupPermissions() {
  const allowed = new Set(['media', 'notifications', 'clipboard-sanitized-write', 'clipboard-read', 'fullscreen', 'display-capture', 'speaker-selection']);
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    cb(allowed.has(permission) && trusted({ url: details.requestingUrl || wc.getURL() }));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin) => allowed.has(permission) && trusted({ url: origin || wc?.getURL() }));

  // getDisplayMedia(): usa a fonte escolhida no seletor do app
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const chosen = pendingSource;
      pendingSource = null;
      const src = (chosen && sources.find((s) => s.id === chosen.id)) || sources.find((s) => s.id.startsWith('screen'));
      if (!src) return callback({});
      const wantAudio = chosen ? chosen.audio : false;
      callback({ video: src, ...(wantAudio && process.platform === 'win32' ? { audio: 'loopback' } : {}) });
    } catch (e) {
      callback({});
    }
  });
}

function setupIpc() {
  const guard = (fn) => (event, ...args) => {
    if (!trusted(event.senderFrame)) throw new Error('origem não autorizada');
    return fn(event, ...args);
  };

  ipcMain.handle('get-sources', guard(async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
    return sources
      .filter((s) => !s.name.startsWith('Resenha') || s.id.startsWith('screen'))
      .map((s) => ({ id: s.id, name: s.id.startsWith('screen') ? s.name.replace(/^Entire screen|^Screen/i, 'Tela') : s.name, thumbnail: s.thumbnail.toDataURL() }));
  }));

  ipcMain.handle('select-source', guard((_e, id, audio) => {
    pendingSource = { id: String(id), audio: !!audio };
  }));

  ipcMain.handle('get-server', guard(() => serverUrl()));

  ipcMain.handle('set-server', guard((_e, url) => {
    const origin = normalizeUrl(url);
    writeConfig({ ...readConfig(), serverUrl: origin });
    // Servidor http:// novo precisa da flag acima, que só vale ao iniciar: reinicia o app
    if (needsSecureFlag(origin) && origin !== startupServer) {
      app.relaunch();
      quitting = true;
      app.exit(0);
      return origin;
    }
    loadApp();
    return origin;
  }));

  ipcMain.handle('change-server', guard(() => {
    win.loadFile(path.join(__dirname, 'connect.html'), { query: { server: serverUrl(), change: '1' } });
  }));

  // ----- hospedar o servidor neste PC -----
  ipcMain.handle('host-info', guard(() => ({ ...host.info(), suggestedInvite: host.randomInvite() })));

  ipcMain.handle('host-start', guard(async (_e, opts = {}) => {
    const port = Math.min(65535, Math.max(1024, Number(opts.port) || 3000));
    const cfg = {
      enabled: true,
      port,
      inviteCode: String(opts.inviteCode || '').trim() || host.randomInvite(),
      serverName: String(opts.serverName || '').trim().slice(0, 50) || 'Resenha',
      autostart: opts.autostart !== false,
    };
    try {
      await host.start(cfg);
    } catch (e) {
      if (e.code !== 'EADDRINUSE') return { error: e.message };
      // Porta ocupada: descobre quem é para oferecer as opções
      const other = await host.probe(port);
      return { error: e.message, busy: true, port, other, freePort: await host.findFreePort(port) };
    }
    host.writeHost(cfg);
    host.setAutostart(cfg.autostart);
    writeConfig({ ...readConfig(), serverUrl: `http://localhost:${port}` });
    updateTray();
    loadApp();
    return { ok: true };
  }));

  ipcMain.handle('host-stop', guard(async () => {
    await host.stop();
    host.writeHost({ ...host.readHost(), enabled: false });
    host.setAutostart(false);
    writeConfig({ ...readConfig(), serverUrl: '' });
    updateTray();
    win.loadFile(path.join(__dirname, 'connect.html'));
  }));

  // Desliga o outro programa/servidor que está ocupando a porta
  ipcMain.handle('host-kill-port', guard((_e, port) => host.killPort(Math.min(65535, Math.max(1024, Number(port) || 3000)))));

  ipcMain.handle('host-autostart', guard((_e, on) => {
    host.writeHost({ ...host.readHost(), autostart: !!on });
    host.setAutostart(!!on);
  }));

  ipcMain.on('focus', (event) => trusted(event.senderFrame) && showWindow());

  ipcMain.on('badge', (event, count) => {
    if (!trusted(event.senderFrame)) return;
    const n = Math.max(0, Number(count) || 0);
    if (isMac) app.dock?.setBadge(n ? String(n) : '');
    else if (process.platform === 'linux') app.setBadgeCount(n);
    if (process.platform === 'win32' && n && !win.isFocused()) win.flashFrame(true);
  });
}

// ---------- ciclo de vida ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.setAppUserModelId('app.resenha.desktop');
  // Permite tocar áudio da chamada sem clique prévio
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  // Microfone/câmera exigem HTTPS. Se o servidor for http:// (ex.: IP do Tailscale),
  // tratamos só essa origem como segura.
  if (needsSecureFlag(startupServer)) {
    app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', startupServer);
  }

  app.whenReady().then(() => {
    if (!isMac) Menu.setApplicationMenu(null);
    setupPermissions();
    setupIpc();
    createWindow();
    createTray();
  });

  app.on('activate', showWindow);
  app.on('before-quit', () => {
    quitting = true;
    host.flush(); // salva mensagens pendentes do servidor hospedado
  });
  app.on('window-all-closed', () => {
    if (!isMac) app.quit();
  });
}

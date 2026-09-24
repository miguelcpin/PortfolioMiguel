// Service worker do Resenha: deixa o app instalável, abre rápido e funciona
// como "casca" offline. A API, o socket e os arquivos enviados nunca são cacheados.
const CACHE = 'resenha-v3';
const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'vendor/socket.io.min.js',
  'vendor/noise-suppressor/index.js',
  'vendor/noise-suppressor/rnnoiseWorklet.js',
  'vendor/noise-suppressor/rnnoise.wasm',
  'vendor/noise-suppressor/rnnoise_simd.wasm',
  'js/app.js',
  'js/config.js',
  'js/icons.js',
  'js/markdown.js',
  'js/mic-processing.js',
  'js/noise-gate-worklet.js',
  'js/settings.js',
  'js/util.js',
  'js/voice.js',
  'icon.svg',
  'icons/icon-192.png',
  'manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Rede primeiro (para receber atualizações na hora); cache se estiver sem internet
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (/\/(api|socket\.io|uploads)\//.test(url.pathname)) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))),
  );
});

// Clicar na notificação abre o app no canal da mensagem
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const channelId = e.notification.data?.channelId;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const client = list[0];
      if (client) {
        client.postMessage({ type: 'open-channel', channelId });
        return client.focus();
      }
      return self.clients.openWindow('./');
    }),
  );
});

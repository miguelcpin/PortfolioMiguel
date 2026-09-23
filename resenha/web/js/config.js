// Onde está o servidor. Na versão servida pelo próprio servidor (navegador, PWA,
// app desktop) é o mesmo endereço da página. No app Android (Capacitor) a interface
// vem embutida no APK, então o endereço do servidor é escolhido pelo usuário.
export const isNative = !!window.Capacitor?.isNativePlatform?.();

let base = '';
if (isNative) {
  try {
    base = JSON.parse(localStorage.getItem('serverUrl')) || '';
  } catch {}
}

export function serverBase() {
  return base;
}

export function setServerBase(origin) {
  base = origin;
  try {
    localStorage.setItem('serverUrl', JSON.stringify(origin));
  } catch {}
}

// Endereço absoluto de um recurso do servidor ('api/login', '/uploads/…')
export function abs(path) {
  if (!path || /^(https?:|data:|blob:)/.test(path)) return path;
  if (!base) return path;
  return base + (path.startsWith('/') ? path : '/' + path);
}

// Mostra "servidor" na interface
export function serverLabel() {
  return base || location.origin;
}

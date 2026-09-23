import { icons } from './icons.js';
import { abs } from './config.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 ** 2) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 ** 3) return (bytes / 1024 ** 2).toFixed(1) + ' MB';
  return (bytes / 1024 ** 3).toFixed(2) + ' GB';
}

const timeFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const longDateFmt = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });

export function formatTime(ts) {
  return timeFmt.format(ts);
}

export function formatTimestamp(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return `Hoje às ${timeFmt.format(d)}`;
  if (d.toDateString() === yesterday.toDateString()) return `Ontem às ${timeFmt.format(d)}`;
  return `${dateFmt.format(d)} ${timeFmt.format(d)}`;
}

export function formatDay(ts) {
  return longDateFmt.format(ts);
}

export function initials(name) {
  return (name || '?').slice(0, 1).toUpperCase();
}

// Avatar: imagem, ou letra inicial sobre a cor do usuário
export function avatarHtml(user, size = 40, withStatus = false) {
  const inner = user?.avatar
    ? `<img src="${escapeHtml(abs(user.avatar))}" alt="">`
    : `<span style="font-size:${Math.round(size * 0.45)}px">${escapeHtml(initials(user?.username))}</span>`;
  const status = withStatus ? `<i class="status-dot ${statusClass(user)}"></i>` : '';
  return `<div class="avatar" style="width:${size}px;height:${size}px;background:${user?.avatar ? 'transparent' : escapeHtml(user?.color || '#5865f2')}">${inner}${status}</div>`;
}

export function statusClass(user) {
  if (!user?.online) return 'offline';
  return user.status === 'invisible' ? 'offline' : user.status || 'online';
}

export const STATUS_LABEL = { online: 'Disponível', idle: 'Ausente', dnd: 'Não perturbe', invisible: 'Invisível', offline: 'Offline' };

// ---------- toque ----------
export const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
const mobileQuery = matchMedia('(max-width: 768px)');
export const isMobile = () => mobileQuery.matches;

// Segurar o dedo = botão direito
export function longPress(el, handler, ms = 450) {
  let timer = 0;
  let start = null;
  let fired = false;
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    start = { x: t.clientX, y: t.clientY };
    fired = false;
    clearTimeout(timer);
    timer = setTimeout(() => {
      fired = true;
      navigator.vibrate?.(15);
      handler({ clientX: start.x, clientY: start.y, target: e.target, currentTarget: el, preventDefault() {}, stopPropagation() {} });
    }, ms);
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (start && Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10) clearTimeout(timer);
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    clearTimeout(timer);
    if (fired) {
      e.preventDefault(); // não gera clique depois do toque longo
      e.stopPropagation();
    }
  });
  el.addEventListener('touchcancel', () => clearTimeout(timer));
}

// Menu de contexto por botão direito (desktop) ou toque longo (celular)
export function bindMenu(el, handler) {
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!isTouch) handler(e);
  });
  if (isTouch) longPress(el, handler);
}

// ---------- toasts ----------
export function toast(text, kind = 'info') {
  let box = $('#toasts');
  if (!box) {
    box = h('<div id="toasts"></div>');
    document.body.append(box);
  }
  const t = h(`<div class="toast ${kind}">${escapeHtml(text)}</div>`);
  box.append(t);
  setTimeout(() => t.classList.add('out'), 3500);
  setTimeout(() => t.remove(), 4000);
}

// ---------- modais ----------
export function openModal(contentHtml, { className = '', onClose } = {}) {
  const layer = h(`<div class="modal-layer"><div class="modal ${className}">${contentHtml}</div></div>`);
  const close = () => {
    layer.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  layer.addEventListener('mousedown', (e) => {
    if (e.target === layer) close();
  });
  document.addEventListener('keydown', onKey, true);
  document.body.append(layer);
  $$('[data-close]', layer).forEach((b) => b.addEventListener('click', close));
  return { el: layer.firstElementChild, close };
}

// Substituto de prompt(), que não existe no Electron
export function askText({ title, label, value = '', placeholder = '', confirm = 'Salvar' }) {
  return new Promise((resolve) => {
    let done = false;
    const m = openModal(
      `<div class="modal-body">
        <h2>${escapeHtml(title)}</h2>
        <label class="field-label">${escapeHtml(label)}</label>
        <input class="input" type="text" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" maxlength="50">
      </div>
      <div class="modal-footer">
        <button class="btn link" data-close>Cancelar</button>
        <button class="btn primary" data-ok>${escapeHtml(confirm)}</button>
      </div>`,
      { className: 'small', onClose: () => !done && resolve(null) },
    );
    const input = $('input', m.el);
    const ok = () => {
      done = true;
      m.close();
      resolve(input.value.trim() || null);
    };
    $('[data-ok]', m.el).addEventListener('click', ok);
    input.addEventListener('keydown', (e) => e.key === 'Enter' && ok());
    setTimeout(() => input.select(), 0);
  });
}

export function confirmDialog({ title, text, confirm = 'Confirmar', danger = true }) {
  return new Promise((resolve) => {
    let done = false;
    const m = openModal(
      `<div class="modal-body">
        <h2>${escapeHtml(title)}</h2>
        <p class="muted">${escapeHtml(text)}</p>
      </div>
      <div class="modal-footer">
        <button class="btn link" data-close>Cancelar</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${escapeHtml(confirm)}</button>
      </div>`,
      { className: 'small', onClose: () => !done && resolve(false) },
    );
    $('[data-ok]', m.el).addEventListener('click', () => {
      done = true;
      m.close();
      resolve(true);
    });
  });
}

// ---------- menu de contexto ----------
let openMenu = null;
export function contextMenu(x, y, items) {
  closeContextMenu();
  const menu = h('<div class="context-menu"></div>');
  for (const item of items) {
    if (item === '-') {
      menu.append(h('<div class="menu-sep"></div>'));
      continue;
    }
    if (item.custom) {
      menu.append(item.custom);
      continue;
    }
    const b = h(`<button class="menu-item ${item.danger ? 'danger' : ''}">${escapeHtml(item.label)}${item.icon ? icons[item.icon] : ''}</button>`);
    b.addEventListener('click', () => {
      closeContextMenu();
      item.action();
    });
    menu.append(b);
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  openMenu = menu;
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
}

function outside(e) {
  if (openMenu && !openMenu.contains(e.target)) closeContextMenu();
}

export function closeContextMenu() {
  openMenu?.remove();
  openMenu = null;
  document.removeEventListener('mousedown', outside, true);
}

// ---------- som de notificação (gerado, sem arquivo) ----------
let audioCtx;
export function playBlip(freqs = [660, 880]) {
  try {
    audioCtx ||= new AudioContext();
    const t0 = audioCtx.currentTime;
    freqs.forEach((f, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + i * 0.09);
      g.gain.exponentialRampToValueAtTime(0.12, t0 + i * 0.09 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.09 + 0.12);
      o.connect(g).connect(audioCtx.destination);
      o.start(t0 + i * 0.09);
      o.stop(t0 + i * 0.09 + 0.13);
    });
  } catch {}
}

export const storage = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

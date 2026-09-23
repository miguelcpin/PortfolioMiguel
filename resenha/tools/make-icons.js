// Gera todos os ícones do Resenha (desktop, PWA e Android) sem dependências.
// Uso: node tools/make-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const BRAND = [88, 101, 242];
const WHITE = [255, 255, 255];
const DARK = [49, 51, 56];

// Formas desenhadas num quadro de 512x512 e depois escaladas
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
function inTri(x, y, [ax, ay], [bx, by], [cx, cy]) {
  const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
  const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
  const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

// Balão sorridente. Retorna cor ou null (transparente) para o ponto (x,y) em 0..512
function glyph(x, y, fg, hole) {
  const bubble = inRoundRect(x, y, 104, 96, 408, 344, 64) || inTri(x, y, [176, 330], [260, 330], [170, 420]);
  if (!bubble) return null;
  if (inCircle(x, y, 196, 204, 26) || inCircle(x, y, 316, 204, 26)) return hole;
  const d = Math.hypot(x - 256, y - 240);
  if (y > 250 && d > 58 && d < 84) return hole;
  return fg;
}

/**
 * variant:
 *  rounded   – quadrado arredondado roxo (desktop, PWA "any")
 *  square    – roxo sangrando até a borda (maskable, iOS, Android legado)
 *  circle    – círculo roxo (Android ic_launcher_round)
 *  foreground– só o balão, transparente, reduzido para a zona segura (Android adaptativo)
 *  splash    – fundo escuro com o ícone arredondado no centro
 */
function render(w, h, variant) {
  const SS = 3;
  const px = Buffer.alloc(w * h * 4);
  const side = Math.min(w, h);
  for (let py = 0; py < h; py++) {
    for (let pxl = 0; pxl < w; pxl++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = pxl + (sx + 0.5) / SS;
          const fy = py + (sy + 0.5) / SS;
          const c = sample(fx, fy);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
        }
      }
      const i = (py * w + pxl) * 4;
      px[i] = a ? r / a : 0; px[i + 1] = a ? g / a : 0; px[i + 2] = a ? b / a : 0;
      px[i + 3] = (a / (SS * SS)) * 255;
    }
  }
  return px;

  function sample(fx, fy) {
    if (variant === 'splash') {
      const size = side * 0.28;
      const ox = (w - size) / 2, oy = (h - size) / 2;
      const x = ((fx - ox) / size) * 512, y = ((fy - oy) / size) * 512;
      if (x < 0 || y < 0 || x > 512 || y > 512 || !inRoundRect(x, y, 0, 0, 512, 512, 112)) return DARK;
      return glyph(x, y, WHITE, BRAND) || BRAND;
    }
    const x = (fx / w) * 512, y = (fy / h) * 512;
    if (variant === 'foreground') {
      // 108dp com zona segura de 66dp: encolhe o desenho para ~61%
      const k = 0.61, gx = 256 + (x - 256) / k, gy = 256 + (y - 256) / k;
      return glyph(gx, gy, WHITE, null);
    }
    if (variant === 'rounded' && !inRoundRect(x, y, 0, 0, 512, 512, 112)) return null;
    if (variant === 'circle' && !inCircle(x, y, 256, 256, 256)) return null;
    return glyph(x, y, WHITE, BRAND) || BRAND;
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function png(w, h, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function write(rel, w, h, variant) {
  const file = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png(w, h, render(w, h, variant)));
  console.log('  ' + rel);
}
function pngSize(file) {
  const b = fs.readFileSync(file);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

console.log('Gerando ícones:');
write('desktop/build/icon.png', 512, 512, 'rounded');
write('web/icons/icon-192.png', 192, 192, 'rounded');
write('web/icons/icon-512.png', 512, 512, 'rounded');
write('web/icons/maskable-512.png', 512, 512, 'square');
write('web/icons/apple-touch-icon.png', 180, 180, 'square');

// Android (se o projeto nativo já foi criado com "npx cap add android")
const res = path.join(ROOT, 'mobile/android/app/src/main/res');
if (fs.existsSync(res)) {
  const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [d, k] of Object.entries(dens)) {
    const n = Math.round(48 * k);
    const f = Math.round(108 * k);
    write(`mobile/android/app/src/main/res/mipmap-${d}/ic_launcher.png`, n, n, 'square');
    write(`mobile/android/app/src/main/res/mipmap-${d}/ic_launcher_round.png`, n, n, 'circle');
    write(`mobile/android/app/src/main/res/mipmap-${d}/ic_launcher_foreground.png`, f, f, 'foreground');
  }
  // Troca a splash padrão do Capacitor pela nossa, mantendo os tamanhos
  for (const dir of fs.readdirSync(res).filter((x) => x.startsWith('drawable'))) {
    const f = path.join(res, dir, 'splash.png');
    if (fs.existsSync(f)) {
      const [w, h] = pngSize(f);
      write(path.relative(ROOT, f), w, h, 'splash');
    }
  }
}

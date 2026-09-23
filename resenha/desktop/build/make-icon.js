// Gera build/icon.png (512x512) sem dependências: balão de fala sorridente no roxo do app.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const N = 512;
const SS = 4; // supersampling
const px = Buffer.alloc(N * N * 4);

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
function inTri(x, y, [ax, ay], [bx, by], [cx, cy]) {
  const s = (ax - cx) * (y - cy) - (ay - cy) * (x - cx);
  const t = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
  if ((s < 0) !== (t < 0) && s !== 0 && t !== 0) return false;
  const d = (cx - bx) * (y - by) - (cy - by) * (x - bx);
  return d === 0 || (d < 0) === (s + t <= 0);
}

function color(x, y) {
  if (!inRoundRect(x, y, 0, 0, N, N, 112)) return null;
  const brand = [88, 101, 242];
  const white = [255, 255, 255];
  const bubble = inRoundRect(x, y, 104, 96, 408, 344, 64) || inTri(x, y, [176, 330], [260, 330], [170, 420]);
  if (!bubble) return brand;
  if (inCircle(x, y, 196, 204, 26) || inCircle(x, y, 316, 204, 26)) return brand;
  // sorriso: anel inferior
  const d = Math.hypot(x - 256, y - 240);
  if (y > 250 && d > 58 && d < 84) return brand;
  return white;
}

for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = color(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
      }
    }
    const i = (y * N + x) * 4;
    const n = SS * SS;
    px[i] = a ? r / a : 0; px[i + 1] = a ? g / a : 0; px[i + 2] = a ? b / a : 0; px[i + 3] = (a / n) * 255;
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
fs.writeFileSync(path.join(__dirname, 'icon.png'), png);
console.log('build/icon.png gerado');

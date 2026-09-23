// Copia a interface (../web) para www/, que é embutida no APK.
// O service worker e o manifest não servem dentro do app nativo.
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', '..', 'web');
const dest = path.join(__dirname, '..', 'www');
const skip = new Set(['sw.js', 'manifest.webmanifest']);

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true, filter: (f) => !skip.has(path.basename(f)) });
console.log(`web/ copiado para ${path.relative(process.cwd(), dest) || 'www'}`);

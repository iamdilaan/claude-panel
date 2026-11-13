// Genera los iconos sin dependencias: rasteriza formas con supermuestreo 4×4
// y escribe PNG RGBA con zlib. Reproducible: `node scripts/make-icons.mjs`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const OUT = join(import.meta.dirname, '..', 'src-tauri', 'icons');
mkdirSync(OUT, { recursive: true });

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (const b of buf) {
    c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Distancias con signo (unidades: fracción del lado) — negativo = dentro
const rrect = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - hw + r, qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const circle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;

/** shade(x,y) → [r,g,b,a] o null, en coordenadas 0..1 */
function raster(size, shade) {
  const buf = Buffer.alloc(size * size * 4);
  const S = 4;
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const c = shade((px + (sx + 0.5) / S) / size, (py + (sy + 0.5) / S) / size);
      if (c) { const al = c[3] / 255; r += c[0] * al; g += c[1] * al; b += c[2] * al; a += al; }
    }
    const i = (py * size + px) * 4, n = S * S;
    if (a > 0) { buf[i] = r / a; buf[i + 1] = g / a; buf[i + 2] = b / a; }
    buf[i + 3] = Math.round((a / n) * 255);
  }
  return buf;
}

// Glifo: una ventana-panel con dos renglones (sesiones) — trazo, no relleno.
function glyph(x, y, { stroke, inset = 0 }) {
  const s = 1 - 2 * inset, X = (x - inset) / s, Y = (y - inset) / s;
  const frame = Math.abs(rrect(X, Y, 0.5, 0.5, 0.40, 0.34, 0.09)) - stroke / 2;
  const line1 = rrect(X, Y, 0.43, 0.42, 0.21, stroke / 2, stroke / 2);
  const line2 = rrect(X, Y, 0.38, 0.59, 0.16, stroke / 2, stroke / 2);
  return Math.min(frame, line1, line2);
}

function tray(size, badge) {
  return raster(size, (x, y) => {
    let d = glyph(x, y, { stroke: 0.085, inset: 0.04 });
    if (badge) {
      const ring = circle(x, y, 0.80, 0.22, 0.20); // hueco alrededor del punto
      if (ring < 0) d = Math.max(d, 1);
      if (circle(x, y, 0.80, 0.22, 0.13) < 0) d = -1;
    }
    return d < 0 ? [0, 0, 0, 255] : null;
  });
}

for (const [name, size, badge] of [['tray', 18, false], ['tray@2x', 36, false], ['tray-active', 18, true], ['tray-active@2x', 36, true]]) {
  writeFileSync(join(OUT, `${name}.png`), png(size, size, tray(size, badge)));
}

// Icono de la app: cuadrado redondeado grafito con el glifo en blanco roto.
const app = raster(1024, (x, y) => {
  if (rrect(x, y, 0.5, 0.5, 0.41, 0.41, 0.19) > 0) return null;
  const g = glyph(x, y, { stroke: 0.05, inset: 0.24 });
  if (g < 0) return [236, 234, 228, 255];
  const t = y; // leve degradado vertical del propio material, no decorativo
  return [Math.round(52 - 10 * t), Math.round(53 - 10 * t), Math.round(56 - 10 * t), 255];
});
writeFileSync(join(OUT, 'app-1024.png'), png(1024, 1024, app));
console.log('iconos en', OUT);

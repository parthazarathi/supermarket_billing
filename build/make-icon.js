// Generates build/icon.png (512x512) and build/icon.ico for MartPOS.
// Pure Node - no image dependencies. Run: node build/make-icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 512;
const px = Buffer.alloc(S * S * 4, 0); // RGBA, transparent

function setPx(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}

// Green rounded-square background
const R = 110, CX = S / 2, CY = S / 2, HALF = S / 2;
const BG = [22, 163, 74]; // tailwind green-600
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const dx = Math.max(Math.abs(x - CX) - (HALF - R), 0);
    const dy = Math.max(Math.abs(y - CY) - (HALF - R), 0);
    if (dx * dx + dy * dy <= R * R) setPx(x, y, BG[0], BG[1], BG[2], 255);
  }
}

function fillRect(x0, y0, x1, y1, [r, g, b]) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) setPx(x, y, r, g, b, 255);
}
function fillCircle(cx, cy, rad, [r, g, b]) {
  for (let y = cy - rad; y <= cy + rad; y++)
    for (let x = cx - rad; x <= cx + rad; x++)
      if ((x - cx) ** 2 + (y - cy) ** 2 <= rad * rad) setPx(x, y, r, g, b, 255);
}
function fillTri(x0, y0, x1, y0_1, xt, yt, c) {
  for (let y = y0; y < yt; y++) {
    const t = (y - y0) / (yt - y0);
    const l = x0 + (xt - x0) * t, rr = x1 + (xt - x1) * t;
    fillRect(Math.round(Math.min(l, rr)), y, Math.round(Math.max(l, rr)) + 1, y + 1, c);
  }
}

const WHITE = [255, 255, 255];
const DARK = [21, 128, 61]; // green-700 lines inside basket

// Shopping cart (flat style)
// basket body: trapezoid slightly narrower at bottom
fillTri(140, 170, 400, 170, 350, 340, WHITE);          // left half slant
fillTri(140, 170, 400, 170, 190, 340, WHITE);          // mirrored right half
fillRect(140, 170, 401, 200, WHITE);                   // basket top band
// basket interior grid (cut lines)
for (const yy of [228, 268, 308]) fillRect(150, yy, 390, yy + 8, DARK);
for (const xx of [210, 270, 330]) fillRect(xx, 200, xx + 8, 330, DARK);
// handle
fillRect(96, 118, 170, 134, WHITE);
fillTri(150, 130, 165, 130, 175, 170, WHITE);
// wheels
fillCircle(210, 390, 34, WHITE);
fillCircle(345, 390, 34, WHITE);
fillCircle(210, 390, 14, DARK);
fillCircle(345, 390, 14, DARK);

// ---- PNG encode ----
function crc32(buf) {
  let c, table = crc32.t;
  if (!table) {
    table = crc32.t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  c = -1;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);

const dir = __dirname;
fs.writeFileSync(path.join(dir, 'icon.png'), png);

// ---- ICO (PNG-in-ICO, valid for Vista+ and electron-builder) ----
const ico = Buffer.alloc(6 + 16);
ico.writeUInt16LE(0, 0); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4);
ico[6] = 0; ico[7] = 0; // 256x256 stored as 0 (png is 512, entry capped at 256)
ico[8] = 0; ico[9] = 0;
ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
fs.writeFileSync(path.join(dir, 'icon.ico'), Buffer.concat([ico, png]));

console.log('Wrote build/icon.png (' + png.length + ' bytes) and build/icon.ico');

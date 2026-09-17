// Generates build/icon.png (512x512) and build/icon.ico for MartPOS.
// Pure Node - no image dependencies. Run: node build/make-icon.js
// Exports renderIcon()/encodePng() for build/make-appx-assets.js - requiring
// this module has no side effects; files are written only when run directly.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Renders the MartPOS cart icon at `size` x `size` into an RGBA buffer.
// All drawing coordinates are authored in 512px space and scaled by size/512.
function renderIcon(size) {
  const S = size;
  const k = S / 512;
  const px = Buffer.alloc(S * S * 4, 0); // RGBA, transparent

  function setPx(x, y, r, g, b, a) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  }

  // Green rounded-square background
  const R = 110 * k, CX = S / 2, CY = S / 2, HALF = S / 2;
  const BG = [22, 163, 74]; // tailwind green-600
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = Math.max(Math.abs(x - CX) - (HALF - R), 0);
      const dy = Math.max(Math.abs(y - CY) - (HALF - R), 0);
      if (dx * dx + dy * dy <= R * R) setPx(x, y, BG[0], BG[1], BG[2], 255);
    }
  }

  function fillRect(x0, y0, x1, y1, [r, g, b]) {
    for (let y = Math.round(y0); y < Math.round(y1); y++) for (let x = Math.round(x0); x < Math.round(x1); x++) setPx(x, y, r, g, b, 255);
  }
  function fillCircle(cx, cy, rad, [r, g, b]) {
    for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++)
      for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++)
        if ((x - cx) ** 2 + (y - cy) ** 2 <= rad * rad) setPx(x, y, r, g, b, 255);
  }
  function fillTri(x0, y0, x1, y0_1, xt, yt, c) {
    for (let y = Math.round(y0); y < Math.round(yt); y++) {
      const t = (y - y0) / (yt - y0);
      const l = x0 + (xt - x0) * t, rr = x1 + (xt - x1) * t;
      fillRect(Math.min(l, rr), y, Math.max(l, rr) + 1, y + 1, c);
    }
  }

  const WHITE = [255, 255, 255];
  const DARK = [21, 128, 61]; // green-700 lines inside basket

  // Shopping cart (flat style) - coordinates are in 512px space, scaled by k
  const P = (v) => v * k;
  fillTri(P(140), P(170), P(400), P(170), P(350), P(340), WHITE); // left half slant
  fillTri(P(140), P(170), P(400), P(170), P(190), P(340), WHITE); // mirrored right half
  fillRect(P(140), P(170), P(401), P(200), WHITE);                // basket top band
  // basket interior grid (cut lines)
  for (const yy of [228, 268, 308]) fillRect(P(150), P(yy), P(390), P(yy + 8), DARK);
  for (const xx of [210, 270, 330]) fillRect(P(xx), P(200), P(xx + 8), P(330), DARK);
  // handle
  fillRect(P(96), P(118), P(170), P(134), WHITE);
  fillTri(P(150), P(130), P(165), P(130), P(175), P(170), WHITE);
  // wheels
  fillCircle(P(210), P(390), P(34), WHITE);
  fillCircle(P(345), P(390), P(34), WHITE);
  fillCircle(P(210), P(390), P(14), DARK);
  fillCircle(P(345), P(390), P(14), DARK);

  return px;
}

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
// rgba: width*height*4 buffer. Returns a PNG file buffer.
function encodePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function writeIconFiles(dir) {
  const S = 512;
  const png = encodePng(renderIcon(S), S, S);
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
}

if (require.main === module) {
  writeIconFiles(__dirname);
}

module.exports = { renderIcon, encodePng, writeIconFiles };

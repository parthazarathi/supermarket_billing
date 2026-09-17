// Generates the MSIX/AppX visual assets in build/appx/ from the MartPOS
// icon (same renderer as build/make-icon.js - no image dependencies).
// Run: node build/make-appx-assets.js   (or npm run build:appx-assets)
//
// electron-builder picks up every file in build/appx/ and maps it into the
// package's assets\ folder. Without these files it would inject its own
// sample tiles, so the real branding is generated here instead.
const fs = require('fs');
const path = require('path');
const { renderIcon, encodePng } = require('./make-icon');

const OUT_DIR = path.join(__dirname, 'appx');
const BRAND = [22, 163, 74]; // tailwind green-600, matches icon + tile background

// Square tile: the icon already carries its own rounded brand background.
function squareIcon(size) {
  return encodePng(renderIcon(size), size, size);
}

// Non-square canvas (wide tile, splash screen): solid brand background with
// the icon alpha-blended and centered - the icon's own green blends in and
// only the cart glyph shows.
function iconOnBrand(width, height, iconSize) {
  const canvas = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    canvas[i * 4] = BRAND[0];
    canvas[i * 4 + 1] = BRAND[1];
    canvas[i * 4 + 2] = BRAND[2];
    canvas[i * 4 + 3] = 255;
  }
  const icon = renderIcon(iconSize);
  const offX = Math.round((width - iconSize) / 2);
  const offY = Math.round((height - iconSize) / 2);
  for (let y = 0; y < iconSize; y++) {
    for (let x = 0; x < iconSize; x++) {
      const si = (y * iconSize + x) * 4;
      const a = icon[si + 3];
      if (!a) continue;
      const dx = offX + x, dy = offY + y;
      if (dx < 0 || dy < 0 || dx >= width || dy >= height) continue;
      const di = (dy * width + dx) * 4;
      for (let c = 0; c < 3; c++) {
        canvas[di + c] = Math.round((icon[si + c] * a + canvas[di + c] * (255 - a)) / 255);
      }
      canvas[di + 3] = 255;
    }
  }
  return encodePng(canvas, width, height);
}

// Names/sizes follow the AppxManifest visual-asset slots electron-builder
// fills: assets\<name> is referenced directly from the generated manifest.
const assets = {
  'StoreLogo.png': () => squareIcon(50),
  'Square44x44Logo.png': () => squareIcon(44),
  'Square150x150Logo.png': () => squareIcon(150),
  'Square71x71Logo.png': () => squareIcon(71),
  'Square310x310Logo.png': () => squareIcon(310),
  'SmallTile.png': () => squareIcon(71),
  'LargeTile.png': () => squareIcon(310),
  'Wide310x150Logo.png': () => iconOnBrand(310, 150, 120),
  'SplashScreen.png': () => iconOnBrand(620, 300, 240)
};

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [name, make] of Object.entries(assets)) {
  const png = make();
  fs.writeFileSync(path.join(OUT_DIR, name), png);
  console.log(`Wrote build/appx/${name} (${png.length} bytes)`);
}

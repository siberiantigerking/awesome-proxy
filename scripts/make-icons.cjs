/**
 * Generate app icons from logo.jpg:
 *   resources/icon.png  (512x512, used by Electron window & tray)
 *   resources/icon.ico  (multi-size, used by the Windows NSIS installer)
 *   public/logo.png      (used by the web UI / title bar)
 *
 * Run: node scripts/make-icons.cjs
 */
const path = require('path');
const fs = require('fs');

(async () => {
  const root = path.join(__dirname, '..');
  const src = path.join(root, 'logo.jpg');
  if (!fs.existsSync(src)) {
    console.error('logo.jpg not found at', src);
    process.exit(1);
  }

  const { Jimp } = require('jimp');
  const pngToIco = require('png-to-ico');

  const image = await Jimp.read(src);

  // Square-crop to the smaller dimension, centered.
  const side = Math.min(image.bitmap.width, image.bitmap.height);
  image.crop({
    x: Math.floor((image.bitmap.width - side) / 2),
    y: Math.floor((image.bitmap.height - side) / 2),
    w: side,
    h: side,
  });

  const resourcesDir = path.join(root, 'resources');
  const publicDir = path.join(root, 'public');
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.mkdirSync(publicDir, { recursive: true });

  // 512px master PNG.
  const png512 = image.clone().resize({ w: 512, h: 512 });
  const iconPngPath = path.join(resourcesDir, 'icon.png');
  await png512.write(iconPngPath);
  await png512.clone().write(path.join(publicDir, 'logo.png'));
  console.log('wrote', iconPngPath);

  // Tint the tray icon by blending each pixel toward a target color. We edit
  // the raw RGBA buffer directly (works across Jimp versions).
  function tint(rgb, strength = 0.55) {
    const clone = image.clone().resize({ w: 256, h: 256 });
    const data = clone.bitmap.data; // RGBA Buffer
    for (let i = 0; i < data.length; i += 4) {
      data[i] = Math.round(data[i] * (1 - strength) + rgb[0] * strength);
      data[i + 1] = Math.round(data[i + 1] * (1 - strength) + rgb[1] * strength);
      data[i + 2] = Math.round(data[i + 2] * (1 - strength) + rgb[2] * strength);
    }
    return clone;
  }

  // Legacy "connected" icon (red) — kept for backwards compatibility, same as
  // the TUN-mode tint below.
  const active = tint([237, 28, 36]);
  const activePngPath = path.join(resourcesDir, 'icon-active.png');
  await active.write(activePngPath);
  console.log('wrote', activePngPath);

  // Per-proxy-mode tray icon tints, so the taskbar tray icon color indicates
  // which mode is currently connected at a glance:
  //   system -> blue   (app's own primary/brand color)
  //   tun    -> red    (full-tunnel, most impactful mode)
  //   split  -> green  (per-app routing)
  //   manual -> yellow (local-only, no system changes)
  const MODE_TINTS = {
    system: [59, 130, 246],  // tailwind primary-500 (blue)
    tun: [237, 28, 36],      // red
    split: [34, 197, 94],    // tailwind green-500
    manual: [234, 179, 8],   // tailwind yellow-500
  };
  for (const [mode, rgb] of Object.entries(MODE_TINTS)) {
    const tinted = tint(rgb);
    const outPath = path.join(resourcesDir, `icon-${mode}.png`);
    await tinted.write(outPath);
    console.log('wrote', outPath);
  }

  // ICO from a set of standard sizes.
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const buffers = [];
  for (const s of sizes) {
    const buf = await image.clone().resize({ w: s, h: s }).getBuffer('image/png');
    buffers.push(buf);
  }
  const icoBuf = await pngToIco(buffers);
  const icoPath = path.join(resourcesDir, 'icon.ico');
  fs.writeFileSync(icoPath, icoBuf);
  console.log('wrote', icoPath);

  console.log('Icons generated successfully.');
})().catch((err) => {
  console.error('Icon generation failed:', err);
  process.exit(1);
});

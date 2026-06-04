// scripts/generate-favicons.mjs
// ----------------------------------------------------------------------------
// Generate favicon-32.png and apple-touch-icon.png (180x180) from the same
// design as public/favicon.svg, using pure Node -- no extra dependencies.
//
// Why a custom rasterizer instead of `sharp` / `resvg`?
//   The favicon is fixed (4 rounded-rect bars on a solid bg). Adding a
//   native-binary or wasm SVG renderer just to flatten 5 shapes felt
//   wasteful, and Node 24 ships with everything we need: `zlib.crc32`
//   (Node >=22.5) for PNG chunk CRCs, and `zlib.deflateSync` for IDAT
//   compression.
//
// Anti-aliasing: 4x4 box-filter supersampling. For each output pixel we
// sample 16 subpixels in the design space and average. At 32x32 the bars
// land on ~4px wide stripes with smooth rounded caps; at 180x180 the
// detail is full-resolution.
//
// Run with:   node scripts/generate-favicons.mjs
// ----------------------------------------------------------------------------

import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, '..', 'public');

// --- Design (matches favicon.svg's viewBox=0..64) --------------------------

const BG = [0x2c, 0x29, 0x25]; // charcoal
const BAR_COLORS = [
  [0x6b, 0x8c, 0xae], // dusty blue
  [0xc8, 0x7a, 0x5b], // terracotta
  [0x8a, 0x9b, 0x6e], // sage
  [0xcf, 0xa2, 0x4a], // ochre
];

const DESIGN = 64;
const BAR_W = 8;
const BAR_Y = 14.5;
const BAR_H = 35;
const RADIUS = BAR_W / 2;
const BAR_XS = [10, 22, 34, 46];

/**
 * Sample the design at design-space coords (x, y in 0..64) and return the
 * solid color at that point. No anti-aliasing here -- caller supersamples.
 */
function colorAt(x, y) {
  for (let i = 0; i < 4; i++) {
    const x0 = BAR_XS[i];
    const x1 = x0 + BAR_W;
    const y0 = BAR_Y;
    const y1 = BAR_Y + BAR_H;
    if (x < x0 || x > x1 || y < y0 || y > y1) continue;

    // Bounding box hit. Check rounded ends.
    const midX = x0 + BAR_W / 2;
    if (y < y0 + RADIUS) {
      const dx = x - midX;
      const dy = y - (y0 + RADIUS);
      if (dx * dx + dy * dy > RADIUS * RADIUS) continue;
    } else if (y > y1 - RADIUS) {
      const dx = x - midX;
      const dy = y - (y1 - RADIUS);
      if (dx * dx + dy * dy > RADIUS * RADIUS) continue;
    }
    return BAR_COLORS[i];
  }
  return BG;
}

/**
 * Render to an RGB pixel buffer at `size` x `size` with `aa` x `aa`
 * subpixel supersampling (default 4).
 */
function renderRGB(size, aa = 4) {
  const pixels = Buffer.alloc(size * size * 3);
  const designPerPixel = DESIGN / size;
  const designPerSub = designPerPixel / aa;

  for (let py = 0; py < size; py++) {
    const rowStart = py * size * 3;
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      const dxBase = px * designPerPixel;
      const dyBase = py * designPerPixel;
      for (let sy = 0; sy < aa; sy++) {
        const dy = dyBase + (sy + 0.5) * designPerSub;
        for (let sx = 0; sx < aa; sx++) {
          const dx = dxBase + (sx + 0.5) * designPerSub;
          const c = colorAt(dx, dy);
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const n = aa * aa;
      const i = rowStart + px * 3;
      pixels[i] = Math.round(r / n);
      pixels[i + 1] = Math.round(g / n);
      pixels[i + 2] = Math.round(b / n);
    }
  }
  return pixels;
}

// --- PNG encoder (RGB, 8-bit, no interlace) -------------------------------

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  // zlib.crc32 in Node 22+ returns an unsigned 32-bit number -- we mask
  // anyway in case any future variation returns a signed int.
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(pixels, size) {
  // Build the raw scanlines (filter byte 0 = None per row, then RGB triplets).
  const stride = size * 3;
  const raw = Buffer.alloc(size * (1 + stride));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + stride)] = 0;
    pixels.copy(raw, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
  }
  const idatData = deflateSync(raw);

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: 2 = RGB
  ihdr[10] = 0; // compression: 0 = deflate
  ihdr[11] = 0; // filter: 0 = adaptive
  ihdr[12] = 0; // interlace: 0 = none

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Run ------------------------------------------------------------------

mkdirSync(PUBLIC_DIR, { recursive: true });

for (const [name, size] of [
  ['favicon-32.png', 32],
  ['apple-touch-icon.png', 180],
]) {
  const out = resolve(PUBLIC_DIR, name);
  const png = encodePNG(renderRGB(size), size);
  writeFileSync(out, png);
  console.log(`[favicons] wrote ${out}  (${size}x${size}, ${png.length} bytes)`);
}

"use strict";

/* FLIGHTPATH — icon generator.  node scripts/make-icons.js

   Structure copied from bullpen/scripts/make-icons.js (the pwa-shell recipe
   points at it): real PNGs encoded with node's own zlib, no dependencies, so
   the icon set is reproducible from source rather than a checked-in binary
   nobody can regenerate. Only the drawing section is Flightpath's.

   The mark is the game's tile motif, drawn once and never as four shapes: a
   matte instrument-panel tile carrying three smoke streamlines and one amber
   signal-lamp arrowhead, pointing east. Same vocabulary as js/art.js.
   Everything is rendered 3x and box-downsampled — the whole anti-aliasing
   strategy, and plenty at icon sizes. */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// ------------------------------------------------------------- PNG encoding
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// -------------------------------------------------------------- tiny raster
function hex(h) {
  return [parseInt(h.substr(1, 2), 16), parseInt(h.substr(3, 2), 16), parseInt(h.substr(5, 2), 16)];
}
function surface(w, h) {
  const buf = Buffer.alloc(w * h * 4);
  const S = {
    w, h, buf,
    set(x, y, c) {
      x = Math.round(x); y = Math.round(y);
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = (y * w + x) * 4;
      buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = 255;
    },
    fill(c) { for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) S.set(x, y, c); },
    roundRect(x0, y0, x1, y1, r, c) {
      for (let y = Math.round(y0); y < Math.round(y1); y++) {
        for (let x = Math.round(x0); x < Math.round(x1); x++) {
          const dx = Math.max(x0 + r - x, 0, x - (x1 - r - 1));
          const dy = Math.max(y0 + r - y, 0, y - (y1 - r - 1));
          if (dx * dx + dy * dy <= r * r) S.set(x, y, c);
        }
      }
    },
    disk(cx, cy, r, c) {
      for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
        for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
          const dx = x - cx, dy = y - cy;
          if (dx * dx + dy * dy <= r * r) S.set(x, y, c);
        }
      }
    },
    /* A stroked segment: stamp a disk along the path. Crude and completely
       adequate once the whole thing is downsampled 3x. */
    seg(x0, y0, x1, y1, width, c) {
      const steps = Math.max(8, Math.round(Math.hypot(x1 - x0, y1 - y0)));
      for (let i = 0; i <= steps; i++) {
        S.disk(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, width / 2, c);
      }
    },
  };
  return S;
}

/* The signed-off palette. */
const GROUND = hex("#1a1e21");   // chamber dark
const TILE   = hex("#2e353a");   // tile face
const EDGE   = hex("#4a5257");   // tile edge, a lighter matte
const SMOKE  = hex("#c3ccc8");   // the streamline motif
const LAMP   = hex("#c2853c");   // signal lamp — the arrowhead

function drawIcon(size, opts) {
  const o = opts || {};
  const SS = 3;
  const S = size * SS;
  const s = surface(S, S);

  s.fill(GROUND);

  /* The tile. `bleed` shrinks the mark into the maskable safe zone; iOS masks
     apple-touch-icon itself, so that one bleeds too. */
  const scale = o.bleed ? 0.62 : 0.80;
  const box = S * scale;
  const x0 = (S - box) / 2, y0 = (S - box) / 2;
  const r = box * 0.19;
  s.roundRect(x0, y0, x0 + box, y0 + box, r, EDGE);
  const inset = Math.max(1, box * 0.035);
  s.roundRect(x0 + inset, y0 + inset, x0 + box - inset, y0 + box - inset, r * 0.86, TILE);

  /* The motif, in the tile's own unit box: three streamlines and one head,
     pointing east. Identical geometry to js/art.js. */
  const u = (v) => x0 + v * box;
  const w = (v) => v * box;
  const rule = Math.max(2, w(0.052));

  s.seg(u(0.145), u(0.5), u(0.565), u(0.5), rule, SMOKE);
  s.seg(u(0.25), u(0.365), u(0.5), u(0.365), rule * 0.66, SMOKE);
  s.seg(u(0.25), u(0.635), u(0.5), u(0.635), rule * 0.66, SMOKE);

  const hx = u(0.605), hy = u(0.5), hw = w(0.20), hh = w(0.175);
  s.seg(hx, hy - hh, hx + hw, hy, rule * 1.5, LAMP);
  s.seg(hx + hw, hy, hx, hy + hh, rule * 1.5, LAMP);

  // box downsample SS x SS -> 1
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let a = 0, b = 0, c = 0, d = 0;
      for (let j = 0; j < SS; j++) {
        for (let i = 0; i < SS; i++) {
          const k = ((y * SS + j) * S + (x * SS + i)) * 4;
          a += s.buf[k]; b += s.buf[k + 1]; c += s.buf[k + 2]; d += s.buf[k + 3];
        }
      }
      const n = SS * SS, k = (y * size + x) * 4;
      out[k] = Math.round(a / n); out[k + 1] = Math.round(b / n);
      out[k + 2] = Math.round(c / n); out[k + 3] = Math.round(d / n);
    }
  }
  return encodePNG(size, size, out);
}

const dir = path.join(__dirname, "..", "icons");
fs.mkdirSync(dir, { recursive: true });

[
  ["icon-192.png", 192, {}],
  ["icon-512.png", 512, {}],
  ["icon-512-maskable.png", 512, { bleed: true }],
  ["apple-touch-icon.png", 180, { bleed: true }],
  ["favicon-32.png", 32, {}],
].forEach(([name, size, opts]) => {
  const png = drawIcon(size, opts);
  fs.writeFileSync(path.join(dir, name), png);
  console.log("wrote icons/" + name + "  " + size + "x" + size + "  " + png.length + " bytes");
});

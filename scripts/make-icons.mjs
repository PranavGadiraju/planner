#!/usr/bin/env node
// Generates the PWA icons with no dependencies: a dark rounded square (#0f1115) with a green (#22c55e) arc glyph.
// Usage: node scripts/make-icons.mjs   -> public/icons/icon-180.png, icon-192.png, icon-512.png, icon-512-maskable.png
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')
const BG = [0x0f, 0x11, 0x15]
const FG = [0x22, 0xc5, 0x5e]
const SS = 4 // supersampling per axis

// ---- PNG encoder --------------------------------------------------------------------------------
const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c >>> 0
}
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---- Geometry -----------------------------------------------------------------------------------
/** 1 when (x, y) is inside a rounded square of side `size` with corner radius `r`, else 0. */
function inRoundedSquare(x, y, size, r) {
  const cx = Math.min(Math.max(x, r), size - r)
  const cy = Math.min(Math.max(y, r), size - r)
  const dx = x - cx, dy = y - cy
  return dx * dx + dy * dy <= r * r ? 1 : 0
}
/** Arc glyph: a ring of radius R, stroke W, drawn from angle a0 clockwise through `sweep` degrees, round caps, plus a centre dot. */
function inGlyph(x, y, cx, cy, R, W, a0, sweep, dot) {
  const dx = x - cx, dy = y - cy
  const d = Math.hypot(dx, dy)
  if (dot > 0 && d <= dot) return 1
  const half = W / 2
  if (Math.abs(d - R) <= half) {
    let ang = (Math.atan2(dy, dx) * 180) / Math.PI // -180..180, 0 = +x, clockwise positive (y down)
    let rel = ((ang - a0) % 360 + 360) % 360
    if (rel <= sweep) return 1
  }
  // round caps
  for (const a of [a0, a0 + sweep]) {
    const rad = (a * Math.PI) / 180
    const px = cx + R * Math.cos(rad), py = cy + R * Math.sin(rad)
    if (Math.hypot(x - px, y - py) <= half) return 1
  }
  return 0
}

function render(size, { maskable }) {
  const rgba = Buffer.alloc(size * size * 4)
  const corner = maskable ? 0 : size * 0.22
  // Maskable icons keep everything inside the central 80% safe zone.
  const scale = maskable ? 0.72 : 0.9
  const cx = size / 2, cy = size / 2
  const R = (size / 2) * 0.58 * scale
  const W = size * 0.115 * scale
  const dot = size * 0.075 * scale
  const inv = 1 / (SS * SS)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0, fg = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS
          const inside = maskable ? 1 : inRoundedSquare(px, py, size, corner)
          if (!inside) continue
          bg++
          fg += inGlyph(px, py, cx, cy, R, W, -90 - 20, 300 - 40, dot)
        }
      }
      const a = bg * inv, f = fg * inv
      const i = (y * size + x) * 4
      // composite: glyph over background, both premultiplied by coverage
      const r = BG[0] * (1 - f) + FG[0] * f
      const g = BG[1] * (1 - f) + FG[1] * f
      const b = BG[2] * (1 - f) + FG[2] * f
      rgba[i] = Math.round(r)
      rgba[i + 1] = Math.round(g)
      rgba[i + 2] = Math.round(b)
      rgba[i + 3] = Math.round(a * 255)
    }
  }
  return encodePNG(size, size, rgba)
}

mkdirSync(OUT, { recursive: true })
const jobs = [
  ['icon-180.png', 180, { maskable: true }], // apple-touch-icon: opaque, iOS applies its own mask
  ['icon-192.png', 192, { maskable: false }],
  ['icon-512.png', 512, { maskable: false }],
  ['icon-512-maskable.png', 512, { maskable: true }],
]
for (const [name, size, opts] of jobs) {
  const png = render(size, opts)
  writeFileSync(join(OUT, name), png)
  console.log(`wrote ${join('public/icons', name)} (${png.length} bytes)`)
}

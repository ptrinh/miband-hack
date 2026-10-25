// Lossless PNG re-compression for the preview screenshots (no dependencies, node:zlib only).
// Chrome writes PNGs quickly rather than small. This decodes an 8-bit, non-interlaced RGB/RGBA PNG and
// re-encodes it as a palette image when it has at most 256 colours, otherwise as RGB/RGBA with a
// per-row filter choice, at zlib level 9. Pixels are unchanged.
import { deflateSync, inflateSync } from 'node:zlib';

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Returns { width, height, rgba } for an 8-bit RGB/RGBA non-interlaced PNG. */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  let off = 8, width = 0, height = 0, type = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const kind = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      type = data[9];
      if (data[8] !== 8 || (type !== 2 && type !== 6) || data[12] !== 0) throw new Error('unsupported PNG layout');
    } else if (kind === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const bpp = type === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? px[dst + i - bpp] : 0;
      const b = y > 0 ? px[dst - stride + i] : 0;
      const c = i >= bpp && y > 0 ? px[dst - stride + i - bpp] : 0;
      const x = raw[src + i];
      px[dst + i] = (f === 0 ? x : f === 1 ? x + a : f === 2 ? x + b : f === 3 ? x + ((a + b) >> 1) : x + paeth(a, b, c)) & 0xff;
    }
  }
  if (bpp === 4) return { width, height, rgba: px };
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < px.length; i += 3, j += 4) {
    rgba[j] = px[i];
    rgba[j + 1] = px[i + 1];
    rgba[j + 2] = px[i + 2];
    rgba[j + 3] = 255;
  }
  return { width, height, rgba };
}

function filterRows(px, stride, height, bpp, adaptive) {
  const out = Buffer.alloc((stride + 1) * height);
  const line = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    let best = 0, bestSum = Infinity, bestLine = null;
    for (const f of adaptive ? [0, 1, 2, 3, 4] : [0]) {
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const x = px[row + i];
        const a = i >= bpp ? px[row + i - bpp] : 0;
        const b = y > 0 ? px[row - stride + i] : 0;
        const c = i >= bpp && y > 0 ? px[row - stride + i - bpp] : 0;
        const v = (f === 0 ? x : f === 1 ? x - a : f === 2 ? x - b : f === 3 ? x - ((a + b) >> 1) : x - paeth(a, b, c)) & 0xff;
        line[i] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) {
        bestSum = sum;
        best = f;
        bestLine = Buffer.from(line);
      }
    }
    out[y * (stride + 1)] = best;
    bestLine.copy(out, y * (stride + 1) + 1);
  }
  return out;
}

export function encodePng({ width, height, rgba }) {
  const colours = new Map();
  let opaque = true;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] !== 255) opaque = false;
    const key = rgba.readUInt32BE(i);
    if (!colours.has(key) && colours.size <= 256) colours.set(key, colours.size);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  const chunks = [];
  let data;
  if (colours.size <= 256) {
    ihdr[9] = 3;
    // opaque entries last so tRNS can stay short
    const keys = [...colours.keys()].sort((a, b) => (a & 0xff) - (b & 0xff));
    keys.forEach((k, i) => colours.set(k, i));
    const plte = Buffer.alloc(keys.length * 3);
    const trns = [];
    keys.forEach((k, i) => {
      plte[i * 3] = k >>> 24;
      plte[i * 3 + 1] = (k >>> 16) & 0xff;
      plte[i * 3 + 2] = (k >>> 8) & 0xff;
      if ((k & 0xff) !== 255) trns.push(k & 0xff);
    });
    chunks.push(chunk('PLTE', plte));
    if (trns.length) chunks.push(chunk('tRNS', Buffer.from(trns)));
    const idx = Buffer.alloc(width * height);
    for (let i = 0; i < idx.length; i++) idx[i] = colours.get(rgba.readUInt32BE(i * 4));
    data = filterRows(idx, width, height, 1, false);
  } else if (opaque) {
    ihdr[9] = 2;
    const rgb = Buffer.alloc(width * height * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) rgba.copy(rgb, j, i, i + 3);
    data = filterRows(rgb, width * 3, height, 3, true);
  } else {
    ihdr[9] = 6;
    data = filterRows(rgba, width * 4, height, 4, true);
  }
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    ...chunks,
    chunk('IDAT', deflateSync(data, { level: 9, memLevel: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Re-encodes a PNG; keeps the original if that is somehow smaller. */
export function optimizePng(buf) {
  const out = encodePng(decodePng(buf));
  return out.length < buf.length ? out : buf;
}

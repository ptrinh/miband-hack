import { deflateSync, inflateSync } from 'fflate';

/**
 * Minimal ZIP reader/writer for .rpk files.
 *
 * The writer reproduces the layout JSZip (used by aiot-toolkit 2.0.5) produces: version made by
 * 20 (DOS), version needed 10, no data descriptors, DEFLATE level 9 for files, STORE for
 * directory entries (external attr 0x10), DOS date/time in UTC, archive comment kept.
 * The reader walks the central directory, so it also works on signed rpks where the
 * "RPK Sig Block 42" sits between the file data and the central directory.
 */

export interface ZipEntry {
  /** Path inside the archive, '/'-separated; directories end with '/'. */
  name: string;
  /** Uncompressed content (empty for directories). */
  data: Uint8Array;
}

export interface ZipArchive {
  entries: ZipEntry[];
  /** Raw archive comment bytes (aiot-toolkit stores build info JSON here). */
  comment: Uint8Array;
}

export interface ZipLayout {
  /** Offset of the End Of Central Directory record. */
  eocdOffset: number;
  /** Central directory offset as stored in the EOCD. */
  cdOffset: number;
  /** Central directory size. */
  cdSize: number;
  /** Local header offset of the first central directory entry (0 for normal archives). */
  firstLocalOffset: number;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

const utf8 = new TextEncoder();
const utf8d = new TextDecoder();

function dv(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

/** Finds the EOCD the way aiot-toolkit's SignUtil does: scan backwards from length - 22. */
export function findEocd(b: Uint8Array): number {
  const v = dv(b);
  for (let off = b.length - 22; off >= 0; off--) {
    if (v.getUint32(off, true) === SIG_EOCD) return off;
  }
  throw new Error('rpk: not a zip (no end of central directory)');
}

export function zipLayout(b: Uint8Array): ZipLayout {
  if (b.length < 26 || dv(b).getUint32(0, true) !== SIG_LOCAL) throw new Error('rpk: not a zip');
  const v = dv(b);
  const eocdOffset = findEocd(b);
  const cdOffset = v.getUint32(eocdOffset + 16, true);
  const cdSize = eocdOffset - cdOffset;
  if (cdOffset + 46 > b.length || v.getUint32(cdOffset, true) !== SIG_CENTRAL) throw new Error('rpk: bad central directory');
  return { eocdOffset, cdOffset, cdSize, firstLocalOffset: v.getUint32(cdOffset + 42, true) };
}

export function readZip(b: Uint8Array): ZipArchive {
  const v = dv(b);
  const { eocdOffset, cdOffset } = zipLayout(b);
  const count = v.getUint16(eocdOffset + 10, true);
  const commentLen = v.getUint16(eocdOffset + 20, true);
  const comment = b.slice(eocdOffset + 22, eocdOffset + 22 + commentLen);
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== SIG_CENTRAL) throw new Error('rpk: bad central directory entry');
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true);
    const usize = v.getUint32(p + 24, true);
    const nlen = v.getUint16(p + 28, true);
    const xlen = v.getUint16(p + 30, true);
    const clen = v.getUint16(p + 32, true);
    const lho = v.getUint32(p + 42, true);
    if (flags & 1) throw new Error('rpk: encrypted entries are not supported');
    const name = utf8d.decode(b.subarray(p + 46, p + 46 + nlen));
    if (v.getUint32(lho, true) !== SIG_LOCAL) throw new Error(`rpk: bad local header for ${name}`);
    const start = lho + 30 + v.getUint16(lho + 26, true) + v.getUint16(lho + 28, true);
    const raw = b.subarray(start, start + csize);
    let data: Uint8Array;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = inflateSync(raw, { out: new Uint8Array(usize) });
    else throw new Error(`rpk: unsupported compression ${method} for ${name}`);
    if (data.length !== usize) throw new Error(`rpk: size mismatch for ${name}`);
    entries.push({ name, data });
    p += 46 + nlen + xlen + clen;
  }
  return { entries, comment };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  const date = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
}

/** Writes entries in the given order (JSZip-compatible layout, see file comment). */
export function writeZip(entries: ZipEntry[], comment: Uint8Array = new Uint8Array(0), date: Date = new Date()): Uint8Array {
  const { time, date: ddate } = dosDateTime(date);
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = utf8.encode(e.name);
    const isDir = e.name.endsWith('/');
    const flags = /[^\x00-\x7f]/.test(e.name) ? 0x0800 : 0;
    const method = isDir ? 0 : 8;
    const comp = isDir ? new Uint8Array(0) : deflateSync(e.data, { level: 9 });
    const crc = isDir ? 0 : crc32(e.data);
    const usize = isDir ? 0 : e.data.length;

    const lh = new Uint8Array(30 + name.length);
    const l = dv(lh);
    l.setUint32(0, SIG_LOCAL, true);
    l.setUint16(4, 10, true);
    l.setUint16(6, flags, true);
    l.setUint16(8, method, true);
    l.setUint16(10, time, true);
    l.setUint16(12, ddate, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, comp.length, true);
    l.setUint32(22, usize, true);
    l.setUint16(26, name.length, true);
    lh.set(name, 30);
    locals.push(lh, comp);

    const ch = new Uint8Array(46 + name.length);
    const c = dv(ch);
    c.setUint32(0, SIG_CENTRAL, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 10, true);
    c.setUint16(8, flags, true);
    c.setUint16(10, method, true);
    c.setUint16(12, time, true);
    c.setUint16(14, ddate, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, comp.length, true);
    c.setUint32(24, usize, true);
    c.setUint16(28, name.length, true);
    c.setUint32(38, isDir ? 0x10 : 0, true);
    c.setUint32(42, offset, true);
    ch.set(name, 46);
    centrals.push(ch);
    offset += lh.length + comp.length;
  }
  const cdSize = centrals.reduce((n, x) => n + x.length, 0);
  const eocd = new Uint8Array(22 + comment.length);
  const e = dv(eocd);
  e.setUint32(0, SIG_EOCD, true);
  e.setUint16(8, entries.length, true);
  e.setUint16(10, entries.length, true);
  e.setUint32(12, cdSize, true);
  e.setUint32(16, offset, true);
  e.setUint16(20, comment.length, true);
  eocd.set(comment, 22);
  return concat([...locals, ...centrals, eocd]);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

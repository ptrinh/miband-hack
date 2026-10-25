// Reads the band's auth key from a copy of the Mi Fitness app folder on iPhone / iPad
// (Files → On My iPhone/iPad → Mi Fitness → Compress). Everything runs in the browser.
//
// Mi Fitness keeps the paired devices in
//   MHWCahe/<user id>/VirtualDevice_registerList/manifest.sqlite
// (a YYCache "manifest" table: key, filename, size, inline_data, …). The value under
// registerList_<region> is an NSKeyedArchiver binary plist holding a list of devices, each with
// `encryptKey` (the 32-hex auth key). Layout documented by artyomxx/xiaomi-band-ios-export
// (band_export/extract_key.py, MIT), tested there with a Smart Band 10. This file is an
// independent implementation: a tiny read-only SQLite reader (incl. WAL), a bplist reader and
// the NSKeyedArchiver unwrapping.

import { unzipSync } from 'fflate';

export interface FileKey {
  name: string;
  model?: string;
  mac?: string;
  did?: string;
  key: string;
  /** e.g. registerList_de */
  entry: string;
}

// ------------------------------------------------------------------ SQLite ---

type SqlValue = null | number | bigint | string | Uint8Array;

function varint(b: Uint8Array, at: number): [bigint, number] {
  let v = 0n;
  for (let i = 0; i < 8; i++) {
    const c = b[at + i];
    v = (v << 7n) | BigInt(c & 0x7f);
    if (!(c & 0x80)) return [v, i + 1];
  }
  return [(v << 8n) | BigInt(b[at + 8]), 9];
}

const u16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];

/** Read-only access to the tables of an SQLite file, with committed WAL frames applied. */
export class SqliteReader {
  readonly pageSize: number;
  private readonly usable: number;
  private readonly wal = new Map<number, Uint8Array>();

  constructor(private readonly db: Uint8Array, walFile?: Uint8Array) {
    if (walFile) this.applyWal(walFile);
    const head = this.db.length >= 100 ? this.db : this.wal.get(1);
    if (!head || new TextDecoder().decode(head.subarray(0, 15)) !== 'SQLite format 3') throw new Error('not an SQLite file');
    const ps = u16(head, 16);
    this.pageSize = ps === 1 ? 65536 : ps;
    this.usable = this.pageSize - head[20];
  }

  private applyWal(w: Uint8Array): void {
    if (w.length < 32) return;
    const magic = u32(w, 0);
    if (magic !== 0x377f0682 && magic !== 0x377f0683) return;
    const ps = u32(w, 8);
    const salt1 = u32(w, 16);
    const salt2 = u32(w, 20);
    let pending = new Map<number, Uint8Array>();
    for (let at = 32; at + 24 + ps <= w.length; at += 24 + ps) {
      if (u32(w, at + 8) !== salt1 || u32(w, at + 12) !== salt2) break;
      pending.set(u32(w, at), w.subarray(at + 24, at + 24 + ps));
      if (u32(w, at + 4) !== 0) {
        for (const [n, p] of pending) this.wal.set(n, p);
        pending = new Map();
      }
    }
  }

  page(n: number): Uint8Array {
    const w = this.wal.get(n);
    if (w) return w;
    const start = (n - 1) * this.pageSize;
    if (n < 1 || start + this.pageSize > this.db.length) throw new Error(`SQLite page ${n} missing`);
    return this.db.subarray(start, start + this.pageSize);
  }

  /** All rows of the table b-tree rooted at `root`. */
  rows(root: number): SqlValue[][] {
    const out: SqlValue[][] = [];
    const walk = (n: number, depth: number): void => {
      if (depth > 32) throw new Error('SQLite tree too deep');
      const p = this.page(n);
      const h = n === 1 ? 100 : 0;
      const type = p[h];
      const cells = u16(p, h + 3);
      const ptrs = h + (type === 0x05 ? 12 : 8);
      for (let i = 0; i < cells; i++) {
        const c = u16(p, ptrs + 2 * i);
        if (type === 0x05) walk(u32(p, c), depth + 1);
        else if (type === 0x0d) out.push(this.record(this.payload(p, c)));
        else throw new Error(`unexpected SQLite page type ${type}`);
      }
      if (type === 0x05) walk(u32(p, h + 8), depth + 1);
    };
    walk(root, 0);
    return out;
  }

  private payload(p: Uint8Array, cell: number): Uint8Array {
    const [size, a] = varint(p, cell);
    const [, b] = varint(p, cell + a);
    const P = Number(size);
    const start = cell + a + b;
    const U = this.usable;
    const X = U - 35;
    if (P <= X) return p.subarray(start, start + P);
    const M = Math.floor(((U - 12) * 32) / 255) - 23;
    const K = M + ((P - M) % (U - 4));
    const local = K <= X ? K : M;
    const out = new Uint8Array(P);
    out.set(p.subarray(start, start + local));
    let got = local;
    let next = u32(p, start + local);
    for (let guard = 0; got < P && next; guard++) {
      if (guard > 1_000_000) throw new Error('SQLite overflow loop');
      const o = this.page(next);
      const take = Math.min(U - 4, P - got);
      out.set(o.subarray(4, 4 + take), got);
      got += take;
      next = u32(o, 0);
    }
    if (got < P) throw new Error('SQLite overflow chain cut short');
    return out;
  }

  private record(r: Uint8Array): SqlValue[] {
    const [hs, n0] = varint(r, 0);
    const types: number[] = [];
    for (let at = n0; at < Number(hs); ) {
      const [t, n] = varint(r, at);
      types.push(Number(t));
      at += n;
    }
    const vals: SqlValue[] = [];
    let at = Number(hs);
    for (const t of types) {
      if (t === 0) vals.push(null);
      else if (t >= 1 && t <= 6) {
        const len = [0, 1, 2, 3, 4, 6, 8][t];
        let v = 0n;
        for (let i = 0; i < len; i++) v = (v << 8n) | BigInt(r[at + i]);
        if (v >= 1n << BigInt(len * 8 - 1)) v -= 1n << BigInt(len * 8);
        vals.push(len <= 6 ? Number(v) : v);
        at += len;
      } else if (t === 7) {
        vals.push(new DataView(r.buffer, r.byteOffset + at, 8).getFloat64(0));
        at += 8;
      } else if (t === 8 || t === 9) vals.push(t - 8);
      else if (t >= 12) {
        const len = (t - (t % 2 ? 13 : 12)) / 2;
        const bytes = r.subarray(at, at + len);
        vals.push(t % 2 ? new TextDecoder().decode(bytes) : bytes);
        at += len;
      } else throw new Error(`bad SQLite serial type ${t}`);
    }
    return vals;
  }

  /** Rows of a table by name, as objects keyed by column name. */
  table(name: string): Record<string, SqlValue>[] {
    const master = this.rows(1).find((r) => r[0] === 'table' && r[1] === name);
    if (!master) return [];
    const cols = columnNames(String(master[4] ?? ''));
    return this.rows(Number(master[3])).map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i] ?? null])));
  }
}

function columnNames(sql: string): string[] {
  const body = sql.slice(sql.indexOf('(') + 1, sql.lastIndexOf(')'));
  return body
    .split(',')
    .map((s) => s.trim().split(/\s+/)[0].replace(/^["`[]|["`\]]$/g, ''))
    .filter((c) => c && !/^(primary|unique|constraint|check|foreign)$/i.test(c));
}

// ------------------------------------------------------------------ bplist ---

export class Uid {
  constructor(readonly value: number) {}
}

type Plist = null | boolean | number | bigint | string | Uint8Array | Date | Uid | Plist[] | { [k: string]: Plist };

/** Parses a binary property list (bplist00). */
export function parseBplist(b: Uint8Array): Plist {
  if (new TextDecoder().decode(b.subarray(0, 8)) !== 'bplist00') throw new Error('not a binary plist');
  const t = b.length - 32;
  const offSize = b[t + 6];
  const refSize = b[t + 7];
  const num = Number(readUInt(b, t + 8, 8));
  const top = Number(readUInt(b, t + 16, 8));
  const table = Number(readUInt(b, t + 24, 8));
  const offset = (i: number) => Number(readUInt(b, table + i * offSize, offSize));
  const seen = new Set<number>();

  const obj = (i: number): Plist => {
    if (i >= num) throw new Error('bplist ref out of range');
    if (seen.has(i)) throw new Error('bplist cycle');
    seen.add(i);
    try {
      return parse(offset(i));
    } finally {
      seen.delete(i);
    }
  };
  const count = (at: number): [number, number] => {
    const n = b[at] & 0x0f;
    if (n !== 0x0f) return [n, at + 1];
    const m = b[at + 1];
    const len = 1 << (m & 0x0f);
    return [Number(readUInt(b, at + 2, len)), at + 2 + len];
  };
  const parse = (at: number): Plist => {
    const m = b[at];
    switch (m >> 4) {
      case 0x0:
        return m === 0x08 ? false : m === 0x09 ? true : null;
      case 0x1: {
        const len = 1 << (m & 0x0f);
        const v = readUInt(b, at + 1, len);
        if (len === 8 && v >= 1n << 63n) return v - (1n << 64n);
        return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
      }
      case 0x2: {
        const len = 1 << (m & 0x0f);
        const dv = new DataView(b.buffer, b.byteOffset + at + 1, len);
        return len === 4 ? dv.getFloat32(0) : dv.getFloat64(0);
      }
      case 0x3:
        return new Date((978307200 + new DataView(b.buffer, b.byteOffset + at + 1, 8).getFloat64(0)) * 1000);
      case 0x4: {
        const [n, s] = count(at);
        return b.slice(s, s + n);
      }
      case 0x5: {
        const [n, s] = count(at);
        return String.fromCharCode(...b.subarray(s, s + n));
      }
      case 0x6: {
        const [n, s] = count(at);
        let str = '';
        for (let k = 0; k < n; k++) str += String.fromCharCode(u16(b, s + 2 * k));
        return str;
      }
      case 0x8:
        return new Uid(Number(readUInt(b, at + 1, (m & 0x0f) + 1)));
      case 0xa:
      case 0xc: {
        const [n, s] = count(at);
        return Array.from({ length: n }, (_, k) => obj(Number(readUInt(b, s + k * refSize, refSize))));
      }
      case 0xd: {
        const [n, s] = count(at);
        const o: { [k: string]: Plist } = {};
        for (let k = 0; k < n; k++) {
          const key = obj(Number(readUInt(b, s + k * refSize, refSize)));
          o[String(key)] = obj(Number(readUInt(b, s + (n + k) * refSize, refSize)));
        }
        return o;
      }
      default:
        throw new Error(`bplist marker 0x${m.toString(16)}`);
    }
  };
  return obj(top);
}

function readUInt(b: Uint8Array, at: number, len: number): bigint {
  let v = 0n;
  for (let i = 0; i < len; i++) v = (v << 8n) | BigInt(b[at + i]);
  return v;
}

/** Unwraps an NSKeyedArchiver plist into plain values (dicts, arrays, strings…). */
export function unarchive(root: Plist): Plist {
  if (!root || typeof root !== 'object' || !('$objects' in root) || !('$top' in root)) throw new Error('not an NSKeyedArchiver plist');
  const objects = (root as { $objects: Plist[] }).$objects;
  const resolve = (v: Plist, depth: number): Plist => {
    if (depth > 64) throw new Error('archive too deep');
    if (v instanceof Uid) {
      const o = objects[v.value];
      return o === '$null' ? null : resolve(o, depth + 1);
    }
    if (Array.isArray(v)) return v.map((x) => resolve(x, depth + 1));
    if (v && typeof v === 'object' && !(v instanceof Uint8Array) && !(v instanceof Date)) {
      if ('NS.objects' in v && !('NS.keys' in v)) return resolve(v['NS.objects'], depth + 1);
      if ('NS.keys' in v && 'NS.objects' in v) {
        const keys = resolve(v['NS.keys'], depth + 1) as Plist[];
        const vals = resolve(v['NS.objects'], depth + 1) as Plist[];
        return Object.fromEntries(keys.map((k, i) => [String(k), vals[i]]));
      }
      if ('NS.string' in v) return resolve(v['NS.string'], depth + 1);
      return Object.fromEntries(Object.entries(v).filter(([k]) => k !== '$class').map(([k, x]) => [k, resolve(x, depth + 1)]));
    }
    return v;
  };
  let top = resolve((root as { $top: Plist }).$top, 0);
  // registerList is archived as { root: … } or { list: … } around the array.
  for (let i = 0; i < 4 && top && typeof top === 'object' && !Array.isArray(top); i++) {
    const keys = Object.keys(top);
    if (keys.length === 1 && (keys[0] === 'root' || keys[0] === 'list')) top = (top as Record<string, Plist>)[keys[0]];
    else break;
  }
  return top;
}

// ------------------------------------------------------------- Mi Fitness ---

const str = (v: Plist | undefined): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Keys from one registerList value (an NSKeyedArchiver bplist). */
export function keysFromRegisterList(blob: Uint8Array, entry: string): FileKey[] {
  const list = unarchive(parseBplist(blob));
  const devices = Array.isArray(list) ? list : [list];
  const out: FileKey[] = [];
  for (const d of devices) {
    if (!d || typeof d !== 'object' || Array.isArray(d) || d instanceof Uint8Array || d instanceof Date || d instanceof Uid) continue;
    const raw = str(d.encryptKey) ?? str(d.encrypt_key);
    const key = raw?.toLowerCase().replace(/^0x/, '');
    if (!key || !/^[0-9a-f]{32}$/.test(key)) continue;
    out.push({ name: str(d.name) ?? '', model: str(d.model), mac: str(d.mac) ?? str(d.randomMac), did: d.did == null ? undefined : String(d.did), key, entry });
  }
  return out;
}

/** Keys from manifest.sqlite (+ optional -wal and the YYCache data/ files for large values). */
export function keysFromManifest(db: Uint8Array, wal?: Uint8Array, dataFile?: (name: string) => Uint8Array | undefined): FileKey[] {
  const rows = new SqliteReader(db, wal).table('manifest');
  const out: FileKey[] = [];
  for (const r of rows) {
    const k = typeof r.key === 'string' ? r.key : '';
    if (!k.startsWith('registerList')) continue;
    let blob = r.inline_data instanceof Uint8Array && r.inline_data.length ? r.inline_data : undefined;
    if (!blob && typeof r.filename === 'string') blob = dataFile?.(r.filename);
    if (!blob || new TextDecoder().decode(blob.subarray(0, 6)) !== 'bplist') continue;
    out.push(...keysFromRegisterList(blob, k));
  }
  return out;
}

/** The registerList manifest, or a lone manifest.sqlite picked by itself. */
const MANIFEST = /(^|\/)VirtualDevice_registerList\/manifest\.sqlite$|^manifest\.sqlite$/;
const WAL = /(^|\/)VirtualDevice_registerList\/manifest\.sqlite-wal$|^manifest\.sqlite-wal$/;

/** Every auth key found in a zip of the Mi Fitness folder (deduplicated). */
export function keysFromZip(zip: Uint8Array): FileKey[] {
  const files = unzipSync(zip, { filter: (f) => /VirtualDevice_registerList\//.test(f.name) && !/(^|\/)__MACOSX\//.test(f.name) });
  return keysFromFiles(files);
}

/** Same as keysFromZip for files picked one by one or from an unzipped folder (path → bytes). */
export function keysFromFiles(files: Record<string, Uint8Array>): FileKey[] {
  const out: FileKey[] = [];
  const seen = new Set<string>();
  for (const [path, bytes] of Object.entries(files)) {
    // Mi Fitness keeps the whole database in the -wal (manifest.sqlite is one empty page), so the
    // -wal alone is enough; it is read on its own only when its manifest.sqlite was not picked.
    const walOnly = WAL.test(path) && !files[path.slice(0, -4)];
    if (!MANIFEST.test(path) && !walOnly) continue;
    const dbPath = walOnly ? path.slice(0, -4) : path;
    const dir = dbPath.slice(0, dbPath.length - 'manifest.sqlite'.length);
    const db = walOnly ? new Uint8Array(0) : bytes;
    const wal = walOnly ? bytes : files[`${path}-wal`];
    for (const k of keysFromManifest(db, wal, (name) => files[`${dir}data/${name}`])) {
      const id = `${k.did ?? k.mac ?? k.name}:${k.key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(k);
    }
  }
  return out;
}

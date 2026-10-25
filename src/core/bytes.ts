import { t } from '../i18n';

export function concat(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function hex(b: Uint8Array, max = 64): string {
  const s = Array.from(b.subarray(0, max), (x) => x.toString(16).padStart(2, '0')).join('');
  return b.length > max ? `${s}…(${b.length}B)` : s;
}

export function fromHex(s: string): Uint8Array {
  const clean = s.trim().replace(/^0x/i, '').replace(/[\s:-]/g, '');
  if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) throw new Error(t('errHex'));
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

export function equals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function u16le(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
}

export function u32le(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
}

export function readU16le(b: Uint8Array, off: number): number {
  return b[off] | (b[off + 1] << 8);
}

export function readU32le(b: Uint8Array, off: number): number {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}

export function cstring(b: Uint8Array, off: number, max = 256): string | null {
  if (off >= b.length) return null;
  let end = off;
  while (end < b.length && end - off < max && b[end] !== 0) end++;
  if (end === off) return null;
  return new TextDecoder().decode(b.subarray(off, end));
}

/** Growable receive buffer for stream transports. */
export class ByteQueue {
  private buf: Uint8Array = new Uint8Array(0);

  push(data: Uint8Array): void {
    this.buf = concat(this.buf, data);
  }

  peek(): Uint8Array {
    return this.buf;
  }

  skip(n: number): void {
    this.buf = n >= this.buf.length ? new Uint8Array(0) : this.buf.slice(n);
  }

  clear(): void {
    this.buf = new Uint8Array(0);
  }
}

// Mi Band watchface v2 (.bin / EasyFace .face) writer: the format the Mi Band 7 Pro / 8 firmware reads.
// Layout checked byte for byte against an official EasyFace Band 8 face (test/watchface.test.ts).
// Format notes cross-checked with utsabfdahal/band10-toolkit docs/format.md (MIT); the code is our own.
//
//   0x00  5A A5 34 12 magic · 0x10 u32 0x800 · 0x1C u8 face count (normal + AOD) · 0x1E u16 sub-version
//   0x20  u32 offset of the preview image · 0x28 id (ASCII digits) · 0x68 UTF-8 name · 0xA8 face headers
//   face header (88 B): u32 background image id, u32 preview offset (first face only), then 10 × (count, table offset)
//   section table entry (16 B): u32 id = section << 24 | index, u32 0, u32 data offset, u32 data length
// Every data block starts on a 4-byte boundary and the file is padded to one.

/** Section numbers inside a face. */
export const SECTION = { elements: 0, images: 2, imageLists: 3, animations: 4, apps: 5, widgets: 7, actions: 9 } as const;
/** Element target types (top byte of the target id). */
export const TARGET = { image: 0x02, imageList: 0x03, widget: 0x07 } as const;

const HEADER_SIZE = 0xa8;
const FACE_HEADER_SIZE = 88;
const SECTIONS = 10;
/** Order the official compiler writes section data in. */
const DATA_ORDER = [0, 7, 9, 5, 4, 1, 6, 8, 2, 3];
const BLOB_MAGIC = [0xe0, 0x21, 0xa5, 0x5a];

/** A bitmap in the band's pixel layout: RGB565 little-endian, or BGRA with straight alpha. */
export interface RawImage {
  format: 'rgb565' | 'bgra';
  width: number;
  height: number;
  pixels: Uint8Array;
}

export interface FaceSections {
  /** Raw section blobs by section number; ids are assigned from the position. */
  [section: number]: Uint8Array[];
}

export interface WatchfaceSpec {
  /** 9 ASCII digits; the band refuses a second face with the same id. */
  id: string;
  name: string;
  preview: Uint8Array;
  /** First the normal face, then optionally the always-on (AOD) face. */
  faces: FaceSections[];
  subVersion?: number;
}

const bpp = (format: RawImage['format']) => (format === 'rgb565' ? 2 : 4);
const typeCode = (format: RawImage['format']) => (format === 'rgb565' ? 2 : 4);
const formatCode = (format: RawImage['format']) => (format === 'rgb565' ? 3 : 0);

/**
 * Run-length encodes pixels of `size` bytes. A control byte below 0x80 repeats the next pixel n times,
 * 0x80 | n copies n literal pixels. EasyFace only writes repeats (`literals: false`, byte-identical);
 * literal runs make antialiased edges smaller and are read fine by the band.
 */
export function rleEncode(px: Uint8Array, size: number, literals = true): Uint8Array {
  const n = px.length / size;
  const out: number[] = [];
  const same = (a: number, b: number) => {
    for (let k = 0; k < size; k++) if (px[a * size + k] !== px[b * size + k]) return false;
    return true;
  };
  const push = (i: number) => {
    for (let k = 0; k < size; k++) out.push(px[i * size + k]);
  };
  let i = 0;
  while (i < n) {
    let j = i + 1;
    while (j < n && j - i < 127 && same(j, i)) j++;
    if (!literals || j - i > 1) {
      out.push(j - i);
      push(i);
      i = j;
      continue;
    }
    // Collect literals until two equal pixels start a repeat.
    j = i;
    while (j < n && j - i < 127 && !(j + 1 < n && same(j, j + 1))) j++;
    if (j === i) j++;
    out.push(0x80 | (j - i));
    for (let k = i; k < j; k++) push(k);
    i = j;
  }
  return Uint8Array.from(out);
}

/** Inverse of rleEncode. */
export function rleDecode(data: Uint8Array, size: number): Uint8Array {
  const out: number[] = [];
  let o = 0;
  while (o < data.length) {
    const c = data[o++];
    const n = c & 0x7f;
    if (c & 0x80) {
      for (let k = 0; k < n * size; k++) out.push(data[o + k]);
      o += n * size;
    } else {
      for (let r = 0; r < n; r++) for (let k = 0; k < size; k++) out.push(data[o + k]);
      o += size;
    }
  }
  return Uint8Array.from(out);
}

/** Compressed pixel payload: magic, (decoded length << 4) | type, RLE data. */
export function compressPixels(img: RawImage, literals = true): Uint8Array {
  const rle = rleEncode(img.pixels, bpp(img.format), literals);
  const out = new Uint8Array(8 + rle.length);
  out.set(BLOB_MAGIC);
  new DataView(out.buffer).setUint32(4, (img.pixels.length << 4) | typeCode(img.format), true);
  out.set(rle, 8);
  return out;
}

/** Decodes a compressed pixel payload; returns the format and the raw pixels. */
export function decompressPixels(data: Uint8Array): { format: RawImage['format']; pixels: Uint8Array } {
  if (!BLOB_MAGIC.every((b, i) => data[i] === b)) throw new Error('watchface image: bad magic');
  const word = new DataView(data.buffer, data.byteOffset).getUint32(4, true);
  const format = (word & 0xf) === 2 ? 'rgb565' : 'bgra';
  const pixels = rleDecode(data.subarray(8), bpp(format));
  if (pixels.length !== word >>> 4) throw new Error('watchface image: bad length');
  return { format, pixels };
}

/** Image section blob: [format][04][00][00] width height u32 length, then the compressed pixels. */
export function imageBlob(img: RawImage, literals = true): Uint8Array {
  const body = compressPixels(img, literals);
  const out = new Uint8Array(12 + body.length);
  const v = new DataView(out.buffer);
  out[0] = formatCode(img.format);
  out[1] = 4;
  v.setUint16(4, img.width, true);
  v.setUint16(6, img.height, true);
  v.setUint32(8, body.length, true);
  out.set(body, 12);
  return out;
}

/** Image list blob: [format][count][04][00] width height u32 total, count × u32 frame size, frames. */
export function imageListBlob(frames: RawImage[], literals = true): Uint8Array {
  const bodies = frames.map((f) => compressPixels(f, literals));
  const total = bodies.reduce((s, b) => s + b.length, 0);
  const out = new Uint8Array(12 + 4 * frames.length + total);
  const v = new DataView(out.buffer);
  out[0] = formatCode(frames[0].format);
  out[1] = frames.length;
  out[2] = 4;
  v.setUint16(4, frames[0].width, true);
  v.setUint16(6, frames[0].height, true);
  v.setUint32(8, total, true);
  let p = 12 + 4 * frames.length;
  bodies.forEach((b, i) => {
    v.setUint32(12 + 4 * i, b.length, true);
    out.set(b, p);
    p += b.length;
  });
  return out;
}

/** Element (16 B): u32 target id (type << 24 | index), u16 x, u16 y, 8 zero bytes. */
export function elementBlob(type: number, index: number, x: number, y: number): Uint8Array {
  const out = new Uint8Array(16);
  const v = new DataView(out.buffer);
  v.setUint32(0, ((type << 24) | index) >>> 0, true);
  v.setUint16(4, x, true);
  v.setUint16(6, y, true);
  return out;
}

/** Data sources of number widgets, as the two bytes the compiler writes. */
export const SOURCE = {
  hourTens: [0x0a, 0x11],
  hourOnes: [0x09, 0x11],
  minuteTens: [0x12, 0x11],
  minuteOnes: [0x11, 0x11],
  month: [0x10, 0x12],
  day: [0x18, 0x12],
  battery: [0x08, 0x41],
  steps: [0x08, 0x21],
} as const;

/**
 * Number widget (20 B): source, digit count, flags (high nibble 1 = number; 0x15 is what EasyFace writes
 * for a zero-padded, left-aligned time digit), u32 0, image list id, spacing at byte 13.
 */
export function numberWidgetBlob(source: readonly [number, number], listIndex: number, digits = 1, flags = 0x15, spacing = 0): Uint8Array {
  const out = new Uint8Array(20);
  out[0] = source[0];
  out[1] = source[1];
  out[2] = digits;
  out[3] = flags;
  new DataView(out.buffer).setUint32(8, ((TARGET.imageList << 24) | listIndex) >>> 0, true);
  out[13] = spacing & 0xff;
  return out;
}

const align4 = (n: number) => (n + 3) & ~3;

/** Lays out a complete watchface file. */
export function packWatchface(spec: WatchfaceSpec): Uint8Array {
  if (!/^\d{1,63}$/.test(spec.id)) throw new Error('watchface id must be ASCII digits');
  const name = new TextEncoder().encode(spec.name);
  if (name.length > 63) throw new Error('watchface name is longer than 63 bytes');

  // Pass 1: offsets. Tables follow the face headers, then each face's data, then the preview.
  let tables = HEADER_SIZE + FACE_HEADER_SIZE * spec.faces.length;
  const tableOff: number[][] = [];
  for (const face of spec.faces) {
    const offs: number[] = [];
    for (let s = 0; s < SECTIONS; s++) {
      offs.push(tables);
      tables += 16 * (face[s]?.length ?? 0);
    }
    tableOff.push(offs);
  }
  let p = align4(tables);
  const dataOff = spec.faces.map((face) => {
    const offs: number[][] = [];
    for (const s of DATA_ORDER) {
      offs[s] = (face[s] ?? []).map((b) => {
        const at = p;
        p = align4(p + b.length);
        return at;
      });
    }
    return offs;
  });
  const previewOff = p;
  const out = new Uint8Array(align4(previewOff + spec.preview.length));
  const v = new DataView(out.buffer);

  // Pass 2: write.
  out.set([0x5a, 0xa5, 0x34, 0x12]);
  v.setUint32(0x10, 0x800, true);
  out[0x1c] = spec.faces.length;
  v.setUint16(0x1e, spec.subVersion ?? 4, true);
  v.setUint32(0x20, previewOff, true);
  out.set(new TextEncoder().encode(spec.id), 0x28);
  out.set(name, 0x68);
  spec.faces.forEach((face, f) => {
    const h = HEADER_SIZE + FACE_HEADER_SIZE * f;
    v.setUint32(h, ((TARGET.image << 24) | 0) >>> 0, true);
    v.setUint32(h + 4, f === 0 ? previewOff : 0, true);
    for (let s = 0; s < SECTIONS; s++) {
      const blobs = face[s] ?? [];
      v.setUint32(h + 8 + 8 * s, blobs.length, true);
      v.setUint32(h + 12 + 8 * s, tableOff[f][s], true);
      blobs.forEach((b, i) => {
        const e = tableOff[f][s] + 16 * i;
        v.setUint32(e, ((s << 24) | i) >>> 0, true);
        v.setUint32(e + 8, dataOff[f][s][i], true);
        v.setUint32(e + 12, b.length, true);
        out.set(b, dataOff[f][s][i]);
      });
    }
  });
  out.set(spec.preview, previewOff);
  return out;
}

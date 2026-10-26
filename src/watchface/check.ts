// Structural check of a v2 watchface before it goes to a band. A Mi Band 8 stopped booting after a face whose
// layout it did not expect (2026-10-26), so a file whose tables point outside it, whose images do not decode
// to their stated size or whose elements point at missing images is refused. Unknown image types and section
// kinds are skipped, not rejected: faces for other bands use them.

const HEADER_SIZE = 0xa8;
const SECTIONS = 10;
const IMAGES = 2;
const LISTS = 3;
const WIDGETS = 7;
const MAGIC = [0xe0, 0x21, 0xa5, 0x5a];

/** Number of faces in the file: the normal face, then the always-on (AOD) one. */
export const watchfaceFaceCount = (fw: Uint8Array): number => fw[0x1c];

/** Bytes per pixel of the compressed payload types we can walk (2 RGB565, 4 BGRA). */
const PIXEL_SIZE: Record<number, number> = { 2: 2, 4: 4 };

/** Walks a compressed payload; returns a problem or null. Does not allocate the pixels. */
function checkPixels(fw: Uint8Array, at: number, len: number, width: number, height: number): string | null {
  if (len < 8 || at + len > fw.length) return 'image data outside the file';
  if (!MAGIC.every((b, i) => fw[at + i] === b)) return null; // uncompressed or another encoding: not ours to judge
  const word = new DataView(fw.buffer, fw.byteOffset + at + 4, 4).getUint32(0, true);
  const size = PIXEL_SIZE[word & 0xf];
  if (!size) return null;
  const expect = width * height * size;
  if (word >>> 4 !== expect) return `image ${width}×${height} states ${word >>> 4} bytes, needs ${expect}`;
  let o = at + 8;
  let out = 0;
  const end = at + len;
  while (o < end) {
    const c = fw[o++];
    const n = c & 0x7f;
    if (!n) return 'image data has an empty run';
    o += c & 0x80 ? n * size : size;
    out += n * size;
  }
  if (o !== end || out !== expect) return `image ${width}×${height} decodes to ${out} bytes, needs ${expect}`;
  return null;
}

/** Returns why the file is unsafe to install, or null when its structure holds together. */
export function checkWatchfaceV2(fw: Uint8Array): string | null {
  if (fw.length < HEADER_SIZE) return 'file shorter than its header';
  const v = new DataView(fw.buffer, fw.byteOffset, fw.byteLength);
  const u32 = (o: number) => v.getUint32(o, true);
  const u16 = (o: number) => v.getUint16(o, true);
  const faces = watchfaceFaceCount(fw);
  if (faces < 1 || faces > 4) return `${faces} faces in the header`;
  let h = HEADER_SIZE + 4 * (fw[0x1d] + fw[0x18]);

  for (let f = 0; f < faces; f++) {
    if (h + 8 + 8 * SECTIONS > fw.length) return 'face header outside the file';
    const count: number[] = [];
    const table: number[] = [];
    for (let s = 0; s < SECTIONS; s++) {
      count.push(u32(h + 8 + 8 * s));
      table.push(u32(h + 12 + 8 * s));
      if (count[s] > 4096 || table[s] + 16 * count[s] > fw.length) return `face ${f}: section ${s} table outside the file`;
    }
    h += 8 + 8 * SECTIONS;
    const entry = (s: number, i: number) => ({ off: u32(table[s] + 16 * i + 8), len: u32(table[s] + 16 * i + 12) });
    for (let s = 0; s < SECTIONS; s++) {
      for (let i = 0; i < count[s]; i++) {
        const { off, len } = entry(s, i);
        if (off + len > fw.length) return `face ${f}: section ${s} item ${i} outside the file`;
      }
    }
    for (let i = 0; i < count[IMAGES]; i++) {
      const { off, len } = entry(IMAGES, i);
      if (len < 12) return `face ${f}: image ${i} too short`;
      const bad = checkPixels(fw, off + 12, Math.min(u32(off + 8), len - 12), u16(off + 4), u16(off + 6));
      if (bad) return `face ${f}: image ${i}: ${bad}`;
    }
    for (let i = 0; i < count[LISTS]; i++) {
      const { off, len } = entry(LISTS, i);
      const frames = fw[off + 1];
      if (len < 12 + 4 * frames) return `face ${f}: image list ${i} too short`;
      let p = off + 12 + 4 * frames;
      for (let k = 0; k < frames; k++) {
        const size = u32(off + 12 + 4 * k);
        if (p + size > off + len) return `face ${f}: image list ${i} frame ${k} outside the list`;
        const bad = checkPixels(fw, p, size, u16(off + 4), u16(off + 6));
        if (bad) return `face ${f}: image list ${i} frame ${k}: ${bad}`;
        p += size;
      }
    }
    // A target id is type << 24 | index; images, lists and widgets it names must exist in this face.
    const missing = (target: number) => {
      const type = target >>> 24;
      const index = target & 0xffffff;
      const n = type === 0x02 ? count[IMAGES] : type === 0x03 ? count[LISTS] : type === 0x07 ? count[WIDGETS] : Infinity;
      return index >= n;
    };
    for (let i = 0; i < count[0]; i++) {
      const { off, len } = entry(0, i);
      if (len >= 4 && missing(u32(off))) return `face ${f}: element ${i} points at a missing item`;
    }
    for (let i = 0; i < count[WIDGETS]; i++) {
      const { off, len } = entry(WIDGETS, i);
      if (len >= 12 && fw[off + 11] === 0x03 && missing(u32(off + 8))) return `face ${f}: widget ${i} points at a missing image list`;
    }
  }
  return null;
}

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { parseFile } from '../src/core/files';
import { BAND8, band8FaceId, buildBand8Face, type Rgba } from '../src/watchface/band8';
import {
  decompressPixels,
  imageBlob,
  imageListBlob,
  packWatchface,
  type FaceSections,
  type RawImage,
  rleDecode,
  rleEncode,
} from '../src/watchface/format';

// Official EasyFace Mi Band 8 sample face (f230.face from the EasyFace sample project, via the TanteJossa
// repository, MIT), gzipped: two faces (normal + AOD), 20 + 14 elements, 8 images, 26 image lists.
const sample = gunzipSync(new Uint8Array(readFileSync(resolve(__dirname, 'fixtures/easyface-band8-sample.face.gz'))));

const u32 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getUint32(o, true);
const u16 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getUint16(o, true);

/** Splits a face file into raw section blobs, the way packWatchface takes them. */
function unpack(file: Uint8Array): { faces: FaceSections[]; preview: Uint8Array } {
  const faces: FaceSections[] = [];
  for (let f = 0; f < file[0x1c]; f++) {
    const h = 0xa8 + 88 * f;
    const face: FaceSections = {};
    for (let s = 0; s < 10; s++) {
      const n = u32(file, h + 8 + 8 * s);
      const t = u32(file, h + 12 + 8 * s);
      if (!n) continue;
      face[s] = [];
      for (let i = 0; i < n; i++) {
        expect(u32(file, t + 16 * i)).toBe(((s << 24) | i) >>> 0);
        face[s].push(file.subarray(u32(file, t + 16 * i + 8), u32(file, t + 16 * i + 8) + u32(file, t + 16 * i + 12)));
      }
    }
    faces.push(face);
  }
  const p = u32(file, 0x20);
  return { faces, preview: file.subarray(p, p + 12 + u32(file, p + 8)) };
}

/** Decodes an image blob back to a RawImage. */
function image(blob: Uint8Array): RawImage {
  return { ...decompressPixels(blob.subarray(12)), width: u16(blob, 4), height: u16(blob, 6) };
}

/** Decodes an image list blob back to its frames. */
function frames(blob: Uint8Array): RawImage[] {
  const out: RawImage[] = [];
  let p = 12 + 4 * blob[1];
  for (let i = 0; i < blob[1]; i++) {
    const size = u32(blob, 12 + 4 * i);
    out.push({ ...decompressPixels(blob.subarray(p, p + size)), width: u16(blob, 4), height: u16(blob, 6) });
    p += size;
  }
  return out;
}

describe('watchface format', () => {
  it('round-trips RLE with and without literal runs', () => {
    const px = Uint8Array.from({ length: 4000 }, (_, i) => (i % 97 < 40 ? 0 : (i * 7) & 0xff));
    for (const size of [2, 4]) for (const lit of [true, false]) expect(rleDecode(rleEncode(px, size, lit), size)).toEqual(px);
  });

  it('re-encodes every image of the official sample byte for byte', () => {
    const { faces, preview } = unpack(sample);
    expect(imageBlob(image(preview), false)).toEqual(preview);
    let n = 0;
    for (const face of faces) {
      for (const b of face[2] ?? []) (expect(imageBlob(image(b), false)).toEqual(b), n++);
      for (const b of face[3] ?? []) (expect(imageListBlob(frames(b), false)).toEqual(b), n++);
    }
    expect(n).toBe(34);
  });

  it('rebuilds the official sample file byte for byte', () => {
    const { faces } = unpack(sample);
    const rebuilt = packWatchface({
      id: '167210065',
      name: new TextDecoder().decode(sample.subarray(0x68, sample.indexOf(0, 0x68))),
      preview: imageBlob(image(unpack(sample).preview), false),
      faces: faces.map((face) => ({
        ...face,
        2: face[2].map((b) => imageBlob(image(b), false)),
        3: face[3].map((b) => imageListBlob(frames(b), false)),
      })),
    });
    expect(rebuilt.length).toBe(sample.length);
    expect(rebuilt).toEqual(sample);
  });
});

describe('Band 8 face builder', () => {
  const solid = (width: number, height: number, rgba: number[]): Rgba => {
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
    return { width, height, data };
  };
  // A digit frame: transparent with an opaque bar whose height is the digit, so frames differ.
  const digit = (d: number): Rgba => {
    const img = solid(72, 104, [0, 0, 0, 0]);
    for (let y = 0; y < 10 * (d + 1); y++) for (let x = 20; x < 50; x++) img.data.set([255, 176, 46, 255], (y * 72 + x) * 4);
    return img;
  };
  const set = Array.from({ length: 10 }, (_, d) => digit(d));
  const bin = buildBand8Face({
    id: band8FaceId('KHOI TRINH|#ffb02e'),
    name: 'KHOI TRINH',
    background: solid(BAND8.width, BAND8.height, [0, 0, 0, 255]),
    preview: solid(BAND8.previewWidth, BAND8.previewHeight, [0, 0, 0, 255]),
    digits: [set, set, set, set],
    positions: [[20, 72], [100, 72], [20, 192], [100, 192]],
  });

  it('is a watchface parseFile accepts', () => {
    const parsed = parseFile(bin);
    expect(parsed.kind).toBe('watchface');
    if (parsed.kind !== 'watchface') return;
    expect(parsed.id).toMatch(/^[3-8]\d{8}$/);
    expect(parsed.id).not.toBe('167210065');
    expect(parsed.name).toBe('KHOI TRINH');
  });

  it('has one face with the background, four time widgets and their digit lists', () => {
    expect(bin.length % 4).toBe(0);
    expect([...bin.subarray(0, 4)]).toEqual([0x5a, 0xa5, 0x34, 0x12]);
    expect(bin[0x1c]).toBe(1);
    const { faces, preview } = unpack(bin);
    const face = faces[0];
    expect(face[0].map((e) => u32(e, 0) >>> 24)).toEqual([2, 7, 7, 7, 7]);
    expect(face[7].map((w) => [w[0], w[1], w[2], w[3]])).toEqual([
      [0x0a, 0x11, 1, 0x15],
      [0x09, 0x11, 1, 0x15],
      [0x12, 0x11, 1, 0x15],
      [0x11, 0x11, 1, 0x15],
    ]);
    expect(face[7].map((w) => u32(w, 8))).toEqual([0x03000000, 0x03000001, 0x03000002, 0x03000003]);
    const bg = image(face[2][0]);
    expect([bg.format, bg.width, bg.height]).toEqual(['rgb565', 192, 490]);
    expect(face[3].map((l) => frames(l).length)).toEqual([11, 11, 11, 11]);
    const f3 = frames(face[3][0])[3];
    expect([f3.format, f3.width, f3.height]).toEqual(['bgra', 72, 104]);
    // BGRA order: the orange bar's first pixel.
    expect([...f3.pixels.subarray(20 * 4, 20 * 4 + 4)]).toEqual([46, 176, 255, 255]);
    expect([image(preview).width, image(preview).height]).toEqual([122, 310]);
  });

  it('gives each design its own stable 9-digit id', () => {
    expect(band8FaceId('A|#fff')).toBe(band8FaceId('A|#fff'));
    expect(band8FaceId('A|#fff')).not.toBe(band8FaceId('B|#fff'));
  });
});

import { elementBlob, imageBlob, imageListBlob, numberWidgetBlob, packWatchface, type RawImage, SECTION, SOURCE, TARGET } from './format';

// Static Mi Band 8 face: one background image plus HH:MM as four one-digit number widgets. The band 8
// (firmware 2.3.14) runs no apps and has no tap zones, so a face is images and data-bound digits only.

export const BAND8 = { width: 192, height: 490, previewWidth: 122, previewHeight: 310 } as const;

/** RGBA pixels as a canvas ImageData holds them. */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

export interface Band8FaceInput {
  id: string;
  name: string;
  /** 192 × 490, drawn opaque. */
  background: Rgba;
  /** 122 × 310 picture shown in the band's face list. */
  preview: Rgba;
  /** Ten frames (0–9) per digit position, in the order hour tens, hour ones, minute tens, minute ones. */
  digits: [Rgba[], Rgba[], Rgba[], Rgba[]];
  /** Top-left corner of each digit position. */
  positions: [[number, number], [number, number], [number, number], [number, number]];
}

export function toRgb565(img: Rgba): RawImage {
  const px = new Uint8Array(img.width * img.height * 2);
  for (let i = 0, o = 0; i < img.data.length; i += 4, o += 2) {
    const v = ((img.data[i] >> 3) << 11) | ((img.data[i + 1] >> 2) << 5) | (img.data[i + 2] >> 3);
    px[o] = v & 0xff;
    px[o + 1] = v >> 8;
  }
  return { format: 'rgb565', width: img.width, height: img.height, pixels: px };
}

/** Fully transparent pixels become 00000000 so they run-length encode as one colour. */
export function toBgra(img: Rgba): RawImage {
  const px = new Uint8Array(img.width * img.height * 4);
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] === 0) continue;
    px[i] = img.data[i + 2];
    px[i + 1] = img.data[i + 1];
    px[i + 2] = img.data[i];
    px[i + 3] = img.data[i + 3];
  }
  return { format: 'bgra', width: img.width, height: img.height, pixels: px };
}

/** A 9-digit id from the design, so the same design keeps its id and a changed one gets a new face. */
export function band8FaceId(seed: string): string {
  let h = 0x811c9dc5;
  for (const c of new TextEncoder().encode(seed)) h = Math.imul(h ^ c, 0x01000193) >>> 0;
  return String(300000000 + (h % 600000000));
}

export function buildBand8Face(input: Band8FaceInput): Uint8Array {
  const sources = [SOURCE.hourTens, SOURCE.hourOnes, SOURCE.minuteTens, SOURCE.minuteOnes];
  // Number lists hold 11 frames: 0–9 and the minus sign, which the time never shows (EasyFace repeats 0).
  const lists = input.digits.map((frames) => imageListBlob([...frames, frames[0]].map(toBgra)));
  return packWatchface({
    id: input.id,
    name: input.name,
    preview: imageBlob(toRgb565(input.preview)),
    faces: [
      {
        [SECTION.elements]: [
          elementBlob(TARGET.image, 0, 0, 0),
          ...input.positions.map(([x, y], i) => elementBlob(TARGET.widget, i, x, y)),
        ],
        [SECTION.images]: [imageBlob(toRgb565(input.background))],
        [SECTION.imageLists]: lists,
        [SECTION.widgets]: sources.map((s, i) => numberWidgetBlob(s, i)),
      },
    ],
  });
}

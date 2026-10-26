import { BAND8, band8FaceId, type Band8FaceInput, type Rgba } from './band8';

// Draws a Band 8 face with the browser's canvas: a black background with the user's text, and the digits
// 0–9 for each time position. Digits keep hard edges (alpha 0 or 255) so they run-length encode small:
// the band takes watchfaces at about 1.7 KB/s.

export interface Band8Design {
  text: string;
  /** CSS colour of the text and the minutes. */
  accent: string;
}

export const DEFAULT_DESIGN: Band8Design = { text: 'KHOI TRINH', accent: '#ffb02e' };

const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const CELL = { width: 72, height: 104, gap: 8 } as const;
const COLS = [(BAND8.width - 2 * CELL.width - CELL.gap) / 2, (BAND8.width + CELL.gap) / 2];
const ROWS = [72, 72 + CELL.height + 16];
/** The time shown in the preview picture. */
const PREVIEW_TIME = [1, 0, 0, 8];

const faceName = (design: Band8Design) => design.text.trim() || DEFAULT_DESIGN.text;

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function canvas(width: number, height: number): { c: HTMLCanvasElement | OffscreenCanvas; ctx: Ctx } {
  let c: HTMLCanvasElement | OffscreenCanvas;
  if (typeof OffscreenCanvas !== 'undefined') c = new OffscreenCanvas(width, height);
  else {
    c = document.createElement('canvas');
    c.width = width;
    c.height = height;
  }
  const ctx = c.getContext('2d') as Ctx | null;
  if (!ctx) throw new Error('canvas 2D is not available');
  return { c, ctx };
}

const pixels = (ctx: Ctx, width: number, height: number): Rgba => {
  const d = ctx.getImageData(0, 0, width, height);
  return { width, height, data: d.data };
};

function drawBackground(ctx: Ctx, design: Band8Design): void {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, BAND8.width, BAND8.height);
  ctx.fillStyle = design.accent;
  const top = ROWS[1] + CELL.height + 28;
  ctx.fillRect((BAND8.width - 40) / 2, top, 40, 3);
  // Largest bold size up to 30 px that fits the screen with an 10 px margin each side.
  const text = faceName(design);
  let size = 30;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (; size > 10; size--) {
    ctx.font = `bold ${size}px ${FONT}`;
    if (ctx.measureText(text).width <= BAND8.width - 20) break;
  }
  ctx.fillText(text, BAND8.width / 2, top + 22);
}

/** Frames 0–9 for one digit position, white for hours and the accent colour for minutes. */
function drawDigits(color: string): Rgba[] {
  const { ctx } = canvas(CELL.width, CELL.height);
  ctx.font = `bold 112px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const m = ctx.measureText('0');
  const baseline = (CELL.height + m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
  // The exact colour, so every opaque pixel is the same and runs stay long.
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const rgb = ctx.getImageData(0, 0, 1, 1).data.slice(0, 3);
  const frames: Rgba[] = [];
  for (let d = 0; d < 10; d++) {
    ctx.clearRect(0, 0, CELL.width, CELL.height);
    ctx.fillStyle = color;
    ctx.fillText(String(d), CELL.width / 2, baseline);
    const img = pixels(ctx, CELL.width, CELL.height);
    for (let i = 0; i < img.data.length; i += 4) {
      if (img.data[i + 3] >= 128) img.data.set([rgb[0], rgb[1], rgb[2], 255], i);
      else img.data.fill(0, i, i + 4);
    }
    frames.push(img);
  }
  return frames;
}

/** Everything buildBand8Face needs, plus the full-size screen at 10:08 for showing on the page. */
export function renderBand8Face(design: Band8Design): Band8FaceInput & { screen: Rgba } {
  const hours = drawDigits('#ffffff');
  const minutes = drawDigits(design.accent);
  const digits: Band8FaceInput['digits'] = [hours, hours, minutes, minutes];
  const positions: Band8FaceInput['positions'] = [
    [COLS[0], ROWS[0]],
    [COLS[1], ROWS[0]],
    [COLS[0], ROWS[1]],
    [COLS[1], ROWS[1]],
  ];

  const bg = canvas(BAND8.width, BAND8.height);
  drawBackground(bg.ctx, design);
  const background = pixels(bg.ctx, BAND8.width, BAND8.height);

  // The screen as the band draws it: digits are opaque or transparent, so copying non-transparent pixels is exact.
  const data = new Uint8ClampedArray(background.data);
  PREVIEW_TIME.forEach((d, i) => {
    const f = digits[i][d];
    const [x0, y0] = positions[i];
    for (let y = 0; y < f.height; y++)
      for (let x = 0; x < f.width; x++) {
        const s = (y * f.width + x) * 4;
        if (!f.data[s + 3]) continue;
        data.set(f.data.subarray(s, s + 4), ((y0 + y) * BAND8.width + x0 + x) * 4);
      }
  });
  const screen: Rgba = { width: BAND8.width, height: BAND8.height, data };

  const full = canvas(BAND8.width, BAND8.height);
  full.ctx.putImageData(new ImageData(data, BAND8.width, BAND8.height), 0, 0);
  const pv = canvas(BAND8.previewWidth, BAND8.previewHeight);
  pv.ctx.imageSmoothingQuality = 'high';
  pv.ctx.drawImage(full.c, 0, 0, BAND8.previewWidth, BAND8.previewHeight);
  const preview = pixels(pv.ctx, BAND8.previewWidth, BAND8.previewHeight);

  // The header holds 63 bytes of UTF-8 for the name.
  let name = faceName(design);
  while (new TextEncoder().encode(name).length > 63) name = name.slice(0, -1);
  return { id: band8FaceId(`${name}|${design.accent}`), name, background, preview, digits, positions, screen };
}

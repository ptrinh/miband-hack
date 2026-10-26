import { unzipSync } from 'fflate';
import { cstring, readU32le } from './bytes';
import { t } from '../i18n';

// Ported from Gadgetbridge XiaomiFWHelper (AGPL-3.0).

export type ParsedFile =
  | { kind: 'rpk'; bytes: Uint8Array; id: string; name: string; version: string; versionCode: number; icon?: Blob; manifest: Record<string, unknown> }
  | { kind: 'watchface'; bytes: Uint8Array; id: string; name: string }
  | { kind: 'unsupported'; bytes: Uint8Array; reason: string };

const WATCHFACE_V3_HEADER = [0x00, 0x00, 0x06, 0x07, 0x00, 0x02, 0x00, 0x01];
const MAX_SIZE = 128 * 1024 * 1024;

function isZip(b: Uint8Array): boolean {
  return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

function parseRpk(bytes: Uint8Array): ParsedFile | null {
  if (!isZip(bytes)) return null;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (f) => f.name === 'manifest.json' });
  } catch {
    return null;
  }
  const raw = files['manifest.json'];
  if (!raw) return null;
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return { kind: 'unsupported', bytes, reason: t('errNotJson') };
  }
  const id = manifest.package;
  const name = manifest.name;
  const version = manifest.versionName;
  if (typeof id !== 'string' || typeof name !== 'string' || version === undefined) {
    return { kind: 'unsupported', bytes, reason: t('errManifestFields') };
  }
  const versionCode = typeof manifest.versionCode === 'number' ? manifest.versionCode : 1;
  // Mi Band 10 firmware crashes on plain-JS quick apps; it only runs QuickJS bytecode (aiot release --enable-jsc).
  const names: string[] = [];
  try {
    unzipSync(bytes, { filter: (f) => (names.push(f.name), false) });
  } catch {
    /* already read once above */
  }
  if (names.includes('app.js') && !names.includes('app.jsc')) {
    return { kind: 'unsupported', bytes, reason: t('errRpkPlainJs') };
  }

  let icon: Blob | undefined;
  if (typeof manifest.icon === 'string') {
    const path = manifest.icon.replace(/^\//, '');
    try {
      const ic = unzipSync(bytes, { filter: (f) => f.name === path })[path];
      if (ic) icon = new Blob([ic.slice().buffer as ArrayBuffer], { type: path.endsWith('.webp') ? 'image/webp' : 'image/png' });
    } catch {
      /* icon is optional */
    }
  }
  return { kind: 'rpk', bytes, id, name, version: String(version), versionCode, icon, manifest };
}

function parseWatchfaceV2(fw: Uint8Array): ParsedFile | null {
  if (fw.length < 0x80 || fw[0] !== 0x5a || fw[1] !== 0xa5) return null;
  const id = cstring(fw, 0x28);
  if (!id || !/^\d+$/.test(id)) return { kind: 'unsupported', bytes: fw, reason: t('errFaceNoId') };
  let name: string | null;
  if (fw[0x68] === 0xff && fw[0x69] === 0xff && fw[0x6a] === 0xff && fw[0x6b] === 0xff) {
    name = extractLocalizedName(fw, readU32le(fw, 0x74), readU32le(fw, 0x78));
  } else {
    name = cstring(fw, 0x68);
  }
  return { kind: 'watchface', bytes: fw, id, name: name || `Watchface ${id}` };
}

/** Picks English (bit 0) or the first available locale from a localized name table. */
function extractLocalizedName(fw: Uint8Array, off: number, size: number): string | null {
  if (size <= 8 || off + size > fw.length) return null;
  const view = new DataView(fw.buffer, fw.byteOffset + off, size);
  let mask = view.getBigUint64(0, true);
  const sizes: number[] = [];
  const present: number[] = [];
  for (let i = 0; mask !== 0n; i++, mask >>= 1n) {
    if (mask & 1n) present.push(i);
  }
  let p = 8;
  for (let i = 0; i < present.length; i++, p += 4) {
    if (p + 4 > size) return null;
    sizes.push(view.getUint32(p, true));
  }
  const target = present.indexOf(0) >= 0 ? present.indexOf(0) : 0;
  let strOff = p;
  for (let i = 0; i < target; i++) strOff += sizes[i];
  if (strOff + sizes[target] > size) return null;
  return new TextDecoder().decode(fw.subarray(off + strOff, off + strOff + sizes[target]));
}

export function parseFile(bytes: Uint8Array): ParsedFile {
  if (bytes.length > MAX_SIZE) return { kind: 'unsupported', bytes, reason: t('errTooBig') };
  const wf = parseWatchfaceV2(bytes);
  if (wf) return wf;
  if (bytes.length >= 100 && WATCHFACE_V3_HEADER.every((v, i) => bytes[i] === v)) {
    return { kind: 'unsupported', bytes, reason: t('errFaceV3') };
  }
  if (bytes[0] === 96 && bytes[1] === 90 && bytes[2] === 90 && bytes[4] === 126) {
    return { kind: 'unsupported', bytes, reason: t('errFirmware') };
  }
  const rpk = parseRpk(bytes);
  if (rpk) return rpk;
  return { kind: 'unsupported', bytes, reason: t('errUnknownFormat') };
}

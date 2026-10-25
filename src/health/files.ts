import { concat, readU16le, readU32le } from '../core/bytes';
import { crc32 } from '../core/checksum';

// Recorded health ("activity") files, reimplemented from Gadgetbridge's XiaomiActivityFileId and
// XiaomiActivityFileFetcher (AGPL-3.0) as a protocol reference.
//
// File id, 7 bytes: u32 LE unix time | i8 timezone (15 min units) | u8 version |
//                   flags: bit 7 type (0 activity, 1 sports), bits 2-6 subtype, bits 0-1 detail type.
// A file on the wire: id(7) | 00 | body | crc32 LE of everything before it.

export const TYPE_ACTIVITY = 0;
export const TYPE_SPORTS = 1;
export const DETAIL_DETAILS = 0;
export const DETAIL_SUMMARY = 1;
export const DETAIL_GPS = 2;

export const ACTIVITY_DAILY = 0x00;
export const ACTIVITY_SLEEP_STAGES = 0x03;
export const ACTIVITY_MANUAL_SAMPLES = 0x06;
export const ACTIVITY_SLEEP = 0x08;

const ACTIVITY_NAMES: Record<number, string> = {
  [ACTIVITY_DAILY]: 'daily',
  [ACTIVITY_SLEEP_STAGES]: 'sleep_stages',
  [ACTIVITY_MANUAL_SAMPLES]: 'manual_samples',
  [ACTIVITY_SLEEP]: 'sleep',
};

export const SPORT_NAMES: Record<number, string> = {
  0x01: 'outdoor_running',
  0x02: 'outdoor_walking',
  0x03: 'treadmill',
  0x06: 'outdoor_cycling',
  0x07: 'indoor_cycling',
  0x08: 'freestyle',
  0x09: 'pool_swimming',
  0x0b: 'elliptical',
  0x0d: 'rowing',
  0x0e: 'jump_rope',
  0x10: 'hiit',
  0x16: 'outdoor_walking',
  0x17: 'outdoor_cycling',
};

const DETAIL_NAMES: Record<number, string> = { [DETAIL_DETAILS]: 'details', [DETAIL_SUMMARY]: 'summary', [DETAIL_GPS]: 'gps_track' };

export interface FileId {
  /** Unix seconds. */
  ts: number;
  /** Band timezone in 15-minute units (signed). */
  tz: number;
  version: number;
  type: number;
  subtype: number;
  detail: number;
}

export interface HealthFile {
  id: FileId;
  /** The whole file as received, including id, padding and crc. */
  bytes: Uint8Array;
}

export function parseFileId(b: Uint8Array, off = 0): FileId {
  const flags = b[off + 6];
  return {
    ts: readU32le(b, off),
    tz: (b[off + 4] << 24) >> 24,
    version: b[off + 5],
    type: (flags >> 7) & 1,
    subtype: (flags & 0x7f) >> 2,
    detail: flags & 3,
  };
}

export function encodeFileId(id: FileId): Uint8Array {
  const out = new Uint8Array(7);
  new DataView(out.buffer).setUint32(0, id.ts >>> 0, true);
  out[4] = id.tz & 0xff;
  out[5] = id.version & 0xff;
  out[6] = ((id.type & 1) << 7) | ((id.subtype & 0x1f) << 2) | (id.detail & 3);
  return out;
}

/** A list of ids as the band sends it (n × 7 bytes); all-zero entries are skipped like Gadgetbridge does. */
export function parseFileIdList(b: Uint8Array | undefined): FileId[] {
  if (!b || b.length % 7 !== 0) return [];
  const ids: FileId[] = [];
  for (let off = 0; off < b.length; off += 7) {
    const id = parseFileId(b, off);
    if (id.ts === 0 && id.version === 0) continue;
    ids.push(id);
  }
  return ids;
}

export const typeName = (id: FileId): string => (id.type === TYPE_SPORTS ? 'sports' : 'activity');

export function subtypeName(id: FileId): string {
  const n = id.type === TYPE_SPORTS ? SPORT_NAMES[id.subtype] : ACTIVITY_NAMES[id.subtype];
  return n ?? `unknown_${id.subtype.toString(16).padStart(2, '0')}`;
}

export const detailName = (id: FileId): string => DETAIL_NAMES[id.detail] ?? `unknown_${id.detail}`;

export const fileIdKey = (id: FileId): string => Array.from(encodeFileId(id), (x) => x.toString(16).padStart(2, '0')).join('');

/** Path of the raw file inside the export zip, close to Gadgetbridge's rawFetchOperations layout (but UTC). */
export function rawFileName(id: FileId): string {
  const iso = new Date(id.ts * 1000).toISOString();
  const stamp = `${iso.slice(0, 10).replaceAll('-', '')}T${iso.slice(11, 19).replaceAll(':', '')}Z`;
  const h = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
  return `${iso.slice(0, 4)}/${typeName(id)}/${subtypeName(id)}/${detailName(id)}/${stamp}_${h(id.type)}_${h(id.subtype)}_${h(id.detail)}_v${id.version}.bin`;
}

/** Gadgetbridge's fetch order: by time, then summaries before details before GPS tracks. */
export function compareFileIds(a: FileId, b: FileId): number {
  const order = (d: number) => (d === DETAIL_SUMMARY ? 0 : d === DETAIL_DETAILS ? 1 : d === DETAIL_GPS ? 2 : 3);
  return a.ts - b.ts || a.tz - b.tz || a.type - b.type || a.subtype - b.subtype || order(a.detail) - order(b.detail) || a.version - b.version;
}

export function sameFileId(a: FileId, b: FileId): boolean {
  return fileIdKey(a) === fileIdKey(b);
}

/** Checks length and crc32 of a complete file; returns its id, or throws. */
export function checkFile(bytes: Uint8Array): FileId {
  if (bytes.length < 13) throw new Error(`activity file too short (${bytes.length} B)`);
  const crc = readU32le(bytes, bytes.length - 4);
  if (crc32(bytes.subarray(0, bytes.length - 4)) !== crc) throw new Error('activity file crc32 mismatch');
  return parseFileId(bytes);
}

/** Reassembles activity-channel chunks (u16 total | u16 index, 1-based | data) into one file. */
export class ActivityAssembler {
  private parts: Uint8Array[] = [];

  /** Returns the complete file after its last chunk, otherwise null. */
  push(chunk: Uint8Array): Uint8Array | null {
    if (chunk.length < 4) throw new Error('activity chunk too short');
    const total = readU16le(chunk, 0);
    const index = readU16le(chunk, 2);
    if (index === 1) this.parts = [];
    else if (index !== this.parts.length + 1) {
      this.parts = [];
      throw new Error(`activity chunk ${index}/${total} out of order`);
    }
    this.parts.push(chunk.slice(4));
    if (index !== total) return null;
    const file = concat(...this.parts);
    this.parts = [];
    return file;
  }

  reset(): void {
    this.parts = [];
  }
}

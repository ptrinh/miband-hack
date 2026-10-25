import { crc32 } from '../src/core/checksum';

// Fixture bytes for the health file decoders.
//
// REAL_* are captures from real bands, copied from Gadgetbridge's test suite (AGPL-3.0):
// ManualSamplesParserTest (Mi Band 9 Active), WorkoutSummaryParserTest (various bands), with the
// values Gadgetbridge's tests assert (checked there against the band's own UI).
// The build* helpers write synthetic files following the documented layouts, independently of
// src/health/parsers.ts, so the round trip checks our reading of the format, not real firmware.

export const fromHex = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, 'hex'));
export const fromB64 = (b: string): Uint8Array => new Uint8Array(Buffer.from(b, 'base64'));

/** "21F328650403A0": 2023-10-13T07:34:57Z, tz 4 (UTC+1), version 3, sports / freestyle / details. */
export const REAL_FILE_ID = '21F328650403A0';

export const REAL_MANUAL_SPO2_97 = 'EFB9856AF4011800FFEFB9856A0261511E4648';
export const REAL_MANUAL_STRESS_40 = '65C0856AF4011800FF65C0856A03288CA20578';

export const REAL_WORKOUTS = {
  rowingV8: {
    b64: 'JaCJaggItQD/v/+b8X8loIlquaCJapMAAAAOAIGRapqZmT4BAAAAAAAAAAAAAAAzAAAAOwAAACUAAAAAAAAAABMALgAAABIAAAAbAAAAAAAAAAAAAAAAAAAAAZMAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAIAAAAAAAB+WRxL',
    expect: { sport: 'rowing', activeSec: 147, hrAvg: 129, hrMax: 145, hrMin: 106 },
  },
  indoorCyclingV9: {
    b64: 'UB+6ZwQJnQD/7++f/kOAf1Afume6KLpnagkAAAAAAACIAgAAAACHll6amTlAAABIAAAAAAAAAAAAbQQAAMQEAAAjAAAARwNqCQAAAAAAAAAAAAgHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFUAAgAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGaZY0A==',
    expect: { sport: 'indoor_cycling', hrAvg: 135, hrMax: 150, hrMin: 94 },
  },
  outdoorCyclingV2v3: {
    b64: 'oTrCaggDmQD////AoTrCavBgwmpmGQAAqkYAAEoCxwAAAMwCAACLKwtCesY7nNnmQzUz4kPZ5u5DZmYYRGaml0MAAEBAMhceAFUAAAAiAQAAEwYAAFQHAACnBwAA2QIAAAAAAAAAAOyp/+M=',
    expect: { sport: 'outdoor_cycling', activeSec: 6502, distanceM: 18090, kcal: 586, hrAvg: 122, hrMax: 198, hrMin: 59, end: new Date(1791123696000).toISOString() },
  },
  outdoorWalkingV1v3: {
    b64: 'JB/BaggDiQD////wJB/Bah8nwWr4BwAAzAUAAFIALwMAAAAAAAD877RAsAgAAJYAVm1HAAAAQDAzW0KVU55DM7OxQzMzlUOamZk+MgEAAAAAAAAAAAAAAAAAAAAAAACPAQAAfwAAAAAAAAAAAOU1xJ8=',
    expect: { sport: 'outdoor_walking', activeSec: 2040, distanceM: 1484, kcal: 82, steps: 2224, hrAvg: 86, hrMax: 109, hrMin: 71 },
  },
  treadmillV9: {
    b64: 'WCA4aggJjQD//H+QDiBYIDhqhyY4aigGAACgCgAAwAByAQAAlAUAAJAMAAC0AIelZDMz8z8CAAAAIAAAAAAAcAAAAPwCAAB0AQAAOgEAAOgAKAYAAAAAAAABAwAAAFgCAAAsAYgTAABKAQAAAADIQQAAoAoAABwAAQAAAAAAAA8AAAAAAAAAAAAAAAAAAwAAh6VkA1B6ALQAhdLGQAisHEFYIDhqhyY4agAAAAAoBgAAKAYAAAAAAAAAAAAAwAAAAKAKAACQDAAAQwIAAHIBAAAAAAAAAAAAAAAAAAADAAAAAAAAAAAAAAAAAAAAAAAAAHAAAAD8AgAAdAEAADoBAAAAAAIBMzPzPwAAAAAAAAAADwAcACAAAAAAAAAAAAAAAAAAAAAAAaiMNkSR',
    expect: { sport: 'treadmill', kcal: 192, distanceM: 2720 },
  },
} as const;

// ------------------------------------------------------------ builders ---

export interface Id { ts: number; tz?: number; version: number; type: 0 | 1; subtype: number; detail: number }

export function idBytes(id: Id): Buffer {
  const b = Buffer.alloc(7);
  b.writeUInt32LE(id.ts, 0);
  b.writeInt8(id.tz ?? 0, 4);
  b[5] = id.version;
  b[6] = (id.type << 7) | (id.subtype << 2) | id.detail;
  return b;
}

/** id | 00 | body | crc32 */
export function wrap(id: Id, body: Buffer): Uint8Array {
  const head = Buffer.concat([idBytes(id), Buffer.from([0]), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32LE(crc32(head), 0);
  return new Uint8Array(Buffer.concat([head, crc]));
}

export interface Minute { steps: number; kcal: number; distanceM: number; hr: number; spo2: number; stress: number; extra?: boolean }

/**
 * Daily details v4. Header nibbles (present | valid bits): steps group 0xB (extra flag + steps),
 * calories 0xA, unknown 0, distance 0xC, HR 0xC, energy 0, unknown 0, SpO2 0xC, stress 0xC, light 0, movement 0.
 */
export function dailyDetailsV4(ts: number, minutes: Minute[], tz = 0): Uint8Array {
  const parts: Buffer[] = [Buffer.from([0xba, 0x0c, 0xc0, 0x0c, 0xc0, 0x00])];
  for (const m of minutes) {
    const b = Buffer.alloc(8);
    b.writeUInt16LE(((m.extra ? 1 : 0) << 14) | (m.steps & 0x3fff), 0);
    b[2] = m.kcal & 0x3f;
    b.writeUInt16LE(m.distanceM, 3);
    b[5] = m.hr;
    b[6] = m.spo2;
    b[7] = m.stress;
    parts.push(b);
    if (m.extra) parts.push(Buffer.from([0x99]));
  }
  return wrap({ ts, tz, version: 4, type: 0, subtype: 0, detail: 0 }, Buffer.concat(parts));
}

/** Daily summary v5: all 32 slots valid; steps, active kcal, HR, stress, standing, SpO2 set. */
export function dailySummaryV5(ts: number, tz: number, v: { steps: number; hrResting: number; hrMax: number; hrMaxAt: number; spo2Avg: number; standingBits: number }): Uint8Array {
  const b = Buffer.alloc(57);
  let o = 0;
  const u8 = (x: number) => (b[o++] = x);
  const u16 = (x: number) => ((b.writeUInt16LE(x, o)), (o += 2));
  const u32 = (x: number) => ((b.writeUInt32LE(x, o)), (o += 4));
  u32(v.steps); u16(250); u8(0); u8(v.hrResting); u8(v.hrMax); u32(v.hrMaxAt); u8(55); u32(v.hrMaxAt - 3600); u8(80);
  u8(40); u8(90); u8(10);
  u8(v.standingBits & 0xff); u8((v.standingBits >> 8) & 0xff); u8((v.standingBits >> 16) & 0xff);
  u16(2200); u16(12); u8(0); u8(99); u32(v.hrMaxAt); u8(92); u32(v.hrMaxAt); u8(v.spo2Avg);
  u16(130); u16(700); u8(2); u8(5); u8(25); u8(40); u16(280); u8(0); u8(0); u16(0); u16(0);
  if (o !== 57) throw new Error(`summary fixture is ${o} bytes`);
  return wrap({ ts, tz, version: 5, type: 0, subtype: 0, detail: 1 }, Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff]), b]));
}

/** Sleep stages v2 (stage codes as stored by Gadgetbridge: 2 deep, 3 light, 4 REM, 5 awake). */
export function sleepStagesV2(ts: number, bed: number, wake: number, stages: [number, number][]): Uint8Array {
  const b = Buffer.alloc(7 + 2 + 4 + 4 + 3 + 8 + 1);
  b.fill(0xff, 0, 2);
  b.writeUInt16LE(Math.round((wake - bed) / 60), 7);
  b.writeUInt32LE(bed, 9);
  b.writeUInt32LE(wake, 13);
  b.writeUInt16LE(120, 20); // deep
  b.writeUInt16LE(240, 22); // light
  b.writeUInt16LE(90, 24); // rem
  b.writeUInt16LE(30, 26); // awake
  const st = stages.map(([t, s]) => {
    const x = Buffer.alloc(5);
    x.writeUInt32LE(t, 0);
    x[4] = s;
    return x;
  });
  return wrap({ ts, version: 2, type: 0, subtype: 3, detail: 0 }, Buffer.concat([b, ...st]));
}

function stagePacket(type: number, ts: bigint, data: Buffer): Buffer {
  const h = Buffer.alloc(17);
  h.writeUInt32LE(0xfffcfafb, 0);
  h[4] = 17;
  h.writeBigUInt64LE(ts, 5);
  h[13] = 1;
  h[14] = type;
  h.writeUInt16BE(data.length, 15);
  return Buffer.concat([h, data]);
}

/**
 * Sleep details v5: score, in-bed time, HR and SpO2 sample blocks, a summary packet (16),
 * a stages packet (17), a breathing-rate packet (0x0a) and a flag packet without data (2).
 */
export function sleepDetailsV5(ts: number, bed: number, wake: number): Uint8Array {
  const head = Buffer.alloc(1 + 4 + 4 + 1 + 9 + 4 + 4);
  let o = 0;
  head[o++] = 0; // awake flag
  head.writeUInt32LE(bed, o); o += 4;
  head.writeUInt32LE(wake, o); o += 4;
  head[o++] = 85; // score
  o += 9;
  head.writeUInt32LE(bed - 1800, o); o += 4; // in bed
  head.writeUInt32LE(wake, o);
  const hr = Buffer.alloc(8 + 3);
  hr.writeUInt16LE(60, 0); hr.writeUInt16LE(3, 2); hr.writeUInt32LE(bed, 4); hr.set([58, 0, 61], 8);
  const spo2 = Buffer.alloc(8 + 2);
  spo2.writeUInt16LE(600, 0); spo2.writeUInt16LE(2, 2); spo2.writeUInt32LE(bed, 4); spo2.set([96, 94], 8);
  const summary = Buffer.alloc(13);
  summary[0] = 0x12;
  [420, 25, 250, 80, 90].forEach((v, i) => summary.writeUInt16BE(v, 1 + i * 2));
  summary[11] = 0x14;
  const stages = Buffer.alloc(6);
  stages.writeUInt16BE((1 << 12) | 30, 0); // light 30 min
  stages.writeUInt16BE((2 << 12) | 60, 2); // deep 60 min
  stages.writeUInt16BE((3 << 12) | 20, 4); // REM 20 min
  const breath = Buffer.from([100, 14, 0, 0, 100, 15, 0, 0, 100, 99, 0, 0]); // 99 is implausible, dropped
  const body = Buffer.concat([
    Buffer.from([0xf0, 0x60]), // valid: awake, bed, wake, score, ..., HR (9), SpO2 (10); not snore (11)
    head,
    hr,
    spo2,
    Buffer.from([0x00, 0x13]), // junk before the first packet, skipped by the magic scan
    stagePacket(2, BigInt(bed), Buffer.alloc(0)),
    stagePacket(16, BigInt(bed), summary),
    stagePacket(17, BigInt(bed), stages),
    stagePacket(0x0a, BigInt(bed + 600) * 1_000_000_000n, breath),
  ]);
  return wrap({ ts, version: 5, type: 0, subtype: 8, detail: 1 }, body);
}

/** Manual samples v2: HR, SpO2, stress, temperature, a zero value (skipped). */
export function manualSamplesV2(ts: number): Uint8Array {
  const rec = (t: number, type: number, v: Buffer) => Buffer.concat([Buffer.from(new Uint32Array([t]).buffer), Buffer.from([type]), v]);
  return wrap(
    { ts, version: 2, type: 0, subtype: 6, detail: 0 },
    Buffer.concat([
      rec(ts + 60, 0x11, Buffer.from([72])),
      rec(ts + 120, 0x12, Buffer.from([97])),
      rec(ts + 180, 0x13, Buffer.from([0])),
      rec(ts + 240, 0x13, Buffer.from([33])),
      rec(ts + 300, 0x44, Buffer.from('5a0e0000', 'hex')),
    ]),
  );
}

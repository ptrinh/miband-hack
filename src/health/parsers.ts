import type { ActivityMinute, DailySummary, Sample, SleepSession, SleepStage, Workout } from './schema';
import {
  ACTIVITY_DAILY,
  ACTIVITY_MANUAL_SAMPLES,
  ACTIVITY_SLEEP,
  ACTIVITY_SLEEP_STAGES,
  DETAIL_DETAILS,
  DETAIL_SUMMARY,
  type FileId,
  rawFileName,
  SPORT_NAMES,
  TYPE_ACTIVITY,
  TYPE_SPORTS,
} from './files';

// Decoders for the band's recorded health files. The layouts are reimplemented from
// Gadgetbridge's xiaomi/activity/impl/*Parser.java (AGPL-3.0), used as a protocol reference:
// DailyDetailsParser, DailySummaryParser, SleepStagesParser, SleepDetailsParser,
// ManualSamplesParser and the leading fields of WorkoutSummaryParser. Anything else is kept raw.

export interface Parsed {
  decoded: 'full' | 'partial' | 'raw';
  note?: string;
  activity?: ActivityMinute[];
  heartRate?: Sample[];
  spo2?: Sample[];
  stress?: Sample[];
  respiratoryRate?: Sample[];
  temperature?: (Sample & { raw: string })[];
  daily?: DailySummary[];
  sleep?: SleepSession[];
  workouts?: Workout[];
}

const iso = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString();
const isoMs = (ms: number): string => new Date(ms).toISOString();

/** Little-endian reader with bounds checks (a short file throws instead of yielding garbage). */
export class Reader {
  pos: number;
  limit: number;
  private readonly dv: DataView;

  constructor(readonly b: Uint8Array, start = 0, limit = b.length) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    this.pos = start;
    this.limit = limit;
  }

  get remaining(): number {
    return this.limit - this.pos;
  }

  private need(n: number): number {
    if (this.pos + n > this.limit) throw new RangeError(`read past end (${this.pos}+${n} > ${this.limit})`);
    const p = this.pos;
    this.pos += n;
    return p;
  }

  u8 = (): number => this.dv.getUint8(this.need(1));
  u16 = (): number => this.dv.getUint16(this.need(2), true);
  u16be = (): number => this.dv.getUint16(this.need(2), false);
  i16 = (): number => this.dv.getInt16(this.need(2), true);
  u32 = (): number => this.dv.getUint32(this.need(4), true);
  i32 = (): number => this.dv.getInt32(this.need(4), true);
  f32 = (): number => this.dv.getFloat32(this.need(4), true);
  /** u64 LE as a Number (precision loss above 2^53 is fine for the nanosecond timestamps it is used for). */
  u64 = (): number => {
    const p = this.need(8);
    return this.dv.getUint32(p + 4, true) * 2 ** 32 + this.dv.getUint32(p, true);
  };
  bytes = (n: number): Uint8Array => {
    const p = this.need(n);
    return this.b.subarray(p, p + n);
  };
  skip = (n: number): void => void this.need(n);
}

/** Bit i of a validity bitmap, MSB first (XiaomiActivityParser.validData). */
export const validBit = (header: Uint8Array, i: number): boolean => (header[i >> 3] & (1 << (7 - (i & 7)))) !== 0;

/**
 * XiaomiComplexActivityParser: the header holds one nibble per field group; bit 3 says the group
 * is present, bits 2..0 say which of its (up to three) values are valid.
 */
export class ComplexReader {
  private group = -1;
  private bits = 0;
  private val = 0;

  constructor(private readonly header: Uint8Array, private readonly r: Reader) {}

  reset(): void {
    this.group = -1;
    this.bits = 0;
    this.val = 0;
  }

  private nibble(): number {
    const b = this.header[this.group >> 1];
    return this.group % 2 === 0 ? b >> 4 : b & 0x0f;
  }

  private consume(n: number): number {
    return n === 8 ? this.r.u8() : n === 16 ? this.r.u16() : this.r.u32();
  }

  nextGroup(nBits: number): boolean {
    this.group++;
    if (this.group >= this.header.length * 2) {
      this.consume(nBits); // as Gadgetbridge: keep the buffer moving instead of looping forever
      return false;
    }
    if ((this.nibble() & 8) === 0) return false;
    this.bits = nBits;
    this.val = this.consume(nBits);
    return true;
  }

  has(idx: number): boolean {
    return (this.nibble() & (1 << (2 - idx))) !== 0;
  }

  get(idx: number, nBits: number): number {
    const shift = this.bits - idx - nBits;
    return Math.floor(this.val / 2 ** shift) & ((1 << nBits) - 1);
  }
}

/** Skips id(7) + padding(1); `withCrc` also excludes the trailing crc32 from reads. */
function body(bytes: Uint8Array, withCrc: boolean): Reader {
  return new Reader(bytes, 8, withCrc ? bytes.length - 4 : bytes.length);
}

const validHr = (v: number): boolean => v > 0 && v < 255;
const validPct = (v: number): boolean => v > 0 && v <= 100;

// ---------------------------------------------------------- daily details ---

const DAILY_DETAILS_HEADER: Record<number, number> = { 1: 4, 2: 4, 3: 5, 4: 6 };

/** One record per minute from the file's timestamp: steps, distance, calories, HR, SpO2, stress. */
export function parseDailyDetails(id: FileId, bytes: Uint8Array): Parsed {
  const headerSize = DAILY_DETAILS_HEADER[id.version];
  if (!headerSize) return { decoded: 'raw', note: `daily details version ${id.version} not known` };
  const r = body(bytes, true);
  const cx = new ComplexReader(r.bytes(headerSize), r);
  const out: Parsed = { decoded: 'full', activity: [], heartRate: [], spo2: [], stress: [] };
  let ts = id.ts;
  try {
    while (r.remaining > 0) {
      cx.reset();
      const m: ActivityMinute = { t: iso(ts) };
      let extraByte = 0;
      if (cx.nextGroup(16)) {
        if (cx.has(1)) extraByte = cx.get(1, 1);
        if (cx.has(2)) m.steps = cx.get(2, 14);
      }
      if (cx.nextGroup(8) && cx.has(1)) m.activeKcal = cx.get(2, 6);
      cx.nextGroup(8); // unknown
      if (cx.nextGroup(16) && cx.has(0)) m.distanceM = cx.get(0, 16);
      if (cx.nextGroup(8) && cx.has(0)) m.heartRate = cx.get(0, 8);
      if (cx.nextGroup(8) && cx.has(0)) m.energy = cx.get(0, 8);
      cx.nextGroup(16); // unknown
      if (id.version >= 3) {
        if (cx.nextGroup(8) && cx.has(0)) m.spo2 = cx.get(0, 8);
        if (cx.nextGroup(8) && cx.has(0)) {
          const s = cx.get(0, 8);
          if (s !== 255) m.stress = s;
        }
      }
      if (extraByte === 1) r.u8();
      if (id.version >= 4) {
        cx.nextGroup(16); // light level (not decoded)
        cx.nextGroup(16); // body movement (not decoded)
      }
      if (m.heartRate !== undefined && !validHr(m.heartRate)) delete m.heartRate;
      if (m.spo2 !== undefined && !validPct(m.spo2)) delete m.spo2;
      out.activity!.push(m);
      if (m.heartRate !== undefined) out.heartRate!.push({ t: m.t, value: m.heartRate, source: 'minute' });
      if (m.spo2 !== undefined) out.spo2!.push({ t: m.t, value: m.spo2, source: 'minute' });
      if (m.stress !== undefined) out.stress!.push({ t: m.t, value: m.stress, source: 'minute' });
      ts += 60;
    }
  } catch (e) {
    out.decoded = 'partial';
    out.note = `stopped after ${out.activity!.length} minutes: ${(e as Error).message}`;
  }
  return out;
}

// ---------------------------------------------------------- daily summary ---

type Slot = [bytes: number, set?: (d: DailySummary, v: number) => void];

// Slot i is valid when bit i of the header bitmap is set; each slot always consumes its bytes.
const SUMMARY_SLOTS: Slot[] = [
  [4, (d, v) => (d.steps = v)],
  [2, (d, v) => (d.activeKcal = v)],
  [1],
  [1, (d, v) => (d.hrResting = v)],
  [1, (d, v) => (d.hrMax = v)],
  [4, (d, v) => (d.hrMaxAt = iso(v))],
  [1, (d, v) => (d.hrMin = v)],
  [4, (d, v) => (d.hrMinAt = iso(v))],
  [1, (d, v) => (d.hrAvg = v)],
  [1, (d, v) => (d.stressAvg = v)],
  [1, (d, v) => (d.stressMax = v)],
  [1, (d, v) => (d.stressMin = v)],
  [3, (d, v) => (d.standingHours = Array.from({ length: 24 }, (_, h) => h).filter((h) => (v >> h) & 1))],
  [2, (d, v) => (d.kcal = v)],
  [2, (d, v) => (d.recoveryHours = v)],
  [1],
  [1, (d, v) => (d.spo2Max = v)],
  [4, (d, v) => (d.spo2MaxAt = iso(v))],
  [1, (d, v) => (d.spo2Min = v)],
  [4, (d, v) => (d.spo2MinAt = iso(v))],
  [1, (d, v) => (d.spo2Avg = v)],
  [2, (d, v) => (d.trainingLoadDay = v)],
  [2, (d, v) => (d.trainingLoadWeek = v)],
  [1, (d, v) => (d.trainingLoadLevel = v)],
  [1, (d, v) => (d.vitalityLight = v)],
  [1, (d, v) => (d.vitalityModerate = v)],
  [1, (d, v) => (d.vitalityHigh = v)],
  [2, (d, v) => (d.vitalityCurrent = v)],
  [1],
  [1],
  [2],
  [2],
];

const DAILY_SUMMARY_LAYOUT: Record<number, [headerSize: number, slots: number]> = { 3: [3, 21], 4: [3, 21], 5: [4, 32] };

/** The band's local calendar day of a file, from its timestamp and timezone. */
export function localDate(id: FileId): string {
  return new Date((id.ts + id.tz * 15 * 60) * 1000).toISOString().slice(0, 10);
}

export function parseDailySummary(id: FileId, bytes: Uint8Array): Parsed {
  const layout = DAILY_SUMMARY_LAYOUT[id.version];
  if (!layout) return { decoded: 'raw', note: `daily summary version ${id.version} not known` };
  const r = body(bytes, false);
  const header = r.bytes(layout[0]);
  const d: DailySummary = { date: localDate(id), t: iso(id.ts), tzOffsetMinutes: id.tz * 15 };
  for (let i = 0; i < layout[1]; i++) {
    const [n, set] = SUMMARY_SLOTS[i];
    const v = n === 1 ? r.u8() : n === 2 ? r.u16() : n === 3 ? r.u8() | (r.u8() << 8) | (r.u8() << 16) : r.u32();
    if (set && validBit(header, i)) set(d, v);
  }
  return { decoded: 'full', daily: [d] };
}

// ----------------------------------------------------------- sleep stages ---

/** Stage codes of the sleep-stages file, as Gadgetbridge stores them (XiaomiSampleProvider). */
const STAGES_FILE_CODES: Record<number, SleepStage> = { 2: 'deep', 3: 'light', 4: 'rem', 5: 'awake' };

export function parseSleepStages(id: FileId, bytes: Uint8Array): Parsed {
  if (id.version !== 2) return { decoded: 'raw', note: `sleep stages version ${id.version} not known` };
  const r = body(bytes, true);
  r.skip(7);
  const total = r.u16();
  const bed = r.u32();
  const wake = r.u32();
  r.skip(3);
  const deep = r.u16();
  const light = r.u16();
  const rem = r.u16();
  const awake = r.u16();
  if (!bed || !wake || !total) return { decoded: 'full', note: 'empty sleep record', sleep: [] };
  r.u8();
  const stages: SleepSession['stages'] = [];
  while (r.remaining >= 5) {
    const t = r.u32();
    stages.push({ t: iso(t), stage: STAGES_FILE_CODES[r.u8()] ?? 'unknown' });
  }
  return {
    decoded: 'full',
    sleep: [{ start: iso(bed), end: iso(wake), totalMin: total, deepMin: deep, lightMin: light, remMin: rem, awakeMin: awake, stages, source: 'sleep_stages', file: rawFileName(id) }],
  };
}

// ---------------------------------------------------------- sleep details ---

const PACKET_MAGIC = 0xfffcfafb;
const PACKETS_WITHOUT_DATA = new Set([0x2, 0x3, 0x9, 0xc, 0xd, 0xe, 0xf, 0x12]);
const DETAIL_STAGE_CODES: SleepStage[] = ['awake', 'light', 'deep', 'rem']; // raw 4 = not asleep → unknown

/** Scans for the next stage packet (u32 LE 0xfffcfafb), as SleepDetailsParser.readStagePacketHeader. */
function nextPacket(r: Reader): boolean {
  while (r.remaining >= 17) {
    if (r.u32() === PACKET_MAGIC) return true;
    r.pos -= 3;
  }
  return false;
}

/** Sample block inside the sleep file: u16 interval | u16 count | (v2+) u32 first time | count values. */
function sleepSamples(r: Reader, id: FileId, bed: number, size: 1 | 4, out: Sample[] | null): void {
  const interval = r.u16();
  const count = r.u16();
  if (count === 0) return;
  const first = id.version >= 2 ? r.u32() : bed;
  for (let i = 0; i < count; i++) {
    const v = size === 1 ? r.u8() : r.f32();
    // The interval unit is not documented; seconds is assumed (see docs/health-data.md).
    if (out && validHr(v)) out.push({ t: iso(first + interval * i), value: v, source: 'sleep' });
  }
}

export function parseSleepDetails(id: FileId, bytes: Uint8Array): Parsed {
  if (id.version < 1 || id.version > 5) return { decoded: 'raw', note: `sleep details version ${id.version} not known` };
  const r = body(bytes, false);
  const header = r.bytes(id.version === 5 ? 2 : 1);
  let idx = 0;
  const awakeFlag = r.u8();
  idx++;
  const bed = r.u32();
  idx++;
  const wake = r.u32();
  idx++;
  const s: SleepSession = { start: iso(bed), end: iso(wake), awakeFlag, stages: [], source: 'sleep_details', file: rawFileName(id) };
  if (id.version >= 4) {
    if (validBit(header, idx)) s.quality = r.u8();
    idx++;
  }
  if (id.version >= 5) {
    r.skip(9);
    s.inBed = iso(r.u32());
    r.u32(); // wake-up time again
    idx += 5;
  }
  const out: Parsed = { decoded: 'full', sleep: [s], heartRate: [], spo2: [], respiratoryRate: [] };
  try {
    if (validBit(header, idx)) sleepSamples(r, id, bed, 1, out.heartRate!);
    idx++;
    if (validBit(header, idx)) sleepSamples(r, id, bed, 1, out.spo2!);
    idx++;
    if (id.version >= 3) {
      if (validBit(header, idx)) sleepSamples(r, id, bed, 4, null); // snore levels, not exported
      idx++;
    }
    while (nextPacket(r)) {
      r.u8(); // packet header length (17)
      const ts = r.u64();
      r.u8(); // parity
      const type = r.u8();
      const len = r.u16be();
      if (PACKETS_WITHOUT_DATA.has(type)) continue;
      const d = new Reader(r.bytes(len));
      if (type === 16) {
        d.u8(); // sleep index | wake count
        s.totalMin = d.u16be();
        s.awakeMin = d.u16be();
        s.lightMin = d.u16be();
        s.remMin = d.u16be();
        s.deepMin = d.u16be();
      } else if (type === 17) {
        let t = ts * 1000;
        for (let i = 0; i < len >> 1; i++) {
          const v = d.u16be();
          s.stages.push({ t: isoMs(t), stage: DETAIL_STAGE_CODES[v >> 12] ?? 'unknown' });
          t += (v & 0xfff) * 60_000;
        }
      } else if (type === 0x0a) {
        // 4 bytes per record, slot 1 = breaths per minute; records spread over the 10 minutes before ts (ns)
        const n = len >> 2;
        const end = Math.round(ts / 1e6);
        for (let i = 0; i < n; i++) {
          d.u8();
          const rate = d.u8();
          d.skip(2);
          if (rate >= 1 && rate <= 40) out.respiratoryRate!.push({ t: isoMs(end - 600_000 + ((i + 1) * 600_000) / (n + 1)), value: rate, source: 'sleep' });
        }
      }
      // type 1 = RR intervals and the rest are left in the raw file
    }
  } catch (e) {
    out.decoded = 'partial';
    out.note = `sleep packets: ${(e as Error).message}`;
  }
  out.spo2 = out.spo2!.filter((x) => validPct(x.value));
  return out;
}

// --------------------------------------------------------- manual samples ---

const MANUAL_HR = 0x11;
const MANUAL_SPO2 = 0x12;
const MANUAL_STRESS = 0x13;
const MANUAL_TEMPERATURE = 0x44;

export function parseManualSamples(id: FileId, bytes: Uint8Array): Parsed {
  const out: Parsed = { decoded: 'full', heartRate: [], spo2: [], stress: [], temperature: [] };
  const r = body(bytes, true);
  if (id.version === 1) {
    // Mi Band 9 Active: 0xff, then 6-byte records (u32 time | type | u8 value)
    if (r.u8() !== 0xff) return { decoded: 'raw', note: 'manual samples v1: unexpected header' };
    while (r.remaining >= 6) {
      const t = iso(r.u32());
      const type = r.u8();
      const value = r.u8();
      if (!validPct(value)) continue;
      if (type === 0x02) out.spo2!.push({ t, value, source: 'manual' });
      else if (type === 0x03) out.stress!.push({ t, value, source: 'manual' });
      else return { ...out, decoded: 'partial', note: `manual samples v1: unknown type ${type}` };
    }
    return out;
  }
  if (id.version !== 2) return { decoded: 'raw', note: `manual samples version ${id.version} not known` };
  while (r.remaining > 0) {
    const t = iso(r.u32());
    const type = r.u8();
    if (type === MANUAL_HR || type === MANUAL_SPO2 || type === MANUAL_STRESS) {
      const value = r.u8();
      if (value === 0) continue;
      const list = type === MANUAL_HR ? out.heartRate! : type === MANUAL_SPO2 ? out.spo2! : out.stress!;
      list.push({ t, value, source: 'manual' });
    } else if (type === MANUAL_TEMPERATURE) {
      // Two u16 values; Gadgetbridge keeps the int as is. The first one / 100 looks like °C (e.g. 0x0e5a = 36.74).
      const raw = r.bytes(4);
      const first = raw[0] | (raw[1] << 8);
      if (first === 0) continue;
      out.temperature!.push({ t, value: first / 100, source: 'manual', raw: Array.from(raw, (x) => x.toString(16).padStart(2, '0')).join('') });
    } else {
      // The record size depends on the type, so an unknown type ends decoding (also in Gadgetbridge).
      return { ...out, decoded: 'partial', note: `manual samples: unknown type 0x${type.toString(16)} at ${r.pos - 5}` };
    }
  }
  return out;
}

// -------------------------------------------------------- workout summary ---

// Leading fields of each sport's summary, up to the first field whose presence depends on the
// version (from WorkoutSummaryParser). Header validity bits are ignored, as in Gadgetbridge.
type W = 'type' | 'start' | 'end' | 'active' | 'dist' | 'kcal16' | 'kcal32' | 'kcalTotal' | 'steps' | 'hrAvg' | 'hrMax' | 'hrMin' | `skip${number}`;
interface Layout { header: Record<number, number>; fields: W[] }

const CORE: W[] = ['start', 'end', 'active', 'kcal16', 'hrAvg', 'hrMax', 'hrMin'];
const OUTDOOR_V2: W[] = ['type', 'start', 'end', 'active', 'skip4', 'dist', 'kcalTotal', 'kcal16'];
const WALK_V4: W[] = ['start', 'end', 'active', 'dist', 'kcal32', 'skip12', 'steps', 'skip2', 'hrAvg', 'hrMax', 'hrMin'];
const OUTDOOR_V3_STEPS: W[] = ['start', 'end', 'active', 'dist', 'kcal16', 'skip12', 'steps', 'skip2', 'hrAvg', 'hrMax', 'hrMin'];
const OUTDOOR_V3: W[] = ['start', 'end', 'active', 'dist', 'kcal16', 'skip12', 'hrAvg', 'hrMax', 'hrMin'];

function workoutLayout(subtype: number, version: number): Layout | null {
  const L = (header: Record<number, number>, fields: W[]): Layout | null => (header[version] ? { header, fields } : null);
  switch (subtype) {
    case 0x08: return L({ 5: 3, 7: 5, 8: 6, 9: 6, 10: 6 }, CORE);
    case 0x10: return L({ 5: 4, 6: 4 }, CORE);
    case 0x0e: return L({ 3: 5, 5: 5 }, CORE);
    case 0x0d: return L({ 4: 4, 6: 5, 7: 5, 8: 6 }, CORE);
    case 0x0b: return L({ 3: 4, 4: 4, 5: 4, 6: 4 }, ['start', 'end', 'active', 'kcal16', 'steps']);
    case 0x07: return L({ 8: 7, 9: 8 }, ['start', 'end', 'active', 'skip4', 'kcal16', 'skip4', 'hrAvg', 'hrMax', 'hrMin']);
    case 0x01:
    case 0x02: return version === 3 ? L({ 3: 4 }, OUTDOOR_V3_STEPS) : L({ 4: 4 }, WALK_V4);
    case 0x06: return version === 3 ? L({ 3: 4 }, OUTDOOR_V3) : L({ 4: 5 }, ['start', 'end', 'active', 'dist', 'kcal16', 'skip12', 'hrAvg', 'hrMax', 'hrMin']);
    case 0x16: return L({ 1: 5, 2: 6, 4: 7, 5: 9, 6: 9, 9: 13 }, OUTDOOR_V2);
    case 0x17: return L({ 4: 6, 5: 6, 6: 7, 8: 8 }, OUTDOOR_V2);
    case 0x09: return L({ 6: 4, 7: 5, 8: 8 }, ['start', 'end', 'active', 'dist', 'kcal16']);
    case 0x03: return L({ 5: 4, 9: 6, 10: 8, 11: 9 }, ['start', 'end', 'active', 'dist', 'kcal16']);
  }
  return null;
}

export function parseWorkoutSummary(id: FileId, bytes: Uint8Array): Parsed {
  const w: Workout = {
    start: iso(id.ts),
    sport: SPORT_NAMES[id.subtype] ?? `unknown_${id.subtype}`,
    sportCode: id.subtype,
    decoded: false,
    file: rawFileName(id),
  };
  const layout = workoutLayout(id.subtype, id.version);
  if (!layout) return { decoded: 'raw', note: `summary layout of this sport/version not known; start time only`, workouts: [w] };
  try {
    const r = body(bytes, false);
    r.skip(layout.header[id.version]);
    for (const f of layout.fields) {
      if (f.startsWith('skip')) r.skip(Number(f.slice(4)));
      else if (f === 'type') w.workoutType = r.u16();
      else if (f === 'start') w.start = iso(r.u32());
      else if (f === 'end') w.end = iso(r.u32());
      else if (f === 'active') w.activeSec = r.u32();
      else if (f === 'dist') w.distanceM = r.u32();
      else if (f === 'kcal16') w.kcal = r.u16();
      else if (f === 'kcal32') w.kcal = r.u32();
      else if (f === 'kcalTotal') w.kcalTotal = r.u16();
      else if (f === 'steps') w.steps = r.u32();
      else if (f === 'hrAvg') w.hrAvg = r.u8();
      else if (f === 'hrMax') w.hrMax = r.u8();
      else if (f === 'hrMin') w.hrMin = r.u8();
    }
    w.decoded = true;
  } catch (e) {
    return { decoded: 'raw', note: `workout summary: ${(e as Error).message}`, workouts: [{ ...w, start: iso(id.ts), decoded: false }] };
  }
  return { decoded: 'partial', note: 'leading summary fields only (time, duration, calories, distance, steps, heart rate)', workouts: [w] };
}

// ---------------------------------------------------------------- dispatch ---

export function parseHealthFile(id: FileId, bytes: Uint8Array): Parsed {
  try {
    if (id.type === TYPE_ACTIVITY) {
      if (id.subtype === ACTIVITY_DAILY && id.detail === DETAIL_DETAILS) return parseDailyDetails(id, bytes);
      if (id.subtype === ACTIVITY_DAILY && id.detail === DETAIL_SUMMARY) return parseDailySummary(id, bytes);
      if (id.subtype === ACTIVITY_SLEEP_STAGES && id.detail === DETAIL_DETAILS) return parseSleepStages(id, bytes);
      if (id.subtype === ACTIVITY_MANUAL_SAMPLES && id.detail === DETAIL_DETAILS) return parseManualSamples(id, bytes);
      if (id.subtype === ACTIVITY_SLEEP) return parseSleepDetails(id, bytes);
    } else if (id.type === TYPE_SPORTS && id.detail === DETAIL_SUMMARY) {
      return parseWorkoutSummary(id, bytes);
    } else if (id.type === TYPE_SPORTS) {
      return { decoded: 'raw', note: 'workout details / GPS track are kept as raw bytes' };
    }
    return { decoded: 'raw', note: 'no decoder for this file type' };
  } catch (e) {
    return { decoded: 'raw', note: `decode error: ${(e as Error).message}` };
  }
}

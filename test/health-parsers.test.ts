import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildHealthData, csvZip, rawZip, toCsv } from '../src/health/export';
import { ActivityAssembler, checkFile, encodeFileId, parseFileId, parseFileIdList, rawFileName, subtypeName } from '../src/health/files';
import { ComplexReader, parseHealthFile, Reader } from '../src/health/parsers';
import {
  dailyDetailsV4,
  dailySummaryV5,
  fromB64,
  fromHex,
  manualSamplesV2,
  REAL_FILE_ID,
  REAL_MANUAL_SPO2_97,
  REAL_MANUAL_STRESS_40,
  REAL_WORKOUTS,
  sleepDetailsV5,
  sleepStagesV2,
} from './health-fixtures';

const T0 = 1_792_800_000; // 2026-10-24T00:00:00Z
const iso = (s: number) => new Date(s * 1000).toISOString();

describe('health file ids', () => {
  it('decodes and re-encodes Gadgetbridge\'s test vector', () => {
    const id = parseFileId(fromHex(REAL_FILE_ID));
    expect(id).toEqual({ ts: 1697182497, tz: 4, version: 3, type: 1, subtype: 8, detail: 0 });
    expect(subtypeName(id)).toBe('freestyle');
    expect(Buffer.from(encodeFileId(id)).toString('hex').toUpperCase()).toBe(REAL_FILE_ID);
    expect(rawFileName(id)).toBe('2023/sports/freestyle/details/20231013T073457Z_01_08_00_v3.bin');
  });

  it('parses id lists, skipping empty entries and odd lengths', () => {
    expect(parseFileIdList(fromHex(`${REAL_FILE_ID}00000000000000${REAL_FILE_ID}`))).toHaveLength(2);
    expect(parseFileIdList(fromHex('0102'))).toEqual([]);
    expect(parseFileIdList(undefined)).toEqual([]);
  });

  it('reassembles activity chunks and checks the crc', () => {
    const file = dailyDetailsV4(T0, [{ steps: 1, kcal: 1, distanceM: 1, hr: 60, spo2: 98, stress: 20 }]);
    const a = new ActivityAssembler();
    const chunk = (i: number, n: number, d: Uint8Array) => new Uint8Array([n, 0, i, 0, ...d]);
    expect(a.push(chunk(1, 2, file.subarray(0, 10)))).toBeNull();
    const whole = a.push(chunk(2, 2, file.subarray(10)))!;
    expect(Buffer.from(whole).equals(Buffer.from(file))).toBe(true);
    expect(checkFile(whole).ts).toBe(T0);
    const bad = whole.slice();
    bad[12] ^= 1;
    expect(() => checkFile(bad)).toThrow(/crc32/);
    expect(() => a.push(chunk(2, 3, file))).toThrow(/out of order/);
  });
});

describe('readers', () => {
  it('ComplexReader reads valid groups and skips absent ones', () => {
    // groups: 16 bits (present, idx 1+2 valid), 8 bits absent, 8 bits present (idx 0)
    const r = new Reader(new Uint8Array([0x05, 0x40, 0x2a]));
    const c = new ComplexReader(new Uint8Array([0xb0, 0xc0]), r);
    expect(c.nextGroup(16)).toBe(true);
    expect(c.get(1, 1)).toBe(1);
    expect(c.get(2, 14)).toBe(5);
    expect(c.nextGroup(8)).toBe(false);
    expect(c.nextGroup(8)).toBe(true);
    expect(c.has(0)).toBe(true);
    expect(c.get(0, 8)).toBe(42);
  });

  it('throws instead of reading past the end', () => {
    expect(() => new Reader(new Uint8Array(3)).u32()).toThrow(RangeError);
  });
});

describe('decoders on synthetic files (our reading of the format)', () => {
  it('daily details v4: one record per minute, extra byte, invalid HR dropped', () => {
    const file = dailyDetailsV4(T0, [
      { steps: 120, kcal: 5, distanceM: 90, hr: 88, spo2: 97, stress: 30 },
      { steps: 0, kcal: 0, distanceM: 0, hr: 0, spo2: 0, stress: 255, extra: true },
      { steps: 16383, kcal: 63, distanceM: 65535, hr: 254, spo2: 100, stress: 0 },
    ]);
    const p = parseHealthFile(parseFileId(file), file);
    expect(p.decoded).toBe('full');
    expect(p.activity).toEqual([
      { t: iso(T0), steps: 120, activeKcal: 5, distanceM: 90, heartRate: 88, spo2: 97, stress: 30 },
      { t: iso(T0 + 60), steps: 0, activeKcal: 0, distanceM: 0 },
      { t: iso(T0 + 120), steps: 16383, activeKcal: 63, distanceM: 65535, heartRate: 254, spo2: 100, stress: 0 },
    ]);
    expect(p.heartRate!.map((s) => s.value)).toEqual([88, 254]);
    expect(p.stress!.map((s) => s.value)).toEqual([30, 0]);
  });

  it('daily details: a truncated file gives the minutes before the cut', () => {
    const file = dailyDetailsV4(T0, [{ steps: 1, kcal: 1, distanceM: 1, hr: 60, spo2: 98, stress: 20 }, { steps: 2, kcal: 1, distanceM: 1, hr: 61, spo2: 98, stress: 20 }]);
    const cut = new Uint8Array([...file.subarray(0, file.length - 8), 0, 0, 0, 0]); // last minute cut short
    const p = parseHealthFile(parseFileId(cut), cut);
    expect(p.decoded).toBe('partial');
    expect(p.activity).toHaveLength(1);
  });

  it('daily summary v5: local date from the timezone, validity bitmap, standing hours', () => {
    const file = dailySummaryV5(T0, 28 /* UTC+7 */, { steps: 8421, hrResting: 58, hrMax: 151, hrMaxAt: T0 + 3600, spo2Avg: 96, standingBits: 0b1000_0001 });
    const p = parseHealthFile(parseFileId(file), file);
    expect(p.daily![0]).toMatchObject({
      date: '2026-10-24',
      tzOffsetMinutes: 420,
      steps: 8421,
      activeKcal: 250,
      hrResting: 58,
      hrMax: 151,
      hrMaxAt: iso(T0 + 3600),
      kcal: 2200,
      spo2Avg: 96,
      standingHours: [0, 7],
      trainingLoadWeek: 700,
      vitalityCurrent: 280,
    });
  });

  it('sleep stages v2', () => {
    const bed = T0;
    const file = sleepStagesV2(T0, bed, bed + 8 * 3600, [[bed, 3], [bed + 1800, 2], [bed + 5400, 4], [bed + 7000, 5], [bed + 7200, 9]]);
    const s = parseHealthFile(parseFileId(file), file).sleep![0];
    expect(s).toMatchObject({ start: iso(bed), end: iso(bed + 8 * 3600), totalMin: 480, deepMin: 120, lightMin: 240, remMin: 90, awakeMin: 30, source: 'sleep_stages' });
    expect(s.stages.map((x) => x.stage)).toEqual(['light', 'deep', 'rem', 'awake', 'unknown']);
  });

  it('sleep details v5: header, samples and stage packets', () => {
    const bed = T0;
    const file = sleepDetailsV5(T0, bed, bed + 7 * 3600);
    const p = parseHealthFile(parseFileId(file), file);
    expect(p.decoded).toBe('full');
    const s = p.sleep![0];
    expect(s).toMatchObject({ start: iso(bed), end: iso(bed + 7 * 3600), inBed: iso(bed - 1800), quality: 85, totalMin: 420, awakeMin: 25, lightMin: 250, remMin: 80, deepMin: 90 });
    expect(s.stages).toEqual([
      { t: iso(bed), stage: 'light' },
      { t: iso(bed + 30 * 60), stage: 'deep' },
      { t: iso(bed + 90 * 60), stage: 'rem' },
    ]);
    expect(p.heartRate).toEqual([
      { t: iso(bed), value: 58, source: 'sleep' },
      { t: iso(bed + 120), value: 61, source: 'sleep' },
    ]);
    expect(p.spo2!.map((x) => x.value)).toEqual([96, 94]);
    expect(p.respiratoryRate!.map((x) => x.value)).toEqual([14, 15]);
  });

  it('manual samples v2: HR, SpO2, stress, temperature', () => {
    const file = manualSamplesV2(T0);
    const p = parseHealthFile(parseFileId(file), file);
    expect(p.heartRate).toEqual([{ t: iso(T0 + 60), value: 72, source: 'manual' }]);
    expect(p.spo2).toEqual([{ t: iso(T0 + 120), value: 97, source: 'manual' }]);
    expect(p.stress).toEqual([{ t: iso(T0 + 240), value: 33, source: 'manual' }]);
    expect(p.temperature).toEqual([{ t: iso(T0 + 300), value: 36.74, source: 'manual', raw: '5a0e0000' }]);
  });

  it('keeps unknown files raw', () => {
    const file = dailyDetailsV4(T0, []);
    const id = { ...parseFileId(file), version: 9 };
    expect(parseHealthFile(id, file).decoded).toBe('raw');
    expect(parseHealthFile({ ...id, type: 1, subtype: 8, detail: 2 }, file)).toMatchObject({ decoded: 'raw' });
  });
});

describe('decoders on real band captures (from Gadgetbridge\'s test suite)', () => {
  it('manual samples v1 (Mi Band 9 Active)', () => {
    const spo2 = fromHex(REAL_MANUAL_SPO2_97);
    expect(parseHealthFile(parseFileId(spo2), spo2).spo2).toEqual([{ t: new Date(1787148783000).toISOString(), value: 97, source: 'manual' }]);
    const stress = fromHex(REAL_MANUAL_STRESS_40);
    expect(parseHealthFile(parseFileId(stress), stress).stress![0].value).toBe(40);
  });

  for (const [name, w] of Object.entries(REAL_WORKOUTS)) {
    it(`workout summary: ${name}`, () => {
      const bytes = fromB64(w.b64);
      const id = parseFileId(bytes);
      const p = parseHealthFile(id, bytes);
      expect(p.workouts![0]).toMatchObject({ ...w.expect, decoded: true });
    });
  }

  it('workout summary of an unknown version keeps the start time', () => {
    const bytes = fromB64(REAL_WORKOUTS.rowingV8.b64);
    const id = { ...parseFileId(bytes), version: 99 };
    expect(parseHealthFile(id, bytes)).toMatchObject({ decoded: 'raw', workouts: [{ sport: 'rowing', decoded: false }] });
  });
});

describe('export', () => {
  const files = [
    dailyDetailsV4(T0, [
      { steps: 10, kcal: 1, distanceM: 8, hr: 70, spo2: 98, stress: 20 },
      { steps: 20, kcal: 2, distanceM: 16, hr: 75, spo2: 97, stress: 25 },
    ]),
    manualSamplesV2(T0),
    sleepStagesV2(T0, T0, T0 + 3600, [[T0, 3]]),
    fromB64(REAL_WORKOUTS.rowingV8.b64),
  ].map((bytes) => ({ id: parseFileId(bytes), bytes }));

  it('merges files into one miband-health/1 document, filtered by range', () => {
    const d = buildHealthData(files, { from: T0 * 1000, to: (T0 + 90) * 1000 });
    expect(d.schema).toBe('miband-health/1');
    expect(d.activity).toHaveLength(2);
    expect(d.heartRate.map((s) => `${s.source}:${s.value}`)).toEqual(['minute:70', 'minute:75', 'manual:72']);
    expect(d.files).toHaveLength(4);
    expect(d.files.find((f) => f.subtype === 'rowing')?.decoded).toBe('partial');
    expect(d.workouts).toHaveLength(0); // the rowing capture is from August, outside the range
    expect(d.units.heartRate).toBe('beats per minute');
  });

  it('writes CSV and zips', () => {
    const d = buildHealthData(files);
    expect(toCsv(d, 'heartRate').split('\r\n').slice(0, 2)).toEqual(['t,value,source', `${iso(T0)},70,minute`]);
    expect(toCsv(d, 'sleepStages')).toContain(`${iso(T0)},${iso(T0)},light`);
    const raw = unzipSync(rawZip(files, d));
    expect(Object.keys(raw)).toContain('index.json');
    expect(Object.keys(raw).filter((n) => n.endsWith('.bin'))).toHaveLength(4);
    expect(Object.keys(unzipSync(csvZip(d)))).toContain('workouts.csv');
  });
});

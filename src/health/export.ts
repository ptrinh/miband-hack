import { zipSync } from 'fflate';
import { detailName, type HealthFile, rawFileName, subtypeName, typeName } from './files';
import { parseHealthFile } from './parsers';
import type { HealthData, RecordKind, Sample } from './schema';
import { HEALTH_SCHEMA, UNITS } from './units';

export { HEALTH_SCHEMA, UNITS };

export interface BuildOptions {
  /** Unix ms; records outside [from, to) are dropped. */
  from?: number;
  to?: number;
  device?: { model?: string; firmware?: string };
}

const inRange = (t: string, o: BuildOptions): boolean => {
  const ms = Date.parse(t);
  return (o.from === undefined || ms >= o.from) && (o.to === undefined || ms < o.to);
};

/** Keeps the last record per key (a re-fetched file supersedes an older copy) and sorts by time. */
function dedupe<T>(list: T[], key: (x: T) => string, time: (x: T) => string): T[] {
  const m = new Map<string, T>();
  for (const x of list) m.set(key(x), x);
  return [...m.values()].sort((a, b) => time(a).localeCompare(time(b)));
}

export function emptyHealthData(): HealthData {
  return {
    schema: HEALTH_SCHEMA,
    exportedAt: new Date().toISOString(),
    generator: 'miband-hack',
    timezone: { timestamps: 'UTC' },
    units: UNITS,
    files: [],
    activity: [],
    heartRate: [],
    spo2: [],
    stress: [],
    respiratoryRate: [],
    temperature: [],
    daily: [],
    sleep: [],
    workouts: [],
  };
}

/** Decodes every file and merges the records into one export. */
export function buildHealthData(files: HealthFile[], o: BuildOptions = {}): HealthData {
  const d = emptyHealthData();
  if (o.from !== undefined && o.to !== undefined) d.range = { from: new Date(o.from).toISOString(), to: new Date(o.to).toISOString() };
  if (o.device) d.device = { model: o.device.model, firmware: o.device.firmware };
  let latest = -Infinity;
  for (const f of files) {
    const p = parseHealthFile(f.id, f.bytes);
    if (f.id.ts > latest) {
      latest = f.id.ts;
      d.timezone.bandOffsetMinutes = f.id.tz * 15;
    }
    d.files.push({
      name: rawFileName(f.id),
      type: typeName(f.id),
      subtype: subtypeName(f.id),
      detail: detailName(f.id),
      version: f.id.version,
      t: new Date(f.id.ts * 1000).toISOString(),
      tzOffsetMinutes: f.id.tz * 15,
      size: f.bytes.length,
      decoded: p.decoded,
      ...(p.note ? { note: p.note } : {}),
    });
    d.activity.push(...(p.activity ?? []).filter((x) => inRange(x.t, o)));
    for (const k of ['heartRate', 'spo2', 'stress', 'respiratoryRate'] as const) d[k].push(...(p[k] ?? []).filter((x) => inRange(x.t, o)));
    d.temperature.push(...(p.temperature ?? []).filter((x) => inRange(x.t, o)));
    d.daily.push(...(p.daily ?? []).filter((x) => inRange(x.t, o)));
    d.sleep.push(...(p.sleep ?? []).filter((x) => inRange(x.end, o) || inRange(x.start, o)));
    d.workouts.push(...(p.workouts ?? []).filter((x) => inRange(x.start, o)));
  }
  const sampleKey = (x: Sample) => `${x.t}|${x.source}`;
  d.activity = dedupe(d.activity, (x) => x.t, (x) => x.t);
  d.heartRate = dedupe(d.heartRate, sampleKey, (x) => x.t);
  d.spo2 = dedupe(d.spo2, sampleKey, (x) => x.t);
  d.stress = dedupe(d.stress, sampleKey, (x) => x.t);
  d.respiratoryRate = dedupe(d.respiratoryRate, sampleKey, (x) => x.t);
  d.temperature = dedupe(d.temperature, sampleKey, (x) => x.t);
  d.daily = dedupe(d.daily, (x) => x.date, (x) => x.t);
  // a sleep is re-sent while it grows; keep the copy with the latest end per start
  d.sleep = dedupe(
    [...d.sleep].sort((a, b) => a.end.localeCompare(b.end)),
    (x) => x.start,
    (x) => x.start,
  );
  d.workouts = dedupe(d.workouts, (x) => x.start, (x) => x.start);
  d.files.sort((a, b) => a.t.localeCompare(b.t));
  return d;
}

// --------------------------------------------------------------------- CSV ---

export const CSV_KINDS = ['activity', 'heartRate', 'spo2', 'stress', 'respiratoryRate', 'temperature', 'daily', 'sleep', 'sleepStages', 'workouts'] as const;
export type CsvKind = (typeof CSV_KINDS)[number];

const COLUMNS: Record<CsvKind, string[]> = {
  activity: ['t', 'steps', 'distanceM', 'activeKcal', 'heartRate', 'spo2', 'stress', 'energy'],
  heartRate: ['t', 'value', 'source'],
  spo2: ['t', 'value', 'source'],
  stress: ['t', 'value', 'source'],
  respiratoryRate: ['t', 'value', 'source'],
  temperature: ['t', 'value', 'raw', 'source'],
  daily: ['date', 't', 'tzOffsetMinutes', 'steps', 'activeKcal', 'kcal', 'hrResting', 'hrAvg', 'hrMin', 'hrMinAt', 'hrMax', 'hrMaxAt', 'stressAvg', 'stressMin', 'stressMax', 'spo2Avg', 'spo2Min', 'spo2MinAt', 'spo2Max', 'spo2MaxAt', 'standingHours', 'recoveryHours', 'trainingLoadDay', 'trainingLoadWeek', 'trainingLoadLevel', 'vitalityLight', 'vitalityModerate', 'vitalityHigh', 'vitalityCurrent'],
  sleep: ['start', 'end', 'inBed', 'totalMin', 'deepMin', 'lightMin', 'remMin', 'awakeMin', 'quality', 'source', 'file'],
  sleepStages: ['sleepStart', 't', 'stage'],
  workouts: ['start', 'end', 'sport', 'sportCode', 'workoutType', 'activeSec', 'kcal', 'kcalTotal', 'distanceM', 'steps', 'hrAvg', 'hrMax', 'hrMin', 'decoded', 'file'],
};

function cell(v: unknown): string {
  if (v === undefined || v === null) return '';
  const s = Array.isArray(v) ? v.join(' ') : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(d: HealthData, kind: CsvKind): string {
  const cols = COLUMNS[kind];
  const rows: Record<string, unknown>[] =
    kind === 'sleepStages' ? d.sleep.flatMap((s) => s.stages.map((x) => ({ sleepStart: s.start, ...x }))) : (d[kind as RecordKind] as unknown as Record<string, unknown>[]);
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}

// --------------------------------------------------------------------- zip ---

/** Raw files exactly as the band sent them, plus an index (same metadata as `files` in the JSON). */
export function rawZip(files: HealthFile[], d: HealthData): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) entries[rawFileName(f.id)] = f.bytes;
  entries['index.json'] = new TextEncoder().encode(JSON.stringify({ schema: HEALTH_SCHEMA, exportedAt: d.exportedAt, files: d.files }, null, 2));
  return zipSync(entries, { level: 6 });
}

export function csvZip(d: HealthData): Uint8Array {
  const enc = new TextEncoder();
  return zipSync(Object.fromEntries(CSV_KINDS.map((k) => [`${k}.csv`, enc.encode(toCsv(d, k))])), { level: 6 });
}

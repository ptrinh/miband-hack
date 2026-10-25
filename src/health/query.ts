import type { HealthData, RecordKind, Sample } from './schema';

// Queries over miband-health/1 data, plus the MCP tool list and JSON-RPC handling built on them.
// Shared by tools/health-mcp (local stdio server, loads this file through Node's type stripping,
// so: no value imports, only erasable TypeScript) and the Worker (REST + remote MCP).

export interface Range {
  /** Unix ms, inclusive. */
  from: number;
  /** Unix ms, exclusive. */
  to: number;
}

export interface QueryArgs {
  from?: string;
  to?: string;
  days?: number;
  resolution?: string;
  tz_offset_minutes?: number;
  stages?: boolean;
  kind?: string;
  limit?: number;
  offset?: number;
}

/** Where the tools read data from: a loaded export file, or the cloud store for one account. */
export interface HealthSource {
  /** Data covering at least `range` (it may hold more; the queries filter). */
  load(range: Range): Promise<HealthData>;
  /** What is stored: kinds, first/last day, file list or counts. */
  info(): Promise<unknown>;
}

const DAY = 86_400_000;
const MAX_SPAN_DAYS = 400;
const MAX_POINTS = 5000;
export const RESOLUTIONS = ['raw', 'minute', '5min', '15min', 'hour', 'day', 'auto'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];
const STEP: Record<string, number> = { minute: 60_000, '5min': 300_000, '15min': 900_000, hour: 3_600_000, day: DAY };
export const KINDS: RecordKind[] = ['activity', 'heartRate', 'spo2', 'stress', 'respiratoryRate', 'temperature', 'daily', 'sleep', 'workouts'];

export class QueryError extends Error {}

function parseTime(s: string, endOfDay: boolean): number {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
  const ms = Date.parse(dateOnly ? `${s}T00:00:00Z` : s);
  if (Number.isNaN(ms)) throw new QueryError(`not a date: ${s} (use YYYY-MM-DD or ISO 8601)`);
  return dateOnly && endOfDay ? ms + DAY : ms;
}

/** from/to (YYYY-MM-DD = whole UTC days, or ISO 8601) or `days` back from now; default the last 7 days. */
export function parseRange(a: QueryArgs, now = Date.now()): Range {
  const to = a.to ? parseTime(a.to, true) : now;
  const days = a.days !== undefined ? Number(a.days) : 7;
  if (!Number.isFinite(days) || days <= 0) throw new QueryError('days must be a positive number');
  const from = a.from ? parseTime(a.from, false) : to - days * DAY;
  if (from >= to) throw new QueryError('from must be before to');
  if (to - from > MAX_SPAN_DAYS * DAY) throw new QueryError(`range longer than ${MAX_SPAN_DAYS} days`);
  return { from, to };
}

const inRange = (t: string, r: Range): boolean => {
  const ms = Date.parse(t);
  return ms >= r.from && ms < r.to;
};

function pickResolution(res: string | undefined, r: Range): Resolution {
  if (res && !(RESOLUTIONS as readonly string[]).includes(res)) throw new QueryError(`resolution must be one of ${RESOLUTIONS.join(', ')}`);
  if (res && res !== 'auto') return res as Resolution;
  const span = r.to - r.from;
  return span <= DAY ? 'minute' : span <= 7 * DAY ? '15min' : span <= 31 * DAY ? 'hour' : 'day';
}

/** Start of the bucket holding `ms`; days follow the band's local day (tz offset in minutes). */
function bucketStart(ms: number, res: Resolution, tz: number): number {
  const step = STEP[res];
  const off = res === 'day' ? tz * 60_000 : 0;
  return Math.floor((ms + off) / step) * step - off;
}

const round1 = (v: number): number => Math.round(v * 10) / 10;
const tzOf = (d: HealthData, a: QueryArgs): number => Number(a.tz_offset_minutes ?? d.timezone?.bandOffsetMinutes ?? 0);
const localDay = (ms: number, tz: number): string => new Date(ms + tz * 60_000).toISOString().slice(0, 10);

function cap<T>(list: T[]): { items: T[]; truncated?: true } {
  return list.length > MAX_POINTS ? { items: list.slice(0, MAX_POINTS), truncated: true } : { items: list };
}

/** A sample series (heart rate, SpO2, stress, breathing) at a resolution: avg/min/max/n per bucket. */
export function series(d: HealthData, key: 'heartRate' | 'spo2' | 'stress' | 'respiratoryRate', a: QueryArgs, now?: number) {
  const r = parseRange(a, now);
  const res = pickResolution(a.resolution, r);
  const samples = (d[key] ?? []).filter((s) => inRange(s.t, r));
  if (res === 'raw') {
    const c = cap(samples);
    return { resolution: res, from: new Date(r.from).toISOString(), to: new Date(r.to).toISOString(), points: c.items, ...(c.truncated ? { truncated: true } : {}) };
  }
  const tz = tzOf(d, a);
  const buckets = new Map<number, number[]>();
  for (const s of samples) {
    const b = bucketStart(Date.parse(s.t), res, tz);
    const list = buckets.get(b);
    if (list) list.push(s.value);
    else buckets.set(b, [s.value]);
  }
  const points = [...buckets.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([b, v]) => ({ t: new Date(b).toISOString(), avg: round1(v.reduce((s, x) => s + x, 0) / v.length), min: Math.min(...v), max: Math.max(...v), n: v.length }));
  const c = cap(points);
  return {
    resolution: res,
    ...(res === 'day' ? { dayTzOffsetMinutes: tz } : {}),
    from: new Date(r.from).toISOString(),
    to: new Date(r.to).toISOString(),
    points: c.items,
    ...(c.truncated ? { truncated: true } : {}),
  };
}

/** Steps, distance and active calories summed per bucket from the per-minute records. */
export function steps(d: HealthData, a: QueryArgs, now?: number) {
  const r = parseRange(a, now);
  let res = pickResolution(a.resolution ?? 'day', r);
  if (res === 'raw') res = 'minute';
  const tz = tzOf(d, a);
  const buckets = new Map<number, { steps: number; distanceM: number; activeKcal: number }>();
  let total = 0;
  for (const m of d.activity ?? []) {
    if (!inRange(m.t, r)) continue;
    const b = bucketStart(Date.parse(m.t), res, tz);
    const x = buckets.get(b) ?? { steps: 0, distanceM: 0, activeKcal: 0 };
    x.steps += m.steps ?? 0;
    x.distanceM += m.distanceM ?? 0;
    x.activeKcal += m.activeKcal ?? 0;
    total += m.steps ?? 0;
    buckets.set(b, x);
  }
  const points = [...buckets.entries()].sort((x, y) => x[0] - y[0]).map(([b, x]) => ({ t: new Date(b).toISOString(), ...x }));
  const bandDaily = (d.daily ?? []).filter((x) => inRange(x.t, r) && x.steps !== undefined).map((x) => ({ date: x.date, steps: x.steps }));
  const c = cap(points);
  return {
    resolution: res,
    ...(res === 'day' ? { dayTzOffsetMinutes: tz } : {}),
    totalSteps: total,
    points: c.items,
    ...(c.truncated ? { truncated: true } : {}),
    // the band's own daily totals, which can differ from the sum of the minutes
    bandDailyTotals: bandDaily,
  };
}

export function sleep(d: HealthData, a: QueryArgs, now?: number) {
  const r = parseRange(a, now);
  const sessions = (d.sleep ?? []).filter((s) => inRange(s.end, r) || inRange(s.start, r));
  return { sessions: a.stages === false ? sessions.map(({ stages: _stages, ...s }) => s) : sessions };
}

export function workouts(d: HealthData, a: QueryArgs, now?: number) {
  const r = parseRange(a, now);
  return { workouts: (d.workouts ?? []).filter((w) => inRange(w.start, r)) };
}

const avg = (v: number[]): number | undefined => (v.length ? round1(v.reduce((s, x) => s + x, 0) / v.length) : undefined);

/** Per local day: steps, distance, heart rate, SpO2, stress, sleep, workouts; plus the band's daily summaries. */
export function summary(d: HealthData, a: QueryArgs, now?: number) {
  const r = parseRange(a, now);
  const tz = tzOf(d, a);
  interface Day { steps: number; distanceM: number; activeKcal: number; hr: number[]; spo2: number[]; stress: number[]; sleepMin: number; workouts: number }
  const days = new Map<string, Day>();
  const day = (ms: number): Day => {
    const k = localDay(ms, tz);
    let x = days.get(k);
    if (!x) days.set(k, (x = { steps: 0, distanceM: 0, activeKcal: 0, hr: [], spo2: [], stress: [], sleepMin: 0, workouts: 0 }));
    return x;
  };
  for (const m of d.activity ?? []) {
    if (!inRange(m.t, r)) continue;
    const x = day(Date.parse(m.t));
    x.steps += m.steps ?? 0;
    x.distanceM += m.distanceM ?? 0;
    x.activeKcal += m.activeKcal ?? 0;
  }
  const push = (list: Sample[], f: (x: Day) => number[]) => {
    for (const s of list ?? []) if (inRange(s.t, r)) f(day(Date.parse(s.t))).push(s.value);
  };
  push(d.heartRate, (x) => x.hr);
  push(d.spo2, (x) => x.spo2);
  push(d.stress, (x) => x.stress);
  for (const s of d.sleep ?? []) if (inRange(s.end, r)) day(Date.parse(s.end)).sleepMin += s.totalMin ?? Math.round((Date.parse(s.end) - Date.parse(s.start)) / 60_000);
  for (const w of d.workouts ?? []) if (inRange(w.start, r)) day(Date.parse(w.start)).workouts++;
  const perDay = [...days.entries()].sort().map(([date, x]) => ({
    date,
    steps: x.steps,
    distanceM: x.distanceM,
    activeKcal: x.activeKcal,
    heartRate: x.hr.length ? { avg: avg(x.hr), min: Math.min(...x.hr), max: Math.max(...x.hr), n: x.hr.length } : undefined,
    spo2: x.spo2.length ? { avg: avg(x.spo2), min: Math.min(...x.spo2), n: x.spo2.length } : undefined,
    stress: x.stress.length ? { avg: avg(x.stress), max: Math.max(...x.stress), n: x.stress.length } : undefined,
    sleepMin: x.sleepMin || undefined,
    workouts: x.workouts || undefined,
  }));
  return {
    from: new Date(r.from).toISOString(),
    to: new Date(r.to).toISOString(),
    dayTzOffsetMinutes: tz,
    days: perDay,
    bandDailySummaries: (d.daily ?? []).filter((x) => inRange(x.t, r)),
    note: 'Days are computed from per-minute records and samples; bandDailySummaries are the band\'s own totals.',
  };
}

/** Raw query: the stored records of one kind in a range, paged. */
export function records(d: HealthData, a: QueryArgs, now?: number) {
  const kind = a.kind as RecordKind;
  if (!KINDS.includes(kind)) throw new QueryError(`kind must be one of ${KINDS.join(', ')}`);
  const r = parseRange(a, now);
  const time = (x: Record<string, unknown>) => String(x.t ?? x.start ?? x.end ?? '');
  const all = ((d[kind] ?? []) as unknown as Record<string, unknown>[]).filter((x) => inRange(time(x), r) || (kind === 'sleep' && inRange(String(x.end), r)));
  const limit = Math.min(Math.max(1, Number(a.limit ?? 1000)), MAX_POINTS);
  const offset = Math.max(0, Number(a.offset ?? 0));
  return { kind, total: all.length, offset, limit, items: all.slice(offset, offset + limit), units: d.units };
}

// ------------------------------------------------------- cloud storage ---

/** The UTC day a record is stored under (by `t`; sleep by `end`, workouts by `start`). */
export function recordDay(kind: RecordKind, r: Record<string, unknown>): string | null {
  const t = kind === 'sleep' ? r.end : kind === 'workouts' ? r.start : r.t;
  return typeof t === 'string' && !Number.isNaN(Date.parse(t)) ? new Date(t).toISOString().slice(0, 10) : null;
}

/** Identity of a record within its kind: a re-upload replaces the record with the same key. */
export function recordKey(kind: RecordKind, r: Record<string, unknown>): string {
  return kind === 'daily' ? String(r.date) : kind === 'sleep' || kind === 'workouts' ? String(r.start) : `${r.t}|${r.source ?? ''}`;
}

/** Splits an export into the {kind, day, records} chunks the cloud API stores. */
export function toChunks(d: HealthData): { kind: RecordKind; day: string; records: Record<string, unknown>[] }[] {
  const out = new Map<string, { kind: RecordKind; day: string; records: Record<string, unknown>[] }>();
  for (const kind of KINDS) {
    for (const r of (d[kind] ?? []) as unknown as Record<string, unknown>[]) {
      const day = recordDay(kind, r);
      if (!day) continue;
      const k = `${kind}|${day}`;
      const c = out.get(k);
      if (c) c.records.push(r);
      else out.set(k, { kind, day, records: [r] });
    }
  }
  return [...out.values()];
}

// --------------------------------------------------------------- tools ---

const rangeProps = {
  from: { type: 'string', description: 'Start, YYYY-MM-DD (UTC day) or ISO 8601. Default: `days` before `to`.' },
  to: { type: 'string', description: 'End (exclusive; a YYYY-MM-DD includes that whole day). Default: now.' },
  days: { type: 'number', description: 'Length of the range in days when `from` is not given (default 7).' },
  tz_offset_minutes: { type: 'number', description: 'Offset from UTC for day buckets (default: the band\'s own).' },
};
const resolutionProp = { type: 'string', enum: [...RESOLUTIONS], description: 'Bucket size; auto (default) picks one from the range length; raw = every sample.' };

export interface Tool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  run: (src: HealthSource, a: QueryArgs) => Promise<unknown>;
}

const loaded = (f: (d: HealthData, a: QueryArgs) => unknown) => async (src: HealthSource, a: QueryArgs) => f(await src.load(parseRange(a)), a);

export const TOOLS: Tool[] = [
  {
    name: 'data_info',
    description: 'What health data is available: date coverage per record kind, units, timezone, and which band files were decoded or kept raw. Call this first.',
    inputSchema: { type: 'object', properties: {} },
    run: (src) => src.info(),
  },
  {
    name: 'summary',
    description: 'Per-day overview for a range: steps, distance, active kcal, heart rate avg/min/max, SpO2, stress, sleep minutes, workouts, plus the band\'s own daily summaries.',
    inputSchema: { type: 'object', properties: { ...rangeProps } },
    run: loaded(summary),
  },
  {
    name: 'heart_rate',
    description: 'Heart rate (bpm) over a range, bucketed (avg/min/max/n per bucket) or raw samples with their source (minute, manual, sleep).',
    inputSchema: { type: 'object', properties: { ...rangeProps, resolution: resolutionProp } },
    run: loaded((d, a) => series(d, 'heartRate', a)),
  },
  {
    name: 'steps',
    description: 'Steps, distance (m) and active kcal summed per bucket (default: per day), with the band\'s own daily step totals.',
    inputSchema: { type: 'object', properties: { ...rangeProps, resolution: resolutionProp } },
    run: loaded(steps),
  },
  {
    name: 'sleep',
    description: 'Sleep sessions: start/end, total/deep/light/REM/awake minutes, score where the band has one, and stage changes (stages=false leaves them out).',
    inputSchema: { type: 'object', properties: { ...rangeProps, stages: { type: 'boolean', description: 'Include stage changes (default true)' } } },
    run: loaded(sleep),
  },
  {
    name: 'workouts',
    description: 'Workouts: sport, start/end, active seconds, kcal, distance, steps, heart rate avg/max/min (where the band\'s summary format is decoded).',
    inputSchema: { type: 'object', properties: { ...rangeProps } },
    run: loaded(workouts),
  },
  {
    name: 'spo2',
    description: 'Blood oxygen saturation (%) over a range, bucketed or raw.',
    inputSchema: { type: 'object', properties: { ...rangeProps, resolution: resolutionProp } },
    run: loaded((d, a) => series(d, 'spo2', a)),
  },
  {
    name: 'stress',
    description: 'The band\'s stress score (0-100) over a range, bucketed or raw.',
    inputSchema: { type: 'object', properties: { ...rangeProps, resolution: resolutionProp } },
    run: loaded((d, a) => series(d, 'stress', a)),
  },
  {
    name: 'records',
    description: `Raw query: the stored records of one kind (${KINDS.join(', ')}) in a range, exactly as exported, paged with limit/offset (max ${MAX_POINTS}).`,
    inputSchema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: KINDS }, ...rangeProps, limit: { type: 'number' }, offset: { type: 'number' } },
      required: ['kind'],
    },
    run: loaded(records),
  },
];

export async function runTool(name: string, args: QueryArgs, src: HealthSource): Promise<unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new QueryError(`unknown tool ${name}`);
  return tool.run(src, args ?? {});
}

// --------------------------------------------------------------- MCP ---

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS =
  'Health data recorded by the user\'s Xiaomi Mi Band (heart rate, steps, sleep, SpO2, stress, workouts). ' +
  'Call data_info first to see which dates and kinds exist. Timestamps are UTC; day buckets use the band\'s timezone. ' +
  'Values come from reverse-engineered file formats: treat them as the band\'s estimates, not medical measurements.';

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { protocolVersion?: string; name?: string; arguments?: QueryArgs };
}

/** One JSON-RPC message → its response, or null for notifications. */
export async function handleMcp(m: RpcMessage, src: HealthSource, server: { name: string; version: string }): Promise<object | null> {
  if (m.id === undefined || m.id === null) return null;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: m.id, result });
  const err = (code: number, message: string) => ({ jsonrpc: '2.0', id: m.id, error: { code, message } });
  switch (m.method) {
    case 'initialize': {
      const asked = m.params?.protocolVersion ?? '';
      return ok({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: server,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const name = m.params?.name ?? '';
      if (!TOOLS.some((t) => t.name === name)) return err(-32602, `Unknown tool ${name}`);
      try {
        const result = await runTool(name, m.params?.arguments ?? {}, src);
        return ok({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false });
      } catch (e) {
        return ok({ content: [{ type: 'text', text: (e as Error).message }], isError: true });
      }
    }
    default:
      return err(-32601, `Method not found: ${m.method}`);
  }
}

// "miband-health/1": the one JSON format the webapp exports, the local MCP server reads and the
// cloud API stores. Every timestamp is an ISO 8601 UTC string ("2026-10-25T07:31:00.000Z").
// Field-by-field description: docs/health-data.md.
//
// Types only (no runtime code), so tools/health-mcp can load the modules that import this one
// through Node's type stripping without a build step.

export type HealthSchema = 'miband-health/1';

/** Where a sample came from: the per-minute activity file, a manual/automatic spot measurement, a sleep file. */
export type SampleSource = 'minute' | 'manual' | 'sleep';

export interface Sample {
  t: string;
  value: number;
  source: SampleSource;
}

/** One minute of the band's daily activity file. Absent fields were not measured that minute. */
export interface ActivityMinute {
  t: string;
  steps?: number;
  distanceM?: number;
  activeKcal?: number;
  heartRate?: number;
  /** The band's "energy" value; its meaning is not known (Gadgetbridge stores it unlabelled). */
  energy?: number;
  spo2?: number;
  stress?: number;
}

/** The band's own summary of one day (its local day; see `date` and `tzOffsetMinutes`). */
export interface DailySummary {
  date: string;
  t: string;
  tzOffsetMinutes: number;
  steps?: number;
  activeKcal?: number;
  kcal?: number;
  hrResting?: number;
  hrMax?: number;
  hrMaxAt?: string;
  hrMin?: number;
  hrMinAt?: string;
  hrAvg?: number;
  stressAvg?: number;
  stressMax?: number;
  stressMin?: number;
  /** Hours of the local day (0-23) in which the band counted standing up. */
  standingHours?: number[];
  recoveryHours?: number;
  spo2Max?: number;
  spo2MaxAt?: string;
  spo2Min?: number;
  spo2MinAt?: string;
  spo2Avg?: number;
  trainingLoadDay?: number;
  trainingLoadWeek?: number;
  trainingLoadLevel?: number;
  vitalityLight?: number;
  vitalityModerate?: number;
  vitalityHigh?: number;
  vitalityCurrent?: number;
}

export type SleepStage = 'awake' | 'light' | 'deep' | 'rem' | 'unknown';

export interface SleepSession {
  start: string;
  end: string;
  /** When the band thinks you went to bed (later firmware only), before falling asleep. */
  inBed?: string;
  totalMin?: number;
  deepMin?: number;
  lightMin?: number;
  remMin?: number;
  awakeMin?: number;
  /** 0-100 sleep score, firmware that reports it only. */
  quality?: number;
  /** Raw "is awake" byte of the sleep file; its exact meaning is unclear. */
  awakeFlag?: number;
  /** Stage changes: each stage lasts until the next entry (or `end`). */
  stages: { t: string; stage: SleepStage }[];
  source: 'sleep_details' | 'sleep_stages';
  file: string;
}

export interface Workout {
  start: string;
  end?: string;
  /** Sport from the file type: running, walking, treadmill, cycling, ... or "unknown_<code>". */
  sport: string;
  /** Sub-type code of the file id (Xiaomi sport file type). */
  sportCode: number;
  /** Detailed Xiaomi workout type code, where the summary carries one (outdoor walking/cycling). */
  workoutType?: number;
  activeSec?: number;
  kcal?: number;
  kcalTotal?: number;
  distanceM?: number;
  steps?: number;
  hrAvg?: number;
  hrMax?: number;
  hrMin?: number;
  /** false: only the start time and sport are known; the summary layout of this version is not decoded. */
  decoded: boolean;
  file: string;
}

export interface RawFileInfo {
  /** Path inside the raw .zip download. */
  name: string;
  type: string;
  subtype: string;
  detail: string;
  version: number;
  t: string;
  tzOffsetMinutes: number;
  size: number;
  /** full: every field we know of; partial: some fields; raw: kept as bytes only. */
  decoded: 'full' | 'partial' | 'raw';
  note?: string;
}

export interface HealthData {
  schema: HealthSchema;
  exportedAt: string;
  generator: string;
  timezone: { timestamps: 'UTC'; bandOffsetMinutes?: number };
  range?: { from: string; to: string };
  device?: { model?: string; firmware?: string };
  units: Record<string, string>;
  files: RawFileInfo[];
  activity: ActivityMinute[];
  heartRate: Sample[];
  spo2: Sample[];
  stress: Sample[];
  respiratoryRate: Sample[];
  /** Spot temperature readings; see units.temperature for how sure the scaling is. */
  temperature: (Sample & { raw: string })[];
  daily: DailySummary[];
  sleep: SleepSession[];
  workouts: Workout[];
}

/** The record arrays of HealthData, which is also what the cloud API stores (one row per kind and UTC day). */
export type RecordKind = 'activity' | 'heartRate' | 'spo2' | 'stress' | 'respiratoryRate' | 'temperature' | 'daily' | 'sleep' | 'workouts';

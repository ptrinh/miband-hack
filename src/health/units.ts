// Constants of the miband-health/1 format, shared by the export (browser) and the cloud API (Worker).

export const HEALTH_SCHEMA = 'miband-health/1';

export const UNITS: Record<string, string> = {
  t: 'ISO 8601, UTC',
  steps: 'steps',
  distanceM: 'metres',
  activeKcal: 'kcal',
  kcal: 'kcal',
  heartRate: 'beats per minute',
  spo2: 'percent',
  stress: 'band stress score 0-100',
  energy: 'band value, meaning unknown',
  respiratoryRate: 'breaths per minute',
  temperature: '°C, assumed (first u16 of the record / 100; scaling not confirmed)',
  sleepDurations: 'minutes',
  workoutDurations: 'seconds',
  tzOffsetMinutes: 'minutes east of UTC',
};

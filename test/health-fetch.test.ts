import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { XiaomiDevice } from '../src/device';
import { buildHealthData } from '../src/health/export';
import { StreamLink } from '../src/protocol/stream-link';
import { FakeBand } from './fake-band';
import { dailyDetailsV4, dailySummaryV5, fromB64, manualSamplesV2, REAL_WORKOUTS, sleepDetailsV5 } from './health-fixtures';

const T0 = 1_792_800_000;
const hexId = (f: Uint8Array) => Buffer.from(f.subarray(0, 7)).toString('hex');

async function connected(health: ConstructorParameters<typeof FakeBand>[1]['health']) {
  const secret = randomBytes(16);
  const band = new FakeBand(secret, { txWindow: 8, chunkSize: 1024, ackDelayMs: 1, health });
  const dev = new XiaomiDevice(new StreamLink(band.transport, 'detect'), new Uint8Array(secret));
  dev.healthFileTimeoutMs = 300;
  await dev.connect();
  return { band, dev };
}

describe('health data end-to-end against the simulated band', () => {
  const minutes = Array.from({ length: 300 }, (_, i) => ({ steps: i, kcal: i % 7, distanceM: i, hr: 60 + (i % 40), spo2: 95 + (i % 5), stress: i % 90, extra: i % 50 === 0 }));
  const details = dailyDetailsV4(T0, minutes, 28);
  const summary = dailySummaryV5(T0 + 86_000, 28, { steps: 9000, hrResting: 55, hrMax: 140, hrMaxAt: T0, spo2Avg: 97, standingBits: 7 });
  const sleep = sleepDetailsV5(T0 - 30_000, T0 - 30_000, T0 - 5000);
  const manual = manualSamplesV2(T0);
  const workout = fromB64(REAL_WORKOUTS.indoorCyclingV9.b64); // February 2025

  it('lists today + past, fetches every file over the encrypted activity channel, decodes it', async () => {
    const { band, dev } = await connected({ today: [details, manual], past: [sleep, summary, workout], activityChunk: 97 });
    const progress: string[] = [];
    const res = await dev.fetchHealth({}, (d, n) => progress.push(`${d}/${n}`));

    expect(res.listed).toBe(5);
    expect(res.failed).toEqual([]);
    expect(res.files.map((f) => hexId(f.bytes)).sort()).toEqual([details, manual, sleep, summary, workout].map(hexId).sort());
    expect(res.files[0].id.ts).toBeLessThanOrEqual(res.files[1].id.ts); // fetched oldest first
    expect(progress.at(-1)).toBe('5/5');
    expect(band.healthAcked).toEqual([]); // nothing is marked as synced by default

    const d = buildHealthData(res.files);
    expect(d.activity).toHaveLength(300);
    expect(d.activity[299]).toMatchObject({ steps: 299, heartRate: 60 + (299 % 40) });
    expect(d.daily[0]).toMatchObject({ steps: 9000, tzOffsetMinutes: 420 });
    expect(d.sleep[0]).toMatchObject({ quality: 85, totalMin: 420 });
    expect(d.workouts[0]).toMatchObject({ sport: 'indoor_cycling', hrAvg: 135 });
    expect(d.timezone.bandOffsetMinutes).toBe(420);
    await dev.disconnect();
  });

  it('skips files outside the range, acks only when asked, survives a corrupt and a missing file', async () => {
    const { band, dev } = await connected({ today: [details, manual], past: [sleep, workout], corrupt: [hexId(manual)], drop: [hexId(sleep)] });
    const res = await dev.fetchHealth({ from: T0 - 3600, to: T0 + 86_400, ack: true }, () => {});
    expect(band.healthRequested).not.toContain(hexId(workout)); // 2025, out of range
    expect(res.files.map((f) => hexId(f.bytes))).toEqual([hexId(details)]);
    expect(res.failed.map((f) => f.reason).join(' ')).toMatch(/crc32/);
    expect(res.failed.map((f) => f.reason).join(' ')).toMatch(/No reply/);
    expect(band.healthAcked).toEqual([hexId(details)]);
    await dev.disconnect();
  });

  it('handles a band with nothing recorded', async () => {
    const { dev } = await connected({ today: [], past: [] });
    const res = await dev.fetchHealth({}, () => {});
    expect(res).toEqual({ files: [], failed: [], listed: 0 });
    await dev.disconnect();
  });
});

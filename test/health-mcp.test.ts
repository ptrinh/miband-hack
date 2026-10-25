import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildHealthData } from '../src/health/export';
import { parseFileId } from '../src/health/files';
import { parseRange, records, series, steps, summary } from '../src/health/query';
import { dailyDetailsV4, dailySummaryV5, manualSamplesV2, sleepDetailsV5 } from './health-fixtures';

const T0 = 1_792_800_000; // 2026-10-24T00:00:00Z
const NOW = (T0 + 86_400) * 1000;
const minutes = Array.from({ length: 180 }, (_, i) => ({ steps: 10, kcal: 1, distanceM: 7, hr: 60 + (i % 30), spo2: 97, stress: 20 }));
const data = buildHealthData(
  [dailyDetailsV4(T0, minutes, 28), manualSamplesV2(T0), sleepDetailsV5(T0 - 30_000, T0 - 30_000, T0 - 5000), dailySummaryV5(T0, 28, { steps: 1800, hrResting: 55, hrMax: 89, hrMaxAt: T0, spo2Avg: 97, standingBits: 1 })].map((bytes) => ({ id: parseFileId(bytes), bytes })),
);

describe('health queries', () => {
  it('parses ranges', () => {
    expect(parseRange({ from: '2026-10-24', to: '2026-10-24' })).toEqual({ from: Date.parse('2026-10-24T00:00:00Z'), to: Date.parse('2026-10-25T00:00:00Z') });
    expect(parseRange({ days: 2 }, NOW)).toEqual({ from: NOW - 2 * 86_400_000, to: NOW });
    expect(() => parseRange({ from: 'yesterday' })).toThrow(/not a date/);
    expect(() => parseRange({ from: '2020-01-01', to: '2026-01-01' })).toThrow(/longer than/);
  });

  it('buckets heart rate', () => {
    const hourly = series(data, 'heartRate', { from: '2026-10-24', to: '2026-10-24', resolution: 'hour' });
    expect(hourly.points.map((p) => (p as { n: number }).n)).toEqual([61, 60, 60]); // the first hour includes the manual sample
    expect((hourly.points[1] as { min: number; max: number }).min).toBe(60);
    const raw = series(data, 'heartRate', { from: '2026-10-24', to: '2026-10-24', resolution: 'raw' });
    expect(raw.points).toHaveLength(181);
    expect(() => series(data, 'heartRate', { resolution: 'weekly' })).toThrow(/resolution/);
  });

  it('sums steps per band-local day and reports the band\'s own total', () => {
    const s = steps(data, { days: 3 }, NOW);
    expect(s).toMatchObject({ resolution: 'day', dayTzOffsetMinutes: 420, totalSteps: 1800, bandDailyTotals: [{ date: '2026-10-24', steps: 1800 }] });
    expect(s.points).toEqual([{ t: '2026-10-23T17:00:00.000Z', steps: 1800, distanceM: 1260, activeKcal: 180 }]);
  });

  it('summarises per day', () => {
    const s = summary(data, { days: 3 }, NOW);
    const day = s.days.find((d) => d.date === '2026-10-24')!;
    expect(day).toMatchObject({ steps: 1800, sleepMin: 420 });
    expect(day.heartRate).toMatchObject({ min: 60, max: 89, n: 181 });
    expect(s.days.find((d) => d.date === '2026-10-23')?.heartRate).toMatchObject({ min: 58, n: 2 }); // sleep samples, 22:40 local
  });

  it('pages raw records', () => {
    const r = records(data, { kind: 'activity', days: 3, limit: 50, offset: 170 }, NOW);
    expect(r).toMatchObject({ total: 180, offset: 170 });
    expect(r.items).toHaveLength(10);
    expect(() => records(data, { kind: 'passwords' })).toThrow(/kind/);
  });
});

describe('tools/health-mcp/server.js (stdio)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-mcp-'));
  writeFileSync(join(dir, 'a.json'), JSON.stringify(data));
  writeFileSync(join(dir, 'b.json'), JSON.stringify({ ...data, activity: [{ t: '2026-10-25T00:00:00.000Z', steps: 5 }], heartRate: [], spo2: [], stress: [], sleep: [], daily: [], files: [] }));
  writeFileSync(join(dir, 'other.json'), '{"not":"an export"}');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function talk(messages: object[]): Promise<Record<string, unknown>[]> {
    const p = spawn(process.execPath, ['tools/health-mcp/server.js'], { env: { ...process.env, HEALTH_DATA: dir }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (b) => (out += b));
    const expected = messages.filter((m) => 'id' in m).length;
    p.stdin.write(messages.map((m) => JSON.stringify(m)).join('\n') + '\n');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout, got: ${out}`)), 10_000);
      p.stdout.on('data', () => {
        if (out.split('\n').filter(Boolean).length >= expected) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    p.kill();
    return out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).sort((a, b) => a.id - b.id);
  }

  const call = (id: number, name: string, args: object = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

  it('initializes, lists tools and answers queries over a folder of exports', async () => {
    const res = await talk([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      call(3, 'data_info'),
      call(4, 'steps', { from: '2026-10-23', to: '2026-10-25', tz_offset_minutes: 0 }),
      call(5, 'sleep', { from: '2026-10-23', to: '2026-10-25', stages: false }),
      call(6, 'heart_rate', { from: 'nope' }),
      call(7, 'no_such_tool'),
      { jsonrpc: '2.0', id: 8, method: 'resources/list' },
    ]);
    expect(res).toHaveLength(8);
    expect(res[0].result).toMatchObject({ protocolVersion: '2025-03-26', serverInfo: { name: 'miband-health' } });
    const tools = (res[1].result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(tools).toEqual(['data_info', 'summary', 'heart_rate', 'steps', 'sleep', 'workouts', 'spo2', 'stress', 'records']);
    const info = (res[2].result as { structuredContent: { coverage: Record<string, { count: number }> } }).structuredContent;
    expect(info.coverage.activity.count).toBe(181); // a.json + b.json merged
    const st = (res[3].result as { structuredContent: { totalSteps: number } }).structuredContent;
    expect(st.totalSteps).toBe(1805);
    const sl = (res[4].result as { structuredContent: { sessions: object[] } }).structuredContent;
    expect(sl.sessions[0]).not.toHaveProperty('stages');
    expect(res[5].result).toMatchObject({ isError: true });
    expect(res[6].error).toMatchObject({ code: -32602 });
    expect(res[7].error).toMatchObject({ code: -32601 });
  });
});

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildHealthData } from '../src/health/export';
import { parseFileId } from '../src/health/files';
import { toChunks } from '../src/health/query';
import { handleHealthApi, type HealthEnv, INACTIVE_ACCOUNT_DAYS, purgeExpired, type RateLimiter } from '../worker/health';
import { makeD1 } from './d1-shim';
import { dailyDetailsV4, manualSamplesV2, sleepDetailsV5 } from './health-fixtures';

const T0 = 1_792_800_000; // 2026-10-24T00:00:00Z
const NOW = (T0 + 86_400) * 1000;
const DAY = 86_400_000;

const data = buildHealthData(
  [dailyDetailsV4(T0, Array.from({ length: 120 }, (_, i) => ({ steps: 10, kcal: 1, distanceM: 7, hr: 60 + (i % 30), spo2: 97, stress: 20 }))), manualSamplesV2(T0), sleepDetailsV5(T0 - 30_000, T0 - 30_000, T0 - 5000)].map((bytes) => ({ id: parseFileId(bytes), bytes })),
);

// Nothing in the health API may print request or response data.
const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m));
afterAll(() => {
  for (const s of consoleSpies) expect(s).not.toHaveBeenCalled();
});

let env: HealthEnv;
let sql: ReturnType<typeof makeD1>['sql'];

function req(method: string, path: string, opts: { key?: string; body?: unknown; now?: number; ip?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.ip) headers['cf-connecting-ip'] = opts.ip;
  const r = new Request(`https://miband.test/api/health${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  return handleHealthApi(r, new URL(r.url), env, opts.now ?? NOW);
}

async function body<T = Record<string, unknown>>(r: Response | Promise<Response>): Promise<T & { status: number }> {
  const res = await r;
  const text = await res.text();
  return { ...(text ? JSON.parse(text) : {}), status: res.status };
}

async function account(): Promise<{ owner: string; id: string }> {
  const r = await body<{ ownerKey: string; accountId: string }>(req('POST', '/account', { body: {} }));
  expect(r.status).toBe(201);
  return { owner: r.ownerKey, id: r.accountId };
}

async function agentKey(owner: string, label = 'claude'): Promise<string> {
  const r = await body<{ key: string }>(req('POST', '/keys', { key: owner, body: { label } }));
  expect(r.status).toBe(201);
  return r.key;
}

async function uploadAll(owner: string, d = data, now = NOW) {
  const chunks = toChunks(d);
  for (let i = 0; i < chunks.length; i += 40) {
    const r = await body(req('PUT', '/data', { key: owner, body: { chunks: chunks.slice(i, i + 40) }, now }));
    expect(r.status).toBe(200);
  }
}

beforeEach(() => {
  const db = makeD1();
  sql = db.sql;
  env = { HEALTH_DB: db.d1 };
});

describe('cloud health API', () => {
  it('creates an anonymous account; stores only a hash of the key and nothing about the caller', async () => {
    const { owner, id } = await account();
    expect(owner).toMatch(/^mbh_[0-9a-f]{16}\.[A-Za-z0-9_-]{43}$/);
    const rows = sql.prepare('SELECT * FROM api_keys').all() as { hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(sql.prepare('SELECT * FROM accounts').all())).not.toContain('203.0.113');
    expect(JSON.stringify(rows)).not.toContain(owner.split('.')[1]);
    const info = await body(req('GET', '/account', { key: owner }));
    expect(info).toMatchObject({ status: 200, accountId: id, retentionDays: 90 });
  });

  it('rejects missing, malformed and unknown keys', async () => {
    await account();
    expect((await req('GET', '/v1/summary')).status).toBe(401);
    expect((await req('GET', '/v1/summary', { key: 'hello' })).status).toBe(401);
    expect((await req('GET', '/v1/summary', { key: `mbh_0123456789abcdef.${'A'.repeat(43)}` })).status).toBe(401);
  });

  it('uploads, merges re-uploads and serves the REST queries to a read key', async () => {
    const { owner } = await account();
    const agent = await agentKey(owner);
    await uploadAll(owner);
    await uploadAll(owner); // idempotent
    const steps = await body<{ totalSteps: number }>(req('GET', '/v1/steps?from=2026-10-24&to=2026-10-24', { key: agent }));
    expect(steps).toMatchObject({ status: 200, totalSteps: 1200 });
    const hr = await body<{ points: { n: number }[] }>(req('GET', '/v1/heart-rate?from=2026-10-24&to=2026-10-24&resolution=hour', { key: agent }));
    expect(hr.points.map((p) => p.n)).toEqual([61, 60]);
    const sleep = await body<{ sessions: { quality: number }[] }>(req('GET', '/v1/sleep?days=3', { key: agent }));
    expect(sleep.sessions[0].quality).toBe(85);
    const recs = await body<{ total: number }>(req('GET', '/v1/records?kind=activity&from=2026-10-24&to=2026-10-24&limit=5', { key: agent }));
    expect(recs.total).toBe(120);
    const info = await body<{ coverage: Record<string, { days: number }> }>(req('GET', '/v1/info', { key: agent }));
    expect(info.coverage.activity.days).toBe(1);
    expect((await body(req('GET', '/v1/heart-rate?from=bad', { key: agent }))).status).toBe(400);
    expect((await body(req('GET', '/v1/nope', { key: agent }))).status).toBe(404);
  });

  it('a read key cannot write, manage keys or delete', async () => {
    const { owner } = await account();
    const agent = await agentKey(owner);
    expect((await req('PUT', '/data', { key: agent, body: { chunks: [] } })).status).toBe(403);
    expect((await req('POST', '/keys', { key: agent, body: {} })).status).toBe(403);
    expect((await req('DELETE', '/account', { key: agent })).status).toBe(403);
    expect((await req('GET', '/account', { key: agent })).status).toBe(403);
  });

  it('keeps accounts apart', async () => {
    const a = await account();
    const b = await account();
    await uploadAll(a.owner);
    const bAgent = await agentKey(b.owner);
    const s = await body<{ totalSteps: number }>(req('GET', '/v1/steps?days=3', { key: bAgent }));
    expect(s.totalSteps).toBe(0);
    const aAgent = await agentKey(a.owner);
    const aAgentId = aAgent.slice(4, 20);
    expect((await req('DELETE', `/keys/${aAgentId}`, { key: b.owner })).status).toBe(404); // B cannot revoke A's key
    expect((await req('GET', '/v1/summary', { key: aAgent })).status).toBe(200);
    const mcp = await body<{ result: { structuredContent: { totalSteps: number } } }>(
      req('POST', '/mcp', { key: bAgent, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'steps', arguments: { days: 3 } } } }),
    );
    expect(mcp.result.structuredContent.totalSteps).toBe(0);
  });

  it('revokes agent keys, but not the owner key', async () => {
    const { owner } = await account();
    const agent = await agentKey(owner);
    const keys = (await body<{ keys: { id: string; role: string }[] }>(req('GET', '/account', { key: owner }))).keys;
    expect(keys.map((k) => k.role)).toEqual(['owner', 'read']);
    expect((await req('DELETE', `/keys/${keys[0].id}`, { key: owner })).status).toBe(400);
    expect((await req('DELETE', `/keys/${keys[1].id}`, { key: owner })).status).toBe(200);
    expect((await req('GET', '/v1/summary', { key: agent })).status).toBe(401);
  });

  it('"delete all my data" removes the account, its keys and its records', async () => {
    const a = await account();
    const b = await account();
    await uploadAll(a.owner);
    await uploadAll(b.owner);
    const agent = await agentKey(a.owner);
    expect((await req('DELETE', '/account', { key: a.owner })).status).toBe(200);
    const left = (t: string, col = 'account_id') => (sql.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} = ?`).get(a.id) as { n: number }).n;
    expect([left('chunks'), left('api_keys'), left('accounts', 'id')]).toEqual([0, 0, 0]);
    expect((await req('GET', '/v1/summary', { key: agent })).status).toBe(401);
    expect((await req('GET', '/v1/summary', { key: a.owner })).status).toBe(401);
    expect((sql.prepare('SELECT COUNT(*) AS n FROM chunks WHERE account_id = ?').get(b.id) as { n: number }).n).toBeGreaterThan(0);
  });

  it('applies retention on upload, on change and in the daily purge', async () => {
    const { owner, id } = await account();
    const old = { ...data, activity: [{ t: new Date(NOW - 100 * DAY).toISOString(), steps: 1 }], heartRate: [], spo2: [], stress: [], respiratoryRate: [], temperature: [], sleep: [], daily: [], workouts: [] };
    const r = await body(req('PUT', '/data', { key: owner, body: { chunks: toChunks(old) } }));
    expect(r).toMatchObject({ stored: 0, skippedOlderThanRetention: 1 });
    await uploadAll(owner);
    expect((await body(req('PATCH', '/account', { key: owner, body: { retentionDays: 12 } }))).status).toBe(400);
    expect((await body(req('PATCH', '/account', { key: owner, body: { retentionDays: 7 } }))).status).toBe(200);
    const days = () => (sql.prepare('SELECT COUNT(*) AS n FROM chunks WHERE account_id = ?').get(id) as { n: number }).n;
    expect(days()).toBeGreaterThan(0);
    await purgeExpired(env, NOW + 10 * DAY); // ten days later the records are past 7 days
    expect(days()).toBe(0);
    expect((await req('GET', '/account', { key: owner, now: NOW + 10 * DAY })).status).toBe(200);
    await purgeExpired(env, NOW + 10 * DAY + (INACTIVE_ACCOUNT_DAYS + 1) * DAY); // unused for half a year
    expect((sql.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n).toBe(0);
    expect((sql.prepare('SELECT COUNT(*) AS n FROM api_keys').get() as { n: number }).n).toBe(0);
  });

  it('validates uploads', async () => {
    const { owner } = await account();
    const put = (b: unknown) => body(req('PUT', '/data', { key: owner, body: b }));
    expect((await put({})).status).toBe(400);
    expect((await put({ chunks: [{ kind: 'passwords', day: '2026-10-24', records: [] }] })).status).toBe(400);
    expect((await put({ chunks: [{ kind: 'activity', day: '2026-10-23', records: [{ t: '2026-10-24T01:00:00Z' }] }] })).status).toBe(400);
    expect((await put({ chunks: Array.from({ length: 41 }, () => ({ kind: 'activity', day: '2026-10-24', records: [] })) })).status).toBe(413);
  });

  it('speaks MCP over streamable HTTP with the same key', async () => {
    const { owner } = await account();
    const agent = await agentKey(owner);
    await uploadAll(owner);
    const init = await body<{ result: { serverInfo: { name: string } } }>(req('POST', '/mcp', { key: agent, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } } }));
    expect(init.result.serverInfo.name).toBe('miband-health-cloud');
    expect((await req('POST', '/mcp', { key: agent, body: { jsonrpc: '2.0', method: 'notifications/initialized' } })).status).toBe(202);
    const batch = await (await req('POST', '/mcp', { key: agent, body: [{ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'summary', arguments: { days: 3 } } }] })).json() as { id: number; result: { structuredContent?: { days: { steps: number }[] } } }[];
    expect(batch.map((m) => m.id)).toEqual([2, 3]);
    expect(batch[1].result.structuredContent!.days.reduce((s, d) => s + d.steps, 0)).toBe(1200);
    expect((await req('GET', '/mcp', { key: agent })).status).toBe(405);
    expect((await req('POST', '/mcp')).status).toBe(401);
  });

  it('rate limits per key and account creation per network', async () => {
    const counter = (max: number): RateLimiter => {
      const n = new Map<string, number>();
      return { limit: async ({ key }) => ({ success: (n.set(key, (n.get(key) ?? 0) + 1).get(key) ?? 0) <= max }) };
    };
    env.HEALTH_RATE_LIMIT = counter(3);
    env.HEALTH_SIGNUP_LIMIT = counter(2);
    const { owner } = await account();
    await account();
    expect((await req('POST', '/account', { body: {} })).status).toBe(429);
    expect((await req('POST', '/account', { body: {}, ip: '203.0.113.9' })).status).toBe(201); // another network
    for (let i = 0; i < 3; i++) expect((await req('GET', '/account', { key: owner })).status).toBe(200);
    const limited = await req('GET', '/account', { key: owner });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
  });

  it('answers 503 when the database is not configured', async () => {
    env = {};
    expect((await req('POST', '/account', { body: {} })).status).toBe(503);
  });
});

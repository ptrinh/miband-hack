import { handleMcp, type HealthSource, KINDS, parseRange, QueryError, type QueryArgs, recordDay, recordKey, runTool } from '../src/health/query';
import type { HealthData, RecordKind } from '../src/health/schema';
import { HEALTH_SCHEMA, UNITS } from '../src/health/units';

// Opt-in cloud API for health data: the browser uploads parsed records, the user's own AI agent
// reads them back over REST or remote MCP with an API key. See docs/health-data.md ("Cloud API").
//
// Identity: POST /api/health/account creates a random account id and an owner key; nothing about
// the person, the band or the Xiaomi account is stored. Keys are `mbh_<16 hex id>.<secret>`; only
// SHA-256(secret) is kept. Owner keys upload, manage keys and delete; read keys only read.
// Never log request or response bodies here (observability is off in wrangler.jsonc).

// The subset of the D1 and Rate Limiting bindings used here, so the tests can run this module on
// node:sqlite (test/d1-shim.ts) without the Workers type globals.
export interface D1Stmt {
  bind(...values: unknown[]): D1Stmt;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes?: number } }>;
}
export interface D1Like {
  prepare(sql: string): D1Stmt;
  batch(statements: D1Stmt[]): Promise<unknown[]>;
}
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface HealthEnv {
  HEALTH_DB?: D1Like;
  /** Per key (and per IP for account creation), see wrangler.jsonc. Optional so `wrangler dev` works without it. */
  HEALTH_RATE_LIMIT?: RateLimiter;
  HEALTH_SIGNUP_LIMIT?: RateLimiter;
}

type Role = 'owner' | 'read';
interface Auth { keyId: string; accountId: string; role: Role }

const RETENTION_CHOICES = [7, 30, 90, 365];
export const DEFAULT_RETENTION_DAYS = 90;
/** Accounts nobody used (no upload, no read) for this long are deleted with everything in them. */
export const INACTIVE_ACCOUNT_DAYS = 180;
const MAX_KEYS = 20;
const MAX_CHUNKS_PER_UPLOAD = 40; // keeps a request under the free plan's 50 D1 queries
const MAX_CHUNK_BYTES = 1_500_000;
const MAX_BODY_BYTES = 25_000_000;
const ACTIVITY_WRITE_EVERY_MS = 3_600_000;
const DAY_MS = 86_400_000;
const KEY_RE = /^mbh_([0-9a-f]{16})\.([A-Za-z0-9_-]{43})$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const TOOL_PATHS: Record<string, string> = {
  info: 'data_info',
  summary: 'summary',
  'heart-rate': 'heart_rate',
  steps: 'steps',
  sleep: 'sleep',
  workouts: 'workouts',
  spo2: 'spo2',
  stress: 'stress',
  records: 'records',
};

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly headers: Record<string, string> = {}) {
    super(message);
  }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

// ------------------------------------------------------------------ keys ---

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

const hexOf = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

async function sha256Hex(s: string): Promise<string> {
  return hexOf(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function newKey(): Promise<{ id: string; key: string; hash: string }> {
  const id = hexOf(crypto.getRandomValues(new Uint8Array(8)));
  const secret = b64url(crypto.getRandomValues(new Uint8Array(32)));
  return { id, key: `mbh_${id}.${secret}`, hash: await sha256Hex(secret) };
}

async function authenticate(req: Request, db: D1Like, env: HealthEnv, now: number): Promise<Auth> {
  const header = req.headers.get('authorization') ?? '';
  const m = KEY_RE.exec(header.replace(/^Bearer\s+/i, '').trim());
  if (!m) throw new HttpError(401, 'missing or malformed API key (Authorization: Bearer mbh_…)', { 'www-authenticate': 'Bearer' });
  const [, keyId, secret] = m;
  if (env.HEALTH_RATE_LIMIT && !(await env.HEALTH_RATE_LIMIT.limit({ key: keyId })).success) {
    throw new HttpError(429, 'rate limited, try again in a minute', { 'retry-after': '60' });
  }
  const row = await db.prepare('SELECT account_id, hash, role, last_used_at FROM api_keys WHERE id = ?').bind(keyId).first<{ account_id: string; hash: string; role: Role; last_used_at: number | null }>();
  if (!row || !timingSafeEqual(row.hash, await sha256Hex(secret))) throw new HttpError(401, 'unknown or revoked API key', { 'www-authenticate': 'Bearer' });
  if (!row.last_used_at || now - row.last_used_at > ACTIVITY_WRITE_EVERY_MS) {
    await db.batch([
      db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').bind(now, keyId),
      db.prepare('UPDATE accounts SET last_active_at = ? WHERE id = ?').bind(now, row.account_id),
    ]);
  }
  return { keyId, accountId: row.account_id, role: row.role };
}

const needOwner = (a: Auth): void => {
  if (a.role !== 'owner') throw new HttpError(403, 'this needs the owner key; agent keys can only read');
};

// --------------------------------------------------------------- storage ---

const recordTime = (r: Record<string, unknown>): string => String(r.t ?? r.start ?? '');

function cutoffDay(retentionDays: number, now: number): string {
  return new Date(now - retentionDays * DAY_MS).toISOString().slice(0, 10);
}

/** A HealthSource over one account's chunks: loads the days of a range (one D1 query). */
function d1Source(db: D1Like, accountId: string): HealthSource {
  return {
    async load(range) {
      // a day either side so sleep sessions that cross midnight are included
      const from = new Date(range.from - DAY_MS).toISOString().slice(0, 10);
      const to = new Date(range.to + DAY_MS).toISOString().slice(0, 10);
      const { results } = await db.prepare('SELECT kind, data FROM chunks WHERE account_id = ? AND day >= ? AND day <= ? ORDER BY day').bind(accountId, from, to).all<{ kind: RecordKind; data: string }>();
      const d = {
        schema: HEALTH_SCHEMA,
        exportedAt: new Date().toISOString(),
        generator: 'miband-hack cloud',
        timezone: { timestamps: 'UTC' },
        units: UNITS,
        files: [],
        ...Object.fromEntries(KINDS.map((k) => [k, [] as unknown[]])),
      } as unknown as HealthData;
      for (const row of results) (d[row.kind] as unknown[]).push(...(JSON.parse(row.data) as unknown[]));
      const tz = d.daily.at(-1)?.tzOffsetMinutes;
      if (tz !== undefined) d.timezone.bandOffsetMinutes = tz;
      return d;
    },
    async info() {
      const acct = await db.prepare('SELECT created_at, retention_days FROM accounts WHERE id = ?').bind(accountId).first<{ created_at: number; retention_days: number }>();
      const { results } = await db
        .prepare('SELECT kind, MIN(day) AS first, MAX(day) AS last, COUNT(*) AS days FROM chunks WHERE account_id = ? GROUP BY kind')
        .bind(accountId)
        .all<{ kind: string; first: string; last: string; days: number }>();
      return {
        schema: HEALTH_SCHEMA,
        units: UNITS,
        retentionDays: acct?.retention_days,
        coverage: Object.fromEntries(results.map((r) => [r.kind, { firstDay: r.first, lastDay: r.last, days: r.days }])),
        note: 'Timestamps are UTC. Raw band files are never uploaded; only decoded records are stored.',
      };
    },
  };
}

interface UploadChunk { kind: RecordKind; day: string; records: Record<string, unknown>[] }

function validateUpload(body: unknown): UploadChunk[] {
  const chunks = (body as { chunks?: unknown })?.chunks;
  if (!Array.isArray(chunks)) throw new HttpError(400, 'expected {chunks: [{kind, day, records}]}');
  if (chunks.length > MAX_CHUNKS_PER_UPLOAD) throw new HttpError(413, `at most ${MAX_CHUNKS_PER_UPLOAD} chunks per request`);
  return chunks.map((c: Partial<UploadChunk>) => {
    if (!c || !KINDS.includes(c.kind as RecordKind)) throw new HttpError(400, `kind must be one of ${KINDS.join(', ')}`);
    if (typeof c.day !== 'string' || !DAY_RE.test(c.day)) throw new HttpError(400, 'day must be YYYY-MM-DD');
    if (!Array.isArray(c.records) || c.records.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) throw new HttpError(400, 'records must be an array of objects');
    for (const r of c.records) if (recordDay(c.kind!, r) !== c.day) throw new HttpError(400, `a ${c.kind} record does not belong to day ${c.day}`);
    return c as UploadChunk;
  });
}

async function upload(db: D1Like, a: Auth, body: unknown, now: number): Promise<object> {
  const chunks = validateUpload(body);
  const acct = await db.prepare('SELECT retention_days FROM accounts WHERE id = ?').bind(a.accountId).first<{ retention_days: number }>();
  if (!acct) throw new HttpError(404, 'account not found');
  const cutoff = cutoffDay(acct.retention_days, now);
  const fresh = chunks.filter((c) => c.day >= cutoff);
  if (fresh.length === 0) return { stored: 0, skippedOlderThanRetention: chunks.length };
  const days = fresh.map((c) => c.day).sort();
  const { results } = await db
    .prepare('SELECT kind, day, data FROM chunks WHERE account_id = ? AND day >= ? AND day <= ?')
    .bind(a.accountId, days[0], days.at(-1)!)
    .all<{ kind: RecordKind; day: string; data: string }>();
  const existing = new Map(results.map((r) => [`${r.kind}|${r.day}`, r.data]));
  // merge with what is stored: a re-upload replaces records with the same time (and source)
  const merged = new Map<string, UploadChunk>();
  for (const c of fresh) {
    const k = `${c.kind}|${c.day}`;
    const prev = merged.get(k)?.records ?? (existing.has(k) ? (JSON.parse(existing.get(k)!) as Record<string, unknown>[]) : []);
    const m = new Map(prev.map((r) => [recordKey(c.kind, r), r]));
    for (const r of c.records) m.set(recordKey(c.kind, r), r);
    merged.set(k, { kind: c.kind, day: c.day, records: [...m.values()].sort((x, y) => recordTime(x).localeCompare(recordTime(y))) });
  }
  const stmts = [...merged.values()].map((c) => {
    const data = JSON.stringify(c.records);
    if (data.length > MAX_CHUNK_BYTES) throw new HttpError(413, `${c.kind} ${c.day} is too large`);
    return db
      .prepare('INSERT INTO chunks (account_id, kind, day, data, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (account_id, kind, day) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
      .bind(a.accountId, c.kind, c.day, data, now);
  });
  stmts.push(db.prepare('UPDATE accounts SET last_active_at = ? WHERE id = ?').bind(now, a.accountId));
  await db.batch(stmts);
  return { stored: merged.size, skippedOlderThanRetention: chunks.length - fresh.length };
}

/** Everything of one account, in one transaction (D1 batches are atomic). */
async function deleteAccount(db: D1Like, accountId: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM chunks WHERE account_id = ?').bind(accountId),
    db.prepare('DELETE FROM api_keys WHERE account_id = ?').bind(accountId),
    db.prepare('DELETE FROM accounts WHERE id = ?').bind(accountId),
  ]);
}

/** Daily cron: drops records past each account's retention and accounts unused for INACTIVE_ACCOUNT_DAYS. */
export async function purgeExpired(env: HealthEnv, now = Date.now()): Promise<void> {
  const db = env.HEALTH_DB;
  if (!db) return;
  const stale = now - INACTIVE_ACCOUNT_DAYS * DAY_MS;
  await db.batch([
    db.prepare("DELETE FROM chunks WHERE day < (SELECT date(?, 'unixepoch', '-' || a.retention_days || ' days') FROM accounts a WHERE a.id = chunks.account_id)").bind(Math.floor(now / 1000)),
    db.prepare('DELETE FROM chunks WHERE account_id IN (SELECT id FROM accounts WHERE last_active_at < ?)').bind(stale),
    db.prepare('DELETE FROM api_keys WHERE account_id IN (SELECT id FROM accounts WHERE last_active_at < ?)').bind(stale),
    db.prepare('DELETE FROM accounts WHERE last_active_at < ?').bind(stale),
    db.prepare('DELETE FROM chunks WHERE account_id NOT IN (SELECT id FROM accounts)'),
    db.prepare('DELETE FROM api_keys WHERE account_id NOT IN (SELECT id FROM accounts)'),
  ]);
}

// ---------------------------------------------------------------- routes ---

async function readJson(req: Request): Promise<unknown> {
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > MAX_BODY_BYTES) throw new HttpError(413, 'request too large');
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
}

function queryArgs(url: URL): QueryArgs {
  const a: Record<string, unknown> = {};
  for (const [k, v] of url.searchParams) {
    a[k] = ['days', 'limit', 'offset', 'tz_offset_minutes'].includes(k) ? Number(v) : k === 'stages' ? v !== 'false' : v;
  }
  return a as QueryArgs;
}

async function route(req: Request, url: URL, env: HealthEnv, db: D1Like, now: number): Promise<Response> {
  const path = url.pathname.replace(/^\/api\/health/, '') || '/';
  const method = req.method;

  if (path === '/account' && method === 'POST') {
    const ip = req.headers.get('cf-connecting-ip') ?? 'local';
    // the IP is only a rate-limit key here; it is not stored
    if (env.HEALTH_SIGNUP_LIMIT && !(await env.HEALTH_SIGNUP_LIMIT.limit({ key: `signup:${await sha256Hex(ip)}` })).success) {
      throw new HttpError(429, 'too many new accounts from this network, try again later', { 'retry-after': '60' });
    }
    const accountId = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const k = await newKey();
    await db.batch([
      db.prepare('INSERT INTO accounts (id, created_at, last_active_at, retention_days) VALUES (?, ?, ?, ?)').bind(accountId, now, now, DEFAULT_RETENTION_DAYS),
      db.prepare("INSERT INTO api_keys (id, account_id, hash, role, label, created_at) VALUES (?, ?, ?, 'owner', 'owner', ?)").bind(k.id, accountId, k.hash, now),
    ]);
    return json({ accountId, ownerKey: k.key, retentionDays: DEFAULT_RETENTION_DAYS }, 201);
  }

  const auth = await authenticate(req, db, env, now);

  if (path === '/mcp') {
    if (method !== 'POST') return json({ error: 'use POST (streamable HTTP, JSON responses)' }, 405, { allow: 'POST' });
    const body = await readJson(req);
    const src = d1Source(db, auth.accountId);
    const server = { name: 'miband-health-cloud', version: '1.0.0' };
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handleMcp(m, src, server)))).filter(Boolean);
      return out.length ? json(out) : new Response(null, { status: 202 });
    }
    const res = await handleMcp(body as object, src, server);
    return res ? json(res) : new Response(null, { status: 202 });
  }

  const tool = /^\/v1\/([a-z0-9-]+)$/.exec(path);
  if (tool && method === 'GET') {
    const name = TOOL_PATHS[tool[1]];
    if (!name) throw new HttpError(404, `unknown endpoint; one of: ${Object.keys(TOOL_PATHS).join(', ')}`);
    const args = queryArgs(url);
    if (name !== 'data_info') parseRange(args, now); // validate before touching D1
    return json(await runTool(name, args, d1Source(db, auth.accountId)));
  }

  if (path === '/account' && method === 'GET') {
    needOwner(auth);
    const acct = await db.prepare('SELECT created_at, retention_days FROM accounts WHERE id = ?').bind(auth.accountId).first<{ created_at: number; retention_days: number }>();
    if (!acct) throw new HttpError(404, 'account not found');
    const { results } = await db
      .prepare('SELECT id, role, label, created_at, last_used_at FROM api_keys WHERE account_id = ? ORDER BY created_at')
      .bind(auth.accountId)
      .all<{ id: string; role: Role; label: string; created_at: number; last_used_at: number | null }>();
    return json({
      accountId: auth.accountId,
      createdAt: new Date(acct.created_at).toISOString(),
      retentionDays: acct.retention_days,
      keys: results.map((k) => ({ id: k.id, role: k.role, label: k.label, createdAt: new Date(k.created_at).toISOString(), lastUsedAt: k.last_used_at ? new Date(k.last_used_at).toISOString() : null, current: k.id === auth.keyId })),
      data: await d1Source(db, auth.accountId).info(),
    });
  }

  if (path === '/account' && method === 'PATCH') {
    needOwner(auth);
    const days = Number((await readJson(req) as { retentionDays?: unknown })?.retentionDays);
    if (!RETENTION_CHOICES.includes(days)) throw new HttpError(400, `retentionDays must be one of ${RETENTION_CHOICES.join(', ')}`);
    await db.batch([
      db.prepare('UPDATE accounts SET retention_days = ? WHERE id = ?').bind(days, auth.accountId),
      db.prepare('DELETE FROM chunks WHERE account_id = ? AND day < ?').bind(auth.accountId, cutoffDay(days, now)),
    ]);
    return json({ retentionDays: days });
  }

  if (path === '/account' && method === 'DELETE') {
    needOwner(auth);
    await deleteAccount(db, auth.accountId);
    return json({ deleted: true });
  }

  if (path === '/data' && method === 'PUT') {
    needOwner(auth);
    return json(await upload(db, auth, await readJson(req), now));
  }

  if (path === '/data' && method === 'DELETE') {
    needOwner(auth);
    await db.prepare('DELETE FROM chunks WHERE account_id = ?').bind(auth.accountId).run();
    return json({ deleted: true });
  }

  if (path === '/keys' && method === 'POST') {
    needOwner(auth);
    const label = String((await readJson(req) as { label?: unknown })?.label ?? '').slice(0, 60);
    const count = await db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE account_id = ?').bind(auth.accountId).first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_KEYS) throw new HttpError(409, `at most ${MAX_KEYS} keys; revoke one first`);
    const k = await newKey();
    await db.prepare("INSERT INTO api_keys (id, account_id, hash, role, label, created_at) VALUES (?, ?, ?, 'read', ?, ?)").bind(k.id, auth.accountId, k.hash, label, now).run();
    return json({ id: k.id, key: k.key, role: 'read', label }, 201);
  }

  const del = /^\/keys\/([0-9a-f]{16})$/.exec(path);
  if (del && method === 'DELETE') {
    needOwner(auth);
    if (del[1] === auth.keyId) throw new HttpError(400, 'the owner key goes away with the account (DELETE /api/health/account)');
    const r = await db.prepare("DELETE FROM api_keys WHERE id = ? AND account_id = ? AND role = 'read'").bind(del[1], auth.accountId).run();
    if (!r.meta.changes) throw new HttpError(404, 'no such key');
    return json({ revoked: del[1] });
  }

  throw new HttpError(404, 'not found');
}

export async function handleHealthApi(req: Request, url: URL, env: HealthEnv, now = Date.now()): Promise<Response> {
  const db = env.HEALTH_DB;
  if (!db) return json({ error: 'the cloud API is not enabled on this server' }, 503);
  try {
    return await route(req, url, env, db, now);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status, e.headers);
    if (e instanceof QueryError) return json({ error: e.message }, 400);
    // no details: they could contain user data
    return json({ error: 'internal error' }, 500);
  }
}

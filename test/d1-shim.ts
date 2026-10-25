import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { D1Like, D1Stmt } from '../worker/health';

/** Just enough of D1 on node:sqlite to run worker/health.ts against the real migration. */
export function makeD1(migration = 'migrations/0001_health.sql'): { d1: D1Like; sql: DatabaseSync } {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(migration, 'utf8'));
  const returnsRows = (q: string) => /^\s*(SELECT|WITH)\b/i.test(q) || /\bRETURNING\b/i.test(q);

  const stmt = (q: string, params: unknown[] = []): D1Stmt & { exec(): unknown } => {
    const s = sql.prepare(q);
    const args = params as (string | number | null)[];
    return {
      bind: (...v: unknown[]) => stmt(q, v),
      first: async <T>() => (s.get(...args) as T | undefined) ?? null,
      all: async <T>() => ({ results: s.all(...args) as T[] }),
      run: async () => ({ meta: { changes: Number(s.run(...args).changes) } }),
      exec: () => (returnsRows(q) ? { results: s.all(...args) } : { meta: { changes: Number(s.run(...args).changes) } }),
    };
  };

  const d1: D1Like = {
    prepare: (q) => stmt(q),
    // D1 runs a batch as one transaction
    batch: async (list) => {
      sql.exec('BEGIN');
      try {
        const out = list.map((s) => (s as ReturnType<typeof stmt>).exec());
        sql.exec('COMMIT');
        return out;
      } catch (e) {
        sql.exec('ROLLBACK');
        throw e;
      }
    },
  };
  return { d1, sql };
}

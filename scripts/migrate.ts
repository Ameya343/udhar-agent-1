#!/usr/bin/env node
// Applies db/migrations/*.sql in name order, each once, each in its own transaction.
//   DATABASE_URL=... node dist-server/scripts/migrate.js
import fs = require('fs');
import path = require('path');
import type { Queryable } from '../server/tables';

/** A pg pool (connect() gives a client to release) or a client already checked out. */
type Client = Queryable & { release?: () => void };
export type Migratable = Client & { connect?: () => Promise<Client> };

// compiled to dist-server/scripts/, two levels below the repo root
const DIR = path.join(__dirname, '..', '..', 'db', 'migrations');

// Takes a pg client or pool; returns the versions applied by this call.
async function migrate(db: Migratable, dir?: string): Promise<string[]> {
  dir = dir || DIR;
  const files = fs.readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const client: Client = db.connect && !db.release ? await db.connect() : db;
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(727001)'); // one migrator at a time
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
    for (const f of files) {
      if (done.has(f)) continue;
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [f]);
        await client.query('COMMIT');
        applied.push(f);
      } catch (e) { await client.query('ROLLBACK'); throw new Error(f + ': ' + (e as Error).message); }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    if (client !== db) client.release!();
  }
  return applied;
}

export { migrate, DIR };
if (require.main === module) {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(2); }
  const pg: typeof import('pg') = require('pg');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  migrate(pool).then((a) => { console.log(a.length ? 'applied: ' + a.join(', ') : 'up to date'); return pool.end(); }, (e) => { console.error('migration failed: ' + e.message); pool.end(); process.exit(1); });
}

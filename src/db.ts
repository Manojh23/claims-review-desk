import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

export type Row = Record<string, unknown>;
export interface Query {
  rows<T extends Row = Row>(sql: string, args?: unknown[]): Promise<T[]>;
}
export interface Database extends Query {
  transaction<T>(fn: (q: Query) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
const schema = `
CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY, digest TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES batches(id),
  payer TEXT NOT NULL, billed_cents INTEGER NOT NULL CHECK(billed_cents>0),
  paid_cents INTEGER NOT NULL CHECK(paid_cents>=0 AND paid_cents<=billed_cents),
  reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open'
    CHECK(status IN ('open','approved','dismissed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS claims_queue_idx ON claims (status, created_at DESC, id);
CREATE TABLE IF NOT EXISTS audit (
  seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id), actor TEXT NOT NULL,
  action TEXT NOT NULL, recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_claim_idx ON audit (claim_id, seq);
CREATE TABLE IF NOT EXISTS outbox (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  claim_id TEXT NOT NULL UNIQUE REFERENCES claims(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), acknowledged_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox (id) WHERE acknowledged_at IS NULL;
`;

export async function connect(url?: string, embeddedPath?: string): Promise<Database> {
  if (!url) {
    const db = new PGlite(embeddedPath);
    await db.exec(schema);
    return {
      rows: async <T extends Row>(s: string, a?: unknown[]) => (await db.query<T>(s,a)).rows,
      transaction: fn => db.transaction(tx => fn({
        rows: async <T extends Row>(s: string, a?: unknown[]) => (await tx.query<T>(s,a)).rows,
      })),
      close: () => db.close(),
    };
  }
  const pool = new pg.Pool({connectionString:url});
  await pool.query(schema);
  return {
    rows: async <T extends Row>(s: string, a?: unknown[]) => (await pool.query<T>(s,a)).rows,
    transaction: async fn => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({rows: async <T extends Row>(s: string,a?: unknown[]) => (await client.query<T>(s,a)).rows});
        await client.query('COMMIT');
        return result;
      } catch(e) { await client.query('ROLLBACK'); throw e; }
      finally { client.release(); }
    },
    close: () => pool.end(),
  };
}

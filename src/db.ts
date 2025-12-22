import { Pool, PoolClient, QueryConfig, QueryResult, QueryResultRow, types } from 'pg';

// Ensure DATE columns round-trip as date-only strings ("YYYY-MM-DD") to avoid timezone shifts
// when JSON serializing JavaScript Date objects.
types.setTypeParser(1082, (value) => value);

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be set before starting the API');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  config: string | QueryConfig<any[]>,
  params?: unknown[]
): Promise<QueryResult<T>> {
  if (typeof config === 'string') {
    return pool.query<T>(config, params);
  }
  return pool.query<T>(config);
}

export async function withTransaction<T>(handler: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await handler(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

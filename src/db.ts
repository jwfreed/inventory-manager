import { Pool, PoolClient, QueryConfig, QueryResult } from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be set before starting the API');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

export async function query<T = unknown>(
  config: string | QueryConfig,
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

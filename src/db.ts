import { Pool, PoolClient, QueryConfig, QueryResult, QueryResultRow, types } from 'pg';

// Ensure DATE columns round-trip as date-only strings ("YYYY-MM-DD") to avoid timezone shifts
// when JSON serializing JavaScript Date objects.
types.setTypeParser(1082, (value) => value);

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be set before starting the API');
}

// Enable query logging with EXPLAIN ANALYZE in development
const EXPLAIN_SLOW_QUERIES = process.env.NODE_ENV === 'development' && process.env.EXPLAIN_SLOW_QUERIES === 'true';
const SLOW_QUERY_THRESHOLD_MS = parseInt(process.env.SLOW_QUERY_THRESHOLD_MS || '100', 10);

// Connection pool configuration for production workloads
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_POOL_MAX || '20', 10), // Maximum connections
  idleTimeoutMillis: 30000, // Close idle connections after 30s
  connectionTimeoutMillis: 5000, // Fail fast if can't connect in 5s
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  config: string | QueryConfig<any[]>,
  params?: unknown[]
): Promise<QueryResult<T>> {
  const sql = typeof config === 'string' ? config : config.text;
  const queryParams = typeof config === 'string' ? params : config.values;
  
  const startTime = Date.now();
  
  let result: QueryResult<T>;
  if (typeof config === 'string') {
    result = await pool.query<T>(config, params);
  } else {
    result = await pool.query<T>(config);
  }
  
  const duration = Date.now() - startTime;
  
  // Log slow queries in development
  if (EXPLAIN_SLOW_QUERIES && duration > SLOW_QUERY_THRESHOLD_MS) {
    console.warn(`[SLOW QUERY] ${duration}ms: ${sql?.substring(0, 200)}...`);
    
    // Run EXPLAIN ANALYZE for SELECT queries
    if (sql && sql.trim().toUpperCase().startsWith('SELECT')) {
      try {
        const explainResult = await pool.query(`EXPLAIN ANALYZE ${sql}`, queryParams);
        console.warn('[EXPLAIN ANALYZE]');
        explainResult.rows.forEach((row: any) => console.warn('  ', row['QUERY PLAN']));
      } catch (err) {
        // Ignore explain errors (e.g., for queries with side effects)
      }
    }
  }
  
  return result;
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

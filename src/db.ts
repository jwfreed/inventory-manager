import { Pool, PoolClient, QueryConfig, QueryResult, QueryResultRow, types } from 'pg';

// Ensure DATE columns round-trip as date-only strings ("YYYY-MM-DD") to avoid timezone shifts
// when JSON serializing JavaScript Date objects.
types.setTypeParser(1082, (value) => value);

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be set before starting the API');
}

type DbErrorLike = Error & {
  code?: string;
  errors?: Array<{ code?: string; message?: string }>;
};

function resolveDbTarget(databaseUrl: string): {
  host: string;
  port: string;
  database: string;
  user: string;
} | null {
  try {
    const parsed = new URL(databaseUrl);
    const database = decodeURIComponent(parsed.pathname.replace(/^\//, '') || '(default)');
    const user = parsed.username ? decodeURIComponent(parsed.username) : '(default)';
    const host = parsed.hostname || '(default)';
    const port = parsed.port || '5432';
    return { host, port, database, user };
  } catch {
    return null;
  }
}

function hasEpermCode(error: unknown): boolean {
  const candidate = error as DbErrorLike | undefined;
  if (candidate?.code === 'EPERM') return true;
  if (!Array.isArray(candidate?.errors)) return false;
  return candidate.errors.some((entry) => entry?.code === 'EPERM');
}

export function logDbConnectionHint(error: unknown, context: string): void {
  if (!hasEpermCode(error)) return;
  const candidate = error as DbErrorLike | undefined;
  console.error('[db.connection.hint]', {
    context,
    code: candidate?.code ?? null,
    message: candidate?.message ?? null,
    hint: 'Possible Node permission model / sandbox restriction; check NODE_OPTIONS and CI network.'
  });
}

// Enable query logging with EXPLAIN ANALYZE in development
const EXPLAIN_SLOW_QUERIES = process.env.NODE_ENV === 'development' && process.env.EXPLAIN_SLOW_QUERIES === 'true';
const SLOW_QUERY_THRESHOLD_MS = parseInt(process.env.SLOW_QUERY_THRESHOLD_MS || '100', 10);
const STATEMENT_TIMEOUT_MS = parseInt(process.env.DB_STATEMENT_TIMEOUT_MS || '5000', 10);
const LOCK_TIMEOUT_MS = parseInt(process.env.DB_LOCK_TIMEOUT_MS || '2000', 10);
const nodeEnv = (process.env.NODE_ENV ?? 'development').toLowerCase();
const resolvedDbTarget = resolveDbTarget(process.env.DATABASE_URL);

if (nodeEnv !== 'production') {
  if (resolvedDbTarget) {
    console.info('[db.config]', resolvedDbTarget);
  } else {
    console.warn('[db.config]', { warning: 'DATABASE_URL could not be parsed for safe target logging.' });
  }
}

// Connection pool configuration for production workloads
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_POOL_MAX || '20', 10), // Maximum connections
  idleTimeoutMillis: 30000, // Close idle connections after 30s
  connectionTimeoutMillis: 5000, // Fail fast if can't connect in 5s
});

pool.on('connect', (client) => {
  if (STATEMENT_TIMEOUT_MS > 0) {
    client.query(`SET statement_timeout TO ${STATEMENT_TIMEOUT_MS}`).catch(() => undefined);
  }
  if (LOCK_TIMEOUT_MS > 0) {
    client.query(`SET lock_timeout TO ${LOCK_TIMEOUT_MS}`).catch(() => undefined);
  }
});

pool.on('error', (error) => {
  logDbConnectionHint(error, 'pool');
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  config: string | QueryConfig<any[]>,
  params?: unknown[]
): Promise<QueryResult<T>> {
  const sql = typeof config === 'string' ? config : config.text;
  const queryParams = typeof config === 'string' ? params : config.values;
  
  const startTime = Date.now();
  
  let result: QueryResult<T>;
  try {
    if (typeof config === 'string') {
      result = await pool.query<T>(config, params);
    } else {
      result = await pool.query<T>(config);
    }
  } catch (error) {
    logDbConnectionHint(error, 'query');
    throw error;
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
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    if (STATEMENT_TIMEOUT_MS > 0) {
      await client.query(`SET LOCAL statement_timeout TO ${STATEMENT_TIMEOUT_MS}`);
    }
    if (LOCK_TIMEOUT_MS > 0) {
      await client.query(`SET LOCAL lock_timeout TO ${LOCK_TIMEOUT_MS}`);
    }
    const result = await handler(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    if (client) {
      await client.query('ROLLBACK').catch(() => undefined);
    }
    logDbConnectionHint(err, 'withTransaction');
    throw err;
  } finally {
    client?.release();
  }
}

export async function withTransactionRetry<T>(
  handler: (client: PoolClient) => Promise<T>,
  options?: {
    retries?: number;
    isolationLevel?: 'SERIALIZABLE' | 'REPEATABLE READ' | 'READ COMMITTED';
    retryDelayMs?: (args: { attempt: number; sqlState: string }) => number;
    onRetry?: (args: { attempt: number; sqlState: string; delayMs: number }) => void;
    sleep?: (delayMs: number) => Promise<void>;
  }
): Promise<T> {
  const retries = options?.retries ?? 2;
  const isolationLevel = options?.isolationLevel;
  const sleep =
    options?.sleep
    ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  let attempt = 0;
  while (true) {
    let client: PoolClient | null = null;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      if (isolationLevel) {
        await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolationLevel}`);
      }
      if (STATEMENT_TIMEOUT_MS > 0) {
        await client.query(`SET LOCAL statement_timeout TO ${STATEMENT_TIMEOUT_MS}`);
      }
      if (LOCK_TIMEOUT_MS > 0) {
        await client.query(`SET LOCAL lock_timeout TO ${LOCK_TIMEOUT_MS}`);
      }
      const result = await handler(client);
      await client.query('COMMIT');
      return result;
    } catch (err: any) {
      if (client) {
        await client.query('ROLLBACK').catch(() => undefined);
      }
      const code = err?.code;
      if (code === '40001' || code === '40P01') {
        if (attempt < retries) {
          const nextAttempt = attempt + 1;
          const requestedDelayMs = options?.retryDelayMs?.({ attempt: nextAttempt, sqlState: code }) ?? 0;
          const delayMs = Math.max(
            0,
            Number.isFinite(Number(requestedDelayMs)) ? Math.floor(Number(requestedDelayMs)) : 0
          );
          options?.onRetry?.({ attempt: nextAttempt, sqlState: code, delayMs });
          if (delayMs > 0) {
            await sleep(delayMs);
          }
          attempt = nextAttempt;
          continue;
        }
        const exhausted: any = new Error('TX_RETRY_EXHAUSTED');
        exhausted.code = 'TX_RETRY_EXHAUSTED';
        exhausted.cause = err;
        exhausted.retrySqlState = code;
        exhausted.retryAttempts = attempt + 1;
        throw exhausted;
      }
      logDbConnectionHint(err, 'withTransactionRetry');
      throw err;
    } finally {
      client?.release();
    }
  }
}

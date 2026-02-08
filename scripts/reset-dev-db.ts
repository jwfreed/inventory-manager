/* eslint-disable no-console */
import { Client } from 'pg';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function parseDatabaseUrl(databaseUrl: string) {
  const url = new URL(databaseUrl);
  const database = url.pathname.replace(/^\//, '');
  const user = decodeURIComponent(url.username || '');
  const password = decodeURIComponent(url.password || '');
  const host = url.hostname || 'localhost';
  const port = url.port ? Number(url.port) : 5432;
  if (!database) {
    throw new Error('DATABASE_URL must include a database name');
  }
  return { database, user, password, host, port };
}

function assertSafeDatabase(database: string) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to reset DB when NODE_ENV=production');
  }
  if (!/dev|test/i.test(database)) {
    throw new Error(
      `Refusing to reset DB "${database}". Database name must include "dev" or "test".`
    );
  }
  if (!/^[A-Za-z0-9_]+$/.test(database)) {
    throw new Error(`Refusing to reset DB "${database}". Unsupported database name format.`);
  }
}

async function main() {
  const databaseUrl = requiredEnv('DATABASE_URL');
  const { database, user, password, host, port } = parseDatabaseUrl(databaseUrl);
  if (user === 'user') {
    console.error(
      "Hint: DATABASE_URL user is 'user' (looks like a placeholder). Use 'postgres' or your local role (e.g. $USER / jonathanfreed)."
    );
  }
  try {
    assertSafeDatabase(database);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${message} (host=${host} port=${port} db=${database} user=${user})`);
  }

  const adminClient = new Client({
    host,
    port,
    user,
    password,
    database: 'postgres'
  });

  await adminClient.connect();
  try {
    console.log(`[db-reset:dev] Target DB: ${database} on ${host}:${port}`);
    console.log('[db-reset:dev] Terminating existing connections…');
    await adminClient.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1
          AND pid <> pg_backend_pid()`,
      [database]
    );
    console.log('[db-reset:dev] Dropping database…');
    await adminClient.query(`DROP DATABASE IF EXISTS "${database}"`);
    console.log('[db-reset:dev] Creating database…');
    await adminClient.query(`CREATE DATABASE "${database}"`);
    console.log('[db-reset:dev] Done. Next: npm run migrate:up');
  } finally {
    await adminClient.end();
  }
}

main().catch((err) => {
  console.error('[db-reset:dev] Failed:', err);
  process.exit(1);
});

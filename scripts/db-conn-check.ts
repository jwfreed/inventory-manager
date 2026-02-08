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
  const host = url.hostname || 'localhost';
  const port = url.port ? Number(url.port) : 5432;
  return { database, user, host, port };
}

async function main() {
  const databaseUrl = requiredEnv('DATABASE_URL');
  const parsed = parseDatabaseUrl(databaseUrl);
  if (parsed.user === 'user') {
    console.error(
      "Hint: DATABASE_URL user is 'user' (looks like a placeholder). Use 'postgres' or your local role (e.g. $USER / jonathanfreed)."
    );
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const res = await client.query<{ current_user: string; current_database: string }>(
      'select current_user as current_user, current_database() as current_database'
    );
    const row = res.rows[0];
    if (!row) {
      throw new Error('Failed to query current_user/current_database');
    }
    if (row.current_database !== parsed.database) {
      console.error(
        `[db:conn:check] mismatch host=${parsed.host} port=${parsed.port} parsed_db=${parsed.database} actual_db=${row.current_database} user=${row.current_user}`
      );
      process.exit(1);
    }
    console.log(
      `[db:conn:check] host=${parsed.host} port=${parsed.port} db=${row.current_database} user=${row.current_user}`
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[db:conn:check] Failed:', err);
  process.exit(1);
});

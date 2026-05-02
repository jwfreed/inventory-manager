/* eslint-disable no-console */
import { spawn } from 'node:child_process';
import { Client } from 'pg';
import { assertNonProductionEnvironment } from './lib/productionGuard';

type DbIdentity = {
  host: string;
  port: string;
  dbName: string;
  user: string;
  redactedUrl: string;
};

type PruneSummary = {
  siamayaTenantId: string;
  scopedTables: number;
  deletedRowsByTable: Record<string, number>;
  tenantsDeleted: number;
};

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function parseBool(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function resolvePack(argv: string[] = process.argv): string {
  const prefix = '--pack=';
  const inline = argv.find((entry) => entry.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf('--pack');
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  return 'siamaya_factory';
}

function resolveNpmCmd(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function readDbIdentity(connectionString: string): DbIdentity {
  const parsed = new URL(connectionString);
  const protocol = parsed.protocol || 'postgres:';
  const host = parsed.hostname || '__missing__';
  const port = parsed.port || '5432';
  const dbName = parsed.pathname.replace(/^\//, '') || '__missing__';
  const user = decodeURIComponent(parsed.username || '__missing__');
  const authDisplay = user !== '__missing__' ? `${encodeURIComponent(user)}:***@` : '';
  const redactedUrl = `${protocol}//${authDisplay}${host}:${port}/${dbName}`;
  return {
    host,
    port,
    dbName,
    user,
    redactedUrl
  };
}

function isProdLikeHost(host: string): boolean {
  return /(prod|production|rds|aws|supabase|neon)/i.test(host);
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`NUCLEAR_RESET_INVALID_IDENTIFIER value=${identifier}`);
  }
  return `"${identifier}"`;
}

function assertPreflightSafety(identity: DbIdentity): void {
  console.log('[db:nuke-and-seed] Phase 1/6 Preflight');
  console.log(
    JSON.stringify(
      {
        code: 'DB_NUKE_PREFLIGHT',
        host: identity.host,
        port: identity.port,
        dbName: identity.dbName,
        user: identity.user,
        databaseUrlRedacted: identity.redactedUrl,
        nodeEnv: process.env.NODE_ENV ?? null
      },
      null,
      2
    )
  );

  if (!parseBool(process.env.ALLOW_NUCLEAR_RESET)) {
    throw new Error(
      [
        'NUCLEAR_RESET_DENIED',
        'ALLOW_NUCLEAR_RESET=true is required.',
        'Usage:',
        '  ALLOW_NUCLEAR_RESET=true npm run db:nuke-and-seed -- --pack siamaya_factory'
      ].join('\n')
    );
  }

  assertNonProductionEnvironment('db-nuke-and-seed');

  if (isProdLikeHost(identity.host)) {
    throw new Error(`NUCLEAR_RESET_DENIED production-like database host detected host=${identity.host}`);
  }
}

async function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env,
      shell: false
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed (${code}): ${command} ${args.join(' ')}`));
      }
    });
  });
}

async function resetDatabaseFast(connectionString: string): Promise<{ mode: 'drop_schema' | 'truncate'; tableCount?: number }> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    try {
      await client.query('BEGIN');
      await client.query('DROP SCHEMA IF EXISTS public CASCADE;');
      await client.query('CREATE SCHEMA public;');
      await client.query('GRANT ALL ON SCHEMA public TO CURRENT_USER;');
      await client.query('COMMIT');
      return { mode: 'drop_schema' };
    } catch (dropError) {
      await client.query('ROLLBACK');
      console.warn('[db:nuke-and-seed] DROP SCHEMA failed; falling back to TRUNCATE RESTART IDENTITY CASCADE');
      console.warn(`[db:nuke-and-seed] drop error: ${(dropError as Error).message}`);
    }

    await client.query('BEGIN');
    try {
      const tablesRes = await client.query<{ fq_name: string }>(
        `SELECT format('%I.%I', schemaname, tablename) AS fq_name
           FROM pg_tables
          WHERE schemaname = 'public'
          ORDER BY tablename`
      );

      if (tablesRes.rows.length > 0) {
        const tableList = tablesRes.rows.map((row) => row.fq_name).join(', ');
        await client.query(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE;`);
      }
      await client.query('COMMIT');
      return { mode: 'truncate', tableCount: tablesRes.rows.length };
    } catch (truncateError) {
      await client.query('ROLLBACK');
      throw truncateError;
    }
  } finally {
    await client.end();
  }
}

async function verifyPostflight(connectionString: string): Promise<void> {
  console.log('[db:nuke-and-seed] Phase 6/6 Verify');
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const tenantsRes = await client.query<{ id: string; slug: string | null; name: string | null }>(
      'SELECT id, slug, name FROM tenants ORDER BY created_at ASC'
    );
    if (tenantsRes.rows.length !== 1) {
      throw new Error(`NUCLEAR_RESET_VERIFY_TENANT_COUNT expected=1 actual=${tenantsRes.rows.length}`);
    }
    const tenant = tenantsRes.rows[0];
    const tenantLabel = `${tenant.slug ?? ''} ${tenant.name ?? ''}`.toLowerCase();
    if (!tenantLabel.includes('siamaya')) {
      throw new Error(
        `NUCLEAR_RESET_VERIFY_TENANT_NOT_SIAMAYA id=${tenant.id} slug=${tenant.slug ?? 'null'} name=${tenant.name ?? 'null'}`
      );
    }

    const userRes = await client.query<{ id: string; email: string }>(
      `SELECT id, email
         FROM users
        WHERE LOWER(email) = LOWER($1)
        LIMIT 1`,
      ['jon.freed@gmail.com']
    );
    if (userRes.rowCount === 0) {
      throw new Error('NUCLEAR_RESET_VERIFY_USER_MISSING email=jon.freed@gmail.com');
    }

    const [itemsRes, bomsRes, movementsRes] = await Promise.all([
      client.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM items'),
      client.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM boms'),
      client.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM inventory_movements')
    ]);

    console.log(
      JSON.stringify(
        {
          code: 'DB_NUKE_AND_SEED_DONE',
          tenant: tenant,
          user: userRes.rows[0],
          counts: {
            items: Number(itemsRes.rows[0]?.count ?? 0),
            boms: Number(bomsRes.rows[0]?.count ?? 0),
            inventoryMovements: Number(movementsRes.rows[0]?.count ?? 0)
          }
        },
        null,
        2
      )
    );
  } finally {
    await client.end();
  }
}

async function pruneToSingleSiamayaTenant(connectionString: string): Promise<PruneSummary> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const matchesRes = await client.query<{ id: string; slug: string | null; name: string | null }>(
      `SELECT id, slug, name
         FROM tenants
        WHERE slug ILIKE '%siamaya%' OR name ILIKE '%siamaya%'
        ORDER BY created_at ASC`
    );

    if (matchesRes.rows.length !== 1) {
      throw new Error(`NUCLEAR_RESET_PRUNE_SIAMAYA_MATCH_COUNT expected=1 actual=${matchesRes.rows.length}`);
    }
    const siamayaTenantId = matchesRes.rows[0].id;

    const tableRes = await client.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name = 'tenant_id'
          AND table_name <> 'tenants'
          AND table_name IN (
            SELECT table_name
              FROM information_schema.tables
             WHERE table_schema = 'public'
               AND table_type = 'BASE TABLE'
          )
        GROUP BY table_name
        ORDER BY table_name`
    );

    const deletedRowsByTable: Record<string, number> = {};

    await client.query('BEGIN');
    try {
      for (const row of tableRes.rows) {
        const tableName = row.table_name;
        const sql = `DELETE FROM ${quoteIdentifier(tableName)} WHERE tenant_id <> $1`;
        const result = await client.query(sql, [siamayaTenantId]);
        deletedRowsByTable[tableName] = result.rowCount;
      }

      const tenantDeleteRes = await client.query('DELETE FROM tenants WHERE id <> $1', [siamayaTenantId]);
      await client.query('COMMIT');
      return {
        siamayaTenantId,
        scopedTables: tableRes.rows.length,
        deletedRowsByTable,
        tenantsDeleted: tenantDeleteRes.rowCount
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    await client.end();
  }
}

async function main() {
  const connectionString = requiredEnv('DATABASE_URL');
  const identity = readDbIdentity(connectionString);
  const pack = resolvePack();
  const npmCmd = resolveNpmCmd();

  assertPreflightSafety(identity);

  console.log('[db:nuke-and-seed] Phase 2/6 Reset');
  const resetSummary = await resetDatabaseFast(connectionString);
  console.log(
    JSON.stringify(
      {
        code: 'DB_NUKE_RESET_DONE',
        mode: resetSummary.mode,
        tableCount: resetSummary.tableCount ?? null
      },
      null,
      2
    )
  );

  console.log('[db:nuke-and-seed] Phase 3/6 Migrate');
  await runCommand(npmCmd, ['run', 'migrate:up'], process.env);

  console.log('[db:nuke-and-seed] Phase 4/6 Seed');
  await runCommand(npmCmd, ['run', 'seed', '--', '--pack', pack], process.env);

  console.log('[db:nuke-and-seed] Phase 5/6 Prune non-Siamaya tenants');
  const pruneSummary = await pruneToSingleSiamayaTenant(connectionString);
  console.log(
    JSON.stringify(
      {
        code: 'DB_NUKE_PRUNE_DONE',
        siamayaTenantId: pruneSummary.siamayaTenantId,
        scopedTables: pruneSummary.scopedTables,
        tenantsDeleted: pruneSummary.tenantsDeleted,
        deletedRowsByTable: pruneSummary.deletedRowsByTable
      },
      null,
      2
    )
  );

  await verifyPostflight(connectionString);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[db:nuke-and-seed] Failed:', error);
    process.exit(1);
  });
}

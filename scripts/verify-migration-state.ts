/* eslint-disable no-console */
import { Client } from 'pg';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const MIGRATIONS_DIR = path.join(process.cwd(), 'src', 'migrations');
const CRITICAL_TABLES = [
  'tenants',
  'users',
  'tenant_memberships',
  'locations',
  'warehouse_default_location',
  'inventory_movements',
  'inventory_movement_lines',
  'inventory_balance'
];
const RECEIVE_TRANSFER_CONSTRAINT = 'chk_inventory_movements_receive_transfer_source_required';

export type MigrationVerifyTarget = {
  dbName: string;
  host: string;
  port: number;
  user: string;
};

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

async function resolveLatestMigrationName(): Promise<string> {
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /^\d+.*\.(ts|js)$/i.test(name))
    .map((name) => name.replace(/\.(ts|js)$/i, ''))
    .sort((a, b) => a.localeCompare(b));

  const latest = names.at(-1);
  if (!latest) {
    throw new Error(`No migrations found in ${MIGRATIONS_DIR}`);
  }
  return latest;
}

function parsePositiveInt(value: string | number | undefined, fallback: number): number {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

function isTruthy(value: string | undefined): boolean {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function resolveMigrationVerifyTarget(client: Client): MigrationVerifyTarget {
  const params = client.connectionParameters;
  return {
    dbName: String(params.database ?? ''),
    host: String(params.host ?? ''),
    port: parsePositiveInt(params.port, 5432),
    user: String(params.user ?? '')
  };
}

export function formatMigrationVerifyTargetForMessage(target: MigrationVerifyTarget): string {
  return `dbName=${target.dbName} host=${target.host} port=${target.port} user=${target.user}`;
}

export function buildMigrationVerifyFailure(
  target: MigrationVerifyTarget,
  error: unknown
): Error & { code?: string; details?: Record<string, unknown> } {
  const candidate = error as { message?: unknown; code?: unknown; details?: unknown };
  const message =
    typeof candidate?.message === 'string' && candidate.message.trim().length > 0
      ? candidate.message
      : 'migration verify failed';
  const wrapped = new Error(`[migrate:verify] ${formatMigrationVerifyTargetForMessage(target)} ${message}`) as Error & {
    code?: string;
    details?: Record<string, unknown>;
  };
  wrapped.code = typeof candidate?.code === 'string' ? candidate.code : 'MIGRATION_VERIFY_FAILED';
  wrapped.details = {
    dbName: target.dbName,
    host: target.host,
    port: target.port,
    user: target.user,
    ...(candidate?.details && typeof candidate.details === 'object' ? (candidate.details as Record<string, unknown>) : {})
  };
  return wrapped;
}

function printTarget(target: MigrationVerifyTarget) {
  console.log(
    JSON.stringify({
      phase: 'migration_verify_target',
      dbName: target.dbName,
      host: target.host,
      port: target.port,
      user: target.user
    })
  );
}

export async function verifyMigrationState(options?: {
  env?: NodeJS.ProcessEnv;
  dryRun?: boolean;
}): Promise<void> {
  const env = options?.env ?? process.env;
  const databaseUrl = requiredEnv('DATABASE_URL');
  const expectedLatestMigration = await resolveLatestMigrationName();
  const client = new Client({ connectionString: databaseUrl });
  const target = resolveMigrationVerifyTarget(client);
  printTarget(target);

  if (options?.dryRun ?? isTruthy(env.MIGRATE_VERIFY_DRY_RUN)) {
    console.log(
      JSON.stringify({
        ok: true,
        dryRun: true,
        latestMigration: expectedLatestMigration,
        dbName: target.dbName,
        host: target.host,
        port: target.port,
        user: target.user
      })
    );
    return;
  }

  await client.connect();
  try {
    const migrationSummary = await client.query<{
      count: string;
      max_name: string | null;
      latest_applied: boolean;
    }>(
      `SELECT COUNT(*)::text AS count,
              MAX(name) AS max_name,
              BOOL_OR(name = $1) AS latest_applied
         FROM inventory_schema_migrations`,
      [expectedLatestMigration]
    );
    const row = migrationSummary.rows[0];
    const latestApplied = row?.latest_applied === true;
    if (!latestApplied) {
      throw new Error(
        `MIGRATION_STATE_INCOMPLETE ${formatMigrationVerifyTargetForMessage(target)} expected_latest=${expectedLatestMigration} max_applied=${row?.max_name ?? 'null'} count=${row?.count ?? '0'}`
      );
    }

    const tableCheck = await client.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])`,
      [CRITICAL_TABLES]
    );
    const existing = new Set(tableCheck.rows.map((entry) => entry.table_name));
    const missing = CRITICAL_TABLES.filter((name) => !existing.has(name));
    if (missing.length > 0) {
      throw new Error(
        `MIGRATION_STATE_MISSING_TABLES ${formatMigrationVerifyTargetForMessage(target)} missing=${missing.join(',')}`
      );
    }

    const constraintCheck = await client.query<{ convalidated: boolean | null }>(
      `SELECT convalidated
         FROM pg_constraint
        WHERE conname = $1`,
      [RECEIVE_TRANSFER_CONSTRAINT]
    );
    if ((constraintCheck.rowCount ?? 0) === 0) {
      throw new Error(
        `MIGRATION_STATE_MISSING_CONSTRAINT ${formatMigrationVerifyTargetForMessage(target)} ${RECEIVE_TRANSFER_CONSTRAINT}`
      );
    }
    if (constraintCheck.rows[0].convalidated !== true) {
      throw new Error(
        `MIGRATION_STATE_CONSTRAINT_NOT_VALIDATED ${formatMigrationVerifyTargetForMessage(target)} ${RECEIVE_TRANSFER_CONSTRAINT}`
      );
    }

    console.log(
      JSON.stringify({
        ok: true,
        latestMigration: expectedLatestMigration,
        migrationCount: Number(row?.count ?? 0),
        dbName: target.dbName,
        host: target.host,
        port: target.port,
        user: target.user,
        validatedConstraint: RECEIVE_TRANSFER_CONSTRAINT,
        checkedTables: CRITICAL_TABLES
      })
    );
  } catch (error) {
    throw buildMigrationVerifyFailure(target, error);
  } finally {
    await client.end();
  }
}

export async function main() {
  await verifyMigrationState();
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[migrate:verify] Failed:', error);
    process.exit(1);
  });
}

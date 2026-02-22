/* eslint-disable no-console */
import { spawn } from 'node:child_process';
import { Client } from 'pg';

const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000001';

function parseBool(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function hasFlag(name: string, argv: string[] = process.argv): boolean {
  const direct = `--${name}`;
  const found = argv.find((entry) => entry === direct || entry.startsWith(`${direct}=`));
  if (!found) return false;
  if (found === direct) return true;
  return parseBool(found.split('=')[1]);
}

function assertConfirmation() {
  if (parseBool(process.env.CONFIRM_DB_RESET)) return;
  throw new Error(
    [
      'Refusing to run db:reset:migrate:seed without explicit confirmation.',
      'Run:',
      '  CONFIRM_DB_RESET=1 npm run db:reset:migrate:seed'
    ].join('\n')
  );
}

function resolveNpmCmd(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

export function resolveFreshContractMode(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (hasFlag('fresh-contract', argv)) return true;
  return parseBool(env.FRESH_DB_CONTRACT);
}

export function assertPostSeedContract(params: {
  freshContract: boolean;
  tenantCount: number;
  receiveTransferSourceGapCount: number;
}) {
  const {
    freshContract,
    tenantCount,
    receiveTransferSourceGapCount
  } = params;

  if (receiveTransferSourceGapCount > 0) {
    throw new Error(
      `RESET_MIGRATE_SEED_SOURCE_GAPS remaining_receive_transfer_source_gaps=${receiveTransferSourceGapCount}`
    );
  }
  if (freshContract && tenantCount !== 1) {
    throw new Error(
      `RESET_MIGRATE_SEED_FRESH_CONTRACT_FAILED expected_tenant_count=1 actual_tenant_count=${tenantCount}`
    );
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

export async function runResetMigrateSeedFlow(options?: {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const argv = options?.argv ?? process.argv;
  const env = { ...(options?.env ?? process.env) };
  const freshContract = resolveFreshContractMode(argv, env);

  assertConfirmation();
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  const npmCmd = resolveNpmCmd();

  console.log('[db:reset:migrate:seed] Step 1/3 reset + migrate');
  await runCommand(npmCmd, ['run', 'db:reset:migrate'], env);

  console.log('[db:reset:migrate:seed] Step 2/3 seed warehouse topology');
  await runCommand(npmCmd, ['run', 'seed:warehouse-topology:default'], env);

  console.log('[db:reset:migrate:seed] Step 3/3 strict invariants');
  await runCommand(npmCmd, ['run', 'invariants:strict:default'], env);

  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    const [tenantCountRes, movementGapRes] = await Promise.all([
      client.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM tenants'),
      client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM inventory_movements
          WHERE movement_type IN ('receive', 'transfer')
            AND (
              source_type IS NULL OR BTRIM(source_type) = ''
              OR source_id IS NULL OR BTRIM(source_id) = ''
            )`
      )
    ]);
    const tenantCount = Number(tenantCountRes.rows[0]?.count ?? 0);
    const receiveTransferSourceGapCount = Number(movementGapRes.rows[0]?.count ?? 0);
    assertPostSeedContract({
      freshContract,
      tenantCount,
      receiveTransferSourceGapCount
    });
    console.log(
      JSON.stringify({
        ok: true,
        freshContract,
        tenantCount,
        receiveTransferSourceGapCount,
        seededTenantId: DEFAULT_TENANT_ID
      })
    );
  } finally {
    await client.end();
  }
}

export async function main() {
  await runResetMigrateSeedFlow();
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[db:reset:migrate:seed] Failed:', error);
    process.exit(1);
  });
}

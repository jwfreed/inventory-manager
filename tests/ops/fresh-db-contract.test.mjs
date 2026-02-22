import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Client } from 'pg';

const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000001';
const HEALTH_TIMEOUT_MS = 45000;
const STEP_TIMEOUT_MS = 240000;

function resolveNpmCmd() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function parseDatabaseUrl(databaseUrl) {
  const url = new URL(databaseUrl);
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = '/postgres';
  return {
    url,
    adminConnectionString: adminUrl.toString()
  };
}

async function runCommand(command, args, { env, timeoutMs = STEP_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      shell: false
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`COMMAND_TIMEOUT ${command} ${args.join(' ')}`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ code, stdout, stderr });
      } else {
        reject(
          new Error(
            [
              `COMMAND_FAILED code=${code} cmd=${command} ${args.join(' ')}`,
              stdout,
              stderr
            ]
              .filter(Boolean)
              .join('\n')
          )
        );
      }
    });
  });
}

async function createIsolatedDatabase(adminConnectionString, databaseName) {
  const client = new Client({ connectionString: adminConnectionString });
  await client.connect();
  try {
    await client.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1
          AND pid <> pg_backend_pid()`,
      [databaseName]
    );
    await client.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await client.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await client.end();
  }
}

async function dropIsolatedDatabase(adminConnectionString, databaseName) {
  const client = new Client({ connectionString: adminConnectionString });
  await client.connect();
  try {
    await client.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1
          AND pid <> pg_backend_pid()`,
      [databaseName]
    );
    await client.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  } finally {
    await client.end();
  }
}

async function waitForHealth(baseUrl, timeoutMs = HEALTH_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.status === 200) return true;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function startServer({ env, port }) {
  const logs = [];
  const child = spawn(
    'node',
    ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register', 'src/server.ts'],
    {
      cwd: process.cwd(),
      env: {
        ...env,
        PORT: String(port),
        NODE_ENV: 'development',
        RUN_INPROCESS_JOBS: 'false',
        WAREHOUSE_DEFAULTS_REPAIR: 'false',
        WAREHOUSE_DEFAULTS_TENANT_ID: DEFAULT_TENANT_ID
      },
      shell: false
    }
  );

  child.stdout?.on('data', (chunk) => {
    logs.push(chunk.toString());
  });
  child.stderr?.on('data', (chunk) => {
    logs.push(chunk.toString());
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const healthy = await waitForHealth(baseUrl);
  if (!healthy) {
    child.kill('SIGTERM');
    throw new Error(`SERVER_STARTUP_TIMEOUT ${baseUrl}\n${logs.join('')}`);
  }

  return {
    child,
    logs,
    baseUrl,
    async stop() {
      if (!child.killed) {
        child.kill('SIGTERM');
      }
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 5000);
        child.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
  };
}

test('fresh DB contract: migrate + seed + non-repair startup + strict invariants', { timeout: 420000 }, async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required');
  const { url, adminConnectionString } = parseDatabaseUrl(process.env.DATABASE_URL);
  const databaseName = `inventory_manager_fresh_contract_${randomUUID().slice(0, 8)}`;
  const isolatedUrl = new URL(url.toString());
  isolatedUrl.pathname = `/${databaseName}`;
  const isolatedDatabaseUrl = isolatedUrl.toString();
  const npmCmd = resolveNpmCmd();
  const env = { ...process.env, DATABASE_URL: isolatedDatabaseUrl };
  const serverPort = 3200 + Math.floor(Math.random() * 200);

  let server = null;
  try {
    await createIsolatedDatabase(adminConnectionString, databaseName);

    await runCommand(
      npmCmd,
      ['run', 'db:reset:migrate:seed', '--', '--fresh-contract'],
      { env: { ...env, FRESH_DB_CONTRACT: 'true' } }
    );

    server = await startServer({ env, port: serverPort });

    const invariants = await runCommand(
      'node',
      ['scripts/inventory_invariants_check.mjs', '--tenant-id', DEFAULT_TENANT_ID, '--strict'],
      { env }
    );
    const invariantOutput = `${invariants.stdout}\n${invariants.stderr}`;
    assert.doesNotMatch(invariantOutput, /Legacy movement sources/i);

    const db = new Client({ connectionString: isolatedDatabaseUrl });
    await db.connect();
    try {
      const tenantCountRes = await db.query(`SELECT COUNT(*)::int AS count FROM tenants`);
      assert.equal(Number(tenantCountRes.rows[0]?.count ?? 0), 1);

      const sourceGapRes = await db.query(
        `SELECT COUNT(*)::int AS count
           FROM inventory_movements
          WHERE movement_type IN ('receive', 'transfer')
            AND (
              source_type IS NULL OR BTRIM(source_type) = ''
              OR source_id IS NULL OR BTRIM(source_id) = ''
            )`
      );
      assert.equal(Number(sourceGapRes.rows[0]?.count ?? 0), 0);
    } finally {
      await db.end();
    }

    assert.doesNotMatch(server.logs.join(''), /Legacy movement sources/i);
  } finally {
    if (server) {
      await server.stop();
    }
    await dropIsolatedDatabase(adminConnectionString, databaseName);
  }
});

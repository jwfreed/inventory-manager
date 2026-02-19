#!/usr/bin/env node
import 'dotenv/config';
import { Pool } from 'pg';
import { fileURLToPath } from 'node:url';
import { checkOnly, fix } from './lib/warehouseTopologyCheck.mjs';
import { loadWarehouseTopology } from './lib/warehouseTopology.mjs';

function getArg(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function hasFlag(name) {
  const direct = `--${name}`;
  const normalized = process.argv.find((arg) => arg === direct || arg.startsWith(`${direct}=`));
  if (!normalized) return false;
  if (normalized === direct) return true;
  const value = normalized.split('=')[1]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function summarizeIssues(issues) {
  return issues.slice(0, 10).map((issue) => JSON.stringify(issue)).join('; ');
}

export async function seedWarehouseTopologyForTenant(client, tenantId, options = {}) {
  const topology = options.topology ?? await loadWarehouseTopology({ topologyDir: options.topologyDir });
  const fixMode = options.fix === true;

  if (fixMode) {
    const repairSummary = await fix(client, tenantId, {
      topology,
      topologyDir: options.topologyDir,
      now: options.now
    });
    return {
      mode: 'fix',
      tenantId,
      ...repairSummary
    };
  }

  const check = await checkOnly(client, tenantId, {
    topology,
    topologyDir: options.topologyDir
  });
  if (check.count > 0) {
    throw new Error(`TOPOLOGY_DRIFT_DETECTED count=${check.count} sample=${summarizeIssues(check.issues)}`);
  }
  return {
    mode: 'check',
    tenantId,
    driftCount: check.count,
    warningCount: check.warningCount
  };
}

export async function runSeedWarehouseTopology({ tenantId, topologyDir, fixMode } = {}) {
  const resolvedTenantId = tenantId ?? getArg('tenant-id') ?? process.env.TENANT_ID;
  const shouldFix = fixMode ?? hasFlag('fix');
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }
  if (!resolvedTenantId) {
    throw new Error('TENANT_ID (or --tenant-id) is required');
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: parsePositiveInt(process.env.DB_POOL_MAX, 20),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    const summary = await seedWarehouseTopologyForTenant(client, resolvedTenantId, {
      topologyDir,
      fix: shouldFix
    });
    await client.query('COMMIT');
    console.log(
      JSON.stringify({
        ok: true,
        mode: shouldFix ? 'fix' : 'check',
        summary
      })
    );
    return summary;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isCli) {
  runSeedWarehouseTopology({
    tenantId: getArg('tenant-id'),
    topologyDir: getArg('topology-dir'),
    fixMode: hasFlag('fix')
  })
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

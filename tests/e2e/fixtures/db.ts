import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { requireDatabaseUrl } from './env';

type CustomerRow = {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  email: string | null;
};

const MAX_CODE_LENGTH = 64;
let sharedPool: Pool | null = null;

function getPool(): Pool {
  if (!sharedPool) {
    sharedPool = new Pool({ connectionString: requireDatabaseUrl() });
  }
  return sharedPool;
}

function normalizeRunId(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 24) || 'run';
}

function tenantShortId(tenantId: string): string {
  return tenantId.replace(/-/g, '').slice(0, 8) || 'tenant';
}

function buildCustomerCode(tenantId: string, runId: string, attempt: number): string {
  const normalizedRun = normalizeRunId(runId);
  const base = `E2E-CUST-${tenantShortId(tenantId)}-${normalizedRun}`;
  const candidate = attempt === 0 ? base : `${base}-${attempt}`;
  return candidate.slice(0, MAX_CODE_LENGTH);
}

function buildCustomerEmail(code: string): string {
  const normalized = code.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40) || 'e2ecustomer';
  return `${normalized}@example.test`;
}

export async function createOrGetCustomerForRun(args: {
  tenantId: string;
  runId: string;
}): Promise<CustomerRow> {
  const pool = getPool();

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const code = buildCustomerCode(args.tenantId, args.runId, attempt);

    const existing = await pool.query<CustomerRow>(
      `SELECT id, tenant_id, code, name, email
         FROM customers
        WHERE code = $1
        LIMIT 1`,
      [code]
    );

    if (existing.rowCount && existing.rows[0].tenant_id === args.tenantId) {
      return existing.rows[0];
    }

    try {
      const created = await pool.query<CustomerRow>(
        `INSERT INTO customers (
            id, tenant_id, code, name, email, phone, active, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, NULL, true, now(), now())
         RETURNING id, tenant_id, code, name, email`,
        [
          randomUUID(),
          args.tenantId,
          code,
          `E2E Customer ${normalizeRunId(args.runId)}`,
          buildCustomerEmail(code)
        ]
      );
      return created.rows[0];
    } catch (error: unknown) {
      const pgError = error as { code?: string };
      if (pgError.code === '23505') {
        continue;
      }
      throw error;
    }
  }

  throw new Error('Unable to create a collision-safe deterministic customer for this E2E run.');
}

export async function cleanupCustomersBestEffort(args: {
  tenantId: string;
  runId: string;
}): Promise<number> {
  const pool = getPool();
  const normalizedRun = normalizeRunId(args.runId);
  const prefix = `E2E-CUST-${tenantShortId(args.tenantId)}-${normalizedRun}%`;

  const result = await pool.query<{ id: string }>(
    `DELETE FROM customers c
      WHERE c.tenant_id = $1
        AND c.code LIKE $2
        AND NOT EXISTS (
          SELECT 1
            FROM sales_orders so
           WHERE so.tenant_id = c.tenant_id
             AND so.customer_id = c.id
        )
        AND NOT EXISTS (
          SELECT 1
            FROM return_authorizations ra
           WHERE ra.tenant_id = c.tenant_id
             AND ra.customer_id = c.id
        )
        AND NOT EXISTS (
          SELECT 1
            FROM recall_impacted_shipments ris
           WHERE ris.tenant_id = c.tenant_id
             AND ris.customer_id = c.id
        )
        AND NOT EXISTS (
          SELECT 1
            FROM recall_communications rc
           WHERE rc.tenant_id = c.tenant_id
             AND rc.customer_id = c.id
        )
      RETURNING c.id`,
    [args.tenantId, prefix]
  );

  return result.rowCount ?? 0;
}

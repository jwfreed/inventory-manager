import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db';
import { roundQuantity, toNumber } from '../lib/numbers';

const DEFAULT_TOLERANCE = Number(process.env.BALANCE_RECON_TOLERANCE ?? 1e-6);
const DEFAULT_MAX_REPAIR = Number(process.env.BALANCE_REBUILD_MAX_ROWS ?? 10000);

export type BalanceKey = {
  itemId: string;
  locationId: string;
  uom: string;
};

export type LedgerBalanceRow = BalanceKey & {
  tenantId: string;
  onHandQty: number;
};

export type BalanceMismatchRow = BalanceKey & {
  tenantId: string;
  balanceQty: number;
  ledgerQty: number;
  delta: number;
};

type LedgerQueryOptions = {
  keys?: BalanceKey[];
  asOf?: Date | null;
};

function buildKeysValues(keys: BalanceKey[]) {
  const params: any[] = [];
  const tuples = keys.map((key) => {
    params.push(key.itemId, key.locationId, key.uom);
    return `($${params.length - 2}, $${params.length - 1}, $${params.length})`;
  });
  return { params, values: tuples.join(', ') };
}

function normalizeQty(value: unknown): number {
  return roundQuantity(toNumber(value));
}

export async function recomputeBalancesFromLedger(
  tenantId: string,
  options: LedgerQueryOptions = {}
): Promise<LedgerBalanceRow[]> {
  const params: any[] = [tenantId];
  const clauses: string[] = [`l.tenant_id = $1`, `m.status = 'posted'`];

  if (options.asOf) {
    params.push(options.asOf);
    clauses.push(`m.occurred_at <= $${params.length}`);
  }

  let keysJoin = '';
  if (options.keys && options.keys.length > 0) {
    const { params: keyParams, values } = buildKeysValues(options.keys);
    const offset = params.length;
    const valuesWithOffset = values.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + offset}`);
    params.push(...keyParams);
    keysJoin = `JOIN (VALUES ${valuesWithOffset}) AS k(item_id, location_id, uom)
                  ON k.item_id = l.item_id
                 AND k.location_id = l.location_id
                 AND k.uom = COALESCE(l.canonical_uom, l.uom)`;
  }

  const sql = `
    SELECT l.tenant_id,
           l.item_id,
           l.location_id,
           COALESCE(l.canonical_uom, l.uom) AS uom,
           SUM(COALESCE(l.quantity_delta_canonical, l.quantity_delta)) AS on_hand_qty
      FROM inventory_movement_lines l
      JOIN inventory_movements m
        ON m.id = l.movement_id
       AND m.tenant_id = l.tenant_id
      ${keysJoin}
     WHERE ${clauses.join(' AND ')}
     GROUP BY l.tenant_id, l.item_id, l.location_id, COALESCE(l.canonical_uom, l.uom)
  `;

  const res = await query(sql, params);
  return res.rows.map((row: any) => ({
    tenantId: row.tenant_id,
    itemId: row.item_id,
    locationId: row.location_id,
    uom: row.uom,
    onHandQty: normalizeQty(row.on_hand_qty)
  }));
}

export async function compareBalances(
  tenantId: string,
  options: LedgerQueryOptions & { tolerance?: number } = {}
): Promise<BalanceMismatchRow[]> {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const params: any[] = [tenantId];
  const clauses: string[] = [`m.status = 'posted'`];

  if (options.asOf) {
    params.push(options.asOf);
    clauses.push(`m.occurred_at <= $${params.length}`);
  }

  let keysJoin = '';
  let keysFilter = '';
  if (options.keys && options.keys.length > 0) {
    const { params: keyParams, values } = buildKeysValues(options.keys);
    const offset = params.length;
    const valuesWithOffset = values.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + offset}`);
    params.push(...keyParams);
    keysJoin = `JOIN (VALUES ${valuesWithOffset}) AS k(item_id, location_id, uom)
                  ON k.item_id = l.item_id
                 AND k.location_id = l.location_id
                 AND k.uom = COALESCE(l.canonical_uom, l.uom)`;
    const keyOffset = 1 + params.length - keyParams.length;
    const valuesForFilter = values.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + keyOffset - 1}`);
    keysFilter = `AND (COALESCE(b.item_id, ledger.item_id), COALESCE(b.location_id, ledger.location_id), COALESCE(b.uom, ledger.uom))
                      IN (VALUES ${valuesForFilter})`;
  }

  const sql = `
    WITH ledger AS (
      SELECT l.tenant_id,
             l.item_id,
             l.location_id,
             COALESCE(l.canonical_uom, l.uom) AS uom,
             SUM(COALESCE(l.quantity_delta_canonical, l.quantity_delta)) AS on_hand_qty
        FROM inventory_movement_lines l
        JOIN inventory_movements m
          ON m.id = l.movement_id
         AND m.tenant_id = l.tenant_id
        ${keysJoin}
       WHERE l.tenant_id = $1
         AND ${clauses.join(' AND ')}
       GROUP BY l.tenant_id, l.item_id, l.location_id, COALESCE(l.canonical_uom, l.uom)
    )
    SELECT COALESCE(b.tenant_id, ledger.tenant_id) AS tenant_id,
           COALESCE(b.item_id, ledger.item_id) AS item_id,
           COALESCE(b.location_id, ledger.location_id) AS location_id,
           COALESCE(b.uom, ledger.uom) AS uom,
           COALESCE(b.on_hand, 0) AS balance_qty,
           COALESCE(ledger.on_hand_qty, 0) AS ledger_qty,
           COALESCE(b.on_hand, 0) - COALESCE(ledger.on_hand_qty, 0) AS delta
      FROM inventory_balance b
      FULL OUTER JOIN ledger
        ON ledger.tenant_id = b.tenant_id
       AND ledger.item_id = b.item_id
       AND ledger.location_id = b.location_id
       AND ledger.uom = b.uom
     WHERE COALESCE(b.tenant_id, ledger.tenant_id) = $1
       ${keysFilter}
       AND ABS(COALESCE(b.on_hand, 0) - COALESCE(ledger.on_hand_qty, 0)) > $${params.length + 1}
  `;

  const res = await query(sql, [...params, tolerance]);
  return res.rows.map((row: any) => ({
    tenantId: row.tenant_id,
    itemId: row.item_id,
    locationId: row.location_id,
    uom: row.uom,
    balanceQty: normalizeQty(row.balance_qty),
    ledgerQty: normalizeQty(row.ledger_qty),
    delta: normalizeQty(row.delta)
  }));
}

export async function repairBalancesFromLedger(
  tenantId: string,
  mismatches: BalanceMismatchRow[],
  options: { runId?: string; actor?: string; maxRepairRows?: number } = {}
): Promise<{ repairedCount: number; runId: string }> {
  const maxRepairRows = options.maxRepairRows ?? DEFAULT_MAX_REPAIR;
  if (mismatches.length > maxRepairRows) {
    const err: any = new Error('BALANCE_REPAIR_THRESHOLD_EXCEEDED');
    err.code = 'BALANCE_REPAIR_THRESHOLD_EXCEEDED';
    err.details = { mismatchCount: mismatches.length, maxRepairRows };
    throw err;
  }
  const runId = options.runId ?? uuidv4();
  const actor = options.actor ?? 'system';
  let repairedCount = 0;

  for (const mismatch of mismatches) {
    await withTransaction(async (client: PoolClient) => {
      await client.query(
        `INSERT INTO inventory_balance (
            tenant_id, item_id, location_id, uom, on_hand, reserved, allocated, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, 0, 0, now(), now())
         ON CONFLICT (tenant_id, item_id, location_id, uom)
         DO UPDATE SET on_hand = EXCLUDED.on_hand, updated_at = now()`,
        [
          tenantId,
          mismatch.itemId,
          mismatch.locationId,
          mismatch.uom,
          mismatch.ledgerQty
        ]
      );
      await client.query(
        `INSERT INTO inventory_balance_rebuild_audit (
            id, run_id, tenant_id, item_id, location_id, uom, before_qty, after_qty, delta_qty, actor, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
        [
          uuidv4(),
          runId,
          tenantId,
          mismatch.itemId,
          mismatch.locationId,
          mismatch.uom,
          mismatch.balanceQty,
          mismatch.ledgerQty,
          roundQuantity(mismatch.ledgerQty - mismatch.balanceQty),
          actor
        ]
      );
      repairedCount += 1;
    });
  }

  return { repairedCount, runId };
}

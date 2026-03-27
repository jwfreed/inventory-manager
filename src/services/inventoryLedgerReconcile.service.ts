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
  reservedQty: number;
  allocatedQty: number;
  availableQty: number;
};

export type BalanceMismatchRow = BalanceKey & {
  tenantId: string;
  balanceQty: number;
  ledgerQty: number;
  delta: number;
  balanceReservedQty: number;
  authoritativeReservedQty: number;
  reservedDelta: number;
  balanceAllocatedQty: number;
  authoritativeAllocatedQty: number;
  allocatedDelta: number;
};

export type ItemQuantitySummaryMismatchRow = {
  tenantId: string;
  itemId: string;
  summaryQty: number;
  ledgerQty: number;
  delta: number;
};

export type ItemValuationSummaryMismatchRow = {
  tenantId: string;
  itemId: string;
  summaryAverageCost: number | null;
  layerAverageCost: number | null;
  averageCostDelta: number;
};

type LedgerQueryOptions = {
  keys?: BalanceKey[];
  asOf?: Date | null;
  client?: PoolClient;
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

async function executeReconcileQuery(
  client: PoolClient | undefined,
  sql: string,
  params: any[]
) {
  if (client) {
    return client.query(sql, params);
  }
  return query(sql, params);
}

export async function recomputeBalancesFromLedger(
  tenantId: string,
  options: LedgerQueryOptions = {}
): Promise<LedgerBalanceRow[]> {
  const client = options.client;
  if (!options.asOf) {
    const params: any[] = [tenantId];
    let keysFilter = '';
    if (options.keys && options.keys.length > 0) {
      const { params: keyParams, values } = buildKeysValues(options.keys);
      const offset = params.length;
      const valuesWithOffset = values.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + offset}`);
      params.push(...keyParams);
      keysFilter = `AND (v.item_id, v.location_id, v.uom) IN (VALUES ${valuesWithOffset})`;
    }

    const res = await executeReconcileQuery(
      client,
      `SELECT v.tenant_id,
              v.item_id,
              v.location_id,
              v.uom,
              v.on_hand_qty,
              v.reserved_qty,
              v.allocated_qty,
              v.available_qty
         FROM inventory_available_location_v v
        WHERE v.tenant_id = $1
          ${keysFilter}`,
      params
    );

    return res.rows.map((row: any) => ({
      tenantId: row.tenant_id,
      itemId: row.item_id,
      locationId: row.location_id,
      uom: row.uom,
      onHandQty: normalizeQty(row.on_hand_qty),
      reservedQty: normalizeQty(row.reserved_qty),
      allocatedQty: normalizeQty(row.allocated_qty),
      availableQty: normalizeQty(row.available_qty)
    }));
  }

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

  const res = await executeReconcileQuery(client, sql, params);
  return res.rows.map((row: any) => ({
    tenantId: row.tenant_id,
    itemId: row.item_id,
    locationId: row.location_id,
    uom: row.uom,
    onHandQty: normalizeQty(row.on_hand_qty),
    reservedQty: 0,
    allocatedQty: 0,
    availableQty: normalizeQty(row.on_hand_qty)
  }));
}

export async function compareBalances(
  tenantId: string,
  options: LedgerQueryOptions & { tolerance?: number } = {}
): Promise<BalanceMismatchRow[]> {
  const client = options.client;
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  if (!options.asOf) {
    const params: any[] = [tenantId];
    let keysFilter = '';
    if (options.keys && options.keys.length > 0) {
      const { params: keyParams, values } = buildKeysValues(options.keys);
      const offset = params.length;
      const valuesWithOffset = values.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + offset}`);
      params.push(...keyParams);
      keysFilter = `AND (COALESCE(b.item_id, authority.item_id), COALESCE(b.location_id, authority.location_id), COALESCE(b.uom, authority.uom))
                        IN (VALUES ${valuesWithOffset})`;
    }
    const sql = `
      WITH authority AS (
        SELECT v.tenant_id,
               v.item_id,
               v.location_id,
               v.uom,
               v.on_hand_qty,
               v.reserved_qty,
               v.allocated_qty
          FROM inventory_available_location_v v
         WHERE v.tenant_id = $1
      )
      SELECT COALESCE(b.tenant_id, authority.tenant_id) AS tenant_id,
             COALESCE(b.item_id, authority.item_id) AS item_id,
             COALESCE(b.location_id, authority.location_id) AS location_id,
             COALESCE(b.uom, authority.uom) AS uom,
             COALESCE(b.on_hand, 0) AS balance_qty,
             COALESCE(authority.on_hand_qty, 0) AS ledger_qty,
             COALESCE(b.on_hand, 0) - COALESCE(authority.on_hand_qty, 0) AS delta,
             COALESCE(b.reserved, 0) AS balance_reserved_qty,
             COALESCE(authority.reserved_qty, 0) AS authoritative_reserved_qty,
             COALESCE(b.reserved, 0) - COALESCE(authority.reserved_qty, 0) AS reserved_delta,
             COALESCE(b.allocated, 0) AS balance_allocated_qty,
             COALESCE(authority.allocated_qty, 0) AS authoritative_allocated_qty,
             COALESCE(b.allocated, 0) - COALESCE(authority.allocated_qty, 0) AS allocated_delta
        FROM inventory_balance b
        FULL OUTER JOIN authority
          ON authority.tenant_id = b.tenant_id
         AND authority.item_id = b.item_id
         AND authority.location_id = b.location_id
         AND authority.uom = b.uom
       WHERE COALESCE(b.tenant_id, authority.tenant_id) = $1
         ${keysFilter}
         AND (
           ABS(COALESCE(b.on_hand, 0) - COALESCE(authority.on_hand_qty, 0)) > $${params.length + 1}
           OR ABS(COALESCE(b.reserved, 0) - COALESCE(authority.reserved_qty, 0)) > $${params.length + 1}
           OR ABS(COALESCE(b.allocated, 0) - COALESCE(authority.allocated_qty, 0)) > $${params.length + 1}
         )
    `;

    const res = await executeReconcileQuery(client, sql, [...params, tolerance]);
    return res.rows.map((row: any) => ({
      tenantId: row.tenant_id,
      itemId: row.item_id,
      locationId: row.location_id,
      uom: row.uom,
      balanceQty: normalizeQty(row.balance_qty),
      ledgerQty: normalizeQty(row.ledger_qty),
      delta: normalizeQty(row.delta),
      balanceReservedQty: normalizeQty(row.balance_reserved_qty),
      authoritativeReservedQty: normalizeQty(row.authoritative_reserved_qty),
      reservedDelta: normalizeQty(row.reserved_delta),
      balanceAllocatedQty: normalizeQty(row.balance_allocated_qty),
      authoritativeAllocatedQty: normalizeQty(row.authoritative_allocated_qty),
      allocatedDelta: normalizeQty(row.allocated_delta)
    }));
  }

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

  const res = await executeReconcileQuery(client, sql, [...params, tolerance]);
  return res.rows.map((row: any) => ({
    tenantId: row.tenant_id,
    itemId: row.item_id,
    locationId: row.location_id,
    uom: row.uom,
    balanceQty: normalizeQty(row.balance_qty),
    ledgerQty: normalizeQty(row.ledger_qty),
    delta: normalizeQty(row.delta),
    balanceReservedQty: 0,
    authoritativeReservedQty: 0,
    reservedDelta: 0,
    balanceAllocatedQty: 0,
    authoritativeAllocatedQty: 0,
    allocatedDelta: 0
  }));
}

export async function repairBalancesFromLedger(
  tenantId: string,
  mismatches: BalanceMismatchRow[],
  options: { runId?: string; actor?: string; maxRepairRows?: number; client?: PoolClient } = {}
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
  const client = options.client;
  let repairedCount = 0;

  for (const mismatch of mismatches) {
    const repairMismatch = async (tx: PoolClient) => {
      await tx.query(
        `INSERT INTO inventory_balance (
            tenant_id, item_id, location_id, uom, on_hand, reserved, allocated, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())
         ON CONFLICT (tenant_id, item_id, location_id, uom)
         DO UPDATE SET
           on_hand = EXCLUDED.on_hand,
           reserved = EXCLUDED.reserved,
           allocated = EXCLUDED.allocated,
           updated_at = now()`,
        [
          tenantId,
          mismatch.itemId,
          mismatch.locationId,
          mismatch.uom,
          mismatch.ledgerQty,
          mismatch.authoritativeReservedQty,
          mismatch.authoritativeAllocatedQty
        ]
      );
      await tx.query(
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
    };
    if (client) {
      await repairMismatch(client);
      continue;
    }
    await withTransaction(repairMismatch);
  }

  return { repairedCount, runId };
}

export async function compareItemQuantitySummaries(
  tenantId: string,
  options: { tolerance?: number; client?: PoolClient } = {}
): Promise<ItemQuantitySummaryMismatchRow[]> {
  const client = options.client;
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const res = await executeReconcileQuery(
    client,
    `WITH ledger AS (
       SELECT l.tenant_id,
              l.item_id,
              COALESCE(SUM(COALESCE(l.quantity_delta_canonical, l.quantity_delta)), 0) AS quantity_on_hand
         FROM inventory_movement_lines l
         JOIN inventory_movements m
           ON m.id = l.movement_id
          AND m.tenant_id = l.tenant_id
        WHERE l.tenant_id = $1
          AND m.status = 'posted'
        GROUP BY l.tenant_id, l.item_id
     )
     SELECT i.tenant_id,
            i.id AS item_id,
            COALESCE(i.quantity_on_hand, 0) AS summary_qty,
            COALESCE(ledger.quantity_on_hand, 0) AS ledger_qty,
            COALESCE(i.quantity_on_hand, 0) - COALESCE(ledger.quantity_on_hand, 0) AS delta
       FROM items i
       LEFT JOIN ledger
         ON ledger.tenant_id = i.tenant_id
        AND ledger.item_id = i.id
      WHERE i.tenant_id = $1
        AND ABS(COALESCE(i.quantity_on_hand, 0) - COALESCE(ledger.quantity_on_hand, 0)) > $2`,
    [tenantId, tolerance]
  );
  return res.rows.map((row: any) => ({
    tenantId: row.tenant_id,
    itemId: row.item_id,
    summaryQty: normalizeQty(row.summary_qty),
    ledgerQty: normalizeQty(row.ledger_qty),
    delta: normalizeQty(row.delta)
  }));
}

export async function repairItemQuantitySummaries(
  tenantId: string,
  mismatches: ItemQuantitySummaryMismatchRow[],
  options: { client?: PoolClient } = {}
): Promise<number> {
  const client = options.client;
  let repaired = 0;
  for (const mismatch of mismatches) {
    const repairMismatch = async (tx: PoolClient) => {
      await tx.query(
        `UPDATE items
            SET quantity_on_hand = $1,
                updated_at = now()
          WHERE tenant_id = $2
            AND id = $3`,
        [mismatch.ledgerQty, tenantId, mismatch.itemId]
      );
    };
    if (client) {
      await repairMismatch(client);
    } else {
      await withTransaction(repairMismatch);
    }
    repaired += 1;
  }
  return repaired;
}

export async function compareItemValuationSummaries(
  tenantId: string,
  options: { tolerance?: number; client?: PoolClient } = {}
): Promise<ItemValuationSummaryMismatchRow[]> {
  const client = options.client;
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const res = await executeReconcileQuery(
    client,
    `WITH layers AS (
       SELECT tenant_id,
              item_id,
              CASE
                WHEN COALESCE(SUM(remaining_quantity), 0) > 0
                THEN COALESCE(SUM(remaining_quantity * unit_cost), 0) / SUM(remaining_quantity)
                ELSE NULL
              END AS average_cost
         FROM inventory_cost_layers
        WHERE tenant_id = $1
          AND remaining_quantity > 0
          AND voided_at IS NULL
        GROUP BY tenant_id, item_id
     )
     SELECT i.tenant_id,
            i.id AS item_id,
            i.average_cost AS summary_average_cost,
            layers.average_cost AS layer_average_cost,
            CASE
              WHEN i.average_cost IS NULL AND layers.average_cost IS NULL THEN 0
              ELSE COALESCE(i.average_cost, 0) - COALESCE(layers.average_cost, 0)
            END AS average_cost_delta
       FROM items i
       LEFT JOIN layers
         ON layers.tenant_id = i.tenant_id
        AND layers.item_id = i.id
      WHERE i.tenant_id = $1
        AND (
          (i.average_cost IS NULL) <> (layers.average_cost IS NULL)
          OR ABS(COALESCE(i.average_cost, 0) - COALESCE(layers.average_cost, 0)) > $2
        )`,
    [tenantId, tolerance]
  );
  return res.rows.map((row: any) => ({
    tenantId: row.tenant_id,
    itemId: row.item_id,
    summaryAverageCost: row.summary_average_cost != null ? Number(row.summary_average_cost) : null,
    layerAverageCost: row.layer_average_cost != null ? Number(row.layer_average_cost) : null,
    averageCostDelta: normalizeQty(row.average_cost_delta)
  }));
}

export async function repairItemValuationSummaries(
  tenantId: string,
  mismatches: ItemValuationSummaryMismatchRow[],
  options: { client?: PoolClient } = {}
): Promise<number> {
  const client = options.client;
  let repaired = 0;
  for (const mismatch of mismatches) {
    const repairMismatch = async (tx: PoolClient) => {
      await tx.query(
        `UPDATE items
            SET average_cost = $1,
                updated_at = now()
          WHERE tenant_id = $2
            AND id = $3`,
        [mismatch.layerAverageCost, tenantId, mismatch.itemId]
      );
    };
    if (client) {
      await repairMismatch(client);
    } else {
      await withTransaction(repairMismatch);
    }
    repaired += 1;
  }
  return repaired;
}

export type ProjectionRebuildPhase = 'balances' | 'quantities' | 'valuations';

export async function rebuildDerivedProjectionsAtomically(
  tenantId: string,
  options: {
    runId?: string;
    actor?: string;
    maxRepairRows?: number;
    onPhaseApplied?: (phase: ProjectionRebuildPhase) => Promise<void> | void;
  } = {}
) {
  return withTransaction(async (client) => {
    const balanceMismatches = await compareBalances(tenantId, { client });
    const balanceRepair = await repairBalancesFromLedger(tenantId, balanceMismatches, {
      runId: options.runId,
      actor: options.actor,
      maxRepairRows: options.maxRepairRows,
      client
    });
    await options.onPhaseApplied?.('balances');

    const quantityMismatches = await compareItemQuantitySummaries(tenantId, { client });
    const repairedQuantityCount = await repairItemQuantitySummaries(tenantId, quantityMismatches, {
      client
    });
    await options.onPhaseApplied?.('quantities');

    const valuationMismatches = await compareItemValuationSummaries(tenantId, { client });
    const repairedValuationCount = await repairItemValuationSummaries(tenantId, valuationMismatches, {
      client
    });
    await options.onPhaseApplied?.('valuations');

    return {
      balanceMismatches,
      repairedBalanceCount: balanceRepair.repairedCount,
      quantityMismatches,
      repairedQuantityCount,
      valuationMismatches,
      repairedValuationCount
    };
  });
}

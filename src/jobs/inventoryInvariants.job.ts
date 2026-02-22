import { query } from '../db';

let isRunning = false;
let lastRunTime: Date | null = null;
let lastRunDuration: number | null = null;

type Tenant = { id: string; name: string; slug: string };
type InventoryInvariantSummary = {
  tenantId: string;
  tenantSlug: string;
  receiptLineCount: number;
  receiptMovementLineCount: number;
  receiptLegacyMovementCount: number;
  qcEventCount: number;
  qcTransferCount: number;
  qcLegacyMovementCount: number;
  sellableMismatchCount: number;
  negativeCount: number;
  reservationBalanceMismatchCount: number;
  warehouseIdDriftCount: number;
  reservationWarehouseHistoricalMismatchCount: number;
  nonSellableFlowScopeInvalidCount: number;
  salesOrderWarehouseScopeMismatchCount: number;
  atpOversellDetectedCount: number;
};
type InventoryInvariantStrictViolation = {
  tenantId: string;
  tenantSlug: string;
  violations: Record<string, number>;
};

function parseTenantScopeCsv(value: string | undefined): string[] {
  const normalized = String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return Array.from(new Set(normalized));
}

export function resolveInvariantTenantScopeEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const scoped = parseTenantScopeCsv(env.INVARIANTS_TENANT_IDS);
  if (scoped.length > 0) return scoped;
  return parseTenantScopeCsv(env.INVARIANTS_TENANT_ID);
}

function isStrictModeEnabled(strict?: boolean): boolean {
  if (typeof strict === 'boolean') {
    return strict;
  }
  const value = String(process.env.INVARIANTS_STRICT ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function summarizeStrictViolations(summary: InventoryInvariantSummary): Record<string, number> {
  const entries: Array<[string, number]> = [
    ['receipt_line_vs_movement_mismatch', Math.abs(summary.receiptLineCount - summary.receiptMovementLineCount)],
    ['qc_event_vs_transfer_mismatch', Math.abs(summary.qcEventCount - summary.qcTransferCount)],
    ['receipt_legacy_source_type_missing', summary.receiptLegacyMovementCount],
    ['qc_legacy_source_type_missing', summary.qcLegacyMovementCount],
    ['qc_accept_non_sellable_flow_scope_invalid', summary.sellableMismatchCount],
    ['negative_inventory_balance', summary.negativeCount],
    ['reservation_balance_mismatch', summary.reservationBalanceMismatchCount],
    ['warehouse_id_drift', summary.warehouseIdDriftCount],
    ['reservation_warehouse_historical_mismatch', summary.reservationWarehouseHistoricalMismatchCount],
    ['non_sellable_flow_scope_invalid', summary.nonSellableFlowScopeInvalidCount],
    ['sales_order_warehouse_scope_mismatch', summary.salesOrderWarehouseScopeMismatchCount],
    ['atp_oversell_detected_count', summary.atpOversellDetectedCount]
  ];
  return Object.fromEntries(
    entries.filter(([, count]) => count > 0)
  );
}

async function getAllActiveTenants(): Promise<Tenant[]> {
  const result = await query<{ id: string; name: string; slug: string }>(
    'SELECT id, name, slug FROM tenants ORDER BY name'
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug
  }));
}

export async function runInventoryInvariantCheck(
  options: { tenantIds?: string[]; strict?: boolean } = {}
): Promise<InventoryInvariantSummary[]> {
  if (isRunning) {
    console.warn('⚠️  Inventory invariant check already running, skipping');
    return [];
  }

  isRunning = true;
  const start = Date.now();
  const windowDays = Number(process.env.INVENTORY_INVARIANT_WINDOW_DAYS ?? 7);
  const reconTolerance = Number(process.env.RESERVATION_BALANCE_RECON_TOLERANCE ?? 1e-6);
  const reconLimit = Number(process.env.RESERVATION_BALANCE_RECON_LIMIT ?? 5);
  const strictMode = isStrictModeEnabled(options.strict);
  const results: InventoryInvariantSummary[] = [];
  const strictViolations: InventoryInvariantStrictViolation[] = [];

  try {
    const scopedTenantIds = options.tenantIds?.length
      ? Array.from(new Set(options.tenantIds.map((id) => String(id).trim()).filter(Boolean)))
      : resolveInvariantTenantScopeEnv();
    const tenants = scopedTenantIds.length
      ? (
          await query<Tenant>(
            'SELECT id, name, slug FROM tenants WHERE id = ANY($1) ORDER BY name',
            [scopedTenantIds]
          )
        ).rows
      : await getAllActiveTenants();
    for (const tenant of tenants) {
      try {
        const receiptLines = await query<{ count: string }>(
          `SELECT COUNT(*) AS count
             FROM purchase_order_receipt_lines prl
             JOIN purchase_order_receipts por
               ON por.id = prl.purchase_order_receipt_id
              AND por.tenant_id = prl.tenant_id
             JOIN inventory_movements m
               ON m.id = por.inventory_movement_id
              AND m.tenant_id = por.tenant_id
            WHERE prl.tenant_id = $1
              AND por.received_at >= now() - ($2::text || ' days')::interval
              AND m.source_type = 'po_receipt'`,
          [tenant.id, windowDays]
        );
        const receiptMovementLines = await query<{ count: string }>(
          `SELECT COUNT(*) AS count
             FROM inventory_movement_lines l
             JOIN inventory_movements m
               ON m.id = l.movement_id
              AND m.tenant_id = l.tenant_id
            WHERE m.tenant_id = $1
              AND m.movement_type = 'receive'
              AND m.source_type = 'po_receipt'
              AND m.occurred_at >= now() - ($2::text || ' days')::interval`,
          [tenant.id, windowDays]
        );
        const receiptLegacyMovements = await query<{ count: string }>(
          `SELECT COUNT(*) AS count
             FROM inventory_movements m
            WHERE m.tenant_id = $1
              AND m.movement_type = 'receive'
              AND m.source_type IS NULL
              AND m.occurred_at >= now() - ($2::text || ' days')::interval`,
          [tenant.id, windowDays]
        );

        const qcEvents = await query<{ count: string }>(
          `SELECT COUNT(*) AS count
             FROM qc_events q
             JOIN inventory_movements m
               ON m.source_type = 'qc_event'
              AND m.source_id = q.id::text
              AND m.tenant_id = q.tenant_id
            WHERE q.tenant_id = $1
              AND q.event_type IN ('accept','hold','reject')
              AND q.occurred_at >= now() - ($2::text || ' days')::interval`,
          [tenant.id, windowDays]
        );
        const qcTransfers = await query<{ count: string }>(
          `SELECT COUNT(*) AS count
             FROM inventory_movements m
            WHERE m.tenant_id = $1
              AND m.movement_type = 'transfer'
              AND m.source_type = 'qc_event'
              AND m.occurred_at >= now() - ($2::text || ' days')::interval`,
          [tenant.id, windowDays]
        );
        const qcLegacyMovements = await query<{ count: string }>(
          `SELECT COUNT(*) AS count
             FROM inventory_movements m
            WHERE m.tenant_id = $1
              AND m.movement_type = 'transfer'
              AND m.source_type IS NULL
              AND m.occurred_at >= now() - ($2::text || ' days')::interval`,
          [tenant.id, windowDays]
        );

        const sellableMismatch = await query<{ count: string }>(
          `SELECT COUNT(*) AS count
             FROM inventory_movement_lines l
             JOIN inventory_movements m
               ON m.id = l.movement_id
              AND m.tenant_id = l.tenant_id
             JOIN qc_events q
               ON q.id::text = m.source_id
              AND q.tenant_id = m.tenant_id
             JOIN locations loc
               ON loc.id = l.location_id
              AND loc.tenant_id = l.tenant_id
            WHERE l.tenant_id = $1
              AND m.status = 'posted'
              AND m.movement_type = 'transfer'
              AND m.source_type = 'qc_event'
              AND q.event_type = 'accept'
              AND l.quantity_delta > 0
              AND loc.is_sellable = false`,
          [tenant.id]
        );

        const negativeOnHand = await query<{ count: string }>(
          `SELECT COUNT(*) AS count
             FROM inventory_balance
            WHERE tenant_id = $1
              AND on_hand < 0`,
          [tenant.id]
        );

        const reservationBalanceMismatch = await query<{ count: string }>(
          `WITH reservation_committed AS (
             SELECT tenant_id,
                    item_id,
                    location_id,
                    uom,
                    SUM(
                      CASE
                        WHEN status = 'RESERVED'
                        THEN GREATEST(0, quantity_reserved - COALESCE(quantity_fulfilled, 0))
                        ELSE 0
                      END
                    ) AS reserved,
                    SUM(
                      CASE
                        WHEN status = 'ALLOCATED'
                        THEN GREATEST(0, quantity_reserved - COALESCE(quantity_fulfilled, 0))
                        ELSE 0
                      END
                    ) AS allocated
               FROM inventory_reservations
              WHERE tenant_id = $1
                AND status IN ('RESERVED','ALLOCATED')
              GROUP BY tenant_id, item_id, location_id, uom
           ),
           combined AS (
             SELECT b.tenant_id,
                    b.item_id,
                    b.location_id,
                    b.uom,
                    (b.reserved + b.allocated) AS balance_committed,
                    COALESCE(r.reserved, 0) + COALESCE(r.allocated, 0) AS reservation_committed
               FROM inventory_balance b
               LEFT JOIN reservation_committed r
                 ON r.tenant_id = b.tenant_id
                AND r.item_id = b.item_id
                AND r.location_id = b.location_id
                AND r.uom = b.uom
              WHERE b.tenant_id = $1
           )
           SELECT COUNT(*) AS count
             FROM combined
            WHERE ABS(balance_committed - reservation_committed) > $2`,
          [tenant.id, reconTolerance]
        );

        const mismatchCount = Number(reservationBalanceMismatch.rows[0]?.count ?? 0);

        const warehouseIdDrift = await query<{
          location_id: string;
          stored_warehouse_id: string | null;
          expected_warehouse_id: string | null;
        }>(
          `SELECT l.id AS location_id,
                  l.warehouse_id AS stored_warehouse_id,
                  resolve_warehouse_for_location(l.tenant_id, l.id) AS expected_warehouse_id
             FROM locations l
            WHERE l.tenant_id = $1
              AND l.warehouse_id IS DISTINCT FROM resolve_warehouse_for_location(l.tenant_id, l.id)`,
          [tenant.id]
        );
        const warehouseIdDriftCount = Number(warehouseIdDrift.rowCount ?? 0);
        if (warehouseIdDriftCount > 0) {
          const samples = warehouseIdDrift.rows.slice(0, 5);
          console.error(
            `CRITICAL invariant violation for tenant ${tenant.slug}: ${warehouseIdDriftCount} warehouse_id drift(s)`,
            { examples: samples }
          );
          await query(
            `INSERT INTO inventory_invariant_blocks (tenant_id, code, active, details, created_at, updated_at)
             VALUES ($1, 'WAREHOUSE_ID_DRIFT', true, $2::jsonb, now(), now())
             ON CONFLICT (tenant_id, code)
             DO UPDATE SET active = true, details = EXCLUDED.details, updated_at = now()`,
            [tenant.id, JSON.stringify({ count: warehouseIdDriftCount, samples })]
          );
        } else {
          await query(
            `UPDATE inventory_invariant_blocks
                SET active = false,
                    updated_at = now()
              WHERE tenant_id = $1
                AND code = 'WAREHOUSE_ID_DRIFT'
                AND active = true`,
            [tenant.id]
          );
        }

        const reservationWarehouseHistoricalMismatch = await query<{ count: string }>(
          `SELECT COUNT(*) AS count
             FROM inventory_reservations r
             JOIN locations l
               ON l.id = r.location_id
              AND l.tenant_id = r.tenant_id
            WHERE r.tenant_id = $1
              AND r.warehouse_id IS NOT NULL
              AND r.warehouse_id <> l.warehouse_id`,
          [tenant.id]
        );
        const reservationWarehouseHistoricalMismatchCount = Number(
          reservationWarehouseHistoricalMismatch.rows[0]?.count ?? 0
        );
        if (reservationWarehouseHistoricalMismatchCount > 0) {
          const samples = await query(
            `SELECT r.id, r.location_id, r.warehouse_id, l.warehouse_id AS current_warehouse_id
               FROM inventory_reservations r
               JOIN locations l
                 ON l.id = r.location_id
                AND l.tenant_id = r.tenant_id
              WHERE r.tenant_id = $1
                AND r.warehouse_id IS NOT NULL
                AND r.warehouse_id <> l.warehouse_id
              ORDER BY r.created_at DESC
              LIMIT 25`,
            [tenant.id]
          );
          console.warn(
            `Invariant warning for tenant ${tenant.slug}: ${reservationWarehouseHistoricalMismatchCount} reservation warehouse historical mismatch(es)`,
            { examples: samples.rows }
          );
        }

        const nonSellableFlowScopeInvalid = await query<{ count: string }>(
          `WITH reservation_refs AS (
             SELECT r.tenant_id, r.location_id
               FROM inventory_reservations r
              WHERE r.tenant_id = $1
                AND r.status IN ('RESERVED','ALLOCATED','FULFILLED')
           ),
           shipment_refs AS (
             SELECT s.tenant_id, s.ship_from_location_id AS location_id
               FROM sales_order_shipments s
              WHERE s.tenant_id = $1
                AND s.ship_from_location_id IS NOT NULL
                AND COALESCE(s.status, 'draft') <> 'canceled'
           ),
           combined AS (
             SELECT * FROM reservation_refs
             UNION ALL
             SELECT * FROM shipment_refs
           )
           SELECT COUNT(*) AS count
             FROM combined c
             JOIN locations l
               ON l.id = c.location_id
              AND l.tenant_id = c.tenant_id
            WHERE l.is_sellable = false`,
          [tenant.id]
        );
        const nonSellableFlowScopeInvalidCount = Number(nonSellableFlowScopeInvalid.rows[0]?.count ?? 0);
        if (nonSellableFlowScopeInvalidCount > 0) {
          console.warn(
            `Invariant violation for tenant ${tenant.slug}: ${nonSellableFlowScopeInvalidCount} non-sellable reservation/fulfillment flow reference(s)`
          );
        }

        const salesOrderWarehouseScopeMismatch = await query<{ count: string }>(
          `WITH reservation_scope_mismatch AS (
             SELECT r.id
               FROM inventory_reservations r
               JOIN sales_order_lines sol
                 ON sol.id = r.demand_id
                AND sol.tenant_id = r.tenant_id
               JOIN sales_orders so
                 ON so.id = sol.sales_order_id
                AND so.tenant_id = sol.tenant_id
               JOIN locations l
                 ON l.id = r.location_id
                AND l.tenant_id = r.tenant_id
              WHERE r.tenant_id = $1
                AND r.demand_type = 'sales_order_line'
                AND (
                  so.warehouse_id IS DISTINCT FROM r.warehouse_id
                  OR so.warehouse_id IS DISTINCT FROM l.warehouse_id
                )
           ),
           shipment_scope_mismatch AS (
             SELECT s.id
               FROM sales_order_shipments s
               JOIN sales_orders so
                 ON so.id = s.sales_order_id
                AND so.tenant_id = s.tenant_id
               LEFT JOIN locations l
                 ON l.id = s.ship_from_location_id
                AND l.tenant_id = s.tenant_id
              WHERE s.tenant_id = $1
                AND s.ship_from_location_id IS NOT NULL
                AND COALESCE(s.status, 'draft') <> 'canceled'
                AND (
                  so.warehouse_id IS NULL
                  OR l.warehouse_id IS NULL
                  OR so.warehouse_id IS DISTINCT FROM l.warehouse_id
                )
           )
           SELECT (
             (SELECT COUNT(*) FROM reservation_scope_mismatch)
             + (SELECT COUNT(*) FROM shipment_scope_mismatch)
           )::text AS count`,
          [tenant.id]
        );
        const salesOrderWarehouseScopeMismatchCount = Number(
          salesOrderWarehouseScopeMismatch.rows[0]?.count ?? 0
        );
        if (salesOrderWarehouseScopeMismatchCount > 0) {
          console.warn(
            `Invariant violation for tenant ${tenant.slug}: ${salesOrderWarehouseScopeMismatchCount} sales-order warehouse scope mismatch(es)`
          );
        }

        const atpOversellDetected = await query<{ count: string }>(
          `WITH sellable_totals AS (
             SELECT b.tenant_id,
                    l.warehouse_id,
                    b.item_id,
                    b.uom,
                    COALESCE(SUM(b.on_hand), 0)::numeric AS on_hand_qty,
                    COALESCE(SUM(b.reserved), 0)::numeric AS reserved_qty,
                    COALESCE(SUM(b.allocated), 0)::numeric AS allocated_qty
               FROM inventory_balance b
               JOIN locations l
                 ON l.id = b.location_id
                AND l.tenant_id = b.tenant_id
              WHERE b.tenant_id = $1
                AND l.type = 'bin'
                AND l.is_sellable = true
              GROUP BY b.tenant_id, l.warehouse_id, b.item_id, b.uom
           )
           SELECT COUNT(*) AS count
             FROM sellable_totals
            WHERE (reserved_qty + allocated_qty) - on_hand_qty > 0.000001`,
          [tenant.id]
        );
        const atpOversellDetectedCount = Number(atpOversellDetected.rows[0]?.count ?? 0);
        if (atpOversellDetectedCount > 0) {
          const samples = await query(
            `WITH sellable_totals AS (
               SELECT b.tenant_id,
                      l.warehouse_id,
                      b.item_id,
                      b.uom,
                      COALESCE(SUM(b.on_hand), 0)::numeric AS on_hand_qty,
                      COALESCE(SUM(b.reserved), 0)::numeric AS reserved_qty,
                      COALESCE(SUM(b.allocated), 0)::numeric AS allocated_qty
                 FROM inventory_balance b
                 JOIN locations l
                   ON l.id = b.location_id
                  AND l.tenant_id = b.tenant_id
                WHERE b.tenant_id = $1
                  AND l.type = 'bin'
                  AND l.is_sellable = true
                GROUP BY b.tenant_id, l.warehouse_id, b.item_id, b.uom
             )
             SELECT warehouse_id,
                    item_id,
                    uom,
                    on_hand_qty,
                    reserved_qty,
                    allocated_qty,
                    (reserved_qty + allocated_qty)::numeric AS committed_qty,
                    ((reserved_qty + allocated_qty) - on_hand_qty)::numeric AS oversell_qty
               FROM sellable_totals
              WHERE (reserved_qty + allocated_qty) - on_hand_qty > 0.000001
              ORDER BY ((reserved_qty + allocated_qty) - on_hand_qty) DESC,
                       warehouse_id,
                       item_id,
                       uom
              LIMIT 25`,
            [tenant.id]
          );
          console.error(
            `Invariant violation for tenant ${tenant.slug}: ${atpOversellDetectedCount} ATP oversell condition(s)`,
            { examples: samples.rows }
          );
        }

        if (mismatchCount > 0) {
          const samples = await query(
            `WITH reservation_committed AS (
               SELECT tenant_id,
                      item_id,
                      location_id,
                      uom,
                      SUM(
                        CASE
                          WHEN status = 'RESERVED'
                          THEN GREATEST(0, quantity_reserved - COALESCE(quantity_fulfilled, 0))
                          ELSE 0
                        END
                      ) AS reserved,
                      SUM(
                        CASE
                          WHEN status = 'ALLOCATED'
                          THEN GREATEST(0, quantity_reserved - COALESCE(quantity_fulfilled, 0))
                          ELSE 0
                        END
                      ) AS allocated
                 FROM inventory_reservations
                WHERE tenant_id = $1
                  AND status IN ('RESERVED','ALLOCATED')
                GROUP BY tenant_id, item_id, location_id, uom
             ),
             combined AS (
               SELECT b.tenant_id,
                      b.item_id,
                      b.location_id,
                      b.uom,
                      (b.reserved + b.allocated) AS balance_committed,
                      COALESCE(r.reserved, 0) + COALESCE(r.allocated, 0) AS reservation_committed
                 FROM inventory_balance b
                 LEFT JOIN reservation_committed r
                   ON r.tenant_id = b.tenant_id
                  AND r.item_id = b.item_id
                  AND r.location_id = b.location_id
                  AND r.uom = b.uom
                WHERE b.tenant_id = $1
             )
             SELECT item_id, location_id, uom, balance_committed, reservation_committed,
                    (balance_committed - reservation_committed) AS delta
               FROM combined
              WHERE ABS(balance_committed - reservation_committed) > $2
              ORDER BY ABS(balance_committed - reservation_committed) DESC
              LIMIT $3`,
            [tenant.id, reconTolerance, reconLimit]
          );
          console.warn(
            `Invariant mismatch for tenant ${tenant.slug}: ${mismatchCount} reservation balance drift(s)`,
            { examples: samples.rows }
          );
        }

        const receiptLineCount = Number(receiptLines.rows[0]?.count ?? 0);
        const receiptMovementLineCount = Number(receiptMovementLines.rows[0]?.count ?? 0);
        const receiptLegacyMovementCount = Number(receiptLegacyMovements.rows[0]?.count ?? 0);
        const qcEventCount = Number(qcEvents.rows[0]?.count ?? 0);
        const qcTransferCount = Number(qcTransfers.rows[0]?.count ?? 0);
        const qcLegacyMovementCount = Number(qcLegacyMovements.rows[0]?.count ?? 0);
        const sellableMismatchCount = Number(sellableMismatch.rows[0]?.count ?? 0);
        const negativeCount = Number(negativeOnHand.rows[0]?.count ?? 0);

        if (receiptLineCount !== receiptMovementLineCount) {
          console.warn(
            `Invariant mismatch for tenant ${tenant.slug}: receipt lines=${receiptLineCount}, receive movement lines=${receiptMovementLineCount}`
          );
        }
        if (qcEventCount !== qcTransferCount) {
          console.warn(
            `Invariant mismatch for tenant ${tenant.slug}: qc events=${qcEventCount}, qc transfers=${qcTransferCount}`
          );
        }
        if (receiptLegacyMovementCount > 0) {
          console.info(
            `Legacy movement sources for tenant ${tenant.slug}: ${receiptLegacyMovementCount} receipt movements missing source_type`
          );
        }
        if (qcLegacyMovementCount > 0) {
          console.info(
            `Legacy movement sources for tenant ${tenant.slug}: ${qcLegacyMovementCount} transfer movements missing source_type`
          );
        }
        if (sellableMismatchCount > 0) {
          console.warn(
            `Invariant violation for tenant ${tenant.slug}: ${sellableMismatchCount} incoming movements to non-sellable locations`
          );
        }
        if (negativeCount > 0) {
          console.warn(
            `Invariant violation for tenant ${tenant.slug}: ${negativeCount} negative inventory balances`
          );
        }

        const summary: InventoryInvariantSummary = {
          tenantId: tenant.id,
          tenantSlug: tenant.slug,
          receiptLineCount,
          receiptMovementLineCount,
          receiptLegacyMovementCount,
          qcEventCount,
          qcTransferCount,
          qcLegacyMovementCount,
          sellableMismatchCount,
          negativeCount,
          reservationBalanceMismatchCount: mismatchCount,
          warehouseIdDriftCount,
          reservationWarehouseHistoricalMismatchCount,
          nonSellableFlowScopeInvalidCount,
          salesOrderWarehouseScopeMismatchCount,
          atpOversellDetectedCount
        };
        results.push(summary);
        if (strictMode) {
          const violations = summarizeStrictViolations(summary);
          if (Object.keys(violations).length > 0) {
            strictViolations.push({
              tenantId: tenant.id,
              tenantSlug: tenant.slug,
              violations
            });
          }
        }
      } catch (error) {
        if (strictMode) {
          throw error;
        }
        console.error(`Inventory invariant check failed for tenant ${tenant.slug}:`, error);
      }
    }

    lastRunTime = new Date();
    lastRunDuration = Date.now() - start;
    if (strictMode && strictViolations.length > 0) {
      const strictError = new Error('INVENTORY_INVARIANTS_STRICT_FAILED') as Error & {
        code?: string;
        details?: Record<string, unknown>;
      };
      strictError.code = 'INVENTORY_INVARIANTS_STRICT_FAILED';
      strictError.details = {
        mode: 'strict',
        violationCount: strictViolations.length,
        violations: strictViolations
      };
      throw strictError;
    }
  } finally {
    isRunning = false;
  }

  return results;
}

export function getInventoryInvariantJobStatus() {
  return {
    isRunning,
    lastRunTime,
    lastRunDuration
  };
}

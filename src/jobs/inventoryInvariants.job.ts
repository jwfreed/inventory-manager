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
};

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
  options: { tenantIds?: string[] } = {}
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
  const results: InventoryInvariantSummary[] = [];

  try {
    const tenants = options.tenantIds?.length
      ? (
          await query<Tenant>(
            'SELECT id, name, slug FROM tenants WHERE id = ANY($1) ORDER BY name',
            [options.tenantIds]
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

        results.push({
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
          reservationBalanceMismatchCount: mismatchCount
        });
      } catch (error) {
        console.error(`Inventory invariant check failed for tenant ${tenant.slug}:`, error);
      }
    }

    lastRunTime = new Date();
    lastRunDuration = Date.now() - start;
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

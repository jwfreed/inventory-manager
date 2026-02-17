#!/usr/bin/env node
import 'dotenv/config';
import { Pool } from 'pg';

function getArg(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function printSection(title, count, rows) {
  console.log(`\n[${title}] count=${count}`);
  if (rows.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const row of rows) {
    console.log(`  ${JSON.stringify(row)}`);
  }
}

const tenantId = getArg('tenant-id') ?? process.env.TENANT_ID;
const warehouseId = getArg('warehouse-id') ?? process.env.WAREHOUSE_ID ?? null;
const limit = parsePositiveInt(getArg('limit') ?? process.env.LIMIT, 200);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
if (!tenantId) {
  console.error('TENANT_ID (or --tenant-id) is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parsePositiveInt(process.env.DB_POOL_MAX, 20),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

const params2 = [tenantId, warehouseId];
const params3 = [tenantId, warehouseId, limit];

const negativeBalanceCountSql = `
  SELECT COUNT(*)::int AS count
    FROM inventory_balance b
    JOIN locations l
      ON l.id = b.location_id
     AND l.tenant_id = b.tenant_id
   WHERE b.tenant_id = $1
     AND ($2::uuid IS NULL OR l.warehouse_id = $2::uuid)
     AND (b.on_hand < 0 OR b.reserved < 0 OR b.allocated < 0)
`;

const negativeBalanceRowsSql = `
  SELECT b.tenant_id, b.item_id, b.location_id, b.uom, b.on_hand, b.reserved, b.allocated
    FROM inventory_balance b
    JOIN locations l
      ON l.id = b.location_id
     AND l.tenant_id = b.tenant_id
   WHERE b.tenant_id = $1
     AND ($2::uuid IS NULL OR l.warehouse_id = $2::uuid)
     AND (b.on_hand < 0 OR b.reserved < 0 OR b.allocated < 0)
   ORDER BY b.item_id, b.location_id, b.uom
   LIMIT $3
`;

const reservationBoundsCountSql = `
  SELECT COUNT(*)::int AS count
    FROM inventory_reservations r
   WHERE r.tenant_id = $1
     AND ($2::uuid IS NULL OR r.warehouse_id = $2::uuid)
     AND (
       r.quantity_reserved < 0
       OR COALESCE(r.quantity_fulfilled, 0) < 0
       OR COALESCE(r.quantity_fulfilled, 0) > r.quantity_reserved
     )
`;

const reservationBoundsRowsSql = `
  SELECT r.id,
         r.tenant_id,
         r.warehouse_id,
         r.item_id,
         r.location_id,
         r.uom,
         r.status,
         r.quantity_reserved,
         COALESCE(r.quantity_fulfilled, 0) AS quantity_fulfilled
    FROM inventory_reservations r
   WHERE r.tenant_id = $1
     AND ($2::uuid IS NULL OR r.warehouse_id = $2::uuid)
     AND (
       r.quantity_reserved < 0
       OR COALESCE(r.quantity_fulfilled, 0) < 0
       OR COALESCE(r.quantity_fulfilled, 0) > r.quantity_reserved
     )
   ORDER BY r.updated_at DESC NULLS LAST, r.id
   LIMIT $3
`;

const commitmentsDriftCte = `
  WITH commitments AS (
    SELECT r.tenant_id,
           r.item_id,
           r.location_id,
           r.uom,
           COALESCE(
             SUM(
               CASE
                 WHEN r.status = 'RESERVED'
                 THEN GREATEST(0, r.quantity_reserved - COALESCE(r.quantity_fulfilled, 0))
                 ELSE 0
               END
             ),
             0
           )::numeric AS reserved_open,
           COALESCE(
             SUM(
               CASE
                 WHEN r.status = 'ALLOCATED'
                 THEN GREATEST(0, r.quantity_reserved - COALESCE(r.quantity_fulfilled, 0))
                 ELSE 0
               END
             ),
             0
           )::numeric AS allocated_open
      FROM inventory_reservations r
      JOIN locations l
        ON l.id = r.location_id
       AND l.tenant_id = r.tenant_id
     WHERE r.tenant_id = $1
       AND ($2::uuid IS NULL OR l.warehouse_id = $2::uuid)
       AND r.status IN ('RESERVED', 'ALLOCATED')
     GROUP BY r.tenant_id, r.item_id, r.location_id, r.uom
  ),
  balances AS (
    SELECT b.tenant_id,
           b.item_id,
           b.location_id,
           b.uom,
           COALESCE(b.reserved, 0)::numeric AS balance_reserved,
           COALESCE(b.allocated, 0)::numeric AS balance_allocated
      FROM inventory_balance b
      JOIN locations l
        ON l.id = b.location_id
       AND l.tenant_id = b.tenant_id
     WHERE b.tenant_id = $1
       AND ($2::uuid IS NULL OR l.warehouse_id = $2::uuid)
  ),
  combined AS (
    SELECT COALESCE(b.tenant_id, c.tenant_id) AS tenant_id,
           COALESCE(b.item_id, c.item_id) AS item_id,
           COALESCE(b.location_id, c.location_id) AS location_id,
           COALESCE(b.uom, c.uom) AS uom,
           COALESCE(b.balance_reserved, 0)::numeric AS balance_reserved,
           COALESCE(b.balance_allocated, 0)::numeric AS balance_allocated,
           COALESCE(c.reserved_open, 0)::numeric AS reserved_open,
           COALESCE(c.allocated_open, 0)::numeric AS allocated_open
      FROM balances b
      FULL OUTER JOIN commitments c
        ON c.tenant_id = b.tenant_id
       AND c.item_id = b.item_id
       AND c.location_id = b.location_id
       AND c.uom = b.uom
  )
`;

const commitmentsDriftCountSql = `
  ${commitmentsDriftCte}
  SELECT COUNT(*)::int AS count
    FROM combined
   WHERE ABS(balance_reserved - reserved_open) > 0.000001
      OR ABS(balance_allocated - allocated_open) > 0.000001
`;

const commitmentsDriftRowsSql = `
  ${commitmentsDriftCte}
  SELECT tenant_id,
         item_id,
         location_id,
         uom,
         balance_reserved,
         reserved_open,
         (balance_reserved - reserved_open)::numeric AS reserved_diff,
         balance_allocated,
         allocated_open,
         (balance_allocated - allocated_open)::numeric AS allocated_diff
    FROM combined
   WHERE ABS(balance_reserved - reserved_open) > 0.000001
      OR ABS(balance_allocated - allocated_open) > 0.000001
   ORDER BY GREATEST(
     ABS(balance_reserved - reserved_open),
     ABS(balance_allocated - allocated_open)
   ) DESC,
   item_id,
   location_id,
   uom
   LIMIT $3
`;

const warehouseSpotCheckSql = `
  ${commitmentsDriftCte}
  SELECT c.location_id, l.warehouse_id
    FROM combined c
    LEFT JOIN locations l
      ON l.id = c.location_id
     AND l.tenant_id = c.tenant_id
   WHERE (ABS(c.balance_reserved - c.reserved_open) > 0.000001
       OR ABS(c.balance_allocated - c.allocated_open) > 0.000001)
     AND ($2::uuid IS NOT NULL)
     AND (l.warehouse_id IS DISTINCT FROM $2::uuid)
   ORDER BY c.location_id
   LIMIT $3
`;

const availabilityReconciliationCountSql = `
  SELECT COUNT(*)::int AS count
    FROM inventory_availability_reconciliation_v v
   WHERE v.tenant_id = $1
     AND ($2::uuid IS NULL OR v.warehouse_id = $2::uuid)
`;

const availabilityReconciliationRowsSql = `
  SELECT v.tenant_id,
         v.warehouse_id,
         v.location_id,
         v.item_id,
         v.uom,
         v.on_hand_qty,
         v.reserved_qty,
         v.allocated_qty,
         v.available_qty,
         v.reconciliation_diff
    FROM inventory_availability_reconciliation_v v
   WHERE v.tenant_id = $1
     AND ($2::uuid IS NULL OR v.warehouse_id = $2::uuid)
   ORDER BY ABS(v.reconciliation_diff) DESC, v.item_id, v.location_id, v.uom
   LIMIT $3
`;

let exitCode = 0;

try {
  const [negativeBalanceCountRes, negativeBalanceRowsRes] = await Promise.all([
    pool.query(negativeBalanceCountSql, params2),
    pool.query(negativeBalanceRowsSql, params3)
  ]);
  const negativeBalanceCount = Number(negativeBalanceCountRes.rows[0]?.count ?? 0);
  printSection('negative_inventory_balance', negativeBalanceCount, negativeBalanceRowsRes.rows);
  if (negativeBalanceCount > 0) {
    exitCode = 2;
  }

  const [reservationBoundsCountRes, reservationBoundsRowsRes] = await Promise.all([
    pool.query(reservationBoundsCountSql, params2),
    pool.query(reservationBoundsRowsSql, params3)
  ]);
  const reservationBoundsCount = Number(reservationBoundsCountRes.rows[0]?.count ?? 0);
  printSection('reservation_quantity_violations', reservationBoundsCount, reservationBoundsRowsRes.rows);
  if (reservationBoundsCount > 0) {
    exitCode = 2;
  }

  const [commitmentsDriftCountRes, commitmentsDriftRowsRes] = await Promise.all([
    pool.query(commitmentsDriftCountSql, params2),
    pool.query(commitmentsDriftRowsSql, params3)
  ]);
  const commitmentsDriftCount = Number(commitmentsDriftCountRes.rows[0]?.count ?? 0);
  printSection('balance_vs_commitments_drift', commitmentsDriftCount, commitmentsDriftRowsRes.rows);
  if (commitmentsDriftCount > 0) {
    exitCode = 2;
  }

  if (warehouseId) {
    const spotCheckRes = await pool.query(warehouseSpotCheckSql, params3);
    printSection('warehouse_isolation_spot_check', spotCheckRes.rowCount, spotCheckRes.rows);
    if (spotCheckRes.rowCount > 0) {
      exitCode = 2;
    }
  }

  const [availabilityReconciliationCountRes, availabilityReconciliationRowsRes] = await Promise.all([
    pool.query(availabilityReconciliationCountSql, params2),
    pool.query(availabilityReconciliationRowsSql, params3)
  ]);
  const availabilityReconciliationCount = Number(availabilityReconciliationCountRes.rows[0]?.count ?? 0);
  printSection(
    'availability_reconciliation_drift',
    availabilityReconciliationCount,
    availabilityReconciliationRowsRes.rows
  );
  if (availabilityReconciliationCount > 0) {
    exitCode = 2;
  }

  process.exit(exitCode);
} catch (error) {
  console.error(error);
  process.exit(1);
} finally {
  await pool.end();
}

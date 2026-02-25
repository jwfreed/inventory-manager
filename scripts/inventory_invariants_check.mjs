#!/usr/bin/env node
import 'dotenv/config';
import { Pool } from 'pg';
import { createRequire } from 'node:module';
import { detectBomCyclesAtRest } from './lib/bomCycleDetector.mjs';
import { checkWarehouseTopologyDefaults } from './lib/warehouseTopologyCheck.mjs';
import { loadWarehouseTopology } from './lib/warehouseTopology.mjs';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { getAllEffectiveBomEdges } = require('../src/services/bomEdges.service.ts');

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

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
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

function summarizeTopologyMissingIssues(issues, rowLimit = 50) {
  const missingWarehouseCodes = new Set();
  const missingLocationCodes = new Set();
  const missingDefaults = new Map();

  for (const issue of issues ?? []) {
    if (!issue || typeof issue !== 'object') continue;
    if (issue.issue === 'MISSING_WAREHOUSE' && issue.warehouseCode) {
      missingWarehouseCodes.add(String(issue.warehouseCode));
    }
    if (issue.issue === 'MISSING_LOCATION' && issue.locationCode) {
      missingLocationCodes.add(String(issue.locationCode));
    }
    if (issue.issue === 'MISSING_DEFAULT' || issue.issue === 'DEFAULT_TARGET_LOCATION_MISSING') {
      const warehouseCode = issue.warehouseCode ? String(issue.warehouseCode) : null;
      const role = issue.role ? String(issue.role) : null;
      const localCode = issue.localCode ? String(issue.localCode) : null;
      if (!warehouseCode || !role) continue;
      const key = `${warehouseCode}:${role}:${localCode ?? ''}`;
      if (!missingDefaults.has(key)) {
        missingDefaults.set(key, { warehouseCode, role, localCode });
      }
    }
  }

  return {
    missingWarehouseCodes: Array.from(missingWarehouseCodes).sort().slice(0, rowLimit),
    missingLocationCodes: Array.from(missingLocationCodes).sort().slice(0, rowLimit),
    missingDefaults: Array.from(missingDefaults.values())
      .sort((left, right) => {
        const warehouseCompare = left.warehouseCode.localeCompare(right.warehouseCode);
        if (warehouseCompare !== 0) return warehouseCompare;
        const roleCompare = left.role.localeCompare(right.role);
        if (roleCompare !== 0) return roleCompare;
        return String(left.localCode ?? '').localeCompare(String(right.localCode ?? ''));
      })
      .slice(0, rowLimit)
  };
}

const tenantId = getArg('tenant-id') ?? process.env.INVARIANTS_TENANT_ID ?? process.env.TENANT_ID;
const warehouseId = getArg('warehouse-id') ?? process.env.WAREHOUSE_ID ?? null;
const limit = parsePositiveInt(getArg('limit') ?? process.env.LIMIT, 200);
const bomCycleLimit = parsePositiveInt(getArg('bom-cycle-limit') ?? process.env.BOM_CYCLE_LIMIT, 50);
const bomCycleNodeLimit = parsePositiveInt(getArg('bom-cycle-node-limit') ?? process.env.BOM_CYCLE_NODE_LIMIT, 10000);
const strictMode = parseBoolean(getArg('strict') ?? process.env.INVARIANTS_STRICT, false);

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

const nonSellableFlowRefsCte = `
  WITH reservation_refs AS (
    SELECT 'reservation'::text AS source_type,
           r.id::text AS source_id,
           r.tenant_id,
           r.warehouse_id,
           r.location_id,
           r.status AS source_status,
           r.demand_id::text AS demand_id
      FROM inventory_reservations r
     WHERE r.tenant_id = $1
       AND ($2::uuid IS NULL OR r.warehouse_id = $2::uuid)
       AND r.status IN ('RESERVED', 'ALLOCATED', 'FULFILLED')
  ),
  shipment_refs AS (
    SELECT 'shipment'::text AS source_type,
           s.id::text AS source_id,
           s.tenant_id,
           so.warehouse_id,
           s.ship_from_location_id AS location_id,
           COALESCE(s.status, 'draft') AS source_status,
           s.sales_order_id::text AS demand_id
      FROM sales_order_shipments s
      JOIN sales_orders so
        ON so.id = s.sales_order_id
       AND so.tenant_id = s.tenant_id
     WHERE s.tenant_id = $1
       AND s.ship_from_location_id IS NOT NULL
       AND COALESCE(s.status, 'draft') <> 'canceled'
       AND ($2::uuid IS NULL OR so.warehouse_id = $2::uuid)
  ),
  combined AS (
    SELECT * FROM reservation_refs
    UNION ALL
    SELECT * FROM shipment_refs
  )
`;

const nonSellableFlowCountSql = `
  ${nonSellableFlowRefsCte}
  SELECT COUNT(*)::int AS count
    FROM combined c
    JOIN locations l
      ON l.id = c.location_id
     AND l.tenant_id = c.tenant_id
   WHERE l.is_sellable = false
`;

const nonSellableFlowRowsSql = `
  ${nonSellableFlowRefsCte}
  SELECT c.source_type,
         c.source_id,
         c.source_status,
         c.demand_id,
         c.warehouse_id,
         c.location_id,
         l.code AS location_code,
         l.local_code AS location_local_code,
         l.role AS location_role,
         l.is_sellable
    FROM combined c
    JOIN locations l
      ON l.id = c.location_id
     AND l.tenant_id = c.tenant_id
   WHERE l.is_sellable = false
   ORDER BY c.source_type, c.source_id
   LIMIT $3
`;

const salesOrderScopeMismatchCte = `
  WITH reservation_scope_mismatch AS (
    SELECT 'reservation'::text AS source_type,
           r.id::text AS source_id,
           so.id::text AS sales_order_id,
           so.warehouse_id AS sales_order_warehouse_id,
           r.warehouse_id AS flow_warehouse_id,
           l.warehouse_id AS location_warehouse_id,
           r.location_id,
           l.code AS location_code,
           l.local_code AS location_local_code
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
       AND ($2::uuid IS NULL OR so.warehouse_id = $2::uuid)
       AND (
         so.warehouse_id IS DISTINCT FROM r.warehouse_id
         OR so.warehouse_id IS DISTINCT FROM l.warehouse_id
       )
  ),
  shipment_scope_mismatch AS (
    SELECT 'shipment'::text AS source_type,
           s.id::text AS source_id,
           so.id::text AS sales_order_id,
           so.warehouse_id AS sales_order_warehouse_id,
           l.warehouse_id AS flow_warehouse_id,
           l.warehouse_id AS location_warehouse_id,
           s.ship_from_location_id AS location_id,
           l.code AS location_code,
           l.local_code AS location_local_code
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
       AND ($2::uuid IS NULL OR so.warehouse_id = $2::uuid)
       AND (
         so.warehouse_id IS NULL
         OR l.warehouse_id IS NULL
         OR so.warehouse_id IS DISTINCT FROM l.warehouse_id
       )
  ),
  combined AS (
    SELECT * FROM reservation_scope_mismatch
    UNION ALL
    SELECT * FROM shipment_scope_mismatch
  )
`;

const salesOrderScopeMismatchCountSql = `
  ${salesOrderScopeMismatchCte}
  SELECT COUNT(*)::int AS count
    FROM combined
`;

const salesOrderScopeMismatchRowsSql = `
  ${salesOrderScopeMismatchCte}
  SELECT source_type,
         source_id,
         sales_order_id,
         sales_order_warehouse_id,
         flow_warehouse_id,
         location_warehouse_id,
         location_id,
         location_code,
         location_local_code
    FROM combined
   ORDER BY source_type, source_id
   LIMIT $3
`;

const atpOversellSellableCte = `
  WITH sellable_totals AS (
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
       AND ($2::uuid IS NULL OR l.warehouse_id = $2::uuid)
     GROUP BY b.tenant_id, l.warehouse_id, b.item_id, b.uom
  )
`;

const atpOversellCountSql = `
  ${atpOversellSellableCte}
  SELECT COUNT(*)::int AS count
    FROM sellable_totals
   WHERE (reserved_qty + allocated_qty) - on_hand_qty > 0.000001
`;

const atpOversellRowsSql = `
  ${atpOversellSellableCte}
  SELECT tenant_id,
         warehouse_id,
         item_id,
         uom,
         on_hand_qty,
         reserved_qty,
         allocated_qty,
         (reserved_qty + allocated_qty)::numeric AS committed_qty,
         ((reserved_qty + allocated_qty) - on_hand_qty)::numeric AS oversell_qty
    FROM sellable_totals
   WHERE (reserved_qty + allocated_qty) - on_hand_qty > 0.000001
   ORDER BY ((reserved_qty + allocated_qty) - on_hand_qty) DESC, warehouse_id, item_id, uom
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

const workOrderCostConservationCte = `
  WITH posted_executions AS (
    SELECT e.id,
           e.tenant_id,
           e.work_order_id,
           e.production_movement_id
      FROM work_order_executions e
     WHERE e.tenant_id = $1
       AND e.status = 'posted'
       AND e.production_movement_id IS NOT NULL
       AND (
         $2::uuid IS NULL
         OR EXISTS (
           SELECT 1
             FROM inventory_movement_lines iml
             JOIN locations l
               ON l.id = iml.location_id
              AND l.tenant_id = iml.tenant_id
            WHERE iml.tenant_id = e.tenant_id
              AND iml.movement_id = e.production_movement_id
              AND l.warehouse_id = $2::uuid
         )
       )
  ),
  component_cost AS (
    SELECT clc.wip_execution_id,
           COALESCE(SUM(clc.extended_cost), 0)::numeric AS total_component_cost
      FROM cost_layer_consumptions clc
      JOIN posted_executions pe
        ON pe.id = clc.wip_execution_id
       AND pe.tenant_id = clc.tenant_id
     WHERE clc.consumption_type = 'production_input'
     GROUP BY clc.wip_execution_id
  ),
  movement_cost AS (
    SELECT iml.movement_id,
           COALESCE(
             SUM(
               CASE
                 WHEN COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) > 0
                  AND lower(COALESCE(iml.reason_code, '')) NOT IN ('scrap', 'work_order_scrap', 'reject', 'work_order_reject')
                 THEN COALESCE(
                   iml.extended_cost,
                   COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) * COALESCE(iml.unit_cost, 0)
                 )
                 ELSE 0
               END
             ),
             0
           )::numeric AS total_fg_cost,
           COALESCE(
             SUM(
               CASE
                 WHEN COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) > 0
                  AND lower(COALESCE(iml.reason_code, '')) IN ('scrap', 'work_order_scrap', 'reject', 'work_order_reject')
                 THEN COALESCE(
                   iml.extended_cost,
                   COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) * COALESCE(iml.unit_cost, 0)
                 )
                 ELSE 0
               END
             ),
             0
           )::numeric AS scrap_cost
      FROM inventory_movement_lines iml
      JOIN posted_executions pe
        ON pe.production_movement_id = iml.movement_id
       AND pe.tenant_id = iml.tenant_id
     GROUP BY iml.movement_id
  ),
  combined AS (
    SELECT pe.tenant_id,
           pe.work_order_id,
           pe.id AS work_order_execution_id,
           pe.production_movement_id,
           COALESCE(cc.total_component_cost, 0)::numeric AS total_component_cost,
           COALESCE(mc.total_fg_cost, 0)::numeric AS total_fg_cost,
           COALESCE(mc.scrap_cost, 0)::numeric AS scrap_cost,
           (
             COALESCE(cc.total_component_cost, 0)
             - COALESCE(mc.total_fg_cost, 0)
             - COALESCE(mc.scrap_cost, 0)
           )::numeric AS difference
      FROM posted_executions pe
      LEFT JOIN component_cost cc
        ON cc.wip_execution_id = pe.id
      LEFT JOIN movement_cost mc
        ON mc.movement_id = pe.production_movement_id
  )
`;

const workOrderCostConservationCountSql = `
  ${workOrderCostConservationCte}
  SELECT COUNT(*)::int AS count
    FROM combined
   WHERE ABS(difference) > 0.000001
`;

const workOrderCostConservationRowsSql = `
  ${workOrderCostConservationCte}
  SELECT tenant_id,
         work_order_id,
         work_order_execution_id,
         production_movement_id,
         total_component_cost,
         total_fg_cost,
         scrap_cost,
         difference
    FROM combined
   WHERE ABS(difference) > 0.000001
   ORDER BY ABS(difference) DESC, work_order_execution_id
   LIMIT $3
`;

const workOrderProductionLinkIntegrityCountSql = `
  WITH posted AS (
    SELECT e.id AS work_order_execution_id,
           e.work_order_id,
           e.consumption_movement_id,
           e.production_movement_id
      FROM work_order_executions e
     WHERE e.tenant_id = $1
       AND e.status = 'posted'
  ),
  linked AS (
    SELECT p.work_order_execution_id,
           p.work_order_id,
           p.consumption_movement_id,
           p.production_movement_id,
           issue.id AS issue_id,
           issue.movement_type AS issue_type,
           issue.status AS issue_status,
           issue.source_type AS issue_source_type,
           issue.source_id AS issue_source_id,
           prod.id AS production_id,
           prod.movement_type AS production_type,
           prod.status AS production_status,
           prod.source_type AS production_source_type,
           prod.source_id AS production_source_id
      FROM posted p
      LEFT JOIN inventory_movements issue
        ON issue.id = p.consumption_movement_id
       AND issue.tenant_id = $1
      LEFT JOIN inventory_movements prod
        ON prod.id = p.production_movement_id
       AND prod.tenant_id = $1
  )
  SELECT COUNT(*)::int AS count
    FROM linked
   WHERE consumption_movement_id IS NULL
      OR production_movement_id IS NULL
      OR issue_id IS NULL
      OR production_id IS NULL
      OR issue_status <> 'posted'
      OR production_status <> 'posted'
      OR issue_type <> 'issue'
      OR production_type <> 'receive'
      OR issue_source_type <> 'work_order_batch_post_issue'
      OR production_source_type <> 'work_order_batch_post_completion'
      OR issue_source_id IS DISTINCT FROM work_order_execution_id::text
      OR production_source_id IS DISTINCT FROM work_order_execution_id::text
`;

const workOrderProductionLinkIntegrityRowsSql = `
  WITH posted AS (
    SELECT e.id AS work_order_execution_id,
           e.work_order_id,
           e.consumption_movement_id,
           e.production_movement_id
      FROM work_order_executions e
     WHERE e.tenant_id = $1
       AND e.status = 'posted'
  ),
  linked AS (
    SELECT p.work_order_execution_id,
           p.work_order_id,
           p.consumption_movement_id,
           p.production_movement_id,
           issue.id AS issue_id,
           issue.movement_type AS issue_type,
           issue.status AS issue_status,
           issue.source_type AS issue_source_type,
           issue.source_id AS issue_source_id,
           prod.id AS production_id,
           prod.movement_type AS production_type,
           prod.status AS production_status,
           prod.source_type AS production_source_type,
           prod.source_id AS production_source_id
      FROM posted p
      LEFT JOIN inventory_movements issue
        ON issue.id = p.consumption_movement_id
       AND issue.tenant_id = $1
      LEFT JOIN inventory_movements prod
        ON prod.id = p.production_movement_id
       AND prod.tenant_id = $1
  )
  SELECT work_order_execution_id,
         work_order_id,
         consumption_movement_id,
         production_movement_id,
         issue_type,
         issue_status,
         issue_source_type,
         issue_source_id,
         production_type,
         production_status,
         production_source_type,
         production_source_id
    FROM linked
   WHERE consumption_movement_id IS NULL
      OR production_movement_id IS NULL
      OR issue_id IS NULL
      OR production_id IS NULL
      OR issue_status <> 'posted'
      OR production_status <> 'posted'
      OR issue_type <> 'issue'
      OR production_type <> 'receive'
      OR issue_source_type <> 'work_order_batch_post_issue'
      OR production_source_type <> 'work_order_batch_post_completion'
      OR issue_source_id IS DISTINCT FROM work_order_execution_id::text
      OR production_source_id IS DISTINCT FROM work_order_execution_id::text
   ORDER BY work_order_execution_id
   LIMIT $2
`;

const qcLocationIntegrityCountSql = `
  WITH production_receipts AS (
    SELECT iml.movement_id,
           iml.location_id,
           iml.quantity_delta_canonical,
           l.role
      FROM inventory_movement_lines iml
      JOIN inventory_movements im
        ON im.id = iml.movement_id
       AND im.tenant_id = iml.tenant_id
      JOIN locations l
        ON l.id = iml.location_id
       AND l.tenant_id = iml.tenant_id
     WHERE iml.tenant_id = $1
       AND im.source_type = 'work_order_batch_post_completion'
       AND im.movement_type = 'receive'
       AND COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) > 0
       AND ($2::uuid IS NULL OR l.warehouse_id = $2::uuid)
  ),
  qc_transfer_outbound AS (
    SELECT iml.movement_id,
           iml.location_id,
           iml.quantity_delta_canonical,
           l.role
      FROM inventory_movement_lines iml
      JOIN inventory_movements im
        ON im.id = iml.movement_id
       AND im.tenant_id = iml.tenant_id
      JOIN locations l
        ON l.id = iml.location_id
       AND l.tenant_id = iml.tenant_id
     WHERE iml.tenant_id = $1
       AND im.source_type = 'qc_event'
       AND im.movement_type = 'transfer'
       AND COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) < 0
       AND ($2::uuid IS NULL OR l.warehouse_id = $2::uuid)
  )
  SELECT (
    (SELECT COUNT(*) FROM production_receipts WHERE role IS DISTINCT FROM 'QA')
    + (SELECT COUNT(*) FROM qc_transfer_outbound WHERE role IS DISTINCT FROM 'QA')
  )::int AS count
`;

const qcLocationIntegrityRowsSql = `
  WITH production_receipts AS (
    SELECT 'production_receipt'::text AS scope,
           im.id AS movement_id,
           im.source_id,
           iml.location_id,
           l.warehouse_id,
           l.role,
           COALESCE(iml.quantity_delta_canonical, iml.quantity_delta)::numeric AS quantity_delta
      FROM inventory_movement_lines iml
      JOIN inventory_movements im
        ON im.id = iml.movement_id
       AND im.tenant_id = iml.tenant_id
      JOIN locations l
        ON l.id = iml.location_id
       AND l.tenant_id = iml.tenant_id
     WHERE iml.tenant_id = $1
       AND im.source_type = 'work_order_batch_post_completion'
       AND im.movement_type = 'receive'
       AND COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) > 0
       AND ($2::uuid IS NULL OR l.warehouse_id = $2::uuid)
       AND l.role IS DISTINCT FROM 'QA'
  ),
  qc_transfer_outbound AS (
    SELECT 'qc_transfer_outbound'::text AS scope,
           im.id AS movement_id,
           im.source_id,
           iml.location_id,
           l.warehouse_id,
           l.role,
           COALESCE(iml.quantity_delta_canonical, iml.quantity_delta)::numeric AS quantity_delta
      FROM inventory_movement_lines iml
      JOIN inventory_movements im
        ON im.id = iml.movement_id
       AND im.tenant_id = iml.tenant_id
      JOIN locations l
        ON l.id = iml.location_id
       AND l.tenant_id = iml.tenant_id
     WHERE iml.tenant_id = $1
       AND im.source_type = 'qc_event'
       AND im.movement_type = 'transfer'
       AND COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) < 0
       AND ($2::uuid IS NULL OR l.warehouse_id = $2::uuid)
       AND l.role IS DISTINCT FROM 'QA'
  ),
  combined AS (
    SELECT * FROM production_receipts
    UNION ALL
    SELECT * FROM qc_transfer_outbound
  )
  SELECT scope,
         movement_id,
         source_id,
         location_id,
         warehouse_id,
         role,
         quantity_delta
    FROM combined
   ORDER BY scope, movement_id
   LIMIT $3
`;

const productionReceiptLocationValidityCountSql = `
  WITH production_receipts AS (
    SELECT iml.tenant_id,
           e.work_order_id,
           im.id AS movement_id,
           iml.location_id AS to_location_id,
           l.warehouse_id AS to_warehouse_id,
           l.role
      FROM inventory_movements im
      JOIN inventory_movement_lines iml
        ON iml.movement_id = im.id
       AND iml.tenant_id = im.tenant_id
      LEFT JOIN work_order_executions e
        ON e.id::text = im.source_id
       AND e.tenant_id = im.tenant_id
      JOIN locations l
        ON l.id = iml.location_id
       AND l.tenant_id = iml.tenant_id
     WHERE im.tenant_id = $1
       AND im.source_type = 'work_order_batch_post_completion'
       AND im.movement_type = 'receive'
       AND im.status = 'posted'
       AND COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) > 0
       AND ($2::uuid IS NULL OR l.warehouse_id = $2::uuid)
  )
  SELECT COUNT(*)::int AS count
    FROM production_receipts
   WHERE role IS DISTINCT FROM 'QA'
`;

const productionReceiptLocationValidityRowsSql = `
  WITH production_receipts AS (
    SELECT iml.tenant_id,
           e.work_order_id,
           im.id AS movement_id,
           iml.location_id AS to_location_id,
           l.warehouse_id AS to_warehouse_id,
           l.role
      FROM inventory_movements im
      JOIN inventory_movement_lines iml
        ON iml.movement_id = im.id
       AND iml.tenant_id = im.tenant_id
      LEFT JOIN work_order_executions e
        ON e.id::text = im.source_id
       AND e.tenant_id = im.tenant_id
      JOIN locations l
        ON l.id = iml.location_id
       AND l.tenant_id = iml.tenant_id
     WHERE im.tenant_id = $1
       AND im.source_type = 'work_order_batch_post_completion'
       AND im.movement_type = 'receive'
       AND im.status = 'posted'
       AND COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) > 0
       AND ($2::uuid IS NULL OR l.warehouse_id = $2::uuid)
       AND l.role IS DISTINCT FROM 'QA'
  )
  SELECT tenant_id AS "tenantId",
         work_order_id AS "workOrderId",
         movement_id AS "movementId",
         to_location_id AS "toLocationId",
         to_warehouse_id AS "toWarehouseId",
         role
    FROM production_receipts
   ORDER BY movement_id, to_location_id
   LIMIT $3
`;

const workOrderComponentQtyExactMatchCte = `
  WITH posted_executions AS (
    SELECT e.id AS work_order_execution_id,
           e.work_order_id,
           e.consumption_movement_id,
           e.production_movement_id,
           w.output_item_id,
           COALESCE(w.bom_version_id, active_version.id) AS bom_version_id
      FROM work_order_executions e
      JOIN work_orders w
        ON w.id = e.work_order_id
       AND w.tenant_id = e.tenant_id
      LEFT JOIN LATERAL (
        SELECT bv.id
          FROM bom_versions bv
         WHERE bv.tenant_id = e.tenant_id
           AND bv.bom_id = w.bom_id
           AND bv.status = 'active'
         ORDER BY bv.version_number DESC, bv.created_at DESC, bv.id DESC
         LIMIT 1
      ) AS active_version ON true
     WHERE e.tenant_id = $1
       AND e.status = 'posted'
       AND e.consumption_movement_id IS NOT NULL
       AND e.production_movement_id IS NOT NULL
       AND (
         $2::uuid IS NULL
         OR EXISTS (
           SELECT 1
             FROM inventory_movement_lines iml
             JOIN locations l
               ON l.id = iml.location_id
              AND l.tenant_id = iml.tenant_id
            WHERE iml.tenant_id = e.tenant_id
              AND (iml.movement_id = e.consumption_movement_id OR iml.movement_id = e.production_movement_id)
              AND l.warehouse_id = $2::uuid
         )
       )
  ),
  eligible_executions AS (
    SELECT pe.*
      FROM posted_executions pe
     WHERE pe.bom_version_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
           FROM inventory_movement_lines iml
          WHERE iml.tenant_id = $1
            AND iml.movement_id = pe.consumption_movement_id
            AND LOWER(COALESCE(iml.reason_code, '')) = 'work_order_backflush_override'
       )
  ),
  produced_qty AS (
    SELECT ee.work_order_execution_id,
           SUM(COALESCE(iml.quantity_delta_canonical, iml.quantity_delta))::numeric AS produced_qty_canonical
      FROM eligible_executions ee
      JOIN inventory_movement_lines iml
        ON iml.tenant_id = $1
       AND iml.movement_id = ee.production_movement_id
       AND iml.item_id = ee.output_item_id
     WHERE COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) > 0
       AND LOWER(COALESCE(iml.reason_code, '')) NOT IN ('scrap', 'work_order_scrap', 'reject', 'work_order_reject')
     GROUP BY ee.work_order_execution_id
  ),
  yield_basis AS (
    SELECT ee.work_order_execution_id,
           ee.work_order_id,
           ee.consumption_movement_id,
           ee.bom_version_id,
           COALESCE(pq.produced_qty_canonical, 0)::numeric AS produced_qty_canonical,
           COALESCE(bv.yield_factor, 1)::numeric AS yield_factor,
           CASE
             WHEN LOWER(bv.yield_uom) = LOWER(COALESCE(oi.canonical_uom, bv.yield_uom))
               THEN bv.yield_quantity::numeric
             WHEN direct.factor IS NOT NULL
               THEN bv.yield_quantity::numeric * direct.factor::numeric
             WHEN reverse.factor IS NOT NULL
               THEN bv.yield_quantity::numeric / reverse.factor::numeric
             ELSE NULL::numeric
           END AS yield_qty_canonical
      FROM eligible_executions ee
      JOIN bom_versions bv
        ON bv.id = ee.bom_version_id
       AND bv.tenant_id = $1
      LEFT JOIN items oi
        ON oi.id = ee.output_item_id
       AND oi.tenant_id = $1
      LEFT JOIN uom_conversions direct
        ON direct.tenant_id = $1
       AND direct.item_id = ee.output_item_id
       AND LOWER(direct.from_uom) = LOWER(bv.yield_uom)
       AND LOWER(direct.to_uom) = LOWER(COALESCE(oi.canonical_uom, bv.yield_uom))
      LEFT JOIN uom_conversions reverse
        ON reverse.tenant_id = $1
       AND reverse.item_id = ee.output_item_id
       AND LOWER(reverse.from_uom) = LOWER(COALESCE(oi.canonical_uom, bv.yield_uom))
       AND LOWER(reverse.to_uom) = LOWER(bv.yield_uom)
      LEFT JOIN produced_qty pq
        ON pq.work_order_execution_id = ee.work_order_execution_id
  ),
  expected_component_qty AS (
    SELECT yb.work_order_execution_id,
           yb.work_order_id,
           bvl.component_item_id,
           SUM(
             (
               yb.produced_qty_canonical
               / NULLIF(yb.yield_qty_canonical * yb.yield_factor, 0)
             )
             * COALESCE(bvl.component_quantity_canonical, bvl.component_quantity::numeric)
             * (1 + COALESCE(bvl.scrap_factor, 0)::numeric)
           )::numeric AS required_qty
      FROM yield_basis yb
      JOIN bom_version_lines bvl
        ON bvl.tenant_id = $1
       AND bvl.bom_version_id = yb.bom_version_id
     WHERE yb.produced_qty_canonical > 0
       AND yb.yield_qty_canonical IS NOT NULL
       AND yb.yield_qty_canonical > 0
     GROUP BY yb.work_order_execution_id, yb.work_order_id, bvl.component_item_id
  ),
  issued_component_qty AS (
    SELECT yb.work_order_execution_id,
           yb.work_order_id,
           iml.item_id AS component_item_id,
           SUM(ABS(COALESCE(iml.quantity_delta_canonical, iml.quantity_delta)))::numeric AS issued_qty
      FROM yield_basis yb
      JOIN inventory_movement_lines iml
        ON iml.tenant_id = $1
       AND iml.movement_id = yb.consumption_movement_id
     WHERE COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) < 0
     GROUP BY yb.work_order_execution_id, yb.work_order_id, iml.item_id
  ),
  combined AS (
    SELECT COALESCE(expected.work_order_id, issued.work_order_id) AS work_order_id,
           COALESCE(expected.work_order_execution_id, issued.work_order_execution_id) AS work_order_execution_id,
           COALESCE(expected.component_item_id, issued.component_item_id) AS component_item_id,
           expected.required_qty,
           issued.issued_qty,
           (COALESCE(issued.issued_qty, 0) - COALESCE(expected.required_qty, 0))::numeric AS delta_qty
      FROM expected_component_qty expected
      FULL OUTER JOIN issued_component_qty issued
        ON issued.work_order_execution_id = expected.work_order_execution_id
       AND issued.component_item_id = expected.component_item_id
  )
`;

const workOrderComponentQtyExactMatchCountSql = `
  ${workOrderComponentQtyExactMatchCte}
  SELECT COUNT(*)::int AS count
    FROM combined
   WHERE required_qty IS NULL
      OR issued_qty IS NULL
      OR ABS(delta_qty) > 0.000001
`;

const workOrderComponentQtyExactMatchRowsSql = `
  ${workOrderComponentQtyExactMatchCte}
  SELECT work_order_id AS "workOrderId",
         work_order_execution_id AS "workOrderExecutionId",
         component_item_id AS "componentItemId",
         required_qty AS "requiredQty",
         issued_qty AS "issuedQty",
         delta_qty AS "deltaQty"
    FROM combined
   WHERE required_qty IS NULL
      OR issued_qty IS NULL
      OR ABS(delta_qty) > 0.000001
   ORDER BY ABS(delta_qty) DESC NULLS LAST, work_order_execution_id, component_item_id
   LIMIT $3
`;

const productionFifoLayerContinuityCte = `
  WITH issue_scopes AS (
    SELECT e.work_order_id,
           e.id AS work_order_execution_id,
           im.id AS movement_id,
           iml.item_id,
           iml.location_id,
           l.warehouse_id,
           SUM(ABS(COALESCE(iml.quantity_delta_canonical, iml.quantity_delta)))::numeric AS issue_qty,
           SUM(
             ABS(
               COALESCE(
                 iml.extended_cost,
                 COALESCE(iml.unit_cost, 0) * COALESCE(iml.quantity_delta_canonical, iml.quantity_delta)
               )
             )
           )::numeric AS issue_cost
      FROM inventory_movements im
      JOIN inventory_movement_lines iml
        ON iml.movement_id = im.id
       AND iml.tenant_id = im.tenant_id
      JOIN locations l
        ON l.id = iml.location_id
       AND l.tenant_id = iml.tenant_id
      LEFT JOIN work_order_executions e
        ON e.id::text = im.source_id
       AND e.tenant_id = im.tenant_id
     WHERE im.tenant_id = $1
       AND im.status = 'posted'
       AND im.source_type = 'work_order_batch_post_issue'
       AND im.movement_type = 'issue'
       AND COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) < 0
       AND ($2::uuid IS NULL OR l.warehouse_id = $2::uuid)
     GROUP BY e.work_order_id, e.id, im.id, iml.item_id, iml.location_id, l.warehouse_id
  ),
  consumption_scopes AS (
    SELECT e.work_order_id,
           e.id AS work_order_execution_id,
           clc.movement_id,
           cl.item_id,
           cl.location_id,
           l.warehouse_id,
           SUM(clc.consumed_quantity)::numeric AS consumed_qty,
           SUM(clc.extended_cost)::numeric AS consumed_cost,
           COUNT(*) FILTER (WHERE cl.id IS NULL)::int AS missing_layer_refs
      FROM cost_layer_consumptions clc
      JOIN inventory_movements im
        ON im.id = clc.movement_id
       AND im.tenant_id = clc.tenant_id
      LEFT JOIN work_order_executions e
        ON e.id::text = im.source_id
       AND e.tenant_id = im.tenant_id
      LEFT JOIN inventory_cost_layers cl
        ON cl.id = clc.cost_layer_id
       AND cl.tenant_id = clc.tenant_id
      LEFT JOIN locations l
        ON l.id = cl.location_id
       AND l.tenant_id = cl.tenant_id
     WHERE clc.tenant_id = $1
       AND clc.consumption_type = 'production_input'
       AND im.source_type = 'work_order_batch_post_issue'
       AND ($2::uuid IS NULL OR l.warehouse_id = $2::uuid)
     GROUP BY e.work_order_id, e.id, clc.movement_id, cl.item_id, cl.location_id, l.warehouse_id
  ),
  combined AS (
    SELECT COALESCE(issue.work_order_id, consumption.work_order_id) AS work_order_id,
           COALESCE(issue.work_order_execution_id, consumption.work_order_execution_id) AS work_order_execution_id,
           COALESCE(issue.movement_id, consumption.movement_id) AS movement_id,
           COALESCE(issue.item_id, consumption.item_id) AS item_id,
           COALESCE(issue.location_id, consumption.location_id) AS location_id,
           COALESCE(issue.warehouse_id, consumption.warehouse_id) AS warehouse_id,
           issue.issue_qty,
           issue.issue_cost,
           consumption.consumed_qty,
           consumption.consumed_cost,
           COALESCE(consumption.missing_layer_refs, 0)::int AS missing_layer_refs,
           (COALESCE(consumption.consumed_qty, 0) - COALESCE(issue.issue_qty, 0))::numeric AS delta_qty,
           (COALESCE(consumption.consumed_cost, 0) - COALESCE(issue.issue_cost, 0))::numeric AS delta_cost
      FROM issue_scopes issue
      FULL OUTER JOIN consumption_scopes consumption
        ON consumption.movement_id = issue.movement_id
       AND consumption.item_id = issue.item_id
       AND consumption.location_id = issue.location_id
  )
`;

const productionFifoLayerContinuityCountSql = `
  ${productionFifoLayerContinuityCte}
  SELECT COUNT(*)::int AS count
    FROM combined
   WHERE issue_qty IS NULL
      OR consumed_qty IS NULL
      OR ABS(delta_qty) > 0.000001
      OR ABS(delta_cost) > 0.000001
      OR missing_layer_refs > 0
`;

const productionFifoLayerContinuityRowsSql = `
  ${productionFifoLayerContinuityCte}
  SELECT work_order_id AS "workOrderId",
         work_order_execution_id AS "workOrderExecutionId",
         movement_id AS "movementId",
         item_id AS "itemId",
         location_id AS "locationId",
         warehouse_id AS "warehouseId",
         issue_qty AS "issueQty",
         consumed_qty AS "consumedQty",
         delta_qty AS "deltaQty",
         issue_cost AS "issueCost",
         consumed_cost AS "consumedCost",
         delta_cost AS "deltaCost",
         missing_layer_refs AS "missingLayerRefs"
    FROM combined
   WHERE issue_qty IS NULL
      OR consumed_qty IS NULL
      OR ABS(delta_qty) > 0.000001
      OR ABS(delta_cost) > 0.000001
      OR missing_layer_refs > 0
   ORDER BY ABS(delta_qty) DESC NULLS LAST, ABS(delta_cost) DESC NULLS LAST, movement_id
   LIMIT $3
`;

const warehouseDefaultCompletenessCte = `
  WITH expected_warehouses AS (
    SELECT DISTINCT expected.warehouse_code
      FROM unnest($3::text[]) AS expected(warehouse_code)
  ),
  expected_defaults AS (
    SELECT expected.warehouse_code,
           expected.role,
           expected.local_code
      FROM unnest($4::text[], $5::text[], $6::text[]) AS expected(warehouse_code, role, local_code)
  ),
  warehouse_roots AS (
    SELECT l.id AS warehouse_id,
           l.code AS warehouse_code
      FROM locations l
     WHERE l.tenant_id = $1
       AND l.type = 'warehouse'
       AND l.parent_location_id IS NULL
       AND l.active = true
       AND ($2::uuid IS NULL OR l.id = $2::uuid)
  ),
  missing_warehouse_roots AS (
    SELECT $1::uuid AS tenant_id,
           NULL::uuid AS warehouse_id,
           ew.warehouse_code,
           NULL::text AS role,
           NULL::text AS expected_local_code,
           'MISSING_WAREHOUSE_ROOT'::text AS issue_code
      FROM expected_warehouses ew
      LEFT JOIN warehouse_roots wr
        ON wr.warehouse_code = ew.warehouse_code
     WHERE wr.warehouse_id IS NULL
       AND $2::uuid IS NULL
  ),
  missing_default_mappings AS (
    SELECT $1::uuid AS tenant_id,
           wr.warehouse_id,
           ed.warehouse_code,
           ed.role,
           ed.local_code AS expected_local_code,
           'MISSING_DEFAULT_MAPPING'::text AS issue_code
      FROM expected_defaults ed
      JOIN warehouse_roots wr
        ON wr.warehouse_code = ed.warehouse_code
      LEFT JOIN warehouse_default_location wdl
        ON wdl.tenant_id = $1
       AND wdl.warehouse_id = wr.warehouse_id
       AND wdl.role = ed.role
     WHERE wdl.location_id IS NULL
  ),
  combined AS (
    SELECT * FROM missing_warehouse_roots
    UNION ALL
    SELECT * FROM missing_default_mappings
  )
`;

const warehouseDefaultCompletenessCountSql = `
  ${warehouseDefaultCompletenessCte}
  SELECT COUNT(*)::int AS count
    FROM combined
`;

const warehouseDefaultCompletenessRowsSql = `
  ${warehouseDefaultCompletenessCte}
  SELECT tenant_id,
         warehouse_id,
         warehouse_code,
         role,
         expected_local_code,
         issue_code
    FROM combined
   ORDER BY issue_code, warehouse_code, role
   LIMIT $7
`;

const unmatchedCostLayersCte = `
  WITH active_layers AS (
    SELECT cl.tenant_id,
           l.warehouse_id,
           cl.item_id,
           cl.location_id,
           cl.uom,
           COUNT(*)::int AS layer_count,
           COALESCE(SUM(cl.remaining_quantity), 0)::numeric AS remaining_qty
      FROM inventory_cost_layers cl
      JOIN locations l
        ON l.id = cl.location_id
       AND l.tenant_id = cl.tenant_id
     WHERE cl.tenant_id = $1
       AND cl.voided_at IS NULL
       AND cl.remaining_quantity > 0
       AND ($2::uuid IS NULL OR l.warehouse_id = $2::uuid)
     GROUP BY cl.tenant_id, l.warehouse_id, cl.item_id, cl.location_id, cl.uom
  ),
  on_hand AS (
    SELECT oh.tenant_id,
           oh.warehouse_id,
           oh.item_id,
           oh.location_id,
           oh.uom,
           COALESCE(SUM(oh.on_hand_qty), 0)::numeric AS on_hand_qty
      FROM inventory_on_hand_location_v oh
     WHERE oh.tenant_id = $1
       AND ($2::uuid IS NULL OR oh.warehouse_id = $2::uuid)
     GROUP BY oh.tenant_id, oh.warehouse_id, oh.item_id, oh.location_id, oh.uom
  ),
  unmatched AS (
    SELECT a.tenant_id,
           a.warehouse_id,
           a.item_id,
           a.location_id,
           a.uom,
           a.layer_count,
           a.remaining_qty,
           COALESCE(o.on_hand_qty, 0)::numeric AS on_hand_qty
      FROM active_layers a
      LEFT JOIN on_hand o
        ON o.tenant_id = a.tenant_id
       AND o.warehouse_id = a.warehouse_id
       AND o.item_id = a.item_id
       AND o.location_id = a.location_id
       AND o.uom = a.uom
     WHERE COALESCE(o.on_hand_qty, 0) <= 0.000001
  )
`;

const unmatchedCostLayersCountSql = `
  ${unmatchedCostLayersCte}
  SELECT COUNT(*)::int AS count
    FROM unmatched
`;

const unmatchedCostLayersRowsSql = `
  ${unmatchedCostLayersCte}
  SELECT u.tenant_id,
         u.warehouse_id,
         u.item_id,
         i.sku AS item_sku,
         u.location_id,
         l.code AS location_code,
         l.local_code AS location_local_code,
         l.role AS location_role,
         u.uom,
         u.layer_count,
         u.remaining_qty,
         u.on_hand_qty
    FROM unmatched u
    LEFT JOIN items i
      ON i.id = u.item_id
     AND i.tenant_id = u.tenant_id
    LEFT JOIN locations l
      ON l.id = u.location_id
     AND l.tenant_id = u.tenant_id
   ORDER BY u.remaining_qty DESC, u.warehouse_id, u.item_id, u.location_id, u.uom
   LIMIT $3
`;

const negativeOnHandCountSql = `
  SELECT COUNT(*)::int AS count
    FROM inventory_on_hand_location_v oh
   WHERE oh.tenant_id = $1
     AND ($2::uuid IS NULL OR oh.warehouse_id = $2::uuid)
     AND oh.on_hand_qty < -0.000001
`;

const negativeOnHandRowsSql = `
  SELECT oh.tenant_id,
         oh.warehouse_id,
         oh.location_id,
         l.code AS location_code,
         l.local_code AS location_local_code,
         l.role AS location_role,
         oh.item_id,
         i.sku AS item_sku,
         oh.uom,
         oh.on_hand_qty,
         ABS(oh.on_hand_qty)::numeric AS deficit_qty
    FROM inventory_on_hand_location_v oh
    LEFT JOIN locations l
      ON l.id = oh.location_id
     AND l.tenant_id = oh.tenant_id
    LEFT JOIN items i
      ON i.id = oh.item_id
     AND i.tenant_id = oh.tenant_id
   WHERE oh.tenant_id = $1
     AND ($2::uuid IS NULL OR oh.warehouse_id = $2::uuid)
     AND oh.on_hand_qty < -0.000001
   ORDER BY oh.on_hand_qty ASC, oh.warehouse_id, oh.item_id, oh.location_id, oh.uom
   LIMIT $3
`;

const orphanedCostLayersCte = `
  WITH layer_scope AS (
    SELECT cl.id AS layer_id,
           cl.tenant_id,
           cl.item_id,
           cl.location_id,
           cl.uom,
           cl.source_type,
           cl.movement_id,
           cl.remaining_quantity,
           i.id AS item_id_for_tenant,
           i.sku AS item_sku_for_tenant,
           loc.id AS location_id_for_tenant,
           loc.code AS location_code_for_tenant,
           loc.local_code AS location_local_code_for_tenant,
           loc.role AS location_role_for_tenant,
           loc.warehouse_id AS warehouse_id_for_tenant,
           wh.id AS warehouse_root_id_for_tenant,
           wh.code AS warehouse_code_for_tenant,
           mv.id AS movement_id_for_tenant
      FROM inventory_cost_layers cl
      LEFT JOIN items i
        ON i.id = cl.item_id
       AND i.tenant_id = cl.tenant_id
      LEFT JOIN locations loc
        ON loc.id = cl.location_id
       AND loc.tenant_id = cl.tenant_id
      LEFT JOIN locations wh
        ON wh.id = loc.warehouse_id
       AND wh.tenant_id = cl.tenant_id
       AND wh.type = 'warehouse'
      LEFT JOIN inventory_movements mv
        ON mv.id = cl.movement_id
       AND mv.tenant_id = cl.tenant_id
     WHERE cl.tenant_id = $1
       AND cl.voided_at IS NULL
       AND ($2::uuid IS NULL OR loc.warehouse_id = $2::uuid)
  ),
  orphaned AS (
    SELECT tenant_id,
           layer_id,
           item_id,
           location_id,
           uom,
           source_type,
           movement_id,
           remaining_quantity,
           warehouse_id_for_tenant AS warehouse_id,
           warehouse_code_for_tenant AS warehouse_code,
           item_sku_for_tenant AS item_sku,
           location_code_for_tenant AS location_code,
           location_local_code_for_tenant AS location_local_code,
           location_role_for_tenant AS location_role,
           CASE
             WHEN item_id_for_tenant IS NULL THEN 'ITEM_TENANT_MISMATCH_OR_MISSING'
             WHEN location_id_for_tenant IS NULL THEN 'LOCATION_TENANT_MISMATCH_OR_MISSING'
             WHEN warehouse_id_for_tenant IS NULL THEN 'LOCATION_WAREHOUSE_MISSING'
             WHEN warehouse_root_id_for_tenant IS NULL THEN 'WAREHOUSE_ROOT_MISSING'
             WHEN movement_id IS NOT NULL AND movement_id_for_tenant IS NULL THEN 'MOVEMENT_TENANT_MISMATCH_OR_MISSING'
             ELSE NULL
           END AS issue_code
      FROM layer_scope
  )
`;

const orphanedCostLayersCountSql = `
  ${orphanedCostLayersCte}
  SELECT COUNT(*)::int AS count
    FROM orphaned
   WHERE issue_code IS NOT NULL
`;

const orphanedCostLayersRowsSql = `
  ${orphanedCostLayersCte}
  SELECT tenant_id,
         warehouse_id,
         warehouse_code,
         layer_id,
         item_id,
         item_sku,
         location_id,
         location_code,
         location_local_code,
         location_role,
         uom,
         source_type,
         movement_id,
         remaining_quantity,
         issue_code
    FROM orphaned
   WHERE issue_code IS NOT NULL
   ORDER BY issue_code, layer_id
   LIMIT $3
`;

const poLineClosedBlocksReceiptsCountSql = `
  SELECT COUNT(*)::int AS count
    FROM purchase_order_receipt_lines porl
    JOIN purchase_order_receipts por
      ON por.id = porl.purchase_order_receipt_id
     AND por.tenant_id = porl.tenant_id
    JOIN purchase_order_lines pol
      ON pol.id = porl.purchase_order_line_id
     AND pol.tenant_id = porl.tenant_id
    JOIN purchase_orders po
      ON po.id = por.purchase_order_id
     AND po.tenant_id = por.tenant_id
    LEFT JOIN locations ship
      ON ship.id = po.ship_to_location_id
     AND ship.tenant_id = po.tenant_id
    LEFT JOIN locations recv
      ON recv.id = po.receiving_location_id
     AND recv.tenant_id = po.tenant_id
   WHERE por.tenant_id = $1
     AND ($2::uuid IS NULL OR COALESCE(ship.warehouse_id, recv.warehouse_id) = $2::uuid)
     AND COALESCE(por.status, 'posted') <> 'voided'
     AND pol.status IN ('closed_short', 'cancelled')
     AND pol.closed_at IS NOT NULL
     AND por.received_at > pol.closed_at + INTERVAL '1 millisecond'
`;

const poLineClosedBlocksReceiptsRowsSql = `
  SELECT por.tenant_id,
         por.purchase_order_id,
         por.id AS purchase_order_receipt_id,
         por.received_at,
         pol.id AS purchase_order_line_id,
         pol.status AS line_status,
         pol.closed_at AS line_closed_at
    FROM purchase_order_receipt_lines porl
    JOIN purchase_order_receipts por
      ON por.id = porl.purchase_order_receipt_id
     AND por.tenant_id = porl.tenant_id
    JOIN purchase_order_lines pol
      ON pol.id = porl.purchase_order_line_id
     AND pol.tenant_id = porl.tenant_id
    JOIN purchase_orders po
      ON po.id = por.purchase_order_id
     AND po.tenant_id = por.tenant_id
    LEFT JOIN locations ship
      ON ship.id = po.ship_to_location_id
     AND ship.tenant_id = po.tenant_id
    LEFT JOIN locations recv
      ON recv.id = po.receiving_location_id
     AND recv.tenant_id = po.tenant_id
   WHERE por.tenant_id = $1
     AND ($2::uuid IS NULL OR COALESCE(ship.warehouse_id, recv.warehouse_id) = $2::uuid)
     AND COALESCE(por.status, 'posted') <> 'voided'
     AND pol.status IN ('closed_short', 'cancelled')
     AND pol.closed_at IS NOT NULL
     AND por.received_at > pol.closed_at + INTERVAL '1 millisecond'
   ORDER BY por.received_at DESC, por.id, pol.id
   LIMIT $3
`;

const poStatusConsistencyCte = `
  WITH received_totals AS (
    SELECT porl.purchase_order_line_id AS line_id,
           COALESCE(SUM(porl.quantity_received), 0)::numeric AS qty_received
      FROM purchase_order_receipt_lines porl
      JOIN purchase_order_receipts por
        ON por.id = porl.purchase_order_receipt_id
       AND por.tenant_id = porl.tenant_id
     WHERE por.tenant_id = $1
       AND COALESCE(por.status, 'posted') <> 'voided'
     GROUP BY porl.purchase_order_line_id
  ),
  line_rollup AS (
    SELECT pol.purchase_order_id,
           COUNT(*)::int AS total_lines,
           COUNT(*) FILTER (WHERE pol.status = 'open')::int AS open_lines,
           COUNT(*) FILTER (WHERE pol.status = 'complete')::int AS complete_lines,
           COUNT(*) FILTER (WHERE pol.status IN ('closed_short', 'cancelled'))::int AS closed_lines,
           COUNT(*) FILTER (WHERE COALESCE(rt.qty_received, 0) > 0.000001)::int AS received_lines,
           COALESCE(SUM(COALESCE(rt.qty_received, 0)), 0)::numeric AS total_received_qty
      FROM purchase_order_lines pol
      LEFT JOIN received_totals rt
        ON rt.line_id = pol.id
     WHERE pol.tenant_id = $1
     GROUP BY pol.purchase_order_id
  ),
  scoped AS (
    SELECT po.id AS purchase_order_id,
           po.status,
           lr.total_lines,
           lr.open_lines,
           lr.complete_lines,
           lr.closed_lines,
           lr.received_lines,
           lr.total_received_qty,
           COALESCE(ship.warehouse_id, recv.warehouse_id) AS warehouse_id
      FROM purchase_orders po
      JOIN line_rollup lr
        ON lr.purchase_order_id = po.id
      LEFT JOIN locations ship
        ON ship.id = po.ship_to_location_id
       AND ship.tenant_id = po.tenant_id
      LEFT JOIN locations recv
        ON recv.id = po.receiving_location_id
       AND recv.tenant_id = po.tenant_id
     WHERE po.tenant_id = $1
       AND ($2::uuid IS NULL OR COALESCE(ship.warehouse_id, recv.warehouse_id) = $2::uuid)
  ),
  mismatch AS (
    SELECT purchase_order_id,
           status,
           total_lines,
           open_lines,
           complete_lines,
           closed_lines,
           received_lines,
           total_received_qty,
           warehouse_id,
           CASE
             WHEN status = 'received' AND (open_lines > 0 OR closed_lines > 0) THEN 'PO_STATUS_RECEIVED_REQUIRES_ALL_COMPLETE'
             WHEN status = 'closed' AND open_lines > 0 THEN 'PO_STATUS_CLOSED_REQUIRES_NO_OPEN_LINES'
             WHEN status = 'partially_received' AND (total_received_qty <= 0 OR open_lines = 0) THEN 'PO_STATUS_PARTIAL_REQUIRES_RECEIPTS_AND_OPEN_LINES'
             WHEN status = 'approved' AND total_received_qty > 0.000001 THEN 'PO_STATUS_APPROVED_WITH_RECEIPTS'
             WHEN status = 'canceled' AND total_received_qty > 0.000001 THEN 'PO_STATUS_CANCELED_WITH_RECEIPTS'
             ELSE NULL
           END AS issue_code
      FROM scoped
  )
`;

const poStatusConsistencyCountSql = `
  ${poStatusConsistencyCte}
  SELECT COUNT(*)::int AS count
    FROM mismatch
   WHERE issue_code IS NOT NULL
`;

const poStatusConsistencyRowsSql = `
  ${poStatusConsistencyCte}
  SELECT purchase_order_id,
         status,
         total_lines,
         open_lines,
         complete_lines,
         closed_lines,
         received_lines,
         total_received_qty,
         warehouse_id,
         issue_code
    FROM mismatch
   WHERE issue_code IS NOT NULL
   ORDER BY purchase_order_id
   LIMIT $3
`;

const poReceivedQtyIntegrityCte = `
  WITH line_totals AS (
    SELECT pol.id AS purchase_order_line_id,
           pol.purchase_order_id,
           pol.item_id,
           pol.quantity_ordered,
           COALESCE(SUM(
             CASE
               WHEN COALESCE(por.status, 'posted') <> 'voided' THEN porl.quantity_received
               ELSE 0
             END
           ), 0)::numeric AS total_received_qty,
           BOOL_OR(
             CASE
               WHEN COALESCE(por.status, 'posted') <> 'voided' THEN COALESCE(porl.over_receipt_approved, false)
               ELSE false
             END
           ) AS has_over_receipt_approval
      FROM purchase_order_lines pol
      LEFT JOIN purchase_order_receipt_lines porl
        ON porl.purchase_order_line_id = pol.id
       AND porl.tenant_id = pol.tenant_id
      LEFT JOIN purchase_order_receipts por
        ON por.id = porl.purchase_order_receipt_id
       AND por.tenant_id = porl.tenant_id
     WHERE pol.tenant_id = $1
     GROUP BY pol.id, pol.purchase_order_id, pol.item_id, pol.quantity_ordered
  ),
  scoped AS (
    SELECT lt.purchase_order_line_id,
           lt.purchase_order_id,
           lt.item_id,
           lt.quantity_ordered,
           lt.total_received_qty,
           lt.has_over_receipt_approval,
           COALESCE(ship.warehouse_id, recv.warehouse_id) AS warehouse_id
      FROM line_totals lt
      JOIN purchase_orders po
        ON po.id = lt.purchase_order_id
       AND po.tenant_id = $1
      LEFT JOIN locations ship
        ON ship.id = po.ship_to_location_id
       AND ship.tenant_id = po.tenant_id
      LEFT JOIN locations recv
        ON recv.id = po.receiving_location_id
       AND recv.tenant_id = po.tenant_id
     WHERE ($2::uuid IS NULL OR COALESCE(ship.warehouse_id, recv.warehouse_id) = $2::uuid)
  ),
  violations AS (
    SELECT purchase_order_line_id,
           purchase_order_id,
           item_id,
           quantity_ordered,
           total_received_qty,
           has_over_receipt_approval,
           warehouse_id,
           CASE
             WHEN total_received_qty < -0.000001 THEN 'RECEIVED_QTY_NEGATIVE'
             WHEN total_received_qty - quantity_ordered > 0.000001
               AND has_over_receipt_approval IS NOT TRUE
               THEN 'OVER_RECEIPT_NOT_APPROVED'
             ELSE NULL
           END AS issue_code
      FROM scoped
  )
`;

const poReceivedQtyIntegrityCountSql = `
  ${poReceivedQtyIntegrityCte}
  SELECT COUNT(*)::int AS count
    FROM violations
   WHERE issue_code IS NOT NULL
`;

const poReceivedQtyIntegrityRowsSql = `
  ${poReceivedQtyIntegrityCte}
  SELECT purchase_order_id,
         purchase_order_line_id,
         item_id,
         warehouse_id,
         quantity_ordered,
         total_received_qty,
         has_over_receipt_approval,
         issue_code
    FROM violations
   WHERE issue_code IS NOT NULL
   ORDER BY purchase_order_id, purchase_order_line_id
   LIMIT $3
`;

let exitCode = 0;
const invariantCounts = {};

try {
  const topology = await loadWarehouseTopology();
  const topologyWarehouseCodes = topology.warehouses.map((warehouse) => warehouse.code);
  const topologyDefaultWarehouseCodes = topology.defaults.map((entry) => entry.warehouseCode);
  const topologyDefaultRoles = topology.defaults.map((entry) => entry.role);
  const topologyDefaultLocalCodes = topology.defaults.map((entry) => entry.localCode);
  const warehouseDefaultCompletenessParams = [
    tenantId,
    warehouseId,
    topologyWarehouseCodes,
    topologyDefaultWarehouseCodes,
    topologyDefaultRoles,
    topologyDefaultLocalCodes
  ];

  const [negativeBalanceCountRes, negativeBalanceRowsRes] = await Promise.all([
    pool.query(negativeBalanceCountSql, params2),
    pool.query(negativeBalanceRowsSql, params3)
  ]);
  const negativeBalanceCount = Number(negativeBalanceCountRes.rows[0]?.count ?? 0);
  invariantCounts.negative_inventory_balance = negativeBalanceCount;
  printSection('negative_inventory_balance', negativeBalanceCount, negativeBalanceRowsRes.rows);
  if (strictMode && negativeBalanceCount > 0) {
    exitCode = 2;
  }

  const [reservationBoundsCountRes, reservationBoundsRowsRes] = await Promise.all([
    pool.query(reservationBoundsCountSql, params2),
    pool.query(reservationBoundsRowsSql, params3)
  ]);
  const reservationBoundsCount = Number(reservationBoundsCountRes.rows[0]?.count ?? 0);
  invariantCounts.reservation_quantity_violations = reservationBoundsCount;
  printSection('reservation_quantity_violations', reservationBoundsCount, reservationBoundsRowsRes.rows);
  if (strictMode && reservationBoundsCount > 0) {
    exitCode = 2;
  }

  const [nonSellableFlowCountRes, nonSellableFlowRowsRes] = await Promise.all([
    pool.query(nonSellableFlowCountSql, params2),
    pool.query(nonSellableFlowRowsSql, params3)
  ]);
  const nonSellableFlowCount = Number(nonSellableFlowCountRes.rows[0]?.count ?? 0);
  invariantCounts.non_sellable_flow_scope_invalid = nonSellableFlowCount;
  printSection('non_sellable_flow_scope_invalid', nonSellableFlowCount, nonSellableFlowRowsRes.rows);
  if (strictMode && nonSellableFlowCount > 0) {
    exitCode = 2;
  }

  const [salesOrderScopeMismatchCountRes, salesOrderScopeMismatchRowsRes] = await Promise.all([
    pool.query(salesOrderScopeMismatchCountSql, params2),
    pool.query(salesOrderScopeMismatchRowsSql, params3)
  ]);
  const salesOrderScopeMismatchCount = Number(salesOrderScopeMismatchCountRes.rows[0]?.count ?? 0);
  invariantCounts.sales_order_warehouse_scope_mismatch = salesOrderScopeMismatchCount;
  printSection('sales_order_warehouse_scope_mismatch', salesOrderScopeMismatchCount, salesOrderScopeMismatchRowsRes.rows);
  if (strictMode && salesOrderScopeMismatchCount > 0) {
    exitCode = 2;
  }

  const [atpOversellCountRes, atpOversellRowsRes] = await Promise.all([
    pool.query(atpOversellCountSql, params2),
    pool.query(atpOversellRowsSql, params3)
  ]);
  const atpOversellCount = Number(atpOversellCountRes.rows[0]?.count ?? 0);
  invariantCounts.atp_oversell_detected_count = atpOversellCount;
  printSection('atp_oversell_detected', atpOversellCount, atpOversellRowsRes.rows);
  if (strictMode && atpOversellCount > 0) {
    exitCode = 2;
  }

  const [commitmentsDriftCountRes, commitmentsDriftRowsRes] = await Promise.all([
    pool.query(commitmentsDriftCountSql, params2),
    pool.query(commitmentsDriftRowsSql, params3)
  ]);
  const commitmentsDriftCount = Number(commitmentsDriftCountRes.rows[0]?.count ?? 0);
  invariantCounts.balance_vs_commitments_drift = commitmentsDriftCount;
  printSection('balance_vs_commitments_drift', commitmentsDriftCount, commitmentsDriftRowsRes.rows);
  if (strictMode && commitmentsDriftCount > 0) {
    exitCode = 2;
  }

  if (warehouseId) {
    const spotCheckRes = await pool.query(warehouseSpotCheckSql, params3);
    invariantCounts.warehouse_isolation_spot_check = spotCheckRes.rowCount;
    printSection('warehouse_isolation_spot_check', spotCheckRes.rowCount, spotCheckRes.rows);
    if (strictMode && spotCheckRes.rowCount > 0) {
      exitCode = 2;
    }
  }

  const [availabilityReconciliationCountRes, availabilityReconciliationRowsRes] = await Promise.all([
    pool.query(availabilityReconciliationCountSql, params2),
    pool.query(availabilityReconciliationRowsSql, params3)
  ]);
  const availabilityReconciliationCount = Number(availabilityReconciliationCountRes.rows[0]?.count ?? 0);
  invariantCounts.availability_reconciliation_drift = availabilityReconciliationCount;
  printSection(
    'availability_reconciliation_drift',
    availabilityReconciliationCount,
    availabilityReconciliationRowsRes.rows
  );
  if (strictMode && availabilityReconciliationCount > 0) {
    exitCode = 2;
  }

  const [workOrderCostCountRes, workOrderCostRowsRes] = await Promise.all([
    pool.query(workOrderCostConservationCountSql, params2),
    pool.query(workOrderCostConservationRowsSql, params3)
  ]);
  const workOrderCostDriftCount = Number(workOrderCostCountRes.rows[0]?.count ?? 0);
  invariantCounts.work_order_cost_conservation_drift = workOrderCostDriftCount;
  invariantCounts.production_cost_conservation = workOrderCostDriftCount;
  printSection(
    'work_order_cost_conservation_drift',
    workOrderCostDriftCount,
    workOrderCostRowsRes.rows
  );
  printSection(
    'production_cost_conservation',
    workOrderCostDriftCount,
    workOrderCostRowsRes.rows
  );
  if (strictMode && workOrderCostDriftCount > 0) {
    exitCode = 2;
  }

  const [workOrderLinkCountRes, workOrderLinkRowsRes] = await Promise.all([
    pool.query(workOrderProductionLinkIntegrityCountSql, [tenantId]),
    pool.query(workOrderProductionLinkIntegrityRowsSql, [tenantId, limit])
  ]);
  const workOrderLinkIntegrityCount = Number(workOrderLinkCountRes.rows[0]?.count ?? 0);
  invariantCounts.work_order_production_link_integrity = workOrderLinkIntegrityCount;
  printSection(
    'work_order_production_link_integrity',
    workOrderLinkIntegrityCount,
    workOrderLinkRowsRes.rows
  );
  if (strictMode && workOrderLinkIntegrityCount > 0) {
    exitCode = 2;
  }

  const [qcLocationIntegrityCountRes, qcLocationIntegrityRowsRes] = await Promise.all([
    pool.query(qcLocationIntegrityCountSql, params2),
    pool.query(qcLocationIntegrityRowsSql, params3)
  ]);
  const qcLocationIntegrityCount = Number(qcLocationIntegrityCountRes.rows[0]?.count ?? 0);
  invariantCounts.qc_location_integrity = qcLocationIntegrityCount;
  printSection(
    'qc_location_integrity',
    qcLocationIntegrityCount,
    qcLocationIntegrityRowsRes.rows
  );
  if (strictMode && qcLocationIntegrityCount > 0) {
    exitCode = 2;
  }

  const [productionReceiptLocationValidityCountRes, productionReceiptLocationValidityRowsRes] = await Promise.all([
    pool.query(productionReceiptLocationValidityCountSql, params2),
    pool.query(productionReceiptLocationValidityRowsSql, params3)
  ]);
  const productionReceiptLocationValidityCount = Number(
    productionReceiptLocationValidityCountRes.rows[0]?.count ?? 0
  );
  invariantCounts.production_receipt_location_validity = productionReceiptLocationValidityCount;
  printSection(
    'production_receipt_location_validity',
    productionReceiptLocationValidityCount,
    productionReceiptLocationValidityRowsRes.rows
  );
  if (strictMode && productionReceiptLocationValidityCount > 0) {
    exitCode = 2;
  }

  const [workOrderComponentQtyExactMatchCountRes, workOrderComponentQtyExactMatchRowsRes] = await Promise.all([
    pool.query(workOrderComponentQtyExactMatchCountSql, params2),
    pool.query(workOrderComponentQtyExactMatchRowsSql, params3)
  ]);
  const workOrderComponentQtyExactMatchCount = Number(workOrderComponentQtyExactMatchCountRes.rows[0]?.count ?? 0);
  invariantCounts.wo_component_quantity_exact_match = workOrderComponentQtyExactMatchCount;
  printSection(
    'wo_component_quantity_exact_match',
    workOrderComponentQtyExactMatchCount,
    workOrderComponentQtyExactMatchRowsRes.rows
  );
  if (strictMode && workOrderComponentQtyExactMatchCount > 0) {
    exitCode = 2;
  }

  const [productionFifoLayerContinuityCountRes, productionFifoLayerContinuityRowsRes] = await Promise.all([
    pool.query(productionFifoLayerContinuityCountSql, params2),
    pool.query(productionFifoLayerContinuityRowsSql, params3)
  ]);
  const productionFifoLayerContinuityCount = Number(productionFifoLayerContinuityCountRes.rows[0]?.count ?? 0);
  invariantCounts.production_fifo_layer_continuity = productionFifoLayerContinuityCount;
  printSection(
    'production_fifo_layer_continuity',
    productionFifoLayerContinuityCount,
    productionFifoLayerContinuityRowsRes.rows
  );
  if (strictMode && productionFifoLayerContinuityCount > 0) {
    exitCode = 2;
  }

  const effectiveEdges = await getAllEffectiveBomEdges(pool, tenantId, new Date().toISOString());
  const atRestCycle = detectBomCyclesAtRest(
    effectiveEdges.map((edge) => ({
      parent_item_id: edge.parentItemId,
      component_item_id: edge.componentItemId
    })),
    {
      cycleLimit: bomCycleLimit,
      nodeLimit: bomCycleNodeLimit
    }
  );
  printSection(
    'bom_cycle_detected_at_rest',
    atRestCycle.count,
    atRestCycle.samplePaths.map((path) => ({ path }))
  );
  invariantCounts.bom_cycle_detected_at_rest = atRestCycle.count;
  if (atRestCycle.truncatedByNodeLimit || atRestCycle.truncatedByCycleLimit) {
    console.log(
      `  ${JSON.stringify({
        truncatedByNodeLimit: atRestCycle.truncatedByNodeLimit,
        truncatedByCycleLimit: atRestCycle.truncatedByCycleLimit,
        visitedNodes: atRestCycle.visitedNodes,
        nodeLimit: bomCycleNodeLimit,
        cycleLimit: bomCycleLimit
      })}`
    );
  }
  if (strictMode && atRestCycle.count > 0) {
    exitCode = 2;
  }

  const topologyCheck = await checkWarehouseTopologyDefaults(pool, tenantId, { topology });
  printSection(
    'warehouse_topology_defaults_invalid',
    topologyCheck.count,
    topologyCheck.issues.slice(0, limit)
  );
  invariantCounts.warehouse_topology_defaults_invalid = topologyCheck.count;
  if (strictMode && topologyCheck.count > 0) {
    exitCode = 2;
  }
  printSection(
    'warehouse_topology_defaults_warning',
    topologyCheck.warningCount ?? 0,
    (topologyCheck.warnings ?? []).slice(0, limit)
  );
  const hasAmbiguousWarehouseRole = (topologyCheck.issues ?? []).some(
    (issue) => issue?.issue === 'WAREHOUSE_ROLE_AMBIGUOUS'
  );
  if (hasAmbiguousWarehouseRole) {
    console.log('  action: manual cleanup required for ambiguous warehouse role candidates before rerunning --fix');
  }
  if (topologyCheck.count > 0) {
    const topologyMissingSummary = summarizeTopologyMissingIssues(topologyCheck.issues, limit);
    if (
      topologyMissingSummary.missingWarehouseCodes.length > 0
      || topologyMissingSummary.missingLocationCodes.length > 0
      || topologyMissingSummary.missingDefaults.length > 0
    ) {
      console.log(`  [warehouse_topology_missing_summary] ${JSON.stringify({
        tenantId,
        ...topologyMissingSummary
      })}`);
    }
    console.log('  hint: run `npm run seed:warehouse-topology -- --tenant-id <TENANT_UUID> --fix`');
  }

  const [warehouseDefaultCompletenessCountRes, warehouseDefaultCompletenessRowsRes] = await Promise.all([
    pool.query(warehouseDefaultCompletenessCountSql, warehouseDefaultCompletenessParams),
    pool.query(warehouseDefaultCompletenessRowsSql, [...warehouseDefaultCompletenessParams, limit])
  ]);
  const warehouseDefaultCompletenessCount = Number(warehouseDefaultCompletenessCountRes.rows[0]?.count ?? 0);
  invariantCounts.warehouse_default_completeness_invalid = warehouseDefaultCompletenessCount;
  printSection(
    'warehouse_default_completeness_invalid',
    warehouseDefaultCompletenessCount,
    warehouseDefaultCompletenessRowsRes.rows
  );
  if (strictMode && warehouseDefaultCompletenessCount > 0) {
    exitCode = 2;
  }

  const [negativeOnHandCountRes, negativeOnHandRowsRes] = await Promise.all([
    pool.query(negativeOnHandCountSql, params2),
    pool.query(negativeOnHandRowsSql, params3)
  ]);
  const negativeOnHandCount = Number(negativeOnHandCountRes.rows[0]?.count ?? 0);
  invariantCounts.negative_on_hand = negativeOnHandCount;
  invariantCounts.no_negative_component_on_hand = negativeOnHandCount;
  printSection('negative_on_hand', negativeOnHandCount, negativeOnHandRowsRes.rows);
  printSection('no_negative_component_on_hand', negativeOnHandCount, negativeOnHandRowsRes.rows);
  if (strictMode && negativeOnHandCount > 0) {
    exitCode = 2;
  }

  const [unmatchedCostLayersCountRes, unmatchedCostLayersRowsRes] = await Promise.all([
    pool.query(unmatchedCostLayersCountSql, params2),
    pool.query(unmatchedCostLayersRowsSql, params3)
  ]);
  const unmatchedCostLayersCount = Number(unmatchedCostLayersCountRes.rows[0]?.count ?? 0);
  invariantCounts.unmatched_cost_layers = unmatchedCostLayersCount;
  printSection('unmatched_cost_layers', unmatchedCostLayersCount, unmatchedCostLayersRowsRes.rows);
  if (strictMode && unmatchedCostLayersCount > 0) {
    exitCode = 2;
  }

  const [orphanedCostLayersCountRes, orphanedCostLayersRowsRes] = await Promise.all([
    pool.query(orphanedCostLayersCountSql, params2),
    pool.query(orphanedCostLayersRowsSql, params3)
  ]);
  const orphanedCostLayersCount = Number(orphanedCostLayersCountRes.rows[0]?.count ?? 0);
  invariantCounts.orphaned_cost_layers = orphanedCostLayersCount;
  printSection('orphaned_cost_layers', orphanedCostLayersCount, orphanedCostLayersRowsRes.rows);
  if (strictMode && orphanedCostLayersCount > 0) {
    exitCode = 2;
  }

  const [poLineClosedCountRes, poLineClosedRowsRes] = await Promise.all([
    pool.query(poLineClosedBlocksReceiptsCountSql, params2),
    pool.query(poLineClosedBlocksReceiptsRowsSql, params3)
  ]);
  const poLineClosedBlocksCount = Number(poLineClosedCountRes.rows[0]?.count ?? 0);
  invariantCounts.po_line_closed_blocks_receipts = poLineClosedBlocksCount;
  printSection('po_line_closed_blocks_receipts', poLineClosedBlocksCount, poLineClosedRowsRes.rows);
  if (strictMode && poLineClosedBlocksCount > 0) {
    exitCode = 2;
  }

  const [poStatusConsistencyCountRes, poStatusConsistencyRowsRes] = await Promise.all([
    pool.query(poStatusConsistencyCountSql, params2),
    pool.query(poStatusConsistencyRowsSql, params3)
  ]);
  const poStatusConsistencyCount = Number(poStatusConsistencyCountRes.rows[0]?.count ?? 0);
  invariantCounts.po_status_consistency = poStatusConsistencyCount;
  printSection('po_status_consistency', poStatusConsistencyCount, poStatusConsistencyRowsRes.rows);
  if (strictMode && poStatusConsistencyCount > 0) {
    exitCode = 2;
  }

  const [poReceivedQtyIntegrityCountRes, poReceivedQtyIntegrityRowsRes] = await Promise.all([
    pool.query(poReceivedQtyIntegrityCountSql, params2),
    pool.query(poReceivedQtyIntegrityRowsSql, params3)
  ]);
  const poReceivedQtyIntegrityCount = Number(poReceivedQtyIntegrityCountRes.rows[0]?.count ?? 0);
  invariantCounts.po_received_qty_integrity_invalid = poReceivedQtyIntegrityCount;
  printSection('po_received_qty_integrity_invalid', poReceivedQtyIntegrityCount, poReceivedQtyIntegrityRowsRes.rows);
  if (strictMode && poReceivedQtyIntegrityCount > 0) {
    exitCode = 2;
  }

  if (strictMode) {
    const violations = Object.fromEntries(
      Object.entries(invariantCounts).filter(([, count]) => Number(count) > 0)
    );
    if (Object.keys(violations).length > 0) {
      console.error(`[strict_failure_summary] ${JSON.stringify({
        tenantId,
        warehouseId,
        violations
      })}`);
    }
  }

  process.exit(exitCode);
} catch (error) {
  console.error(error);
  process.exit(1);
} finally {
  await pool.end();
}

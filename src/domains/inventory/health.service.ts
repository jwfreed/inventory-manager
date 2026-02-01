import { query } from '../../db';
import { getInventoryHealthGateConfig } from '../../config/inventoryHealth';

export type InventoryHealthOptions = {
  topLimit?: number;
  countWindowDays?: number;
};

export type InventoryHealthResult = {
  gate: {
    pass: boolean;
    reasons: string[];
    thresholds: Record<string, unknown>;
  };
  ledgerVsCostLayers: {
    rowCount: number;
    rowsWithVariance: number;
    variancePct: number;
    absQtyVariance: number;
    absValueVariance: number;
    topOffenders: Array<{
      itemId: string;
      itemSku: string | null;
      locationId: string;
      locationCode: string | null;
      uom: string;
      ledgerQty: number;
      layerQty: number;
      varianceQty: number;
      varianceValue: number;
    }>;
  };
  cycleCountVariance: {
    totalLines: number;
    linesWithVariance: number;
    variancePct: number;
    absQtyVariance: number;
    topOffenders: Array<{
      itemId: string;
      itemSku: string | null;
      locationId: string;
      locationCode: string | null;
      uom: string;
      varianceQty: number;
      countedAt: string;
      cycleCountId: string;
    }>;
  };
  negativeInventory: {
    count: number;
    topOffenders: Array<{
      itemId: string;
      itemSku: string | null;
      locationId: string;
      locationCode: string | null;
      uom: string;
      onHand: number;
    }>;
  };
  generatedAt: string;
  durationMs: number;
};

function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  return Number(value);
}

export async function computeInventoryHealth(
  tenantId: string,
  options: InventoryHealthOptions = {}
): Promise<InventoryHealthResult> {
  const startedAt = Date.now();
  const topLimit = options.topLimit ?? 25;
  const countWindowDays = options.countWindowDays ?? 90;

  const ledgerSummary = await query(
    `WITH ledger AS (
       SELECT l.item_id,
              l.location_id,
              COALESCE(l.canonical_uom, l.uom) AS uom,
              SUM(COALESCE(l.quantity_delta_canonical, l.quantity_delta)) AS qty
         FROM inventory_movement_lines l
         JOIN inventory_movements m
           ON m.id = l.movement_id
          AND m.tenant_id = l.tenant_id
        WHERE m.status = 'posted'
          AND l.tenant_id = $1
        GROUP BY l.item_id, l.location_id, COALESCE(l.canonical_uom, l.uom)
     ),
     layers AS (
       SELECT item_id,
              location_id,
              uom,
              SUM(remaining_quantity) AS qty
         FROM inventory_cost_layers
        WHERE tenant_id = $1
          AND voided_at IS NULL
        GROUP BY item_id, location_id, uom
     ),
     combined AS (
       SELECT COALESCE(l.item_id, c.item_id) AS item_id,
              COALESCE(l.location_id, c.location_id) AS location_id,
              COALESCE(l.uom, c.uom) AS uom,
              COALESCE(l.qty, 0) AS ledger_qty,
              COALESCE(c.qty, 0) AS layer_qty,
              (COALESCE(l.qty, 0) - COALESCE(c.qty, 0)) AS variance_qty
         FROM ledger l
         FULL OUTER JOIN layers c
           ON l.item_id = c.item_id
          AND l.location_id = c.location_id
          AND l.uom = c.uom
     )
     SELECT
       COUNT(*) AS row_count,
       SUM(CASE WHEN variance_qty <> 0 THEN 1 ELSE 0 END) AS rows_with_variance,
       SUM(ABS(variance_qty)) AS abs_qty_variance,
       SUM(ABS(variance_qty) * COALESCE(i.standard_cost_base, i.standard_cost, 0)) AS abs_value_variance
     FROM combined c
     LEFT JOIN items i ON i.id = c.item_id AND i.tenant_id = $1`,
    [tenantId]
  );

  const ledgerSummaryRow = ledgerSummary.rows[0] ?? {
    row_count: 0,
    rows_with_variance: 0,
    abs_qty_variance: 0,
    abs_value_variance: 0
  };

  const ledgerOffenders = await query(
    `WITH ledger AS (
       SELECT l.item_id,
              l.location_id,
              COALESCE(l.canonical_uom, l.uom) AS uom,
              SUM(COALESCE(l.quantity_delta_canonical, l.quantity_delta)) AS qty
         FROM inventory_movement_lines l
         JOIN inventory_movements m
           ON m.id = l.movement_id
          AND m.tenant_id = l.tenant_id
        WHERE m.status = 'posted'
          AND l.tenant_id = $1
        GROUP BY l.item_id, l.location_id, COALESCE(l.canonical_uom, l.uom)
     ),
     layers AS (
       SELECT item_id,
              location_id,
              uom,
              SUM(remaining_quantity) AS qty
         FROM inventory_cost_layers
        WHERE tenant_id = $1
          AND voided_at IS NULL
        GROUP BY item_id, location_id, uom
     ),
     combined AS (
       SELECT COALESCE(l.item_id, c.item_id) AS item_id,
              COALESCE(l.location_id, c.location_id) AS location_id,
              COALESCE(l.uom, c.uom) AS uom,
              COALESCE(l.qty, 0) AS ledger_qty,
              COALESCE(c.qty, 0) AS layer_qty,
              (COALESCE(l.qty, 0) - COALESCE(c.qty, 0)) AS variance_qty
         FROM ledger l
         FULL OUTER JOIN layers c
           ON l.item_id = c.item_id
          AND l.location_id = c.location_id
          AND l.uom = c.uom
     )
     SELECT c.item_id,
            i.sku AS item_sku,
            c.location_id,
            loc.code AS location_code,
            c.uom,
            c.ledger_qty,
            c.layer_qty,
            c.variance_qty,
            (ABS(c.variance_qty) * COALESCE(i.standard_cost_base, i.standard_cost, 0)) AS variance_value
       FROM combined c
       LEFT JOIN items i ON i.id = c.item_id AND i.tenant_id = $1
       LEFT JOIN locations loc ON loc.id = c.location_id AND loc.tenant_id = $1
      WHERE c.variance_qty <> 0
      ORDER BY ABS(c.variance_qty) DESC
      LIMIT $2`,
    [tenantId, topLimit]
  );

  const negativeInventory = await query(
    `WITH ledger AS (
       SELECT l.item_id,
              l.location_id,
              COALESCE(l.canonical_uom, l.uom) AS uom,
              SUM(COALESCE(l.quantity_delta_canonical, l.quantity_delta)) AS qty
         FROM inventory_movement_lines l
         JOIN inventory_movements m
           ON m.id = l.movement_id
          AND m.tenant_id = l.tenant_id
        WHERE m.status = 'posted'
          AND l.tenant_id = $1
        GROUP BY l.item_id, l.location_id, COALESCE(l.canonical_uom, l.uom)
     )
     SELECT l.item_id,
            i.sku AS item_sku,
            l.location_id,
            loc.code AS location_code,
            l.uom,
            l.qty
       FROM ledger l
       LEFT JOIN items i ON i.id = l.item_id AND i.tenant_id = $1
       LEFT JOIN locations loc ON loc.id = l.location_id AND loc.tenant_id = $1
      WHERE l.qty < 0
      ORDER BY l.qty ASC
      LIMIT $2`,
    [tenantId, topLimit]
  );

  const negativeCount = await query(
    `WITH ledger AS (
       SELECT l.item_id,
              l.location_id,
              COALESCE(l.canonical_uom, l.uom) AS uom,
              SUM(COALESCE(l.quantity_delta_canonical, l.quantity_delta)) AS qty
         FROM inventory_movement_lines l
         JOIN inventory_movements m
           ON m.id = l.movement_id
          AND m.tenant_id = l.tenant_id
        WHERE m.status = 'posted'
          AND l.tenant_id = $1
        GROUP BY l.item_id, l.location_id, COALESCE(l.canonical_uom, l.uom)
     )
     SELECT COUNT(*) AS negative_count
       FROM ledger
      WHERE qty < 0`,
    [tenantId]
  );

  const cycleSummary = await query(
    `SELECT
        COUNT(*) AS total_lines,
        SUM(CASE WHEN l.variance_quantity IS NOT NULL AND l.variance_quantity <> 0 THEN 1 ELSE 0 END) AS lines_with_variance,
        SUM(ABS(COALESCE(l.variance_quantity, 0))) AS abs_qty_variance
       FROM cycle_count_lines l
       JOIN cycle_counts c
         ON c.id = l.cycle_count_id
        AND c.tenant_id = l.tenant_id
      WHERE c.tenant_id = $1
        AND c.status = 'posted'
        AND c.counted_at >= (CURRENT_DATE - $2::int)`,
    [tenantId, countWindowDays]
  );

  const cycleOffenders = await query(
    `SELECT l.item_id,
            i.sku AS item_sku,
            c.location_id,
            loc.code AS location_code,
            l.uom,
            l.variance_quantity AS variance_qty,
            c.counted_at::text AS counted_at,
            c.id AS cycle_count_id
       FROM cycle_count_lines l
       JOIN cycle_counts c
         ON c.id = l.cycle_count_id
        AND c.tenant_id = l.tenant_id
       LEFT JOIN items i ON i.id = l.item_id AND i.tenant_id = $1
       LEFT JOIN locations loc ON loc.id = c.location_id AND loc.tenant_id = $1
      WHERE c.tenant_id = $1
        AND c.status = 'posted'
        AND c.counted_at >= (CURRENT_DATE - $2::int)
        AND l.variance_quantity IS NOT NULL
        AND l.variance_quantity <> 0
      ORDER BY ABS(l.variance_quantity) DESC
      LIMIT $3`,
    [tenantId, countWindowDays, topLimit]
  );

  const ledgerRowCount = toNumber(ledgerSummaryRow.row_count);
  const ledgerRowsWithVariance = toNumber(ledgerSummaryRow.rows_with_variance);
  const ledgerVariancePct = ledgerRowCount === 0 ? 0 : (ledgerRowsWithVariance / ledgerRowCount) * 100;

  const cycleTotalLines = toNumber(cycleSummary.rows[0]?.total_lines);
  const cycleLinesWithVariance = toNumber(cycleSummary.rows[0]?.lines_with_variance);
  const cycleVariancePct = cycleTotalLines === 0 ? 0 : (cycleLinesWithVariance / cycleTotalLines) * 100;

  const config = getInventoryHealthGateConfig();
  const gateReasons: string[] = [];
  if (ledgerVariancePct > config.maxLedgerVariancePct) {
    gateReasons.push(`ledger_variance_pct>${config.maxLedgerVariancePct}`);
  }
  if (toNumber(ledgerSummaryRow.abs_value_variance) > config.maxLedgerValueVariance) {
    gateReasons.push(`ledger_value_variance>${config.maxLedgerValueVariance}`);
  }
  if (cycleVariancePct > config.maxCycleCountVariancePct) {
    gateReasons.push(`cycle_count_variance_pct>${config.maxCycleCountVariancePct}`);
  }
  if (toNumber(negativeCount.rows[0]?.negative_count) > 0 && config.failOnNegativeInventory) {
    gateReasons.push('negative_inventory_detected');
  }

  const durationMs = Date.now() - startedAt;

  return {
    gate: {
      pass: gateReasons.length === 0,
      reasons: gateReasons,
      thresholds: config
    },
    ledgerVsCostLayers: {
      rowCount: ledgerRowCount,
      rowsWithVariance: ledgerRowsWithVariance,
      variancePct: ledgerVariancePct,
      absQtyVariance: toNumber(ledgerSummaryRow.abs_qty_variance),
      absValueVariance: toNumber(ledgerSummaryRow.abs_value_variance),
      topOffenders: ledgerOffenders.rows.map((row: any) => ({
        itemId: row.item_id,
        itemSku: row.item_sku ?? null,
        locationId: row.location_id,
        locationCode: row.location_code ?? null,
        uom: row.uom,
        ledgerQty: toNumber(row.ledger_qty),
        layerQty: toNumber(row.layer_qty),
        varianceQty: toNumber(row.variance_qty),
        varianceValue: toNumber(row.variance_value)
      }))
    },
    cycleCountVariance: {
      totalLines: cycleTotalLines,
      linesWithVariance: cycleLinesWithVariance,
      variancePct: cycleVariancePct,
      absQtyVariance: toNumber(cycleSummary.rows[0]?.abs_qty_variance),
      topOffenders: cycleOffenders.rows.map((row: any) => ({
        itemId: row.item_id,
        itemSku: row.item_sku ?? null,
        locationId: row.location_id,
        locationCode: row.location_code ?? null,
        uom: row.uom,
        varianceQty: toNumber(row.variance_qty),
        countedAt: row.counted_at,
        cycleCountId: row.cycle_count_id
      }))
    },
    negativeInventory: {
      count: toNumber(negativeCount.rows[0]?.negative_count),
      topOffenders: negativeInventory.rows.map((row: any) => ({
        itemId: row.item_id,
        itemSku: row.item_sku ?? null,
        locationId: row.location_id,
        locationCode: row.location_code ?? null,
        uom: row.uom,
        onHand: toNumber(row.qty)
      }))
    },
    generatedAt: new Date().toISOString(),
    durationMs
  };
}

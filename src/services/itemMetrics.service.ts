import { query } from '../db';
import { roundQuantity, toNumber } from '../lib/numbers';

export type ItemMetrics = {
  itemId: string;
  windowDays: number;
  orderedQty: number;
  shippedQty: number;
  fillRate: number | null;
  stockoutRate: number | null;
  totalOutflowQty: number;
  avgOnHandQty: number;
  turns: number | null;
  doiDays: number | null;
  lastCountAt: string | null;
  lastCountVarianceQty: number | null;
  lastCountVariancePct: number | null;
};

function parseNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const num = typeof value === 'string' ? Number(value) : (value as number);
  if (Number.isNaN(num)) {
    return null;
  }
  return num;
}

export async function getItemMetrics(
  tenantId: string,
  itemIds: string[],
  windowDays: number = 90
): Promise<ItemMetrics[]> {
  if (itemIds.length === 0) return [];

  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const windowMid = new Date((windowStart.getTime() + windowEnd.getTime()) / 2);

  const fillRows = await query<{
    item_id: string;
    ordered_qty: string;
    shipped_qty: string;
  }>(
    `
    WITH shipped_lines AS (
      SELECT DISTINCT sol.id, sol.item_id, sol.quantity_ordered
      FROM sales_order_shipment_lines sosl
      JOIN sales_order_shipments sos
        ON sos.id = sosl.sales_order_shipment_id
       AND sos.tenant_id = sosl.tenant_id
      JOIN sales_order_lines sol
        ON sol.id = sosl.sales_order_line_id
       AND sol.tenant_id = sosl.tenant_id
      WHERE sos.tenant_id = $1
        AND sol.item_id = ANY($2::uuid[])
        AND sos.shipped_at >= $3
        AND sos.shipped_at < $4
    ),
    ordered AS (
      SELECT item_id, SUM(quantity_ordered) AS ordered_qty
      FROM shipped_lines
      GROUP BY item_id
    ),
    shipped AS (
      SELECT sol.item_id, SUM(sosl.quantity_shipped) AS shipped_qty
      FROM sales_order_shipment_lines sosl
      JOIN sales_order_shipments sos
        ON sos.id = sosl.sales_order_shipment_id
       AND sos.tenant_id = sosl.tenant_id
      JOIN sales_order_lines sol
        ON sol.id = sosl.sales_order_line_id
       AND sol.tenant_id = sosl.tenant_id
      WHERE sos.tenant_id = $1
        AND sol.item_id = ANY($2::uuid[])
        AND sos.shipped_at >= $3
        AND sos.shipped_at < $4
      GROUP BY sol.item_id
    )
    SELECT ordered.item_id, ordered.ordered_qty, COALESCE(shipped.shipped_qty, 0) AS shipped_qty
    FROM ordered
    LEFT JOIN shipped ON shipped.item_id = ordered.item_id
    `,
    [tenantId, itemIds, windowStart.toISOString(), windowEnd.toISOString()]
  );

  const turnsCanonicalRows = await query<{
    item_id: string;
    total_outflow_qty: string;
    avg_on_hand_qty: string;
  }>(
    `
    WITH samples AS (
      SELECT $3::timestamptz AS sample_time
      UNION ALL
      SELECT $4::timestamptz
      UNION ALL
      SELECT $5::timestamptz
    ),
    on_hand_samples AS (
      SELECT iml.item_id, SUM(iml.quantity_delta_canonical) AS quantity
      FROM inventory_movement_lines iml
      JOIN inventory_movements im
        ON im.id = iml.movement_id
       AND im.tenant_id = iml.tenant_id
      JOIN samples s ON im.occurred_at <= s.sample_time
      WHERE im.status = 'posted'
        AND iml.tenant_id = $1
        AND iml.item_id = ANY($2::uuid[])
        AND iml.quantity_delta_canonical IS NOT NULL
      GROUP BY iml.item_id, s.sample_time
    ),
    avg_on_hand AS (
      SELECT item_id, AVG(quantity) AS avg_on_hand_qty
      FROM on_hand_samples
      GROUP BY item_id
    ),
    outflow_qty AS (
      SELECT iml.item_id, SUM(ABS(iml.quantity_delta_canonical)) AS total_outflow_qty
      FROM inventory_movement_lines iml
      JOIN inventory_movements im
        ON im.id = iml.movement_id
       AND im.tenant_id = iml.tenant_id
      WHERE im.status = 'posted'
        AND iml.tenant_id = $1
        AND iml.item_id = ANY($2::uuid[])
        AND im.occurred_at >= $3
        AND im.occurred_at < $5
        AND iml.quantity_delta_canonical < 0
      GROUP BY iml.item_id
    )
    SELECT i.item_id,
           COALESCE(o.total_outflow_qty, 0) AS total_outflow_qty,
           COALESCE(a.avg_on_hand_qty, 0) AS avg_on_hand_qty
      FROM (SELECT DISTINCT unnest($2::uuid[]) AS item_id) i
      LEFT JOIN outflow_qty o ON o.item_id = i.item_id
      LEFT JOIN avg_on_hand a ON a.item_id = i.item_id
    `,
    [tenantId, itemIds, windowStart.toISOString(), windowMid.toISOString(), windowEnd.toISOString()]
  );


  const countRows = await query<{
    item_id: string;
    counted_at: string;
    variance_quantity: string | null;
    system_quantity: string | null;
    counted_quantity: string | null;
  }>(
    `
    SELECT DISTINCT ON (ccl.item_id)
      ccl.item_id,
      cc.counted_at,
      ccl.variance_quantity,
      ccl.system_quantity,
      ccl.counted_quantity
    FROM cycle_count_lines ccl
    JOIN cycle_counts cc ON cc.id = ccl.cycle_count_id AND cc.tenant_id = ccl.tenant_id
    WHERE ccl.tenant_id = $1
      AND ccl.item_id = ANY($2::uuid[])
    ORDER BY ccl.item_id, cc.counted_at DESC, ccl.created_at DESC
    `,
    [tenantId, itemIds]
  );

  const fillMap = new Map<string, { orderedQty: number; shippedQty: number; fillRate: number | null }>();
  for (const row of fillRows.rows) {
    const orderedQty = roundQuantity(toNumber(row.ordered_qty));
    const shippedQty = roundQuantity(toNumber(row.shipped_qty));
    const fillRate = orderedQty > 0 ? roundQuantity(shippedQty / orderedQty) : null;
    fillMap.set(row.item_id, { orderedQty, shippedQty, fillRate });
  }

  const turnsMap = new Map<string, { totalOutflowQty: number; avgOnHandQty: number; turns: number | null; doiDays: number | null }>();
  for (const row of turnsCanonicalRows.rows) {
    const totalOutflowQty = roundQuantity(toNumber(row.total_outflow_qty));
    const avgOnHandQty = roundQuantity(toNumber(row.avg_on_hand_qty));
    const turns = avgOnHandQty > 0 ? roundQuantity(totalOutflowQty / avgOnHandQty) : null;
    const avgDailyOutflow = windowDays > 0 ? totalOutflowQty / windowDays : 0;
    const doiDays = avgDailyOutflow > 0 ? roundQuantity(avgOnHandQty / avgDailyOutflow) : null;
    turnsMap.set(row.item_id, { totalOutflowQty, avgOnHandQty, turns, doiDays });
  }

  const countMap = new Map<
    string,
    { lastCountAt: string | null; varianceQty: number | null; variancePct: number | null }
  >();
  for (const row of countRows.rows) {
    const countedQty = parseNullableNumber(row.counted_quantity);
    const systemQty = parseNullableNumber(row.system_quantity);
    const varianceQty =
      parseNullableNumber(row.variance_quantity) ??
      (countedQty !== null && systemQty !== null ? countedQty - systemQty : null);
    let variancePct: number | null = null;
    if (varianceQty !== null) {
      if (systemQty !== null && systemQty > 0) {
        variancePct = roundQuantity(Math.abs(varianceQty) / systemQty);
      } else if (countedQty !== null && countedQty === 0) {
        variancePct = 0;
      } else {
        variancePct = 1;
      }
    }
    countMap.set(row.item_id, {
      lastCountAt: row.counted_at ?? null,
      varianceQty: varianceQty !== null ? roundQuantity(varianceQty) : null,
      variancePct
    });
  }

  return itemIds.map((itemId) => {
    const fill = fillMap.get(itemId);
    const turns = turnsMap.get(itemId);
    const count = countMap.get(itemId);
    const fillRate = fill?.fillRate ?? null;
    return {
      itemId,
      windowDays,
      orderedQty: fill?.orderedQty ?? 0,
      shippedQty: fill?.shippedQty ?? 0,
      fillRate,
      stockoutRate: fillRate !== null ? roundQuantity(1 - fillRate) : null,
      totalOutflowQty: turns?.totalOutflowQty ?? 0,
      avgOnHandQty: turns?.avgOnHandQty ?? 0,
      turns: turns?.turns ?? null,
      doiDays: turns?.doiDays ?? null,
      lastCountAt: count?.lastCountAt ?? null,
      lastCountVarianceQty: count?.varianceQty ?? null,
      lastCountVariancePct: count?.variancePct ?? null
    };
  });
}

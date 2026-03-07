import type { PoolClient } from 'pg';
import { query } from '../../../db';
import {
  getItemQuantityOnHandProjectionFromLedger,
  refreshItemQuantityOnHandProjection
} from './itemStockSummary.projector';

export interface ItemCostSummaryProjection {
  standardCost: number | null;
  averageCost: number | null;
  quantityOnHand: number;
}

export interface ItemValuationProjection {
  quantityOnHand: number;
  averageCost: number | null;
  totalValue: number;
}

export async function getItemValuationProjectionFromCostLayers(
  tenantId: string,
  itemId: string,
  client?: PoolClient
): Promise<ItemValuationProjection> {
  const executor = client ? client.query.bind(client) : query;
  const result = await executor(
    `SELECT
       COALESCE(SUM(remaining_quantity), 0) AS total_quantity,
       COALESCE(SUM(remaining_quantity * unit_cost), 0) AS total_value,
       CASE
         WHEN COALESCE(SUM(remaining_quantity), 0) > 0
         THEN COALESCE(SUM(remaining_quantity * unit_cost), 0) / SUM(remaining_quantity)
         ELSE NULL
       END AS average_cost
     FROM inventory_cost_layers
     WHERE tenant_id = $1
       AND item_id = $2
       AND remaining_quantity > 0
       AND voided_at IS NULL`,
    [tenantId, itemId]
  );
  const row = result.rows[0];
  return {
    quantityOnHand: row?.total_quantity != null ? Number(row.total_quantity) : 0,
    averageCost: row?.average_cost != null ? Number(row.average_cost) : null,
    totalValue: row?.total_value != null ? Number(row.total_value) : 0
  };
}

// items.average_cost and items.quantity_on_hand are derived summaries.
// Cost layers remain the valuation authority; these columns are maintained
// synchronously only for compatibility until async projectors replace them.
export async function getItemCostSummaryProjection(
  tenantId: string,
  itemId: string,
  client?: PoolClient
): Promise<ItemCostSummaryProjection> {
  const executor = client ? client.query.bind(client) : query;
  const itemResult = await executor(
    `SELECT
       COALESCE(standard_cost_base, standard_cost) AS standard_cost
     FROM items
     WHERE id = $1 AND tenant_id = $2`,
    [itemId, tenantId]
  );
  if (itemResult.rowCount === 0) {
    return { standardCost: null, averageCost: null, quantityOnHand: 0 };
  }
  const row = itemResult.rows[0];
  const valuation = await getItemValuationProjectionFromCostLayers(tenantId, itemId, client);
  const quantityOnHand = await getItemQuantityOnHandProjectionFromLedger(tenantId, itemId, client);
  return {
    standardCost: row.standard_cost != null ? Number(row.standard_cost) : null,
    averageCost: valuation.averageCost,
    quantityOnHand
  };
}

export async function refreshItemCostSummaryProjection(
  tenantId: string,
  itemId: string,
  client: PoolClient
): Promise<ItemCostSummaryProjection> {
  const itemResult = await client.query<{ standard_cost: string | number | null }>(
    `SELECT COALESCE(standard_cost_base, standard_cost) AS standard_cost
       FROM items
      WHERE id = $1
        AND tenant_id = $2`,
    [itemId, tenantId]
  );
  const standardCost = itemResult.rows[0]?.standard_cost != null
    ? Number(itemResult.rows[0].standard_cost)
    : null;
  const valuation = await getItemValuationProjectionFromCostLayers(tenantId, itemId, client);
  const quantityOnHand = await refreshItemQuantityOnHandProjection(tenantId, itemId, client);
  const newAverageCost = valuation.averageCost != null
    ? Math.round(valuation.averageCost * 1000000) / 1000000
    : null;

  await client.query(
    `UPDATE items
     SET average_cost = $1,
         updated_at = now()
     WHERE id = $2 AND tenant_id = $3`,
    [newAverageCost, itemId, tenantId]
  );

  return {
    standardCost,
    averageCost: newAverageCost,
    quantityOnHand
  };
}

export async function refreshItemValuationSummaryProjection(
  tenantId: string,
  itemId: string,
  client: PoolClient
): Promise<number> {
  const projection = await refreshItemCostSummaryProjection(tenantId, itemId, client);
  return projection.averageCost ?? 0;
}

export async function projectMovingAverageReceiptSummary(
  tenantId: string,
  itemId: string,
  _receivedQuantity: number,
  _unitCostAtReceipt: number,
  client: PoolClient
): Promise<number> {
  return refreshItemValuationSummaryProjection(tenantId, itemId, client);
}

import { query } from '../db';
import { PoolClient } from 'pg';
import {
  getItemCostSummaryProjection,
  projectMovingAverageReceiptSummary,
  refreshItemCostSummaryProjection,
  type ItemCostSummaryProjection
} from '../modules/costing/infrastructure/itemCostSummary.projector';

/**
 * Costing Service
 * Handles standard costing and moving average costing logic for inventory movements
 */

export interface MovementCostData {
  unitCost: number | null;
  extendedCost: number | null;
}

export interface ItemCostInfo {
  standardCost: number | null;
  averageCost: number | null;
  quantityOnHand: number;
}

/**
 * Get the standard cost for an item
 * @param tenantId - Tenant ID
 * @param itemId - Item ID
 * @param client - Optional database client for transaction support
 * @returns The item's standard cost, or null if not set
 */
export async function getItemStandardCost(
  tenantId: string,
  itemId: string,
  client?: PoolClient
): Promise<number | null> {
  const executor = client ? client.query.bind(client) : query;
  const result = await executor(
    'SELECT COALESCE(standard_cost_base, standard_cost) AS standard_cost FROM items WHERE id = $1 AND tenant_id = $2',
    [itemId, tenantId]
  );
  if (result.rowCount === 0) {
    return null;
  }
  const cost = result.rows[0].standard_cost;
  return cost != null ? Number(cost) : null;
}

/**
 * Get cost information for an item (standard cost, average cost, quantity on hand)
 * @param tenantId - Tenant ID
 * @param itemId - Item ID
 * @param client - Optional database client for transaction support
 * @returns Cost information for the item
 */
export async function getItemCostInfo(
  tenantId: string,
  itemId: string,
  client?: PoolClient
): Promise<ItemCostInfo> {
  const projection: ItemCostSummaryProjection = await getItemCostSummaryProjection(tenantId, itemId, client);
  return projection;
}

/**
 * Update item's moving average cost based on a new receipt
 * Formula: New Average = ((Old Qty × Old Avg Cost) + (New Qty × New Unit Cost)) / (Old Qty + New Qty)
 * @param tenantId - Tenant ID
 * @param itemId - Item ID
 * @param receivedQuantity - Quantity being received
 * @param unitCostAtReceipt - Unit cost from the PO receipt
 * @param client - Database client (must be in transaction)
 * @returns The new average cost after update
 */
export async function updateMovingAverageCost(
  tenantId: string,
  itemId: string,
  receivedQuantity: number,
  unitCostAtReceipt: number,
  client: PoolClient
): Promise<number> {
  return projectMovingAverageReceiptSummary(
    tenantId,
    itemId,
    receivedQuantity,
    unitCostAtReceipt,
    client
  );
}

/**
 * Refresh derived item summaries after authoritative stock/cost mutations.
 * The quantity delta parameter remains for compatibility with legacy callers.
 * @param tenantId - Tenant ID
 * @param itemId - Item ID
 * @param quantityDelta - Legacy compatibility input, not used as authority
 * @param client - Database client (must be in transaction)
 */
export async function updateItemQuantityOnHand(
  tenantId: string,
  itemId: string,
  _quantityDelta: number,
  client: PoolClient
): Promise<void> {
  await refreshItemCostSummaryProjection(tenantId, itemId, client);
}

/**
 * Calculate movement cost data for a movement line
 * Uses standard costing: unit_cost = item's standard_cost at time of posting
 * @param tenantId - Tenant ID
 * @param itemId - Item ID
 * @param quantityDelta - Quantity change (can be negative)
 * @param client - Optional database client for transaction support
 * @returns Cost data including unit cost and extended cost
 */
export async function calculateMovementCost(
  tenantId: string,
  itemId: string,
  quantityDelta: number,
  client?: PoolClient
): Promise<MovementCostData> {
  const unitCost = await getItemStandardCost(tenantId, itemId, client);
  
  if (unitCost === null) {
    return { unitCost: null, extendedCost: null };
  }

  // Extended cost = quantity * unit cost
  // For negative movements (consumption/issues), extended cost is also negative
  const extendedCost = quantityDelta * unitCost;

  return {
    unitCost,
    extendedCost: Math.round(extendedCost * 1000000) / 1000000 // Round to 6 decimal places
  };
}

/**
 * Calculate movement cost using a specific unit cost (e.g., from receipt)
 * @param quantityDelta - Quantity change (can be negative)
 * @param unitCost - Unit cost to use
 * @returns Cost data including extended cost
 */
export function calculateMovementCostWithUnitCost(
  quantityDelta: number,
  unitCost: number | null
): MovementCostData {
  if (unitCost === null) {
    return { unitCost: null, extendedCost: null };
  }

  const extendedCost = quantityDelta * unitCost;

  return {
    unitCost,
    extendedCost: Math.round(extendedCost * 1000000) / 1000000
  };
}

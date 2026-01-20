import type { PoolClient } from 'pg';
import { getItemUomConfig } from './uomCanonical.service';
import * as costLayersService from './costLayers.service';

/**
 * Cost Layer Integration Helpers
 * 
 * These functions integrate cost layers with existing inventory operations.
 * They should be called whenever inventory movements occur to maintain accurate cost tracking.
 */

/**
 * Process a receipt into cost layers
 * Called when receiving inventory (purchase orders, returns, etc.)
 */
export async function processReceiptIntoCostLayers(params: {
  tenant_id: string;
  item_id: string;
  location_id: string;
  uom: string;
  quantity: number;
  unit_cost: number;
  source_type: 'receipt' | 'production' | 'adjustment' | 'transfer_in';
  source_document_id?: string;
  movement_id?: string;
  lot_id?: string;
  received_at?: Date;
  notes?: string;
  client?: PoolClient;
}): Promise<void> {
  // Create a new cost layer for the receipt
  await costLayersService.createCostLayer({
    tenant_id: params.tenant_id,
    item_id: params.item_id,
    location_id: params.location_id,
    uom: params.uom,
    quantity: params.quantity,
    unit_cost: params.unit_cost,
    source_type: params.source_type,
    source_document_id: params.source_document_id,
    movement_id: params.movement_id,
    lot_id: params.lot_id,
    layer_date: params.received_at,
    notes: params.notes,
    client: params.client
  });
}

/**
 * Process an issue/consumption from cost layers
 * Called when issuing inventory (work orders, shipments, adjustments, etc.)
 * Returns the weighted average cost of the consumed quantity
 */
export async function processIssueFromCostLayers(params: {
  tenant_id: string;
  item_id: string;
  location_id: string;
  quantity: number;
  consumption_type: 'issue' | 'production_input' | 'sale' | 'adjustment' | 'scrap' | 'transfer_out';
  consumption_document_id?: string;
  movement_id?: string;
  consumed_at?: Date;
  lot_id?: string;
  notes?: string;
  client?: PoolClient;
}): Promise<{
  total_cost: number;
  weighted_average_cost: number;
}> {
  // Consume from cost layers in FIFO order
  const result = await costLayersService.consumeCostLayers({
    tenant_id: params.tenant_id,
    item_id: params.item_id,
    location_id: params.location_id,
    quantity: params.quantity,
    consumption_type: params.consumption_type,
    consumption_document_id: params.consumption_document_id,
    movement_id: params.movement_id,
    consumed_at: params.consumed_at,
    lot_id: params.lot_id,
    notes: params.notes,
    client: params.client
  });

  return {
    total_cost: result.total_cost,
    weighted_average_cost: result.weighted_average_cost
  };
}

/**
 * Get the current cost for an item at a location
 * This can be used for costing estimates before actually consuming
 */
export async function getCurrentItemCost(
  tenant_id: string,
  item_id: string,
  location_id: string
): Promise<{
  average_cost: number;
  total_quantity: number;
  total_value: number;
} | null> {
  return await costLayersService.getCurrentWeightedAverageCost(
    tenant_id,
    item_id,
    location_id
  );
}

/**
 * Helper to decide whether to use cost layers or fallback to standard cost
 * During transition period, we can check if cost layers exist, and if not, use standard cost
 */
export async function shouldUseCostLayers(
  tenant_id: string,
  item_id: string,
  location_id: string
): Promise<boolean> {
  const layers = await costLayersService.getAvailableLayers(
    tenant_id,
    item_id,
    location_id
  );
  return layers.length > 0;
}

/**
 * Initialize cost layers from current inventory snapshot (one-time migration helper)
 * This can be used to seed cost layers based on current on-hand inventory
 */
export async function initializeCostLayersFromSnapshot(
  tenant_id: string,
  item_id: string,
  location_id: string,
  quantity: number,
  cost_per_unit: number,
  client?: PoolClient
): Promise<void> {
  if (quantity <= 0) {
    return; // Nothing to initialize
  }

  const itemConfig = await getItemUomConfig(tenant_id, item_id, client);
  await costLayersService.createCostLayer({
    tenant_id,
    item_id,
    location_id,
    uom: itemConfig.canonicalUom,
    quantity,
    unit_cost: cost_per_unit,
    source_type: 'opening_balance',
    layer_date: new Date(),
    notes: 'Initial cost layer from inventory snapshot',
    client
  });
}

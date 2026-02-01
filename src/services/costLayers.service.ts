import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { query, pool } from '../db';

/**
 * Cost Layer Management Service
 * 
 * Implements FIFO (First-In-First-Out) cost layer tracking for accurate inventory valuation and COGS.
 * 
 * Key concepts:
 * - Each receipt creates a new cost layer with its actual cost
 * - Layers are consumed in FIFO order (oldest first)
 * - Partially consumed layers remain active with reduced remaining_quantity
 * - All consumptions are tracked in cost_layer_consumptions for audit trail
 */

export interface CostLayer {
  id: string;
  tenant_id: string;
  item_id: string;
  location_id: string;
  uom: string;
  layer_date: Date;
  layer_sequence: number;
  original_quantity: number;
  remaining_quantity: number;
  unit_cost: number;
  extended_cost: number;
  source_type: 'receipt' | 'production' | 'adjustment' | 'opening_balance' | 'transfer_in';
  source_document_id?: string;
  movement_id?: string;
  lot_id?: string;
  notes?: string;
  created_at: Date;
  updated_at: Date;
}

export interface CostLayerConsumption {
  id: string;
  tenant_id: string;
  cost_layer_id: string;
  consumed_quantity: number;
  unit_cost: number;
  extended_cost: number;
  consumption_type: 'issue' | 'production_input' | 'sale' | 'adjustment' | 'scrap' | 'transfer_out';
  consumption_document_id?: string;
  movement_id?: string;
  wip_execution_id?: string;
  wip_allocated_at?: Date;
  consumed_at: Date;
  notes?: string;
  created_at: Date;
}

interface CreateLayerParams {
  tenant_id: string;
  item_id: string;
  location_id: string;
  uom: string;
  quantity: number;
  unit_cost: number;
  source_type: CostLayer['source_type'];
  source_document_id?: string;
  movement_id?: string;
  lot_id?: string;
  layer_date?: Date;
  notes?: string;
  client?: PoolClient;
}

interface ConsumeLayersParams {
  tenant_id: string;
  item_id: string;
  location_id: string;
  quantity: number;
  consumption_type: CostLayerConsumption['consumption_type'];
  consumption_document_id?: string;
  movement_id?: string;
  consumed_at?: Date;
  lot_id?: string; // If specified, only consume from this lot
  notes?: string;
  client?: PoolClient;
}

interface ConsumeLayersResult {
  total_cost: number;
  weighted_average_cost: number;
  consumptions: Array<{
    layer_id: string;
    quantity: number;
    unit_cost: number;
    extended_cost: number;
  }>;
}

/**
 * Create a new cost layer from a receipt, production, or adjustment
 */
export async function createCostLayer(params: CreateLayerParams): Promise<CostLayer> {
  const id = uuidv4();
  const layer_date = params.layer_date || new Date();
  const extended_cost = params.quantity * params.unit_cost;
  const executor = params.client ? params.client.query.bind(params.client) : query;

  // Get next sequence number for this date
  const seqResult = await executor<{ max_seq: number }>(
    `SELECT COALESCE(MAX(layer_sequence), 0) as max_seq
     FROM inventory_cost_layers
     WHERE tenant_id = $1 
       AND item_id = $2 
       AND location_id = $3 
       AND DATE(layer_date) = DATE($4)`,
    [params.tenant_id, params.item_id, params.location_id, layer_date]
  );
  const layer_sequence = (seqResult.rows[0]?.max_seq || 0) + 1;

  const result = await executor<CostLayer>(
    `INSERT INTO inventory_cost_layers (
      id, tenant_id, item_id, location_id, uom,
      layer_date, layer_sequence,
      original_quantity, remaining_quantity,
      unit_cost, extended_cost,
      source_type, source_document_id, movement_id, lot_id, notes
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    RETURNING *`,
    [
      id,
      params.tenant_id,
      params.item_id,
      params.location_id,
      params.uom,
      layer_date,
      layer_sequence,
      params.quantity,
      params.quantity, // remaining_quantity starts equal to original_quantity
      params.unit_cost,
      extended_cost,
      params.source_type,
      params.source_document_id || null,
      params.movement_id || null,
      params.lot_id || null,
      params.notes || null
    ]
  );

  return result.rows[0];
}

/**
 * Create a receipt cost layer exactly once per receipt line.
 * Uses ON CONFLICT DO NOTHING to ensure concurrency safety.
 */
export async function createReceiptCostLayerOnce(params: CreateLayerParams): Promise<CostLayer> {
  if (params.source_type !== 'receipt' || !params.source_document_id) {
    throw new Error('COST_LAYER_RECEIPT_SOURCE_REQUIRED');
  }
  const id = uuidv4();
  const layer_date = params.layer_date || new Date();
  const extended_cost = params.quantity * params.unit_cost;
  const executor = params.client ? params.client.query.bind(params.client) : query;

  const seqResult = await executor<{ max_seq: number }>(
    `SELECT COALESCE(MAX(layer_sequence), 0) as max_seq
     FROM inventory_cost_layers
     WHERE tenant_id = $1 
       AND item_id = $2 
       AND location_id = $3 
       AND DATE(layer_date) = DATE($4)`,
    [params.tenant_id, params.item_id, params.location_id, layer_date]
  );
  const layer_sequence = (seqResult.rows[0]?.max_seq || 0) + 1;

  const insertResult = await executor<CostLayer>(
    `INSERT INTO inventory_cost_layers (
      id, tenant_id, item_id, location_id, uom,
      layer_date, layer_sequence,
      original_quantity, remaining_quantity,
      unit_cost, extended_cost,
      source_type, source_document_id, movement_id, lot_id, notes
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    ON CONFLICT DO NOTHING
    RETURNING *`,
    [
      id,
      params.tenant_id,
      params.item_id,
      params.location_id,
      params.uom,
      layer_date,
      layer_sequence,
      params.quantity,
      params.quantity,
      params.unit_cost,
      extended_cost,
      params.source_type,
      params.source_document_id || null,
      params.movement_id || null,
      params.lot_id || null,
      params.notes || null
    ]
  );

  if (insertResult.rowCount > 0) {
    return insertResult.rows[0];
  }

  const existing = await executor<CostLayer>(
    `SELECT *
       FROM inventory_cost_layers
      WHERE tenant_id = $1
        AND source_type = 'receipt'
        AND source_document_id = $2
        AND voided_at IS NULL
      LIMIT 1`,
    [params.tenant_id, params.source_document_id]
  );
  if (existing.rowCount === 0) {
    throw new Error('COST_LAYER_RECEIPT_CONFLICT_MISSING');
  }
  return existing.rows[0];
}

/**
 * Get available cost layers for an item/location (FIFO order)
 */
export async function getAvailableLayers(
  tenant_id: string,
  item_id: string,
  location_id: string,
  lot_id?: string,
  client?: PoolClient
): Promise<CostLayer[]> {
  const executor = client ? client.query.bind(client) : query;
  let sql = `
    SELECT * FROM inventory_cost_layers
    WHERE tenant_id = $1 
      AND item_id = $2 
      AND location_id = $3 
      AND remaining_quantity > 0
      AND voided_at IS NULL
  `;
  const params: any[] = [tenant_id, item_id, location_id];

  if (lot_id) {
    sql += ` AND lot_id = $4`;
    params.push(lot_id);
  }

  sql += ` ORDER BY layer_date ASC, layer_sequence ASC`;

  const result = await executor<CostLayer>(sql, params);
  return result.rows;
}

/**
 * Consume from cost layers in FIFO order
 * Returns the total cost and records all consumptions
 */
export async function consumeCostLayers(params: ConsumeLayersParams): Promise<ConsumeLayersResult> {
  const externalClient = params.client;
  const client = externalClient ?? (await pool.connect());
  const ownsClient = !externalClient;
  
  try {
    if (ownsClient) {
      await client.query('BEGIN');
    }

    // Get available layers in FIFO order
    const layers = await getAvailableLayers(
      params.tenant_id,
      params.item_id,
      params.location_id,
      params.lot_id,
      client
    );

    if (layers.length === 0) {
      throw new Error(`No cost layers available for item ${params.item_id} at location ${params.location_id}`);
    }

    // Calculate total available quantity
    const total_available = layers.reduce((sum, layer) => sum + Number(layer.remaining_quantity), 0);
    
    if (total_available < params.quantity) {
      throw new Error(
        `Insufficient quantity in cost layers. Requested: ${params.quantity}, Available: ${total_available}`
      );
    }

    let remaining_to_consume = params.quantity;
    let total_cost = 0;
    const consumptions: ConsumeLayersResult['consumptions'] = [];
    const consumed_at = params.consumed_at || new Date();

    // Consume from layers in FIFO order
    for (const layer of layers) {
      if (remaining_to_consume <= 0) break;

      const consume_from_layer = Math.min(Number(layer.remaining_quantity), remaining_to_consume);
      const layer_cost = consume_from_layer * Number(layer.unit_cost);

      // Record consumption
      const consumption_id = uuidv4();
      await client.query(
        `INSERT INTO cost_layer_consumptions (
          id, tenant_id, cost_layer_id,
          consumed_quantity, unit_cost, extended_cost,
          consumption_type, consumption_document_id, movement_id,
          consumed_at, notes
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          consumption_id,
          params.tenant_id,
          layer.id,
          consume_from_layer,
          layer.unit_cost,
          layer_cost,
          params.consumption_type,
          params.consumption_document_id || null,
          params.movement_id || null,
          consumed_at,
          params.notes || null
        ]
      );

      // Update layer remaining quantity
      const new_remaining = Number(layer.remaining_quantity) - consume_from_layer;
      const new_extended = new_remaining * Number(layer.unit_cost);
      
      await client.query(
        `UPDATE inventory_cost_layers 
         SET remaining_quantity = $1,
             extended_cost = $2,
             updated_at = NOW()
         WHERE id = $3`,
        [new_remaining, new_extended, layer.id]
      );

      consumptions.push({
        layer_id: layer.id,
        quantity: consume_from_layer,
        unit_cost: Number(layer.unit_cost),
        extended_cost: layer_cost
      });

      total_cost += layer_cost;
      remaining_to_consume -= consume_from_layer;
    }

    if (ownsClient) {
      await client.query('COMMIT');
    }

    const weighted_average_cost = total_cost / params.quantity;

    return {
      total_cost,
      weighted_average_cost,
      consumptions
    };

  } catch (error) {
    if (ownsClient) {
      await client.query('ROLLBACK');
    }
    throw error;
  } finally {
    if (ownsClient) {
      client.release();
    }
  }
}

/**
 * Get current weighted average cost for an item/location based on available layers
 */
export async function getCurrentWeightedAverageCost(
  tenant_id: string,
  item_id: string,
  location_id: string
): Promise<{ average_cost: number; total_quantity: number; total_value: number } | null> {
  const result = await query<{ 
    total_quantity: string; 
    total_value: string; 
    average_cost: string;
  }>(
    `SELECT 
       SUM(remaining_quantity) as total_quantity,
       SUM(extended_cost) as total_value,
       CASE 
         WHEN SUM(remaining_quantity) > 0 
         THEN SUM(extended_cost) / SUM(remaining_quantity)
         ELSE 0
       END as average_cost
     FROM inventory_cost_layers
     WHERE tenant_id = $1 
       AND item_id = $2 
       AND location_id = $3 
       AND remaining_quantity > 0
       AND voided_at IS NULL`,
    [tenant_id, item_id, location_id]
  );

  const row = result.rows[0];
  if (!row || Number(row.total_quantity) === 0) {
    return null;
  }

  return {
    average_cost: Number(row.average_cost),
    total_quantity: Number(row.total_quantity),
    total_value: Number(row.total_value)
  };
}

/**
 * Get COGS (Cost of Goods Sold) for a time period
 */
export async function getCOGSForPeriod(
  tenant_id: string,
  start_date: Date,
  end_date: Date,
  item_id?: string,
  location_id?: string
): Promise<Array<{
  item_id: string;
  location_id: string;
  total_quantity_consumed: number;
  total_cogs: number;
  average_cost: number;
}>> {
  let sql = `
    SELECT 
      icl.item_id,
      icl.location_id,
      SUM(clc.consumed_quantity) as total_quantity_consumed,
      SUM(clc.extended_cost) as total_cogs,
      SUM(clc.extended_cost) / NULLIF(SUM(clc.consumed_quantity), 0) as average_cost
    FROM cost_layer_consumptions clc
    JOIN inventory_cost_layers icl ON clc.cost_layer_id = icl.id
    WHERE clc.tenant_id = $1
      AND clc.consumed_at >= $2
      AND clc.consumed_at < $3
  `;
  const params: any[] = [tenant_id, start_date, end_date];

  if (item_id) {
    params.push(item_id);
    sql += ` AND icl.item_id = $${params.length}`;
  }

  if (location_id) {
    params.push(location_id);
    sql += ` AND icl.location_id = $${params.length}`;
  }

  sql += ` GROUP BY icl.item_id, icl.location_id ORDER BY total_cogs DESC`;

  const result = await query<{
    item_id: string;
    location_id: string;
    total_quantity_consumed: string;
    total_cogs: string;
    average_cost: string;
  }>(sql, params);

  return result.rows.map((row: any) => ({
    item_id: row.item_id,
    location_id: row.location_id,
    total_quantity_consumed: Number(row.total_quantity_consumed),
    total_cogs: Number(row.total_cogs),
    average_cost: Number(row.average_cost)
  }));
}

/**
 * Get cost layer details for an item/location (for reporting/analysis)
 */
export async function getCostLayerDetails(
  tenant_id: string,
  item_id: string,
  location_id?: string
): Promise<Array<CostLayer & { 
  consumed_quantity: number;
  consumption_count: number;
}>> {
  let sql = `
    SELECT 
      icl.*,
      COALESCE(SUM(clc.consumed_quantity), 0) as consumed_quantity,
      COUNT(clc.id) as consumption_count
    FROM inventory_cost_layers icl
    LEFT JOIN cost_layer_consumptions clc ON icl.id = clc.cost_layer_id
    WHERE icl.tenant_id = $1 
      AND icl.item_id = $2
  `;
  const params: any[] = [tenant_id, item_id];

  if (location_id) {
    params.push(location_id);
    sql += ` AND icl.location_id = $${params.length}`;
  }

  sql += `
    GROUP BY icl.id
    ORDER BY icl.layer_date DESC, icl.layer_sequence DESC
  `;

  const result = await query<CostLayer & { 
    consumed_quantity: string;
    consumption_count: string;
  }>(sql, params);

  return result.rows.map((row: any) => ({
    ...row,
    consumed_quantity: Number(row.consumed_quantity),
    consumption_count: Number(row.consumption_count)
  }));
}

/**
 * Get consumption history for a cost layer
 */
export async function getLayerConsumptions(
  tenant_id: string,
  cost_layer_id: string
): Promise<CostLayerConsumption[]> {
  const result = await query<CostLayerConsumption>(
    `SELECT * FROM cost_layer_consumptions
     WHERE tenant_id = $1 AND cost_layer_id = $2
     ORDER BY consumed_at DESC`,
    [tenant_id, cost_layer_id]
  );

  return result.rows;
}

/**
 * Delete a cost layer (only if not consumed)
 * Used for reversing incorrect receipts/adjustments
 */
export async function deleteCostLayer(
  tenant_id: string,
  cost_layer_id: string
): Promise<void> {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Check if layer has any consumptions
    const consumptionCheck = await client.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM cost_layer_consumptions
       WHERE tenant_id = $1 AND cost_layer_id = $2`,
      [tenant_id, cost_layer_id]
    );

    if (Number(consumptionCheck.rows[0].count) > 0) {
      throw new Error('Cannot delete cost layer that has been consumed. Use adjustment instead.');
    }

    // Check remaining quantity equals original (nothing consumed)
    const layerCheck = await client.query<CostLayer>(
      `SELECT * FROM inventory_cost_layers
       WHERE tenant_id = $1 AND id = $2`,
      [tenant_id, cost_layer_id]
    );

    if (layerCheck.rows.length === 0) {
      throw new Error('Cost layer not found');
    }

    const layer = layerCheck.rows[0];
    if (Number(layer.remaining_quantity) !== Number(layer.original_quantity)) {
      throw new Error('Cannot delete partially consumed cost layer');
    }

    // Delete the layer
    await client.query(
      `DELETE FROM inventory_cost_layers
       WHERE tenant_id = $1 AND id = $2`,
      [tenant_id, cost_layer_id]
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

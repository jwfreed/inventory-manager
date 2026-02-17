import { query } from '../db';

/**
 * Enhanced Reports Using Cost Layers
 * 
 * These reports use the cost layer system for more accurate inventory valuation and COGS
 */

export type CostLayerValuationRow = {
  itemId: string;
  itemSku: string;
  itemName: string;
  locationId: string;
  locationCode: string;
  locationName: string;
  uom: string;
  quantityOnHand: number;
  layerBasedValue: number;
  layerBasedAverageCost: number;
  layerCount: number;
  oldestLayerDate: Date | null;
  newestLayerDate: Date | null;
};

export type CostLayerValuationSummary = {
  totalItems: number;
  totalQuantity: number;
  totalValue: number;
  totalLayers: number;
};

/**
 * Get inventory valuation based on cost layers
 * This provides more accurate valuation than simple average cost
 */
export async function getInventoryValuationByCostLayers(
  tenantId: string,
  options?: {
    locationId?: string;
    itemType?: string;
    minValue?: number;
    limit?: number;
    offset?: number;
  }
): Promise<{
  data: CostLayerValuationRow[];
  summary: CostLayerValuationSummary;
}> {
  const { locationId, itemType, minValue, limit = 500, offset = 0 } = options || {};

  const params: any[] = [tenantId];
  const whereClauses: string[] = ['cl.remaining_quantity > 0'];
  
  if (locationId) {
    whereClauses.push(`cl.location_id = $${params.push(locationId)}`);
  }

  if (itemType) {
    whereClauses.push(`i.type = $${params.push(itemType)}`);
  }

  const whereClause = whereClauses.length ? `AND ${whereClauses.join(' AND ')}` : '';

  // Main query - aggregate cost layers by item and location
  const dataResult = await query<{
    item_id: string;
    item_sku: string;
    item_name: string;
    location_id: string;
    location_code: string;
    location_name: string;
    uom: string;
    quantity_on_hand: string;
    total_value: string;
    layer_count: string;
    oldest_layer: string | null;
    newest_layer: string | null;
  }>(
    `SELECT 
      i.id as item_id,
      i.sku as item_sku,
      i.name as item_name,
      l.id as location_id,
      l.code as location_code,
      l.name as location_name,
      cl.uom,
      SUM(cl.remaining_quantity) as quantity_on_hand,
      SUM(cl.remaining_quantity * cl.unit_cost) as total_value,
      COUNT(cl.id) as layer_count,
      MIN(cl.layer_date) as oldest_layer,
      MAX(cl.layer_date) as newest_layer
    FROM inventory_cost_layers cl
    JOIN items i ON cl.item_id = i.id
    JOIN locations l ON cl.location_id = l.id
    WHERE cl.tenant_id = $1
      AND cl.voided_at IS NULL
      ${whereClause}
    GROUP BY i.id, i.sku, i.name, l.id, l.code, l.name, cl.uom
    ${minValue ? `HAVING SUM(cl.remaining_quantity * cl.unit_cost) >= $${params.push(minValue)}` : ''}
    ORDER BY total_value DESC
    LIMIT $${params.push(limit)} OFFSET $${params.push(offset)}`,
    params
  );

  // Summary query
  const summaryResult = await query<{
    total_items: string;
    total_quantity: string;
    total_value: string;
    total_layers: string;
  }>(
    `SELECT 
      COUNT(DISTINCT CONCAT(i.id, '|', l.id)) as total_items,
      SUM(cl.remaining_quantity) as total_quantity,
      SUM(cl.remaining_quantity * cl.unit_cost) as total_value,
      COUNT(cl.id) as total_layers
    FROM inventory_cost_layers cl
    JOIN items i ON cl.item_id = i.id
    JOIN locations l ON cl.location_id = l.id
    WHERE cl.tenant_id = $1
      AND cl.voided_at IS NULL
      AND cl.remaining_quantity > 0
      ${whereClause}`,
    [tenantId, ...(locationId ? [locationId] : []), ...(itemType ? [itemType] : [])]
  );

  const data = dataResult.rows.map(row => ({
    itemId: row.item_id,
    itemSku: row.item_sku,
    itemName: row.item_name,
    locationId: row.location_id,
    locationCode: row.location_code,
    locationName: row.location_name,
    uom: row.uom,
    quantityOnHand: Number(row.quantity_on_hand),
    layerBasedValue: Number(row.total_value),
    layerBasedAverageCost: Number(row.total_value) / Number(row.quantity_on_hand),
    layerCount: Number(row.layer_count),
    oldestLayerDate: row.oldest_layer ? new Date(row.oldest_layer) : null,
    newestLayerDate: row.newest_layer ? new Date(row.newest_layer) : null
  }));

  const summaryRow = summaryResult.rows[0];
  const summary = {
    totalItems: Number(summaryRow?.total_items || 0),
    totalQuantity: Number(summaryRow?.total_quantity || 0),
    totalValue: Number(summaryRow?.total_value || 0),
    totalLayers: Number(summaryRow?.total_layers || 0)
  };

  return { data, summary };
}

/**
 * Get cost variance comparing standard cost to cost layer average
 */
export async function getCostVarianceByCostLayers(
  tenantId: string,
  options?: {
    locationId?: string;
    minVariancePercent?: number;
    limit?: number;
    offset?: number;
  }
): Promise<Array<{
  itemId: string;
  itemSku: string;
  itemName: string;
  locationId: string;
  locationCode: string;
  standardCost: number | null;
  layerBasedAverageCost: number;
  variance: number;
  variancePercent: number;
  quantityOnHand: number;
  extendedVariance: number;
}>> {
  const { locationId, minVariancePercent, limit = 500, offset = 0 } = options || {};

  const params: any[] = [tenantId];
  const whereClauses: string[] = ['cl.remaining_quantity > 0'];
  
  if (locationId) {
    whereClauses.push(`cl.location_id = $${params.push(locationId)}`);
  }

  const whereClause = whereClauses.length ? `AND ${whereClauses.join(' AND ')}` : '';

  const result = await query<{
    item_id: string;
    item_sku: string;
    item_name: string;
    location_id: string;
    location_code: string;
    standard_cost: string | null;
    quantity_on_hand: string;
    total_value: string;
  }>(
    `SELECT 
      i.id as item_id,
      i.sku as item_sku,
      i.name as item_name,
      l.id as location_id,
      l.code as location_code,
      COALESCE(i.standard_cost_base, i.standard_cost) AS standard_cost,
      SUM(cl.remaining_quantity) as quantity_on_hand,
      SUM(cl.remaining_quantity * cl.unit_cost) as total_value
    FROM inventory_cost_layers cl
    JOIN items i ON cl.item_id = i.id
    JOIN locations l ON cl.location_id = l.id
    WHERE cl.tenant_id = $1
      AND cl.voided_at IS NULL
      ${whereClause}
    GROUP BY i.id, i.sku, i.name, COALESCE(i.standard_cost_base, i.standard_cost), l.id, l.code
    HAVING SUM(cl.remaining_quantity) > 0
    ORDER BY i.sku
    LIMIT $${params.push(limit)} OFFSET $${params.push(offset)}`,
    params
  );

  const rows = result.rows.map(row => {
    const standardCost = row.standard_cost ? Number(row.standard_cost) : null;
    const quantityOnHand = Number(row.quantity_on_hand);
    const totalValue = Number(row.total_value);
    const layerBasedAverageCost = totalValue / quantityOnHand;
    
    const variance = standardCost !== null ? layerBasedAverageCost - standardCost : 0;
    const variancePercent = standardCost && standardCost !== 0 
      ? (variance / standardCost) * 100 
      : 0;
    const extendedVariance = variance * quantityOnHand;

    return {
      itemId: row.item_id,
      itemSku: row.item_sku,
      itemName: row.item_name,
      locationId: row.location_id,
      locationCode: row.location_code,
      standardCost,
      layerBasedAverageCost,
      variance,
      variancePercent,
      quantityOnHand,
      extendedVariance
    };
  });

  // Filter by variance percent if specified
  if (minVariancePercent !== undefined) {
    return rows.filter(row => Math.abs(row.variancePercent) >= minVariancePercent);
  }

  return rows;
}

/**
 * Get COGS analysis for a period
 */
export async function getCOGSAnalysis(
  tenantId: string,
  startDate: Date,
  endDate: Date,
  options?: {
    itemId?: string;
    locationId?: string;
    consumptionType?: string;
    groupBy?: 'item' | 'location' | 'type' | 'month';
  }
): Promise<Array<{
  groupKey: string;
  groupLabel: string;
  totalQuantityConsumed: number;
  totalCOGS: number;
  averageCost: number;
  consumptionCount: number;
}>> {
  const { itemId, locationId, consumptionType, groupBy = 'item' } = options || {};

  const params: any[] = [tenantId, startDate, endDate];
  const whereClauses: string[] = [];
  
  if (itemId) {
    whereClauses.push(`cl.item_id = $${params.push(itemId)}`);
  }

  if (locationId) {
    whereClauses.push(`cl.location_id = $${params.push(locationId)}`);
  }

  if (consumptionType) {
    whereClauses.push(`clc.consumption_type = $${params.push(consumptionType)}`);
  }

  const whereClause = whereClauses.length ? `AND ${whereClauses.join(' AND ')}` : '';

  let groupByClause: string;
  let groupKey: string;
  let groupLabel: string;

  switch (groupBy) {
    case 'location':
      groupByClause = 'cl.location_id, l.code, l.name';
      groupKey = 'cl.location_id';
      groupLabel = "CONCAT(l.code, ' - ', l.name)";
      break;
    case 'type':
      groupByClause = 'clc.consumption_type';
      groupKey = 'clc.consumption_type';
      groupLabel = 'clc.consumption_type';
      break;
    case 'month':
      groupByClause = "DATE_TRUNC('month', clc.consumed_at)";
      groupKey = "TO_CHAR(DATE_TRUNC('month', clc.consumed_at), 'YYYY-MM')";
      groupLabel = "TO_CHAR(DATE_TRUNC('month', clc.consumed_at), 'YYYY-MM')";
      break;
    default: // 'item'
      groupByClause = 'cl.item_id, i.sku, i.name';
      groupKey = 'cl.item_id';
      groupLabel = "CONCAT(i.sku, ' - ', i.name)";
  }

  const result = await query<{
    group_key: string;
    group_label: string;
    total_quantity: string;
    total_cogs: string;
    consumption_count: string;
  }>(
    `SELECT 
      ${groupKey} as group_key,
      ${groupLabel} as group_label,
      SUM(clc.consumed_quantity) as total_quantity,
      SUM(clc.extended_cost) as total_cogs,
      COUNT(clc.id) as consumption_count
    FROM cost_layer_consumptions clc
    JOIN inventory_cost_layers cl ON clc.cost_layer_id = cl.id AND cl.voided_at IS NULL
    LEFT JOIN items i ON cl.item_id = i.id
    LEFT JOIN locations l ON cl.location_id = l.id
    WHERE clc.tenant_id = $1
      AND clc.consumed_at >= $2
      AND clc.consumed_at < $3
      ${whereClause}
    GROUP BY ${groupByClause}
    ORDER BY total_cogs DESC`,
    params
  );

  return result.rows.map(row => ({
    groupKey: row.group_key,
    groupLabel: row.group_label,
    totalQuantityConsumed: Number(row.total_quantity),
    totalCOGS: Number(row.total_cogs),
    averageCost: Number(row.total_cogs) / Number(row.total_quantity),
    consumptionCount: Number(row.consumption_count)
  }));
}

/**
 * Get inventory aging based on cost layer dates
 */
export async function getInventoryAgingByCostLayers(
  tenantId: string,
  options?: {
    locationId?: string;
    agingBuckets?: number[]; // days, e.g., [30, 60, 90, 180]
  }
): Promise<Array<{
  itemId: string;
  itemSku: string;
  itemName: string;
  locationId: string;
  locationCode: string;
  agingBucket: string;
  quantity: number;
  value: number;
  averageAge: number;
}>> {
  const { locationId, agingBuckets = [30, 60, 90, 180, 365] } = options || {};

  const params: any[] = [tenantId];
  const whereClauses: string[] = ['cl.remaining_quantity > 0'];
  
  if (locationId) {
    whereClauses.push(`cl.location_id = $${params.push(locationId)}`);
  }

  const whereClause = whereClauses.length ? `AND ${whereClauses.join(' AND ')}` : '';

  // Build CASE statement for aging buckets
  const bucketCases = agingBuckets.map((days, index) => {
    if (index === 0) {
      return `WHEN age <= ${days} THEN '0-${days} days'`;
    } else {
      return `WHEN age <= ${days} THEN '${agingBuckets[index - 1] + 1}-${days} days'`;
    }
  }).join('\n        ');

  const result = await query<{
    item_id: string;
    item_sku: string;
    item_name: string;
    location_id: string;
    location_code: string;
    aging_bucket: string;
    quantity: string;
    value: string;
    avg_age: string;
  }>(
    `WITH layer_age AS (
      SELECT 
        cl.*,
        EXTRACT(DAY FROM AGE(NOW(), cl.layer_date))::integer as age
      FROM inventory_cost_layers cl
      WHERE cl.tenant_id = $1
        AND cl.voided_at IS NULL
        ${whereClause}
    )
    SELECT 
      i.id as item_id,
      i.sku as item_sku,
      i.name as item_name,
      l.id as location_id,
      l.code as location_code,
      CASE 
        ${bucketCases}
        ELSE '${agingBuckets[agingBuckets.length - 1]}+ days'
      END as aging_bucket,
      SUM(la.remaining_quantity) as quantity,
      SUM(la.remaining_quantity * la.unit_cost) as value,
      AVG(la.age) as avg_age
    FROM layer_age la
    JOIN items i ON la.item_id = i.id
    JOIN locations l ON la.location_id = l.id
    GROUP BY i.id, i.sku, i.name, l.id, l.code, aging_bucket
    ORDER BY i.sku, l.code, 
      CASE aging_bucket
        ${agingBuckets.map((days, index) => 
          index === 0 
            ? `WHEN '0-${days} days' THEN ${index}` 
            : `WHEN '${agingBuckets[index - 1] + 1}-${days} days' THEN ${index}`
        ).join('\n        ')}
        ELSE ${agingBuckets.length}
      END`,
    params
  );

  return result.rows.map(row => ({
    itemId: row.item_id,
    itemSku: row.item_sku,
    itemName: row.item_name,
    locationId: row.location_id,
    locationCode: row.location_code,
    agingBucket: row.aging_bucket,
    quantity: Number(row.quantity),
    value: Number(row.value),
    averageAge: Number(row.avg_age)
  }));
}

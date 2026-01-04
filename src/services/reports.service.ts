import { query } from '../db';

export type InventoryValuationRow = {
  itemId: string;
  itemSku: string;
  itemName: string;
  locationId: string;
  locationCode: string;
  locationName: string;
  uom: string;
  quantityOnHand: number;
  averageCost: number | null;
  standardCost: number | null;
  extendedValue: number | null;
};

export type InventoryValuationSummary = {
  totalItems: number;
  totalQuantity: number;
  totalValue: number;
  totalValuedItems: number;
  totalUnvaluedItems: number;
};

export type CostVarianceRow = {
  itemId: string;
  itemSku: string;
  itemName: string;
  standardCost: number | null;
  averageCost: number | null;
  variance: number | null;
  variancePercent: number | null;
  quantityOnHand: number;
};

export type ReceiptCostAnalysisRow = {
  receiptId: string;
  receiptDate: string;
  poNumber: string;
  vendorCode: string;
  vendorName: string;
  itemId: string;
  itemSku: string;
  itemName: string;
  quantityReceived: number;
  uom: string;
  expectedUnitCost: number | null;
  actualUnitCost: number | null;
  variance: number | null;
  variancePercent: number | null;
  extendedVariance: number | null;
};

/**
 * Get inventory valuation report
 * Shows quantity on hand and extended value by item and location
 */
export async function getInventoryValuation(
  tenantId: string,
  options?: {
    locationId?: string;
    itemType?: string;
    includeZeroQty?: boolean;
    limit?: number;
    offset?: number;
  }
): Promise<{
  data: InventoryValuationRow[];
  summary: InventoryValuationSummary;
}> {
  const { locationId, itemType, includeZeroQty = false, limit = 500, offset = 0 } = options || {};

  const params: any[] = [tenantId];
  const whereClauses: string[] = [];
  
  if (locationId) {
    whereClauses.push(`iml.location_id = $${params.push(locationId)}`);
  }

  if (itemType) {
    whereClauses.push(`i.type = $${params.push(itemType)}`);
  }

  const whereMovements = whereClauses.length ? `AND ${whereClauses.join(' AND ')}` : '';
  const havingClause = includeZeroQty ? '' : 'HAVING SUM(iml.quantity_delta) > 0';

  // Main data query - calculate on_hand from movement lines
  const dataQuery = `
    WITH on_hand AS (
      SELECT 
        iml.item_id,
        iml.location_id,
        iml.uom,
        SUM(iml.quantity_delta) AS quantity_on_hand
      FROM inventory_movement_lines iml
      JOIN inventory_movements im ON im.id = iml.movement_id
      WHERE im.status = 'posted'
        AND iml.tenant_id = $1
        AND im.tenant_id = $1
        ${whereMovements}
      GROUP BY iml.item_id, iml.location_id, iml.uom
      ${havingClause}
    )
    SELECT 
      i.id as item_id,
      i.sku as item_sku,
      i.name as item_name,
      l.id as location_id,
      l.code as location_code,
      l.name as location_name,
      oh.uom,
      oh.quantity_on_hand,
      NULL::numeric as average_cost,
      i.standard_cost,
      CASE 
        WHEN i.standard_cost IS NOT NULL THEN oh.quantity_on_hand * i.standard_cost
        ELSE NULL
      END as extended_value
    FROM on_hand oh
    JOIN items i ON i.id = oh.item_id AND i.tenant_id = $1
    JOIN locations l ON l.id = oh.location_id AND l.tenant_id = $1
    ORDER BY i.sku, l.code
    LIMIT $${params.push(limit)} OFFSET $${params.push(offset)}
  `;

  const dataResult = await query<InventoryValuationRow>(dataQuery, params);

  // Summary query (without limit/offset)
  const summaryQuery = `
    WITH on_hand AS (
      SELECT 
        iml.item_id,
        iml.location_id,
        iml.uom,
        SUM(iml.quantity_delta) AS quantity_on_hand
      FROM inventory_movement_lines iml
      JOIN inventory_movements im ON im.id = iml.movement_id
      WHERE im.status = 'posted'
        AND iml.tenant_id = $1
        AND im.tenant_id = $1
        ${whereMovements}
      GROUP BY iml.item_id, iml.location_id, iml.uom
      ${havingClause}
    )
    SELECT 
      COUNT(DISTINCT i.id) as total_items,
      COALESCE(SUM(oh.quantity_on_hand), 0) as total_quantity,
      COALESCE(SUM(
        CASE 
          WHEN i.standard_cost IS NOT NULL THEN oh.quantity_on_hand * i.standard_cost
          ELSE 0
        END
      ), 0) as total_value,
      COUNT(DISTINCT CASE WHEN i.standard_cost IS NOT NULL THEN i.id END) as total_valued_items,
      COUNT(DISTINCT CASE WHEN i.standard_cost IS NULL THEN i.id END) as total_unvalued_items
    FROM on_hand oh
    JOIN items i ON i.id = oh.item_id AND i.tenant_id = $1
    JOIN locations l ON l.id = oh.location_id AND l.tenant_id = $1
  `;

  const summaryParams = params.slice(0, params.length - 2); // Remove limit and offset
  const summaryResult = await query<any>(summaryQuery, summaryParams);

  // Map database rows to camelCase
  const mappedData = dataResult.rows.map((row: any) => ({
    itemId: row.item_id,
    itemSku: row.item_sku,
    itemName: row.item_name,
    locationId: row.location_id,
    locationCode: row.location_code,
    locationName: row.location_name,
    uom: row.uom,
    quantityOnHand: parseFloat(row.quantity_on_hand || '0'),
    averageCost: row.average_cost ? parseFloat(row.average_cost) : null,
    standardCost: row.standard_cost ? parseFloat(row.standard_cost) : null,
    extendedValue: row.extended_value ? parseFloat(row.extended_value) : null,
  }));

  return {
    data: mappedData,
    summary: {
      totalItems: parseInt(summaryResult.rows[0]?.total_items || '0'),
      totalQuantity: parseFloat(summaryResult.rows[0]?.total_quantity || '0'),
      totalValue: parseFloat(summaryResult.rows[0]?.total_value || '0'),
      totalValuedItems: parseInt(summaryResult.rows[0]?.total_valued_items || '0'),
      totalUnvaluedItems: parseInt(summaryResult.rows[0]?.total_unvalued_items || '0'),
    },
  };
}

/**
 * Get cost variance report
 * Shows differences between standard cost and average cost
 * 
 * Note: Average cost calculation requires cost layer tracking which is not yet implemented.
 * This simplified version returns items with standard costs and current on-hand quantities.
 */
export async function getCostVariance(
  tenantId: string,
  options?: {
    minVariancePercent?: number;
    itemType?: string;
    limit?: number;
    offset?: number;
  }
): Promise<{ data: CostVarianceRow[] }> {
  const { itemType, limit = 500, offset = 0 } = options || {};

  let whereConditions = ['i.tenant_id = $1', 'i.standard_cost IS NOT NULL'];
  const params: any[] = [tenantId];
  let paramIndex = 2;

  if (itemType) {
    whereConditions.push(`i.type = $${paramIndex}`);
    params.push(itemType);
    paramIndex++;
  }

  const whereClause = whereConditions.join(' AND ');

  // Calculate on-hand from movement lines (similar to ATP calculation)
  const sql = `
    WITH on_hand AS (
      SELECT 
        iml.item_id,
        SUM(iml.quantity_delta) AS quantity_on_hand
      FROM inventory_movement_lines iml
      JOIN inventory_movements im ON im.id = iml.movement_id
      WHERE im.status = 'posted'
        AND iml.tenant_id = $1
        AND im.tenant_id = $1
      GROUP BY iml.item_id
      HAVING SUM(iml.quantity_delta) > 0
    )
    SELECT 
      i.id as item_id,
      i.sku as item_sku,
      i.name as item_name,
      i.standard_cost,
      NULL::numeric as average_cost,
      NULL::numeric as variance,
      NULL::numeric as variance_percent,
      COALESCE(oh.quantity_on_hand, 0) as quantity_on_hand
    FROM items i
    LEFT JOIN on_hand oh ON i.id = oh.item_id
    WHERE ${whereClause}
    ORDER BY i.sku
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
  `;

  params.push(limit, offset);

  const result = await query<CostVarianceRow>(sql, params);

  return { data: result.rows };
}

/**
 * Get receipt cost analysis
 * Compares expected cost (PO line unit price) vs actual cost (receipt line unit cost)
 */
export async function getReceiptCostAnalysis(
  tenantId: string,
  options?: {
    startDate?: string;
    endDate?: string;
    vendorId?: string;
    minVariancePercent?: number;
    limit?: number;
    offset?: number;
  }
): Promise<{ data: ReceiptCostAnalysisRow[] }> {
  const { startDate, endDate, vendorId, minVariancePercent, limit = 500, offset = 0 } = options || {};

  let whereConditions = ['r.tenant_id = $1', 'pol.unit_price IS NOT NULL'];
  const params: any[] = [tenantId];
  let paramIndex = 2;

  if (startDate) {
    whereConditions.push(`r.receipt_date >= $${paramIndex}`);
    params.push(startDate);
    paramIndex++;
  }

  if (endDate) {
    whereConditions.push(`r.receipt_date <= $${paramIndex}`);
    params.push(endDate);
    paramIndex++;
  }

  if (vendorId) {
    whereConditions.push(`po.vendor_id = $${paramIndex}`);
    params.push(vendorId);
    paramIndex++;
  }

  const whereClause = whereConditions.join(' AND ');

  // Build HAVING clause for variance filter
  let havingClause = '';
  if (minVariancePercent !== undefined) {
    havingClause = `
      HAVING ABS(
        CASE 
          WHEN pol.unit_price > 0 THEN 
            ((COALESCE(rl.unit_cost, pol.unit_price) - pol.unit_price) / pol.unit_price * 100)
          ELSE 0
        END
      ) >= $${paramIndex}
    `;
    params.push(minVariancePercent);
    paramIndex++;
  }

  const sql = `
    SELECT 
      r.id as receipt_id,
      r.receipt_date::text,
      po.po_number,
      v.code as vendor_code,
      v.name as vendor_name,
      i.id as item_id,
      i.sku as item_sku,
      i.name as item_name,
      rl.quantity_received,
      rl.uom,
      pol.unit_price as expected_unit_cost,
      rl.unit_cost as actual_unit_cost,
      CASE 
        WHEN pol.unit_price IS NOT NULL THEN 
          COALESCE(rl.unit_cost, pol.unit_price) - pol.unit_price
        ELSE NULL
      END as variance,
      CASE 
        WHEN pol.unit_price > 0 THEN 
          ((COALESCE(rl.unit_cost, pol.unit_price) - pol.unit_price) / pol.unit_price * 100)
        ELSE NULL
      END as variance_percent,
      CASE 
        WHEN pol.unit_price IS NOT NULL THEN 
          (COALESCE(rl.unit_cost, pol.unit_price) - pol.unit_price) * rl.quantity_received
        ELSE NULL
      END as extended_variance
    FROM purchase_order_receipt_lines rl
    JOIN purchase_order_receipts r ON rl.purchase_order_receipt_id = r.id AND rl.tenant_id = r.tenant_id
    JOIN purchase_order_lines pol ON rl.po_line_id = pol.id AND rl.tenant_id = pol.tenant_id
    JOIN purchase_orders po ON pol.purchase_order_id = po.id AND pol.tenant_id = po.tenant_id
    JOIN vendors v ON po.vendor_id = v.id AND po.tenant_id = v.tenant_id
    JOIN items i ON rl.item_id = i.id AND rl.tenant_id = i.tenant_id
    WHERE ${whereClause}
    ${havingClause}
    ORDER BY r.receipt_date DESC, po.po_number, i.sku
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
  `;

  params.push(limit, offset);

  const result = await query<ReceiptCostAnalysisRow>(sql, params);

  return { data: result.rows };
}

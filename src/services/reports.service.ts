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
    whereConditions.push(`r.received_at >= $${paramIndex}`);
    params.push(startDate);
    paramIndex++;
  }

  if (endDate) {
    whereConditions.push(`r.received_at <= $${paramIndex}`);
    params.push(endDate);
    paramIndex++;
  }

  if (vendorId) {
    whereConditions.push(`po.vendor_id = $${paramIndex}`);
    params.push(vendorId);
    paramIndex++;
  }

  // Add variance filter to WHERE clause
  if (minVariancePercent !== undefined) {
    whereConditions.push(`
      ABS(
        CASE 
          WHEN pol.unit_price > 0 THEN 
            ((COALESCE(rl.unit_cost, pol.unit_price) - pol.unit_price) / pol.unit_price * 100)
          ELSE 0
        END
      ) >= $${paramIndex}
    `);
    params.push(minVariancePercent);
    paramIndex++;
  }

  const whereClause = whereConditions.join(' AND ');

  const sql = `
    SELECT 
      r.id as receipt_id,
      r.received_at::text as receipt_date,
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
    JOIN purchase_order_lines pol ON rl.purchase_order_line_id = pol.id AND rl.tenant_id = pol.tenant_id
    JOIN purchase_orders po ON pol.purchase_order_id = po.id AND pol.tenant_id = po.tenant_id
    JOIN vendors v ON po.vendor_id = v.id AND po.tenant_id = v.tenant_id
    JOIN items i ON pol.item_id = i.id AND pol.tenant_id = i.tenant_id
    WHERE ${whereClause}
    ORDER BY r.received_at DESC, po.po_number, i.sku
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
  `;

  params.push(limit, offset);

  const result = await query<ReceiptCostAnalysisRow>(sql, params);

  return { data: result.rows };
}

// ============================================================================
// PHASE 1 PRODUCTION & INVENTORY REPORTS
// ============================================================================

// Work Order Progress Report Types
export type WorkOrderProgressRow = {
  workOrderId: string;
  workOrderNumber: string;
  itemId: string;
  itemSku: string;
  itemName: string;
  status: string;
  orderType: string;
  quantityPlanned: number;
  quantityCompleted: number;
  percentComplete: number;
  dueDate: string | null;
  daysUntilDue: number | null;
  isLate: boolean;
  createdAt: string;
};

export async function getWorkOrderProgress(params: {
  tenantId: string;
  startDate?: string;
  endDate?: string;
  status?: string;
  itemId?: string;
  includeCompleted?: boolean;
  limit?: number;
  offset?: number;
}): Promise<{ data: WorkOrderProgressRow[] }> {
  const {
    tenantId,
    startDate,
    endDate,
    status,
    itemId,
    includeCompleted = false,
    limit = 100,
    offset = 0,
  } = params;

  let whereConditions = ['wo.tenant_id = $1'];
  const queryParams: any[] = [tenantId];
  let paramIndex = 2;

  if (startDate) {
    whereConditions.push(`wo.created_at >= $${paramIndex}`);
    queryParams.push(startDate);
    paramIndex++;
  }

  if (endDate) {
    whereConditions.push(`wo.created_at <= $${paramIndex}`);
    queryParams.push(endDate);
    paramIndex++;
  }

  if (status) {
    whereConditions.push(`wo.status = $${paramIndex}`);
    queryParams.push(status);
    paramIndex++;
  }

  if (itemId) {
    whereConditions.push(`wo.output_item_id = $${paramIndex}`);
    queryParams.push(itemId);
    paramIndex++;
  }

  if (!includeCompleted) {
    whereConditions.push(`wo.status NOT IN ('completed', 'closed', 'canceled')`);
  }

  const whereClause = whereConditions.join(' AND ');

  const sql = `
    SELECT 
      wo.id as "workOrderId",
      wo.work_order_number as "workOrderNumber",
      wo.output_item_id as "itemId",
      i.sku as "itemSku",
      i.name as "itemName",
      wo.status,
      wo.kind as "orderType",
      wo.quantity_planned as "quantityPlanned",
      COALESCE(
        (SELECT SUM(quantity)
         FROM work_order_execution_lines woel
         JOIN work_order_executions woe ON woel.work_order_execution_id = woe.id
         WHERE woe.work_order_id = wo.id 
           AND woel.line_type = 'produce'
           AND woe.status = 'posted'),
        0
      ) as "quantityCompleted",
      CASE 
        WHEN wo.quantity_planned > 0 THEN 
          ROUND((COALESCE(
            (SELECT SUM(quantity)
             FROM work_order_execution_lines woel
             JOIN work_order_executions woe ON woel.work_order_execution_id = woe.id
             WHERE woe.work_order_id = wo.id 
               AND woel.line_type = 'produce'
               AND woe.status = 'posted'),
            0
          ) / wo.quantity_planned * 100)::numeric, 2)
        ELSE 0
      END as "percentComplete",
      wo.scheduled_due_at::text as "dueDate",
      CASE 
        WHEN wo.scheduled_due_at IS NOT NULL THEN 
          (wo.scheduled_due_at::date - CURRENT_DATE)
        ELSE NULL
      END as "daysUntilDue",
      CASE 
        WHEN wo.scheduled_due_at IS NOT NULL AND wo.scheduled_due_at::date < CURRENT_DATE 
          AND wo.status NOT IN ('completed', 'closed') THEN true
        ELSE false
      END as "isLate",
      wo.created_at::text as "createdAt"
    FROM work_orders wo
    JOIN items i ON wo.output_item_id = i.id AND wo.tenant_id = i.tenant_id
    WHERE ${whereClause}
    ORDER BY 
      CASE WHEN wo.scheduled_due_at::date < CURRENT_DATE THEN 0 ELSE 1 END,
      wo.scheduled_due_at ASC NULLS LAST,
      wo.created_at DESC
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
  `;

  queryParams.push(limit, offset);

  const result = await query<WorkOrderProgressRow>(sql, queryParams);
  return { data: result.rows };
}

// Movement Transaction History Report Types
export type MovementTransactionRow = {
  movementId: string;
  movementNumber: string;
  movementType: string;
  status: string;
  movementDate: string;
  lineId: string;
  itemId: string;
  itemSku: string;
  itemName: string;
  locationId: string;
  locationCode: string;
  locationName: string;
  quantity: number;
  uom: string;
  unitCost: number | null;
  extendedValue: number | null;
  lotNumber: string | null;
  referenceType: string | null;
  referenceNumber: string | null;
  notes: string | null;
  createdAt: string;
  postedAt: string | null;
};

export async function getMovementTransactionHistory(params: {
  tenantId: string;
  startDate?: string;
  endDate?: string;
  itemId?: string;
  locationId?: string;
  movementType?: string;
  limit?: number;
  offset?: number;
}): Promise<{ data: MovementTransactionRow[] }> {
  const {
    tenantId,
    startDate,
    endDate,
    itemId,
    locationId,
    movementType,
    limit = 100,
    offset = 0,
  } = params;

  let whereConditions = ['im.tenant_id = $1'];
  const queryParams: any[] = [tenantId];
  let paramIndex = 2;

  if (startDate) {
    whereConditions.push(`im.occurred_at >= $${paramIndex}`);
    queryParams.push(startDate);
    paramIndex++;
  }

  if (endDate) {
    whereConditions.push(`im.occurred_at <= $${paramIndex}`);
    queryParams.push(endDate);
    paramIndex++;
  }

  if (itemId) {
    whereConditions.push(`iml.item_id = $${paramIndex}`);
    queryParams.push(itemId);
    paramIndex++;
  }

  if (locationId) {
    whereConditions.push(`iml.location_id = $${paramIndex}`);
    queryParams.push(locationId);
    paramIndex++;
  }

  if (movementType) {
    whereConditions.push(`im.movement_type = $${paramIndex}`);
    queryParams.push(movementType);
    paramIndex++;
  }

  const whereClause = whereConditions.join(' AND ');

  const sql = `
    SELECT 
      im.id as "movementId",
      im.external_ref as "movementNumber",
      im.movement_type as "movementType",
      im.status,
      im.occurred_at::text as "movementDate",
      iml.id as "lineId",
      iml.item_id as "itemId",
      i.sku as "itemSku",
      i.name as "itemName",
      iml.location_id as "locationId",
      l.code as "locationCode",
      l.name as "locationName",
      iml.quantity_delta as quantity,
      iml.uom,
      NULL::numeric as "unitCost",
      NULL::numeric as "extendedValue",
      lot.lot_code as "lotNumber",
      im.movement_type as "referenceType",
      im.external_ref as "referenceNumber",
      im.notes,
      im.created_at::text as "createdAt",
      im.posted_at::text as "postedAt"
    FROM inventory_movements im
    JOIN inventory_movement_lines iml ON im.id = iml.movement_id
    JOIN items i ON iml.item_id = i.id AND iml.tenant_id = i.tenant_id
    JOIN locations l ON iml.location_id = l.id AND iml.tenant_id = l.tenant_id
    LEFT JOIN (
      SELECT iml_lot.inventory_movement_line_id, MIN(l.lot_code) as lot_code
      FROM inventory_movement_lots iml_lot
      JOIN lots l ON iml_lot.lot_id = l.id
      GROUP BY iml_lot.inventory_movement_line_id
    ) lot ON iml.id = lot.inventory_movement_line_id
    WHERE ${whereClause}
    ORDER BY im.occurred_at DESC, im.created_at DESC, iml.id
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
  `;

  queryParams.push(limit, offset);

  const result = await query<MovementTransactionRow>(sql, queryParams);
  return { data: result.rows };
}

// Inventory Movement Velocity Report Types
export type InventoryVelocityRow = {
  itemId: string;
  itemSku: string;
  itemName: string;
  itemType: string;
  totalMovements: number;
  quantityIn: number;
  quantityOut: number;
  netChange: number;
  currentOnHand: number;
  daysInPeriod: number;
  avgDailyMovement: number;
  turnoverProxy: number | null;
};

export async function getInventoryMovementVelocity(params: {
  tenantId: string;
  startDate: string;
  endDate: string;
  itemType?: string;
  locationId?: string;
  minMovements?: number;
  limit?: number;
  offset?: number;
}): Promise<{ data: InventoryVelocityRow[] }> {
  const {
    tenantId,
    startDate,
    endDate,
    itemType,
    locationId,
    minMovements = 0,
    limit = 100,
    offset = 0,
  } = params;

  let havingConditions: string[] = [];
  let whereConditions = ['im.tenant_id = $1', 'im.status = $2'];
  const queryParams: any[] = [tenantId, 'posted'];
  let paramIndex = 3;

  queryParams.push(startDate);
  whereConditions.push(`im.occurred_at >= $${paramIndex}`);
  paramIndex++;

  queryParams.push(endDate);
  whereConditions.push(`im.occurred_at <= $${paramIndex}`);
  paramIndex++;

  if (itemType) {
    whereConditions.push(`i.item_type = $${paramIndex}`);
    queryParams.push(itemType);
    paramIndex++;
  }

  if (locationId) {
    whereConditions.push(`iml.location_id = $${paramIndex}`);
    queryParams.push(locationId);
    paramIndex++;
  }

  if (minMovements > 0) {
    havingConditions.push(`COUNT(DISTINCT im.id) >= $${paramIndex}`);
    queryParams.push(minMovements);
    paramIndex++;
  }

  const whereClause = whereConditions.join(' AND ');
  const havingClause = havingConditions.length > 0 
    ? `HAVING ${havingConditions.join(' AND ')}`
    : '';

  const sql = `
    WITH movement_stats AS (
      SELECT 
        iml.item_id,
        i.sku,
        i.name,
        i.type as item_type,
        COUNT(DISTINCT im.id) as total_movements,
        SUM(CASE WHEN iml.quantity_delta > 0 THEN iml.quantity_delta ELSE 0 END) as quantity_in,
        SUM(CASE WHEN iml.quantity_delta < 0 THEN ABS(iml.quantity_delta) ELSE 0 END) as quantity_out,
        SUM(iml.quantity_delta) as net_change,
        ($4::date - $3::date) + 1 as days_in_period
      FROM inventory_movements im
      JOIN inventory_movement_lines iml ON im.id = iml.movement_id
      JOIN items i ON iml.item_id = i.id AND iml.tenant_id = i.tenant_id
      WHERE ${whereClause}
      GROUP BY iml.item_id, i.sku, i.name, i.type
      ${havingClause}
    ),
    current_inventory AS (
      SELECT 
        iml.item_id,
        SUM(iml.quantity_delta) as quantity_on_hand
      FROM inventory_movement_lines iml
      JOIN inventory_movements im ON iml.movement_id = im.id
      WHERE im.tenant_id = $1 
        AND im.status = 'posted'
        ${locationId ? `AND iml.location_id = $${queryParams.indexOf(locationId) + 1}` : ''}
      GROUP BY iml.item_id
    )
    SELECT 
      ms.item_id as "itemId",
      ms.sku as "itemSku",
      ms.name as "itemName",
      ms.item_type as "itemType",
      ms.total_movements as "totalMovements",
      ms.quantity_in as "quantityIn",
      ms.quantity_out as "quantityOut",
      ms.net_change as "netChange",
      COALESCE(ci.quantity_on_hand, 0) as "currentOnHand",
      ms.days_in_period::integer as "daysInPeriod",
      ROUND((ms.quantity_out / NULLIF(ms.days_in_period, 0))::numeric, 2) as "avgDailyMovement",
      CASE 
        WHEN COALESCE(ci.quantity_on_hand, 0) > 0 THEN 
          ROUND((ms.quantity_out / NULLIF(COALESCE(ci.quantity_on_hand, 0), 0))::numeric, 2)
        ELSE NULL
      END as "turnoverProxy"
    FROM movement_stats ms
    LEFT JOIN current_inventory ci ON ms.item_id = ci.item_id
    ORDER BY ms.quantity_out DESC, ms.total_movements DESC
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
  `;

  queryParams.push(limit, offset);

  const result = await query<InventoryVelocityRow>(sql, queryParams);
  return { data: result.rows };
}

// Open PO Aging Report Types
export type OpenPOAgingRow = {
  purchaseOrderId: string;
  poNumber: string;
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  status: string;
  orderDate: string;
  promisedDate: string | null;
  daysOpen: number;
  daysOverdue: number | null;
  totalLines: number;
  receivedLines: number;
  outstandingLines: number;
  totalOrdered: number;
  totalReceived: number;
  fillRate: number;
};

export async function getOpenPOAging(params: {
  tenantId: string;
  vendorId?: string;
  minDaysOpen?: number;
  includeFullyReceived?: boolean;
  limit?: number;
  offset?: number;
}): Promise<{ data: OpenPOAgingRow[] }> {
  const {
    tenantId,
    vendorId,
    minDaysOpen = 0,
    includeFullyReceived = false,
    limit = 100,
    offset = 0,
  } = params;

  let whereConditions = ['po.tenant_id = $1'];
  const queryParams: any[] = [tenantId];
  let paramIndex = 2;

  if (!includeFullyReceived) {
    whereConditions.push(`po.status NOT IN ('received', 'closed', 'canceled')`);
  } else {
    whereConditions.push(`po.status NOT IN ('canceled')`);
  }

  if (vendorId) {
    whereConditions.push(`po.vendor_id = $${paramIndex}`);
    queryParams.push(vendorId);
    paramIndex++;
  }

  if (minDaysOpen > 0) {
    whereConditions.push(`(CURRENT_DATE - po.order_date) >= $${paramIndex}`);
    queryParams.push(minDaysOpen);
    paramIndex++;
  }

  const whereClause = whereConditions.join(' AND ');

  const sql = `
    WITH po_stats AS (
      SELECT 
        pol.purchase_order_id,
        COUNT(pol.id) as total_lines,
        SUM(CASE WHEN COALESCE(rcpt.quantity_received, 0) >= pol.quantity_ordered THEN 1 ELSE 0 END) as received_lines,
        SUM(pol.quantity_ordered) as total_ordered,
        SUM(COALESCE(rcpt.quantity_received, 0)) as total_received
      FROM purchase_order_lines pol
      LEFT JOIN (
        SELECT 
          porl.purchase_order_line_id,
          SUM(porl.quantity_received) as quantity_received
        FROM purchase_order_receipt_lines porl
        JOIN purchase_order_receipts por ON porl.purchase_order_receipt_id = por.id
        WHERE por.tenant_id = $1 AND por.status = 'posted'
        GROUP BY porl.purchase_order_line_id
      ) rcpt ON pol.id = rcpt.purchase_order_line_id
      WHERE pol.tenant_id = $1
      GROUP BY pol.purchase_order_id
    )
    SELECT 
      po.id as "purchaseOrderId",
      po.po_number as "poNumber",
      po.vendor_id as "vendorId",
      v.code as "vendorCode",
      v.name as "vendorName",
      po.status,
      po.order_date::text as "orderDate",
      po.expected_date::text as "expectedDate",
      (CURRENT_DATE - po.order_date) as "daysOpen",
      CASE 
        WHEN po.expected_date IS NOT NULL AND po.expected_date < CURRENT_DATE 
          AND po.status NOT IN ('received', 'closed') THEN
          (CURRENT_DATE - po.expected_date)
        ELSE NULL
      END as "daysOverdue",
      COALESCE(ps.total_lines, 0) as "totalLines",
      COALESCE(ps.received_lines, 0) as "receivedLines",
      COALESCE(ps.total_lines, 0) - COALESCE(ps.received_lines, 0) as "outstandingLines",
      COALESCE(ps.total_ordered, 0) as "totalOrdered",
      COALESCE(ps.total_received, 0) as "totalReceived",
      CASE 
        WHEN COALESCE(ps.total_ordered, 0) > 0 THEN 
          ROUND((COALESCE(ps.total_received, 0) / ps.total_ordered * 100)::numeric, 2)
        ELSE 0
      END as "fillRate"
    FROM purchase_orders po
    JOIN vendors v ON po.vendor_id = v.id AND po.tenant_id = v.tenant_id
    LEFT JOIN po_stats ps ON po.id = ps.purchase_order_id
    WHERE ${whereClause}
    ORDER BY 
      CASE WHEN po.expected_date < CURRENT_DATE THEN 0 ELSE 1 END,
      "daysOpen" DESC
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
  `;

  queryParams.push(limit, offset);

  const result = await query<OpenPOAgingRow>(sql, queryParams);
  return { data: result.rows };
}

// Sales Order Fill Performance Report Types
export type SalesOrderFillRow = {
  salesOrderId: string;
  soNumber: string;
  customerCode: string | null;
  customerName: string | null;
  status: string;
  orderDate: string;
  requestedDate: string | null;
  shippedDate: string | null;
  daysToShip: number | null;
  isLate: boolean;
  totalLines: number;
  shippedLines: number;
  outstandingLines: number;
  totalOrdered: number;
  totalShipped: number;
  fillRate: number;
  onTimeShipment: boolean;
};

export async function getSalesOrderFillPerformance(params: {
  tenantId: string;
  startDate?: string;
  endDate?: string;
  customerId?: string;
  includeFullyShipped?: boolean;
  onlyLate?: boolean;
  limit?: number;
  offset?: number;
}): Promise<{ data: SalesOrderFillRow[] }> {
  const {
    tenantId,
    startDate,
    endDate,
    customerId,
    includeFullyShipped = false,
    onlyLate = false,
    limit = 100,
    offset = 0,
  } = params;

  let whereConditions = ['so.tenant_id = $1'];
  const queryParams: any[] = [tenantId];
  let paramIndex = 2;

  if (!includeFullyShipped) {
    whereConditions.push(`so.status NOT IN ('shipped', 'closed', 'canceled')`);
  } else {
    whereConditions.push(`so.status NOT IN ('canceled')`);
  }

  if (startDate) {
    whereConditions.push(`so.order_date >= $${paramIndex}`);
    queryParams.push(startDate);
    paramIndex++;
  }

  if (endDate) {
    whereConditions.push(`so.order_date <= $${paramIndex}`);
    queryParams.push(endDate);
    paramIndex++;
  }

  if (customerId) {
    whereConditions.push(`so.customer_id = $${paramIndex}`);
    queryParams.push(customerId);
    paramIndex++;
  }

  if (onlyLate) {
    whereConditions.push(`so.requested_ship_date IS NOT NULL`);
    whereConditions.push(`so.status NOT IN ('shipped', 'closed', 'canceled')`);
    whereConditions.push(`so.requested_ship_date < CURRENT_DATE`);
  }

  const whereClause = whereConditions.join(' AND ');

  const sql = `
    WITH so_stats AS (
      SELECT 
        sol.sales_order_id,
        COUNT(sol.id) as total_lines,
        SUM(CASE WHEN COALESCE(ship.quantity_shipped, 0) >= sol.quantity_ordered THEN 1 ELSE 0 END) as shipped_lines,
        SUM(sol.quantity_ordered) as total_ordered,
        SUM(COALESCE(ship.quantity_shipped, 0)) as total_shipped
      FROM sales_order_lines sol
      LEFT JOIN (
        SELECT 
          sosl.sales_order_line_id,
          SUM(sosl.quantity_shipped) as quantity_shipped
        FROM sales_order_shipment_lines sosl
        JOIN sales_order_shipments sos ON sosl.sales_order_shipment_id = sos.id
        WHERE sos.tenant_id = $1
        GROUP BY sosl.sales_order_line_id
      ) ship ON sol.id = ship.sales_order_line_id
      WHERE sol.tenant_id = $1
      GROUP BY sol.sales_order_id
    ),
    shipment_dates AS (
      SELECT 
        sos.sales_order_id,
        MAX(sos.shipped_at) as last_shipped_at
      FROM sales_order_shipments sos
      WHERE sos.tenant_id = $1
      GROUP BY sos.sales_order_id
    )
    SELECT 
      so.id as "salesOrderId",
      so.so_number as "soNumber",
      c.code as "customerCode",
      c.name as "customerName",
      so.status,
      so.order_date::text as "orderDate",
      so.requested_ship_date::text as "requestedDate",
      sd.last_shipped_at::date::text as "shippedDate",
      CASE 
        WHEN sd.last_shipped_at IS NOT NULL THEN
          (sd.last_shipped_at::date - so.order_date)
        ELSE NULL
      END as "daysToShip",
      CASE 
        WHEN so.requested_ship_date IS NOT NULL 
          AND sd.last_shipped_at IS NULL 
          AND so.requested_ship_date < CURRENT_DATE 
          AND so.status NOT IN ('shipped', 'closed', 'canceled') THEN true
        WHEN so.requested_ship_date IS NOT NULL 
          AND sd.last_shipped_at IS NOT NULL 
          AND sd.last_shipped_at::date > so.requested_ship_date THEN true
        ELSE false
      END as "isLate",
      COALESCE(ss.total_lines, 0) as "totalLines",
      COALESCE(ss.shipped_lines, 0) as "shippedLines",
      COALESCE(ss.total_lines, 0) - COALESCE(ss.shipped_lines, 0) as "outstandingLines",
      COALESCE(ss.total_ordered, 0) as "totalOrdered",
      COALESCE(ss.total_shipped, 0) as "totalShipped",
      CASE 
        WHEN COALESCE(ss.total_ordered, 0) > 0 THEN 
          ROUND((COALESCE(ss.total_shipped, 0) / ss.total_ordered * 100)::numeric, 2)
        ELSE 0
      END as "fillRate",
      CASE 
        WHEN so.requested_ship_date IS NULL THEN true
        WHEN sd.last_shipped_at IS NULL THEN false
        WHEN sd.last_shipped_at::date <= so.requested_ship_date THEN true
        ELSE false
      END as "onTimeShipment"
    FROM sales_orders so
    JOIN customers c ON so.customer_id = c.id AND so.tenant_id = c.tenant_id
    LEFT JOIN so_stats ss ON so.id = ss.sales_order_id
    LEFT JOIN shipment_dates sd ON so.id = sd.sales_order_id
    WHERE ${whereClause}
    ORDER BY 
      CASE 
        WHEN so.requested_ship_date IS NOT NULL 
          AND sd.last_shipped_at IS NULL 
          AND so.requested_ship_date < CURRENT_DATE 
          AND so.status NOT IN ('shipped', 'closed', 'canceled') THEN 0
        WHEN so.requested_ship_date IS NOT NULL 
          AND sd.last_shipped_at IS NOT NULL 
          AND sd.last_shipped_at::date > so.requested_ship_date THEN 0
        ELSE 1
      END,
      so.order_date DESC
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
  `;

  queryParams.push(limit, offset);

  const result = await query<SalesOrderFillRow>(sql, queryParams);
  return { data: result.rows };
}

// Production Run Frequency Report Types
export type ProductionRunFrequencyRow = {
  itemId: string;
  itemSku: string;
  itemName: string;
  itemType: string;
  totalRuns: number;
  totalQuantityProduced: number;
  avgBatchSize: number;
  minBatchSize: number;
  maxBatchSize: number;
  lastProductionDate: string | null;
  daysSinceLastProduction: number | null;
};

export async function getProductionRunFrequency(params: {
  tenantId: string;
  startDate: string;
  endDate: string;
  itemType?: string;
  itemId?: string;
  minRuns?: number;
  limit?: number;
  offset?: number;
}): Promise<{ data: ProductionRunFrequencyRow[] }> {
  const {
    tenantId,
    startDate,
    endDate,
    itemType,
    itemId,
    minRuns = 0,
    limit = 100,
    offset = 0,
  } = params;

  let whereConditions = ['wo.tenant_id = $1', 'wo.kind = $2'];
  let havingConditions: string[] = [];
  const queryParams: any[] = [tenantId, 'production'];
  let paramIndex = 3;

  queryParams.push(startDate);
  whereConditions.push(`woe.occurred_at >= $${paramIndex}`);
  paramIndex++;

  queryParams.push(endDate);
  whereConditions.push(`woe.occurred_at <= $${paramIndex}`);
  paramIndex++;

  if (itemType) {
    whereConditions.push(`i.type = $${paramIndex}`);
    queryParams.push(itemType);
    paramIndex++;
  }

  if (itemId) {
    whereConditions.push(`wo.output_item_id = $${paramIndex}`);
    queryParams.push(itemId);
    paramIndex++;
  }

  if (minRuns > 0) {
    havingConditions.push(`COUNT(DISTINCT woe.id) >= $${paramIndex}`);
    queryParams.push(minRuns);
    paramIndex++;
  }

  const whereClause = whereConditions.join(' AND ');
  const havingClause = havingConditions.length > 0 
    ? `HAVING ${havingConditions.join(' AND ')}`
    : '';

  const sql = `
    WITH execution_produced AS (
      SELECT 
        woe.id as execution_id,
        COALESCE(SUM(woel.quantity), 0) as quantity_produced
      FROM work_order_executions woe
      LEFT JOIN work_order_execution_lines woel ON woel.work_order_execution_id = woe.id
        AND woel.line_type = 'produce'
      WHERE woe.status = 'posted'
        AND woe.tenant_id = $1
      GROUP BY woe.id
    ),
    production_stats AS (
      SELECT 
        wo.output_item_id as item_id,
        i.sku,
        i.name,
        i.type as item_type,
        COUNT(DISTINCT woe.id)::integer as total_runs,
        COALESCE(SUM(ep.quantity_produced), 0)::numeric as total_quantity_produced,
        MAX(woe.occurred_at)::date as last_production_date
      FROM work_orders wo
      JOIN work_order_executions woe ON wo.id = woe.work_order_id
      JOIN items i ON wo.output_item_id = i.id AND wo.tenant_id = i.tenant_id
      LEFT JOIN execution_produced ep ON woe.id = ep.execution_id
      WHERE ${whereClause}
        AND woe.status = 'posted'
      GROUP BY wo.output_item_id, i.sku, i.name, i.type
      ${havingClause}
    )
    SELECT 
      item_id as "itemId",
      sku as "itemSku",
      name as "itemName",
      item_type as "itemType",
      total_runs as "totalRuns",
      total_quantity_produced as "totalQuantityProduced",
      ROUND((total_quantity_produced / NULLIF(total_runs, 0))::numeric, 2) as "avgBatchSize",
      0 as "minBatchSize",
      0 as "maxBatchSize",
      last_production_date::text as "lastProductionDate",
      CASE 
        WHEN last_production_date IS NOT NULL THEN
          (CURRENT_DATE - last_production_date)
        ELSE NULL::integer
      END as "daysSinceLastProduction"
    FROM production_stats
    ORDER BY "totalRuns" DESC, "totalQuantityProduced" DESC
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
  `;

  queryParams.push(limit, offset);

  const result = await query<ProductionRunFrequencyRow>(sql, queryParams);
  return { data: result.rows };
}

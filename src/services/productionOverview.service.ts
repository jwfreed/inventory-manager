import { query } from '../db';
import { roundQuantity } from '../lib/numbers';

interface ProductionOverviewQuery {
  dateFrom?: string;
  dateTo?: string;
  itemId?: string;
  locationId?: string;
  workCenterId?: string;
}

/**
 * Get production volume trend data - completed work orders by period
 */
export async function getProductionVolumeTrend(
  tenantId: string,
  filters: ProductionOverviewQuery
) {
  const params: any[] = [tenantId];
  let paramCount = 1;

  let whereClause = '';
  if (filters.dateFrom) {
    params.push(filters.dateFrom);
    whereClause += ` AND wo.completed_at >= $${++paramCount}`;
  }
  if (filters.dateTo) {
    params.push(filters.dateTo);
    whereClause += ` AND wo.completed_at <= $${++paramCount}`;
  }
  if (filters.itemId) {
    params.push(filters.itemId);
    whereClause += ` AND wo.output_item_id = $${++paramCount}`;
  }
  if (filters.locationId) {
    params.push(filters.locationId);
    whereClause += ` AND wo.default_produce_location_id = $${++paramCount}`;
  }

  const sql = `
    SELECT 
      DATE_TRUNC('day', wo.completed_at) as period,
      COUNT(wo.id) as work_order_count,
      SUM(wo.quantity_completed) as total_quantity
    FROM work_orders wo
    WHERE wo.tenant_id = $1
      AND wo.status = 'completed'
      AND wo.completed_at IS NOT NULL
      ${whereClause}
    GROUP BY DATE_TRUNC('day', wo.completed_at)
    ORDER BY period ASC
  `;

  const result = await query(sql, params);

  return result.rows.map(row => ({
    period: row.period,
    workOrderCount: Number(row.work_order_count),
    totalQuantity: roundQuantity(Number(row.total_quantity))
  }));
}

/**
 * Get top/bottom SKUs by production frequency and batch size
 */
export async function getTopBottomSKUs(
  tenantId: string,
  filters: ProductionOverviewQuery
) {
  const params: any[] = [tenantId];
  let paramCount = 1;

  let whereClause = '';
  if (filters.dateFrom) {
    params.push(filters.dateFrom);
    whereClause += ` AND wo.completed_at >= $${++paramCount}`;
  }
  if (filters.dateTo) {
    params.push(filters.dateTo);
    whereClause += ` AND wo.completed_at <= $${++paramCount}`;
  }
  if (filters.itemId) {
    params.push(filters.itemId);
    whereClause += ` AND wo.output_item_id = $${++paramCount}`;
  }
  if (filters.locationId) {
    params.push(filters.locationId);
    whereClause += ` AND wo.default_produce_location_id = $${++paramCount}`;
  }

  const sql = `
    SELECT 
      wo.output_item_id as item_id,
      COUNT(wo.id) as production_frequency,
      AVG(wo.quantity_completed) as avg_batch_size,
      SUM(wo.quantity_completed) as total_produced,
      wo.output_uom as uom
    FROM work_orders wo
    WHERE wo.tenant_id = $1
      AND wo.status = 'completed'
      AND wo.completed_at IS NOT NULL
      ${whereClause}
    GROUP BY wo.output_item_id, wo.output_uom
    ORDER BY production_frequency DESC, avg_batch_size DESC
  `;

  const result = await query(sql, params);

  return result.rows.map(row => ({
    itemId: row.item_id,
    productionFrequency: Number(row.production_frequency),
    avgBatchSize: roundQuantity(Number(row.avg_batch_size)),
    totalProduced: roundQuantity(Number(row.total_produced)),
    uom: row.uom
  }));
}

/**
 * Get WIP (Work In Progress) status summary
 */
export async function getWIPStatusSummary(
  tenantId: string,
  filters: ProductionOverviewQuery
) {
  const params: any[] = [tenantId];
  let paramCount = 1;

  let whereClause = '';
  if (filters.dateFrom) {
    params.push(filters.dateFrom);
    whereClause += ` AND wo.scheduled_start_at >= $${++paramCount}`;
  }
  if (filters.dateTo) {
    params.push(filters.dateTo);
    whereClause += ` AND wo.scheduled_due_at <= $${++paramCount}`;
  }
  if (filters.itemId) {
    params.push(filters.itemId);
    whereClause += ` AND wo.output_item_id = $${++paramCount}`;
  }
  if (filters.locationId) {
    params.push(filters.locationId);
    whereClause += ` AND wo.default_produce_location_id = $${++paramCount}`;
  }

  const sql = `
    SELECT 
      wo.status,
      COUNT(wo.id) as work_order_count,
      SUM(wo.quantity_planned) as total_planned,
      SUM(COALESCE(wo.quantity_completed, 0)) as total_completed
    FROM work_orders wo
    WHERE wo.tenant_id = $1
      ${whereClause}
    GROUP BY wo.status
    ORDER BY 
      CASE wo.status
        WHEN 'released' THEN 1
        WHEN 'in_progress' THEN 2
        WHEN 'draft' THEN 3
        WHEN 'completed' THEN 4
        WHEN 'cancelled' THEN 5
        ELSE 6
      END
  `;

  const result = await query(sql, params);

  return result.rows.map(row => ({
    status: row.status,
    workOrderCount: Number(row.work_order_count),
    totalPlanned: roundQuantity(Number(row.total_planned)),
    totalCompleted: roundQuantity(Number(row.total_completed))
  }));
}

/**
 * Get materials consumed from work_order_execution_lines
 */
export async function getMaterialsConsumed(
  tenantId: string,
  filters: ProductionOverviewQuery
) {
  const params: any[] = [tenantId];
  let paramCount = 1;

  let whereClause = '';
  if (filters.dateFrom) {
    params.push(filters.dateFrom);
    whereClause += ` AND woe.occurred_at >= $${++paramCount}`;
  }
  if (filters.dateTo) {
    params.push(filters.dateTo);
    whereClause += ` AND woe.occurred_at <= $${++paramCount}`;
  }
  if (filters.itemId) {
    params.push(filters.itemId);
    whereClause += ` AND wo.output_item_id = $${++paramCount}`;
  }
  if (filters.locationId) {
    params.push(filters.locationId);
    whereClause += ` AND woel.from_location_id = $${++paramCount}`;
  }

  const sql = `
    SELECT 
      woel.item_id,
      woel.uom,
      SUM(woel.quantity) as total_consumed,
      COUNT(DISTINCT woe.work_order_id) as work_order_count,
      COUNT(DISTINCT woe.id) as execution_count
    FROM work_order_execution_lines woel
    JOIN work_order_executions woe ON woel.work_order_execution_id = woe.id
    JOIN work_orders wo ON woe.work_order_id = wo.id
    WHERE woel.tenant_id = $1
      AND woel.line_type = 'consume'
      ${whereClause}
    GROUP BY woel.item_id, woel.uom
    ORDER BY total_consumed DESC
  `;

  const result = await query(sql, params);

  return result.rows.map(row => ({
    itemId: row.item_id,
    uom: row.uom,
    totalConsumed: roundQuantity(Number(row.total_consumed)),
    workOrderCount: Number(row.work_order_count),
    executionCount: Number(row.execution_count)
  }));
}

/**
 * Get combined production overview data
 */
export async function getProductionOverview(
  tenantId: string,
  filters: ProductionOverviewQuery
) {
  const [volumeTrend, topBottomSKUs, wipStatus, materialsConsumed] = await Promise.all([
    getProductionVolumeTrend(tenantId, filters),
    getTopBottomSKUs(tenantId, filters),
    getWIPStatusSummary(tenantId, filters),
    getMaterialsConsumed(tenantId, filters)
  ]);

  return {
    volumeTrend,
    topBottomSKUs,
    wipStatus,
    materialsConsumed
  };
}

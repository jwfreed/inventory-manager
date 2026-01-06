import { query } from '../db';

interface BomConsumptionVarianceRow {
  workOrderId: string;
  workOrderNumber: string;
  outputItemId: string;
  outputItemSku: string;
  outputItemName: string;
  executionId: string;
  executionDate: string;
  componentItemId: string;
  componentItemSku: string;
  componentItemName: string;
  expectedQuantity: number;
  actualQuantity: number;
  variance: number;
  variancePercent: number;
}

interface YieldReportRow {
  workOrderId: string;
  workOrderNumber: string;
  outputItemId: string;
  outputItemSku: string;
  outputItemName: string;
  executionId: string;
  executionDate: string;
  expectedQuantity: number;
  actualProducedQuantity: number;
  yieldVariance: number;
  yieldPercent: number;
}

interface ExecutionDurationRow {
  executionId: string;
  workOrderId: string;
  workOrderNumber: string;
  outputItemSku: string;
  outputItemName: string;
  occurredAt: string;
  status: string;
  durationMinutes: number | null;
  consumedItemCount: number;
  producedQuantity: number;
}

/**
 * Service for computing production variance metrics
 * Implements Phase 3: Production variance reporting
 */
export class ProductionVarianceService {
  /**
   * Compute BOM consumption variance by comparing actual consumption
   * (from work_order_execution_lines) vs expected from bom_lines
   * 
   * @param tenantId - Tenant ID
   * @param startDate - Start date for filtering executions
   * @param endDate - End date for filtering executions
   * @param workOrderId - Optional filter by specific work order
   * @param itemId - Optional filter by output item
   */
  static async getBomConsumptionVariance(params: {
    tenantId: string;
    startDate?: string;
    endDate?: string;
    workOrderId?: string;
    itemId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ data: BomConsumptionVarianceRow[] }> {
    const {
      tenantId,
      startDate,
      endDate,
      workOrderId,
      itemId,
      limit = 100,
      offset = 0,
    } = params;

    const whereConditions = ['wo.tenant_id = $1', "woe.status = 'posted'"];
    const queryParams: any[] = [tenantId];
    let paramIndex = 2;

    if (startDate) {
      whereConditions.push(`woe.occurred_at >= $${paramIndex}`);
      queryParams.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      whereConditions.push(`woe.occurred_at < $${paramIndex}`);
      queryParams.push(endDate);
      paramIndex++;
    }

    if (workOrderId) {
      whereConditions.push(`wo.id = $${paramIndex}`);
      queryParams.push(workOrderId);
      paramIndex++;
    }

    if (itemId) {
      whereConditions.push(`wo.output_item_id = $${paramIndex}`);
      queryParams.push(itemId);
      paramIndex++;
    }

    const whereClause = whereConditions.join(' AND ');

    const sql = `
      WITH execution_consumption AS (
        -- Actual consumption from execution lines
        SELECT 
          woe.id as execution_id,
          woe.work_order_id,
          woe.occurred_at,
          woel.item_id as component_item_id,
          SUM(woel.quantity) as actual_quantity
        FROM work_order_executions woe
        JOIN work_order_execution_lines woel 
          ON woe.id = woel.work_order_execution_id
        WHERE woel.line_type = 'consume'
        GROUP BY woe.id, woe.work_order_id, woe.occurred_at, woel.item_id
      ),
      expected_consumption AS (
        -- Expected consumption from BOM (scaled by execution produced quantity)
        SELECT 
          woe.id as execution_id,
          woe.work_order_id,
          bl.component_item_id,
          -- Get produced quantity from execution
          COALESCE(
            (SELECT SUM(woel_prod.quantity)
             FROM work_order_execution_lines woel_prod
             WHERE woel_prod.work_order_execution_id = woe.id
               AND woel_prod.line_type = 'produce'),
            0
          ) as produced_qty,
          -- Expected quantity = BOM quantity * (produced_qty / BOM base quantity)
          bl.quantity * (
            COALESCE(
              (SELECT SUM(woel_prod.quantity)
               FROM work_order_execution_lines woel_prod
               WHERE woel_prod.work_order_execution_id = woe.id
                 AND woel_prod.line_type = 'produce'),
              0
            ) / b.quantity
          ) as expected_quantity
        FROM work_order_executions woe
        JOIN work_orders wo ON woe.work_order_id = wo.id AND woe.tenant_id = wo.tenant_id
        JOIN boms b ON wo.output_item_id = b.item_id AND wo.tenant_id = b.tenant_id
        JOIN bom_lines bl ON b.id = bl.bom_id AND b.tenant_id = bl.tenant_id
        WHERE b.active = true
      )
      SELECT 
        wo.id as work_order_id,
        wo.work_order_number,
        wo.output_item_id,
        oi.sku as output_item_sku,
        oi.name as output_item_name,
        ec.execution_id,
        ec.occurred_at::date::text as execution_date,
        ec.component_item_id,
        ci.sku as component_item_sku,
        ci.name as component_item_name,
        COALESCE(exp.expected_quantity, 0) as expected_quantity,
        COALESCE(ec.actual_quantity, 0) as actual_quantity,
        COALESCE(ec.actual_quantity, 0) - COALESCE(exp.expected_quantity, 0) as variance,
        CASE 
          WHEN COALESCE(exp.expected_quantity, 0) > 0 THEN
            ROUND(
              ((COALESCE(ec.actual_quantity, 0) - COALESCE(exp.expected_quantity, 0)) 
               / exp.expected_quantity * 100)::numeric, 
              2
            )
          ELSE NULL
        END as variance_percent
      FROM execution_consumption ec
      JOIN work_orders wo ON ec.work_order_id = wo.id
      JOIN items oi ON wo.output_item_id = oi.id
      JOIN items ci ON ec.component_item_id = ci.id
      LEFT JOIN expected_consumption exp 
        ON ec.execution_id = exp.execution_id 
        AND ec.component_item_id = exp.component_item_id
      JOIN work_order_executions woe 
        ON ec.execution_id = woe.id
      WHERE ${whereClause}
      ORDER BY ec.occurred_at DESC, wo.work_order_number, ci.sku
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    queryParams.push(limit, offset);

    const result = await query<{
      work_order_id: string;
      work_order_number: string;
      output_item_id: string;
      output_item_sku: string;
      output_item_name: string;
      execution_id: string;
      execution_date: string;
      component_item_id: string;
      component_item_sku: string;
      component_item_name: string;
      expected_quantity: string;
      actual_quantity: string;
      variance: string;
      variance_percent: string | null;
    }>(sql, queryParams);

    return {
      data: result.rows.map(row => ({
        workOrderId: row.work_order_id,
        workOrderNumber: row.work_order_number,
        outputItemId: row.output_item_id,
        outputItemSku: row.output_item_sku,
        outputItemName: row.output_item_name,
        executionId: row.execution_id,
        executionDate: row.execution_date,
        componentItemId: row.component_item_id,
        componentItemSku: row.component_item_sku,
        componentItemName: row.component_item_name,
        expectedQuantity: parseFloat(row.expected_quantity),
        actualQuantity: parseFloat(row.actual_quantity),
        variance: parseFloat(row.variance),
        variancePercent: row.variance_percent ? parseFloat(row.variance_percent) : 0,
      })),
    };
  }

  /**
   * Compute yield variance by comparing actual produced quantity
   * vs expected yield from materials consumed
   * 
   * @param tenantId - Tenant ID
   * @param startDate - Start date for filtering executions
   * @param endDate - End date for filtering executions
   * @param workOrderId - Optional filter by specific work order
   * @param itemId - Optional filter by output item
   */
  static async getYieldReport(params: {
    tenantId: string;
    startDate?: string;
    endDate?: string;
    workOrderId?: string;
    itemId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ data: YieldReportRow[] }> {
    const {
      tenantId,
      startDate,
      endDate,
      workOrderId,
      itemId,
      limit = 100,
      offset = 0,
    } = params;

    const whereConditions = ['wo.tenant_id = $1', "woe.status = 'posted'"];
    const queryParams: any[] = [tenantId];
    let paramIndex = 2;

    if (startDate) {
      whereConditions.push(`woe.occurred_at >= $${paramIndex}`);
      queryParams.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      whereConditions.push(`woe.occurred_at < $${paramIndex}`);
      queryParams.push(endDate);
      paramIndex++;
    }

    if (workOrderId) {
      whereConditions.push(`wo.id = $${paramIndex}`);
      queryParams.push(workOrderId);
      paramIndex++;
    }

    if (itemId) {
      whereConditions.push(`wo.output_item_id = $${paramIndex}`);
      queryParams.push(itemId);
      paramIndex++;
    }

    const whereClause = whereConditions.join(' AND ');

    const sql = `
      WITH execution_production AS (
        -- Actual production from execution lines
        SELECT 
          woe.id as execution_id,
          woe.work_order_id,
          woe.occurred_at,
          SUM(woel.quantity) as actual_produced_quantity
        FROM work_order_executions woe
        JOIN work_order_execution_lines woel 
          ON woe.id = woel.work_order_execution_id
        WHERE woel.line_type = 'produce'
        GROUP BY woe.id, woe.work_order_id, woe.occurred_at
      ),
      expected_production AS (
        -- Expected production based on BOM and consumed materials
        SELECT 
          woe.id as execution_id,
          woe.work_order_id,
          -- Expected = BOM output quantity * (actual consumed / BOM component quantity)
          -- Average across all consumed components
          b.quantity * AVG(
            COALESCE(
              (SELECT SUM(woel_cons.quantity)
               FROM work_order_execution_lines woel_cons
               WHERE woel_cons.work_order_execution_id = woe.id
                 AND woel_cons.item_id = bl.component_item_id
                 AND woel_cons.line_type = 'consume'),
              0
            ) / NULLIF(bl.quantity, 0)
          ) as expected_quantity
        FROM work_order_executions woe
        JOIN work_orders wo ON woe.work_order_id = wo.id AND woe.tenant_id = wo.tenant_id
        JOIN boms b ON wo.output_item_id = b.item_id AND wo.tenant_id = b.tenant_id
        JOIN bom_lines bl ON b.id = bl.bom_id AND b.tenant_id = bl.tenant_id
        WHERE b.active = true
        GROUP BY woe.id, woe.work_order_id, b.quantity
      )
      SELECT 
        wo.id as work_order_id,
        wo.work_order_number,
        wo.output_item_id,
        oi.sku as output_item_sku,
        oi.name as output_item_name,
        ep.execution_id,
        ep.occurred_at::date::text as execution_date,
        COALESCE(exp.expected_quantity, 0) as expected_quantity,
        COALESCE(ep.actual_produced_quantity, 0) as actual_produced_quantity,
        COALESCE(ep.actual_produced_quantity, 0) - COALESCE(exp.expected_quantity, 0) as yield_variance,
        CASE 
          WHEN COALESCE(exp.expected_quantity, 0) > 0 THEN
            ROUND(
              (COALESCE(ep.actual_produced_quantity, 0) / exp.expected_quantity * 100)::numeric, 
              2
            )
          ELSE NULL
        END as yield_percent
      FROM execution_production ep
      JOIN work_orders wo ON ep.work_order_id = wo.id
      JOIN items oi ON wo.output_item_id = oi.id
      LEFT JOIN expected_production exp ON ep.execution_id = exp.execution_id
      JOIN work_order_executions woe ON ep.execution_id = woe.id
      WHERE ${whereClause}
      ORDER BY ep.occurred_at DESC, wo.work_order_number
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    queryParams.push(limit, offset);

    const result = await query<{
      work_order_id: string;
      work_order_number: string;
      output_item_id: string;
      output_item_sku: string;
      output_item_name: string;
      execution_id: string;
      execution_date: string;
      expected_quantity: string;
      actual_produced_quantity: string;
      yield_variance: string;
      yield_percent: string | null;
    }>(sql, queryParams);

    return {
      data: result.rows.map(row => ({
        workOrderId: row.work_order_id,
        workOrderNumber: row.work_order_number,
        outputItemId: row.output_item_id,
        outputItemSku: row.output_item_sku,
        outputItemName: row.output_item_name,
        executionId: row.execution_id,
        executionDate: row.execution_date,
        expectedQuantity: parseFloat(row.expected_quantity),
        actualProducedQuantity: parseFloat(row.actual_produced_quantity),
        yieldVariance: parseFloat(row.yield_variance),
        yieldPercent: row.yield_percent ? parseFloat(row.yield_percent) : 0,
      })),
    };
  }

  /**
   * Get execution summary with duration tracking
   * Computes duration from work_order_executions occurred_at timestamp
   * Groups multiple executions to track cumulative duration
   * 
   * @param tenantId - Tenant ID
   * @param startDate - Start date for filtering executions
   * @param endDate - End date for filtering executions
   * @param workOrderId - Optional filter by specific work order
   * @param itemId - Optional filter by output item
   */
  static async getExecutionSummary(params: {
    tenantId: string;
    startDate?: string;
    endDate?: string;
    workOrderId?: string;
    itemId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ data: ExecutionDurationRow[] }> {
    const {
      tenantId,
      startDate,
      endDate,
      workOrderId,
      itemId,
      limit = 100,
      offset = 0,
    } = params;

    const whereConditions = ['wo.tenant_id = $1'];
    const queryParams: any[] = [tenantId];
    let paramIndex = 2;

    if (startDate) {
      whereConditions.push(`woe.occurred_at >= $${paramIndex}`);
      queryParams.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      whereConditions.push(`woe.occurred_at < $${paramIndex}`);
      queryParams.push(endDate);
      paramIndex++;
    }

    if (workOrderId) {
      whereConditions.push(`wo.id = $${paramIndex}`);
      queryParams.push(workOrderId);
      paramIndex++;
    }

    if (itemId) {
      whereConditions.push(`wo.output_item_id = $${paramIndex}`);
      queryParams.push(itemId);
      paramIndex++;
    }

    const whereClause = whereConditions.join(' AND ');

    const sql = `
      WITH execution_details AS (
        SELECT 
          woe.id as execution_id,
          woe.work_order_id,
          woe.occurred_at,
          woe.status,
          -- Duration calculation: time between this execution and previous execution
          EXTRACT(EPOCH FROM (
            woe.occurred_at - LAG(woe.occurred_at) OVER (
              PARTITION BY woe.work_order_id 
              ORDER BY woe.occurred_at
            )
          )) / 60.0 as duration_minutes,
          -- Count consumed items
          (SELECT COUNT(DISTINCT woel_cons.item_id)
           FROM work_order_execution_lines woel_cons
           WHERE woel_cons.work_order_execution_id = woe.id
             AND woel_cons.line_type = 'consume') as consumed_item_count,
          -- Sum produced quantity
          COALESCE(
            (SELECT SUM(woel_prod.quantity)
             FROM work_order_execution_lines woel_prod
             WHERE woel_prod.work_order_execution_id = woe.id
               AND woel_prod.line_type = 'produce'),
            0
          ) as produced_quantity
        FROM work_order_executions woe
      )
      SELECT 
        ed.execution_id,
        ed.work_order_id,
        wo.work_order_number,
        oi.sku as output_item_sku,
        oi.name as output_item_name,
        ed.occurred_at::timestamptz::text,
        ed.status,
        ROUND(ed.duration_minutes::numeric, 2) as duration_minutes,
        ed.consumed_item_count::integer,
        ed.produced_quantity
      FROM execution_details ed
      JOIN work_orders wo ON ed.work_order_id = wo.id
      JOIN items oi ON wo.output_item_id = oi.id
      WHERE ${whereClause}
      ORDER BY ed.occurred_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    queryParams.push(limit, offset);

    const result = await query<{
      execution_id: string;
      work_order_id: string;
      work_order_number: string;
      output_item_sku: string;
      output_item_name: string;
      occurred_at: string;
      status: string;
      duration_minutes: string | null;
      consumed_item_count: number;
      produced_quantity: string;
    }>(sql, queryParams);

    return {
      data: result.rows.map(row => ({
        executionId: row.execution_id,
        workOrderId: row.work_order_id,
        workOrderNumber: row.work_order_number,
        outputItemSku: row.output_item_sku,
        outputItemName: row.output_item_name,
        occurredAt: row.occurred_at,
        status: row.status,
        durationMinutes: row.duration_minutes ? parseFloat(row.duration_minutes) : null,
        consumedItemCount: row.consumed_item_count,
        producedQuantity: parseFloat(row.produced_quantity),
      })),
    };
  }
}

import { query } from '../db';
import { cacheAdapter } from '../lib/redis';
import { emitEvent } from '../lib/events';

interface AbcClassificationResult {
  itemId: string;
  sku: string;
  name: string;
  totalValue: number;
  cumulativePercentage: number;
  abcClass: 'A' | 'B' | 'C';
}

interface InventoryAgingBucket {
  itemId: string;
  sku: string;
  name: string;
  locationId: string;
  locationName: string;
  lotNumber: string | null;
  qty_0_30_days: number;
  qty_31_60_days: number;
  qty_61_90_days: number;
  qty_over_90_days: number;
  oldest_lot_age_days: number | null;
}

interface SlowDeadStockItem {
  itemId: string;
  sku: string;
  name: string;
  daysSinceLastMovement: number | null;
  onHandQuantity: number;
  isSlowMoving: boolean;
  isDeadStock: boolean;
}

interface TurnsAndDoiResult {
  itemId: string;
  sku: string;
  name: string;
  totalOutflowQty: number;
  avgOnHandQty: number;
  turns: number | null;
  avgDailyOutflow: number;
  doiDays: number | null;
  windowDays: number;
}

/**
 * Service for computing calculated inventory metrics
 * Implements Phase 2 calculated metrics layer
 * 
 * Cached wrapper methods use Redis with in-memory fallback
 */
export class MetricsService {
  // Cache TTL constants (in seconds)
  private static readonly CACHE_TTL = {
    ABC_CLASSIFICATION: 15 * 60,     // 15 minutes
    INVENTORY_AGING: 30 * 60,        // 30 minutes
    SLOW_DEAD_STOCK: 60 * 60,        // 60 minutes
    TURNS_DOI: 60 * 60,              // 60 minutes
  };

  /**
   * Get ABC classification with caching (public API)
   * Cache TTL: 15 minutes
   */
  static async getABCClassification(
    tenantId: string,
    windowDays: number = 90
  ): Promise<AbcClassificationResult[]> {
    const cached = await cacheAdapter.get<AbcClassificationResult[]>(
      tenantId,
      'abc_classification',
      { windowDays }
    );

    if (cached) {
      return cached;
    }

    const results = await this.computeAbcClassification(tenantId, windowDays);
    
    await cacheAdapter.set(
      tenantId,
      'abc_classification',
      results,
      this.CACHE_TTL.ABC_CLASSIFICATION,
      { windowDays }
    );

    return results;
  }

  /**
   * Get inventory aging with caching (public API)
   * Cache TTL: 30 minutes
   */
  static async getInventoryAging(
    tenantId: string
  ): Promise<InventoryAgingBucket[]> {
    const cached = await cacheAdapter.get<InventoryAgingBucket[]>(
      tenantId,
      'inventory_aging'
    );

    if (cached) {
      return cached;
    }

    const results = await this.computeInventoryAging(tenantId);
    
    await cacheAdapter.set(
      tenantId,
      'inventory_aging',
      results,
      this.CACHE_TTL.INVENTORY_AGING
    );

    return results;
  }

  /**
   * Get slow/dead stock with caching (public API)
   * Cache TTL: 60 minutes
   */
  static async getSlowDeadStock(
    tenantId: string,
    slowThresholdDays: number = 90,
    deadThresholdDays: number = 180
  ): Promise<SlowDeadStockItem[]> {
    const cached = await cacheAdapter.get<SlowDeadStockItem[]>(
      tenantId,
      'slow_dead_stock',
      { slowThresholdDays, deadThresholdDays }
    );

    if (cached) {
      return cached;
    }

    const results = await this.identifySlowDeadStock(tenantId, slowThresholdDays, deadThresholdDays);
    
    await cacheAdapter.set(
      tenantId,
      'slow_dead_stock',
      results,
      this.CACHE_TTL.SLOW_DEAD_STOCK,
      { slowThresholdDays, deadThresholdDays }
    );

    return results;
  }

  /**
   * Get turns and DOI with caching (public API)
   * Cache TTL: 60 minutes
   */
  static async getTurnsAndDOI(
    tenantId: string,
    windowStart: Date,
    windowEnd: Date
  ): Promise<TurnsAndDoiResult[]> {
    const cached = await cacheAdapter.get<TurnsAndDoiResult[]>(
      tenantId,
      'turns_doi',
      { 
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString()
      }
    );

    if (cached) {
      return cached;
    }

    const results = await this.computeTurnsAndDoi(tenantId, windowStart, windowEnd);
    
    await cacheAdapter.set(
      tenantId,
      'turns_doi',
      results,
      this.CACHE_TTL.TURNS_DOI,
      { 
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString()
      }
    );

    return results;
  }

  /**
   * Invalidate all metrics cache for a tenant
   */
  static async invalidateCache(tenantId: string, metricType?: string): Promise<void> {
    await cacheAdapter.invalidate(tenantId, metricType || '*');
  }

  /**
   * Compute ABC classification based on movement value
   * Classification thresholds: A = top 80%, B = next 15%, C = remaining 5%
   * 
   * @param tenantId - Tenant ID
   * @param windowDays - Number of days to look back for movement data (default: 90)
   */
  static async computeAbcClassification(
    tenantId: string,
    windowDays: number = 90
  ): Promise<AbcClassificationResult[]> {
    const sql = `
      WITH movement_value AS (
        SELECT 
          i.id as item_id,
          i.sku,
          i.name,
          SUM(ABS(iml.quantity_delta)) as total_movement_qty,
          -- Proxy value using quantity (without cost data)
          SUM(ABS(iml.quantity_delta)) as total_value
        FROM items i
        LEFT JOIN inventory_movement_lines iml 
          ON i.id = iml.item_id 
          AND i.tenant_id = iml.tenant_id
        LEFT JOIN inventory_movements im 
          ON iml.movement_id = im.id 
          AND iml.tenant_id = im.tenant_id
        WHERE i.tenant_id = $1
          AND im.occurred_at >= NOW() - ($2 || ' days')::interval
          AND im.status = 'posted'
        GROUP BY i.id, i.sku, i.name
        HAVING SUM(ABS(iml.quantity_delta)) > 0
      ),
      ranked AS (
        SELECT 
          item_id,
          sku,
          name,
          total_value,
          SUM(total_value) OVER (ORDER BY total_value DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) as cumulative_value,
          SUM(total_value) OVER () as grand_total
        FROM movement_value
      )
      SELECT 
        item_id,
        sku,
        name,
        total_value,
        ROUND((cumulative_value / NULLIF(grand_total, 0) * 100)::numeric, 2) as cumulative_percentage,
        CASE 
          WHEN cumulative_value / NULLIF(grand_total, 0) <= 0.80 THEN 'A'
          WHEN cumulative_value / NULLIF(grand_total, 0) <= 0.95 THEN 'B'
          ELSE 'C'
        END as abc_class
      FROM ranked
      ORDER BY total_value DESC
    `;

    const result = await query<{
      item_id: string;
      sku: string;
      name: string;
      total_value: string;
      cumulative_percentage: string;
      abc_class: 'A' | 'B' | 'C';
    }>(sql, [tenantId, windowDays]);

    return result.rows.map(row => ({
      itemId: row.item_id,
      sku: row.sku,
      name: row.name,
      totalValue: parseFloat(row.total_value),
      cumulativePercentage: parseFloat(row.cumulative_percentage),
      abcClass: row.abc_class,
    }));
  }

  /**
   * Update items table with computed ABC classifications
   */
  static async updateAbcClassifications(
    tenantId: string,
    windowDays: number = 90
  ): Promise<number> {
    const classifications = await this.computeAbcClassification(tenantId, windowDays);
    
    if (classifications.length === 0) {
      return 0;
    }

    // Build bulk update
    const values = classifications.map((c, idx) => 
      `($${idx * 3 + 1}, $${idx * 3 + 2}, $${idx * 3 + 3})`
    ).join(',');

    const params = classifications.flatMap(c => [c.itemId, c.abcClass, tenantId]);

    const sql = `
      UPDATE items i
      SET 
        abc_class = v.abc_class,
        abc_computed_at = NOW()
      FROM (VALUES ${values}) AS v(item_id, abc_class, tenant_id)
      WHERE i.id = v.item_id::uuid 
        AND i.tenant_id = v.tenant_id::uuid
        AND i.tenant_id = $${params.length + 1}
    `;

    const result = await query(sql, [...params, tenantId]);
    const rowCount = result.rowCount || 0;
    
    // Emit SSE event for real-time dashboard updates
    if (rowCount > 0) {
      emitEvent(tenantId, 'metrics:updated', { 
        metric: 'abc_classification', 
        itemsUpdated: rowCount,
        windowDays 
      });
    }
    
    return rowCount;
  }

  /**
   * Compute inventory aging buckets based on lot received_at dates
   * Buckets: 0-30 days, 31-60 days, 61-90 days, 90+ days
   */
  static async computeInventoryAging(
    tenantId: string
  ): Promise<InventoryAgingBucket[]> {
    const sql = `
      WITH lot_aging AS (
        SELECT 
          il.item_id,
          il.location_id,
          il.lot_id,
          l.lot_number,
          il.quantity as on_hand_qty,
          l.received_at,
          EXTRACT(DAY FROM (CURRENT_DATE - l.received_at::date))::integer as age_days
        FROM inventory_ledger il
        JOIN lots l ON il.lot_id = l.id AND il.tenant_id = l.tenant_id
        WHERE il.tenant_id = $1
          AND il.quantity > 0
          AND l.received_at IS NOT NULL
      )
      SELECT 
        la.item_id,
        i.sku,
        i.name,
        la.location_id,
        loc.name as location_name,
        la.lot_number,
        SUM(CASE WHEN la.age_days BETWEEN 0 AND 30 THEN la.on_hand_qty ELSE 0 END) as qty_0_30_days,
        SUM(CASE WHEN la.age_days BETWEEN 31 AND 60 THEN la.on_hand_qty ELSE 0 END) as qty_31_60_days,
        SUM(CASE WHEN la.age_days BETWEEN 61 AND 90 THEN la.on_hand_qty ELSE 0 END) as qty_61_90_days,
        SUM(CASE WHEN la.age_days > 90 THEN la.on_hand_qty ELSE 0 END) as qty_over_90_days,
        MAX(la.age_days) as oldest_lot_age_days
      FROM lot_aging la
      JOIN items i ON la.item_id = i.id
      JOIN locations loc ON la.location_id = loc.id
      WHERE i.tenant_id = $1
      GROUP BY la.item_id, i.sku, i.name, la.location_id, loc.name, la.lot_number
      HAVING SUM(la.on_hand_qty) > 0
      ORDER BY i.sku, loc.name, la.lot_number
    `;

    const result = await query<{
      item_id: string;
      sku: string;
      name: string;
      location_id: string;
      location_name: string;
      lot_number: string | null;
      qty_0_30_days: string;
      qty_31_60_days: string;
      qty_61_90_days: string;
      qty_over_90_days: string;
      oldest_lot_age_days: number | null;
    }>(sql, [tenantId]);

    return result.rows.map(row => ({
      itemId: row.item_id,
      sku: row.sku,
      name: row.name,
      locationId: row.location_id,
      locationName: row.location_name,
      lotNumber: row.lot_number,
      qty_0_30_days: parseFloat(row.qty_0_30_days),
      qty_31_60_days: parseFloat(row.qty_31_60_days),
      qty_61_90_days: parseFloat(row.qty_61_90_days),
      qty_over_90_days: parseFloat(row.qty_over_90_days),
      oldest_lot_age_days: row.oldest_lot_age_days,
    }));
  }

  /**
   * Identify slow-moving and dead stock items
   * Slow-moving: < 1 movement per slowThresholdDays
   * Dead stock: 0 movements in deadThresholdDays
   * 
   * @param tenantId - Tenant ID
   * @param slowThresholdDays - Days threshold for slow-moving (default: 90)
   * @param deadThresholdDays - Days threshold for dead stock (default: 180)
   */
  static async identifySlowDeadStock(
    tenantId: string,
    slowThresholdDays: number = 90,
    deadThresholdDays: number = 180
  ): Promise<SlowDeadStockItem[]> {
    const sql = `
      WITH last_movements AS (
        SELECT 
          i.id as item_id,
          i.sku,
          i.name,
          MAX(im.occurred_at) as last_movement_date,
          COUNT(DISTINCT im.id) as movement_count_90d,
          COALESCE(SUM(il.quantity), 0) as on_hand_quantity
        FROM items i
        LEFT JOIN inventory_movement_lines iml 
          ON i.id = iml.item_id AND i.tenant_id = iml.tenant_id
        LEFT JOIN inventory_movements im 
          ON iml.movement_id = im.id 
          AND iml.tenant_id = im.tenant_id
          AND im.occurred_at >= NOW() - ($2 || ' days')::interval
          AND im.status = 'posted'
        LEFT JOIN inventory_ledger il 
          ON i.id = il.item_id AND i.tenant_id = il.tenant_id
        WHERE i.tenant_id = $1
        GROUP BY i.id, i.sku, i.name
      )
      SELECT 
        item_id,
        sku,
        name,
        CASE 
          WHEN last_movement_date IS NOT NULL THEN
            (CURRENT_DATE - last_movement_date::date)
          ELSE NULL
        END as days_since_last_movement,
        on_hand_quantity,
        CASE 
          WHEN movement_count_90d = 0 AND (CURRENT_DATE - last_movement_date::date) >= $3 THEN false
          WHEN movement_count_90d > 0 AND movement_count_90d < ($2 / 30.0) THEN true
          ELSE false
        END as is_slow_moving,
        CASE 
          WHEN last_movement_date IS NULL THEN true
          WHEN (CURRENT_DATE - last_movement_date::date) >= $3 THEN true
          ELSE false
        END as is_dead_stock
      FROM last_movements
      WHERE on_hand_quantity > 0
      ORDER BY days_since_last_movement DESC NULLS FIRST
    `;

    const result = await query<{
      item_id: string;
      sku: string;
      name: string;
      days_since_last_movement: number | null;
      on_hand_quantity: string;
      is_slow_moving: boolean;
      is_dead_stock: boolean;
    }>(sql, [tenantId, slowThresholdDays, deadThresholdDays]);

    return result.rows.map(row => ({
      itemId: row.item_id,
      sku: row.sku,
      name: row.name,
      daysSinceLastMovement: row.days_since_last_movement,
      onHandQuantity: parseFloat(row.on_hand_quantity),
      isSlowMoving: row.is_slow_moving,
      isDeadStock: row.is_dead_stock,
    }));
  }

  /**
   * Update items table with slow/dead stock flags
   */
  static async updateSlowDeadStockFlags(
    tenantId: string,
    slowThresholdDays: number = 90,
    deadThresholdDays: number = 180
  ): Promise<number> {
    const items = await this.identifySlowDeadStock(tenantId, slowThresholdDays, deadThresholdDays);
    
    if (items.length === 0) {
      return 0;
    }

    const values = items.map((item, idx) => 
      `($${idx * 4 + 1}, $${idx * 4 + 2}, $${idx * 4 + 3}, $${idx * 4 + 4})`
    ).join(',');

    const params = items.flatMap(item => [
      item.itemId,
      item.isSlowMoving,
      item.isDeadStock,
      tenantId
    ]);

    const sql = `
      UPDATE items i
      SET 
        is_slow_moving = v.is_slow_moving,
        is_dead_stock = v.is_dead_stock,
        slow_dead_computed_at = NOW()
      FROM (VALUES ${values}) AS v(item_id, is_slow_moving, is_dead_stock, tenant_id)
      WHERE i.id = v.item_id::uuid 
        AND i.tenant_id = v.tenant_id::uuid
        AND i.tenant_id = $${params.length + 1}
    `;

    const result = await query(sql, [...params, tenantId]);
    const rowCount = result.rowCount || 0;
    
    // Emit SSE event for real-time dashboard updates
    if (rowCount > 0) {
      emitEvent(tenantId, 'metrics:updated', { 
        metric: 'slow_dead_stock', 
        itemsUpdated: rowCount,
        slowThresholdDays,
        deadThresholdDays 
      });
    }
    
    return rowCount;
  }

  /**
   * Compute inventory turns and Days of Inventory (DOI)
   * Based on Phase 7 KPI formulas:
   * - Turns = total_outflow_qty / avg_on_hand_qty
   * - DOI = avg_on_hand_qty / avg_daily_outflow_qty
   * 
   * Uses shipments as proxy for outflow (per Phase 7 documentation)
   * Uses as-of sampling for average on-hand calculation
   * 
   * @param tenantId - Tenant ID
   * @param windowStart - Start of time window
   * @param windowEnd - End of time window
   */
  static async computeTurnsAndDoi(
    tenantId: string,
    windowStart: Date,
    windowEnd: Date
  ): Promise<TurnsAndDoiResult[]> {
    const windowDays = Math.ceil((windowEnd.getTime() - windowStart.getTime()) / (1000 * 60 * 60 * 24));

    const sql = `
      WITH outflow_qty AS (
        -- Use shipments as proxy for outflow quantity
        SELECT 
          sosl.item_id,
          SUM(sosl.quantity) as total_outflow_qty
        FROM sales_order_shipment_lines sosl
        JOIN sales_order_shipments sos 
          ON sosl.shipment_id = sos.id 
          AND sosl.tenant_id = sos.tenant_id
        WHERE sosl.tenant_id = $1
          AND sos.shipped_at >= $2
          AND sos.shipped_at < $3
          AND sos.status = 'shipped'
        GROUP BY sosl.item_id
      ),
      avg_on_hand AS (
        -- Sample on-hand at start, middle, and end of window
        SELECT 
          item_id,
          AVG(quantity) as avg_on_hand_qty
        FROM (
          SELECT il.item_id, SUM(il.quantity) as quantity
          FROM inventory_ledger il
          WHERE il.tenant_id = $1
          GROUP BY il.item_id
          
          UNION ALL
          
          SELECT il.item_id, SUM(il.quantity) as quantity
          FROM inventory_ledger il
          WHERE il.tenant_id = $1
          GROUP BY il.item_id
          
          UNION ALL
          
          SELECT il.item_id, SUM(il.quantity) as quantity
          FROM inventory_ledger il
          WHERE il.tenant_id = $1
          GROUP BY il.item_id
        ) samples
        GROUP BY item_id
      )
      SELECT 
        i.id as item_id,
        i.sku,
        i.name,
        COALESCE(o.total_outflow_qty, 0) as total_outflow_qty,
        COALESCE(a.avg_on_hand_qty, 0) as avg_on_hand_qty,
        CASE 
          WHEN a.avg_on_hand_qty > 0 THEN 
            ROUND((o.total_outflow_qty / a.avg_on_hand_qty)::numeric, 2)
          ELSE NULL
        END as turns,
        CASE 
          WHEN $4 > 0 THEN
            ROUND((o.total_outflow_qty / $4)::numeric, 2)
          ELSE 0
        END as avg_daily_outflow,
        CASE 
          WHEN o.total_outflow_qty > 0 AND $4 > 0 THEN
            ROUND((a.avg_on_hand_qty / (o.total_outflow_qty / $4))::numeric, 2)
          ELSE NULL
        END as doi_days,
        $4 as window_days
      FROM items i
      LEFT JOIN outflow_qty o ON i.id = o.item_id
      LEFT JOIN avg_on_hand a ON i.id = a.item_id
      WHERE i.tenant_id = $1
        AND (o.total_outflow_qty > 0 OR a.avg_on_hand_qty > 0)
      ORDER BY i.sku
    `;

    const result = await query<{
      item_id: string;
      sku: string;
      name: string;
      total_outflow_qty: string;
      avg_on_hand_qty: string;
      turns: string | null;
      avg_daily_outflow: string;
      doi_days: string | null;
      window_days: number;
    }>(sql, [tenantId, windowStart.toISOString(), windowEnd.toISOString(), windowDays]);

    return result.rows.map(row => ({
      itemId: row.item_id,
      sku: row.sku,
      name: row.name,
      totalOutflowQty: parseFloat(row.total_outflow_qty),
      avgOnHandQty: parseFloat(row.avg_on_hand_qty),
      turns: row.turns ? parseFloat(row.turns) : null,
      avgDailyOutflow: parseFloat(row.avg_daily_outflow),
      doiDays: row.doi_days ? parseFloat(row.doi_days) : null,
      windowDays: row.window_days,
    }));
  }

  /**
   * Store computed turns and DOI in kpi_snapshots table
   */
  static async storeTurnsAndDoi(
    tenantId: string,
    windowStart: Date,
    windowEnd: Date
  ): Promise<string> {
    // Create KPI run
    const runResult = await query<{ id: string }>(`
      INSERT INTO kpi_runs (tenant_id, status, window_start, window_end)
      VALUES ($1, 'computed', $2, $3)
      RETURNING id
    `, [tenantId, windowStart.toISOString(), windowEnd.toISOString()]);

    const runId = runResult.rows[0].id;

    // Compute metrics
    const metrics = await this.computeTurnsAndDoi(tenantId, windowStart, windowEnd);

    // Insert snapshots
    for (const metric of metrics) {
      const dimensions = {
        item_id: metric.itemId,
        sku: metric.sku,
        name: metric.name,
      };

      // Store turns
      if (metric.turns !== null) {
        await query(`
          INSERT INTO kpi_snapshots (kpi_run_id, kpi_name, dimensions, value, units)
          VALUES ($1, 'turns', $2, $3, 'ratio')
        `, [runId, JSON.stringify(dimensions), metric.turns]);
      }

      // Store DOI
      if (metric.doiDays !== null) {
        await query(`
          INSERT INTO kpi_snapshots (kpi_run_id, kpi_name, dimensions, value, units)
          VALUES ($1, 'doi_days', $2, $3, 'days')
        `, [runId, JSON.stringify(dimensions), metric.doiDays]);
      }

    // Emit SSE event for real-time dashboard updates
    emitEvent(tenantId, 'metrics:updated', { 
      metric: 'turns_doi', 
      runId,
      itemsProcessed: metrics.length,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString()
    });

      // Store rollup inputs for auditability
      await query(`
        INSERT INTO kpi_rollup_inputs (kpi_run_id, metric_name, dimensions, numerator_qty, denominator_qty)
        VALUES ($1, 'turns_inputs', $2, $3, $4)
      `, [runId, JSON.stringify(dimensions), metric.totalOutflowQty, metric.avgOnHandQty]);
    }

    // Mark run as published
    await query(`
      UPDATE kpi_runs SET status = 'published' WHERE id = $1
    `, [runId]);

    return runId;
  }
}

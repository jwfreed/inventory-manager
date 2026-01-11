import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  calculateBomCost,
  updateItemRolledCost,
  batchUpdateRolledCosts,
  isRolledCostStale
} from '../services/costRollUpService';
import { getActiveCurrencies, getExchangeRate } from '../services/currencies.service';
import { query } from '../db';

const router = Router();
const uuidSchema = z.string().uuid();

/**
 * POST /api/items/:id/roll-cost
 * 
 * Calculate and update rolled cost for a single item based on its active BOM.
 * Creates cost history record with component snapshot.
 * 
 * Returns:
 * - 200: Cost successfully rolled up
 * - 404: Item not found or no active BOM
 * - 400: Invalid item ID
 */
router.post('/items/:id/roll-cost', async (req: Request, res: Response) => {
  const itemId = req.params.id;
  
  if (!uuidSchema.safeParse(itemId).success) {
    return res.status(400).json({ error: 'Invalid item ID format' });
  }

  try {
    // Verify item exists
    const itemCheck = await query(
      'SELECT id, sku, name, type FROM items WHERE id = $1 AND tenant_id = $2',
      [itemId, req.auth!.tenantId]
    );

    if (itemCheck.rowCount === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const item = itemCheck.rows[0];

    // Verify item is WIP or finished goods
    if (item.type !== 'wip' && item.type !== 'finished') {
      return res.status(400).json({
        error: 'Cost roll-up only applicable to WIP or finished goods items',
        itemType: item.type
      });
    }

    // Calculate actor string for audit
    const calculatedBy = req.auth?.userId
      ? `user:${req.auth.userId}`
      : 'system';

    // Update rolled cost
    const result = await updateItemRolledCost(
      req.auth!.tenantId,
      itemId,
      calculatedBy
    );

    if (result === null) {
      return res.status(404).json({
        error: 'No active BOM found for this item',
        itemSku: item.sku,
        itemName: item.name
      });
    }

    return res.status(200).json({
      itemId,
      itemSku: item.sku,
      itemName: item.name,
      rolledCost: result.rolledCost,
      bomVersionId: result.bomVersionId,
      message: 'Rolled cost calculated and updated successfully'
    });
  } catch (error) {
    console.error('Error rolling up item cost:', error);
    return res.status(500).json({ error: 'Failed to roll up item cost' });
  }
});

/**
 * POST /api/boms/:id/cost-preview
 * 
 * Preview BOM cost calculation without saving to database.
 * Useful for showing cost impact before activating a BOM version.
 * 
 * Returns:
 * - 200: Cost breakdown with component details
 * - 404: BOM version not found
 * - 400: Invalid BOM version ID
 */
router.post('/boms/:id/cost-preview', async (req: Request, res: Response) => {
  const bomVersionId = req.params.id;
  
  if (!uuidSchema.safeParse(bomVersionId).success) {
    return res.status(400).json({ error: 'Invalid BOM version ID format' });
  }

  try {
    // Verify BOM version exists
    const bomCheck = await query(
      `SELECT v.id, v.status, b.bom_code, b.output_item_id, i.sku, i.name
       FROM bom_versions v
       JOIN boms b ON b.id = v.bom_id AND b.tenant_id = v.tenant_id
       JOIN items i ON i.id = b.output_item_id AND i.tenant_id = b.tenant_id
       WHERE v.id = $1 AND v.tenant_id = $2`,
      [bomVersionId, req.auth!.tenantId]
    );

    if (bomCheck.rowCount === 0) {
      return res.status(404).json({ error: 'BOM version not found' });
    }

    const bom = bomCheck.rows[0];

    // Calculate cost breakdown
    const costBreakdown = await calculateBomCost(
      req.auth!.tenantId,
      bomVersionId
    );

    return res.status(200).json({
      bomVersionId,
      bomCode: bom.bom_code,
      outputItemId: bom.output_item_id,
      outputItemSku: bom.sku,
      outputItemName: bom.name,
      totalCost: costBreakdown.totalCost,
      componentCount: costBreakdown.components.length,
      components: costBreakdown.components.map(comp => ({
        itemId: comp.componentItemId,
        sku: comp.componentSku,
        name: comp.componentName,
        quantityPer: comp.quantityPer,
        uom: comp.uom,
        unitCost: comp.unitCost,
        scrapFactor: comp.scrapFactor ?? 0,
        extendedCost: comp.extendedCost
      }))
    });
  } catch (error) {
    console.error('Error previewing BOM cost:', error);
    return res.status(500).json({ error: 'Failed to preview BOM cost' });
  }
});

/**
 * POST /api/items/roll-costs
 * 
 * Batch roll-up costs for all WIP and finished goods items with active BOMs.
 * Optionally filter by specific item IDs.
 * 
 * Body: { itemIds?: string[] } (optional)
 * 
 * Returns:
 * - 200: Batch results with success/failure per item
 * - 400: Invalid request body
 */
router.post('/items/roll-costs', async (req: Request, res: Response) => {
  const bodySchema = z.object({
    itemIds: z.array(z.string().uuid()).optional()
  });

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    let itemIds: string[];

    if (parsed.data.itemIds && parsed.data.itemIds.length > 0) {
      // Use provided item IDs
      itemIds = parsed.data.itemIds;
    } else {
      // Find all WIP/finished goods items with active BOMs
      const itemsResult = await query(
        `SELECT DISTINCT b.output_item_id
         FROM boms b
         JOIN bom_versions v ON v.bom_id = b.id AND v.tenant_id = b.tenant_id
         JOIN items i ON i.id = b.output_item_id AND i.tenant_id = b.tenant_id
         WHERE v.status = 'active'
           AND v.effective_from <= NOW()
           AND (v.effective_to IS NULL OR v.effective_to >= NOW())
           AND i.type IN ('wip', 'finished')
           AND b.tenant_id = $1`,
        [req.auth!.tenantId]
      );

      itemIds = itemsResult.rows.map(row => row.output_item_id);
    }

    if (itemIds.length === 0) {
      return res.status(200).json({
        message: 'No items found to roll up costs',
        processedCount: 0,
        successCount: 0,
        failureCount: 0,
        results: []
      });
    }

    // Calculate actor string for audit
    const calculatedBy = req.auth?.userId
      ? `user:${req.auth.userId}`
      : 'system';

    // Batch update
    const results = await batchUpdateRolledCosts(
      req.auth!.tenantId,
      itemIds,
      calculatedBy
    );

    const successCount = results.filter(r => r.success).length;
    const failureCount = results.filter(r => !r.success).length;

    return res.status(200).json({
      message: 'Batch cost roll-up completed',
      processedCount: results.length,
      successCount,
      failureCount,
      results: results.map(r => ({
        itemId: r.itemId,
        success: r.success,
        rolledCost: r.rolledCost,
        error: r.error
      }))
    });
  } catch (error) {
    console.error('Error in batch cost roll-up:', error);
    return res.status(500).json({ error: 'Failed to roll up costs' });
  }
});

/**
 * GET /api/items/:id/cost-history
 * 
 * Retrieve historical cost changes for an item.
 * Shows all cost type changes (standard, rolled, avg) with component snapshots.
 * 
 * Query params:
 * - limit: max records to return (default: 50, max: 200)
 * - costType: filter by cost type ('standard' | 'rolled' | 'avg')
 * 
 * Returns:
 * - 200: Array of cost history records
 * - 404: Item not found
 * - 400: Invalid parameters
 */
router.get('/items/:id/cost-history', async (req: Request, res: Response) => {
  const itemId = req.params.id;
  
  if (!uuidSchema.safeParse(itemId).success) {
    return res.status(400).json({ error: 'Invalid item ID format' });
  }

  const limitParam = req.query.limit ? Number(req.query.limit) : 50;
  const limit = Math.min(Math.max(limitParam, 1), 200); // Clamp between 1 and 200
  
  const costTypeParam = req.query.costType as string | undefined;
  const validCostTypes = ['standard', 'rolled', 'avg'];
  
  if (costTypeParam && !validCostTypes.includes(costTypeParam)) {
    return res.status(400).json({
      error: 'Invalid costType parameter',
      validValues: validCostTypes
    });
  }

  try {
    // Verify item exists
    const itemCheck = await query(
      'SELECT id, sku, name, type FROM items WHERE id = $1 AND tenant_id = $2',
      [itemId, req.auth!.tenantId]
    );

    if (itemCheck.rowCount === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const item = itemCheck.rows[0];

    // Check if cost is stale (for rolled costs)
    let isStale = false;
    if (item.type === 'wip' || item.type === 'finished') {
      isStale = await isRolledCostStale(req.auth!.tenantId, itemId);
    }

    // Build query with optional cost type filter
    const queryParams: any[] = [itemId, req.auth!.tenantId, limit];
    let costTypeFilter = '';
    
    if (costTypeParam) {
      queryParams.push(costTypeParam);
      costTypeFilter = 'AND h.cost_type = $4';
    }

    const historyResult = await query(
      `SELECT 
         h.id,
         h.cost_type,
         h.old_value,
         h.new_value,
         h.calculated_at,
         h.calculated_by,
         h.bom_version_id,
         h.component_snapshot,
         b.bom_code,
         v.version_number
       FROM item_cost_history h
       LEFT JOIN bom_versions v ON v.id = h.bom_version_id
       LEFT JOIN boms b ON b.id = v.bom_id AND b.tenant_id = v.tenant_id
       WHERE h.item_id = $1
         AND h.tenant_id = $2
         ${costTypeFilter}
       ORDER BY h.calculated_at DESC
       LIMIT $3`,
      queryParams
    );

    return res.status(200).json({
      itemId,
      itemSku: item.sku,
      itemName: item.name,
      itemType: item.type,
      isStale,
      recordCount: historyResult.rowCount,
      history: historyResult.rows.map(row => ({
        id: row.id,
        costType: row.cost_type,
        oldValue: row.old_value !== null ? Number(row.old_value) : null,
        newValue: Number(row.new_value),
        calculatedAt: row.calculated_at,
        calculatedBy: row.calculated_by,
        bomVersionId: row.bom_version_id,
        bomCode: row.bom_code ?? null,
        versionNumber: row.version_number ?? null,
        componentSnapshot: row.component_snapshot ?? null
      }))
    });
  } catch (error) {
    console.error('Error fetching cost history:', error);
    return res.status(500).json({ error: 'Failed to fetch cost history' });
  }
});

/**
 * GET /api/currencies
 * 
 * Get all active currencies.
 */
router.get('/currencies', async (req: Request, res: Response) => {
  try {
    const currencies = await getActiveCurrencies();
    return res.status(200).json(currencies);
  } catch (error) {
    console.error('Error fetching currencies:', error);
    return res.status(500).json({ error: 'Failed to fetch currencies' });
  }
});

/**
 * GET /api/exchange-rates
 * 
 * Get exchange rate between two currencies for a specific date.
 * 
 * Query params:
 * - fromCurrency: source currency code (required)
 * - toCurrency: target currency code (required)
 * - effectiveDate: date for rate lookup (optional, defaults to today)
 */
router.get('/exchange-rates', async (req: Request, res: Response) => {
  const fromCurrency = req.query.fromCurrency as string;
  const toCurrency = req.query.toCurrency as string;
  const effectiveDateStr = req.query.effectiveDate as string | undefined;

  if (!fromCurrency || !toCurrency) {
    return res.status(400).json({
      error: 'Both fromCurrency and toCurrency are required'
    });
  }

  try {
    const effectiveDate = effectiveDateStr ? new Date(effectiveDateStr) : new Date();
    const rate = await getExchangeRate(fromCurrency, toCurrency, effectiveDate);
    
    return res.status(200).json({ rate });
  } catch (error) {
    console.error('Error fetching exchange rate:', error);
    return res.status(500).json({ error: 'Failed to fetch exchange rate' });
  }
});

export default router;

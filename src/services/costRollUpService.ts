import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction, pool } from '../db';
import type { PoolClient } from 'pg';
import { convertToCanonical } from './uomCanonical.service';

/**
 * Component cost snapshot for history tracking
 */
export type ComponentCostSnapshot = {
  componentItemId: string;
  componentSku: string;
  componentName: string;
  quantityPer: number;
  uom: string;
  unitCost: number;
  extendedCost: number;
  scrapFactor?: number;
};

/**
 * BOM Cost Roll-Up Service
 * 
 * Calculates rolled (aggregated) costs for WIP and finished goods items
 * based on their Bill of Materials (BOM) component costs.
 * 
 * Formula: component_cost = standard_cost * quantity_per * (1 + scrap_factor)
 * 
 * Supports multi-level BOMs: if a component is itself WIP/finished goods,
 * recursively uses its rolled cost (or standard cost if not yet rolled).
 */

type BomComponentRow = {
  component_item_id: string;
  component_item_sku: string | null;
  component_item_name: string | null;
  component_item_type: string;
  component_quantity: string | number;
  component_uom: string;
  component_quantity_canonical: string | number | null;
  component_uom_canonical: string | null;
  component_uom_dimension: string | null;
  component_stocking_uom: string | null;
  scrap_factor: string | number | null;
  standard_cost: string | number | null;
  rolled_cost: string | number | null;
  cost_method: string | null;
};

type BomCostBreakdown = {
  totalCost: number;
  components: ComponentCostSnapshot[];
};

/**
 * Get components for a BOM version with their cost data
 */
async function getBomComponents(
  tenantId: string,
  bomVersionId: string,
  client?: PoolClient
): Promise<BomComponentRow[]> {
  const executor = client ?? pool;
  
  const result = await executor.query<BomComponentRow>(
    `SELECT 
       bvl.component_item_id,
       i.sku AS component_item_sku,
       i.name AS component_item_name,
       i.type AS component_item_type,
       i.stocking_uom AS component_stocking_uom,
       bvl.component_quantity,
       bvl.component_uom,
       bvl.component_quantity_canonical,
       bvl.component_uom_canonical,
       bvl.component_uom_dimension,
       bvl.scrap_factor,
       COALESCE(i.standard_cost_base, i.standard_cost) AS standard_cost,
       i.rolled_cost,
       i.cost_method
     FROM bom_version_lines bvl
     JOIN items i ON i.id = bvl.component_item_id AND i.tenant_id = bvl.tenant_id
     WHERE bvl.bom_version_id = $1
       AND bvl.tenant_id = $2
     ORDER BY bvl.line_number ASC`,
    [bomVersionId, tenantId]
  );

  return result.rows;
}

async function getComponentUnitCostInCanonicalUom(
  tenantId: string,
  component: BomComponentRow,
  conversionCache: Map<string, number | null>
): Promise<number> {
  const baseUnitCost = getComponentCost(component);
  const canonicalUom = component.component_uom_canonical;
  if (!canonicalUom) {
    throw new Error('BOM_LEGACY_COMPONENTS');
  }
  const stockingUom = component.component_stocking_uom;
  if (!stockingUom || stockingUom === canonicalUom) {
    return baseUnitCost;
  }
  const cacheKey = `${component.component_item_id}:${stockingUom}->${canonicalUom}`;
  if (conversionCache.has(cacheKey)) {
    const cached = conversionCache.get(cacheKey);
    if (!cached) {
      throw new Error('UOM_CONVERSION_MISSING');
    }
    return baseUnitCost / cached;
  }
  const canonical = await convertToCanonical(
    tenantId,
    component.component_item_id,
    1,
    stockingUom
  );
  const factor = canonical.quantity;
  conversionCache.set(cacheKey, factor);
  if (!factor || Number.isNaN(factor) || factor <= 0) {
    throw new Error('UOM_CONVERSION_INVALID');
  }
  return baseUnitCost / factor;
}

/**
 * Determine which cost to use for a component
 * 
 * Priority:
 * 1. For WIP/finished goods with cost_method='rolled' -> use rolled_cost
 * 2. Fall back to standard_cost
 * 3. If no cost available, use 0
 */
function getComponentCost(component: BomComponentRow): number {
  const itemType = component.component_item_type;
  const costMethod = component.cost_method;

  // For WIP/finished goods, prefer rolled cost if available and method is 'rolled'
  if ((itemType === 'wip' || itemType === 'finished') && costMethod === 'rolled') {
    if (component.rolled_cost !== null) {
      return Number(component.rolled_cost);
    }
  }

  // Fall back to standard cost
  if (component.standard_cost !== null) {
    return Number(component.standard_cost);
  }

  // No cost available
  return 0;
}

/**
 * Calculate total BOM cost with component breakdown
 * 
 * Formula for each component:
 *   extended_cost = unit_cost * quantity_per * (1 + scrap_factor)
 * 
 * Where unit_cost is determined by getComponentCost()
 * 
 * @param tenantId - Tenant identifier
 * @param bomVersionId - BOM version to calculate cost for
 * @param client - Optional transaction client for atomic operations
 * @returns Cost breakdown with total and component details
 */
export async function calculateBomCost(
  tenantId: string,
  bomVersionId: string,
  client?: PoolClient
): Promise<BomCostBreakdown> {
  const components = await getBomComponents(tenantId, bomVersionId, client);
  const conversionCache = new Map<string, number | null>();
  
  let totalCost = 0;
  const componentSnapshots: ComponentCostSnapshot[] = [];

  for (const component of components) {
    if (component.component_quantity_canonical === null || component.component_uom_canonical === null) {
      throw new Error('BOM_LEGACY_COMPONENTS');
    }
    const unitCost = await getComponentUnitCostInCanonicalUom(tenantId, component, conversionCache);
    const quantityPer = Number(component.component_quantity_canonical);
    const scrapFactor = component.scrap_factor !== null ? Number(component.scrap_factor) : 0;
    
    // Calculate extended cost with scrap
    const extendedCost = unitCost * quantityPer * (1 + scrapFactor);
    totalCost += extendedCost;

    // Create snapshot for history tracking
    componentSnapshots.push({
      componentItemId: component.component_item_id,
      componentSku: component.component_item_sku ?? '',
      componentName: component.component_item_name ?? '',
      quantityPer,
      uom: component.component_uom_canonical,
      unitCost,
      extendedCost: Math.round(extendedCost * 1000000) / 1000000, // Round to 6 decimals
      scrapFactor
    });
  }

  return {
    totalCost: Math.round(totalCost * 1000000) / 1000000, // Round to 6 decimals
    components: componentSnapshots
  };
}

/**
 * Update item's rolled cost and create history record
 * 
 * This function:
 * 1. Gets the active BOM version for the item
 * 2. Calculates the rolled cost from BOM components
 * 3. Updates items.rolled_cost and items.rolled_cost_at
 * 4. Creates an item_cost_history record with component snapshot
 * 
 * @param tenantId - Tenant identifier
 * @param itemId - Item to update
 * @param calculatedBy - Actor performing the calculation (e.g., 'user:123' or 'system')
 * @param client - Optional transaction client
 * @returns Updated rolled cost, or null if no active BOM found
 */
export async function updateItemRolledCost(
  tenantId: string,
  itemId: string,
  calculatedBy: string | null = null,
  client?: PoolClient
): Promise<{ rolledCost: number; bomVersionId: string } | null> {
  const executor = client ?? pool;

  // Find active BOM version for this item
  const bomResult = await executor.query<{ bom_version_id: string }>(
    `SELECT v.id AS bom_version_id
     FROM boms b
     JOIN bom_versions v ON v.bom_id = b.id AND v.tenant_id = b.tenant_id
     WHERE b.output_item_id = $1
       AND b.tenant_id = $2
       AND v.status = 'active'
       AND v.effective_from <= NOW()
       AND (v.effective_to IS NULL OR v.effective_to >= NOW())
     ORDER BY v.effective_from DESC
     LIMIT 1`,
    [itemId, tenantId]
  );

  if (bomResult.rowCount === 0) {
    // No active BOM found - cannot calculate rolled cost
    return null;
  }

  const bomVersionId = bomResult.rows[0].bom_version_id;

  // Calculate cost from BOM
  const costBreakdown = await calculateBomCost(tenantId, bomVersionId, client);

  // Get current rolled cost for history tracking
  const currentCostResult = await executor.query<{ rolled_cost: string | number | null }>(
    `SELECT rolled_cost FROM items WHERE id = $1 AND tenant_id = $2`,
    [itemId, tenantId]
  );

  const oldCost = currentCostResult.rows[0]?.rolled_cost
    ? Number(currentCostResult.rows[0].rolled_cost)
    : null;

  const now = new Date();

  // Update item's rolled cost
  await executor.query(
    `UPDATE items
     SET rolled_cost = $1,
         rolled_cost_at = $2,
         cost_method = 'rolled',
         updated_at = $2
     WHERE id = $3 AND tenant_id = $4`,
    [costBreakdown.totalCost, now, itemId, tenantId]
  );

  // Create cost history record
  const historyId = uuidv4();
  let calculatedById: string | null = null;
  if (calculatedBy) {
    if (calculatedBy.startsWith('user:')) {
      calculatedById = calculatedBy.slice(5);
    } else if (calculatedBy !== 'system') {
      calculatedById = calculatedBy;
    }
  }
  await executor.query(
    `INSERT INTO item_cost_history (
       id, tenant_id, item_id, cost_type, old_value, new_value,
       calculated_at, calculated_by, bom_version_id, component_snapshot
     ) VALUES ($1, $2, $3, 'rolled', $4, $5, $6, $7, $8, $9)`,
    [
      historyId,
      tenantId,
      itemId,
      oldCost,
      costBreakdown.totalCost,
      now,
      calculatedById,
      bomVersionId,
      JSON.stringify(costBreakdown.components)
    ]
  );

  return {
    rolledCost: costBreakdown.totalCost,
    bomVersionId
  };
}

/**
 * Batch update rolled costs for multiple items
 * 
 * Useful for recalculating costs across all WIP/finished goods items
 * after component cost changes.
 * 
 * @param tenantId - Tenant identifier
 * @param itemIds - Array of item IDs to update
 * @param calculatedBy - Actor performing the calculation
 * @returns Array of results with success/failure per item
 */
export async function batchUpdateRolledCosts(
  tenantId: string,
  itemIds: string[],
  calculatedBy: string | null = null
): Promise<Array<{ itemId: string; success: boolean; rolledCost?: number; error?: string }>> {
  const results: Array<{ itemId: string; success: boolean; rolledCost?: number; error?: string }> = [];

  for (const itemId of itemIds) {
    try {
      const result = await withTransaction(async (client) => {
        return await updateItemRolledCost(tenantId, itemId, calculatedBy, client);
      });

      if (result === null) {
        results.push({
          itemId,
          success: false,
          error: 'No active BOM found for item'
        });
      } else {
        results.push({
          itemId,
          success: true,
          rolledCost: result.rolledCost
        });
      }
    } catch (error) {
      results.push({
        itemId,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  return results;
}

/**
 * Check if an item's rolled cost is stale
 * 
 * A cost is considered stale if:
 * 1. Item has cost_method='rolled' and rolled_cost is set
 * 2. Any component's current cost differs from the snapshot in the latest history record
 * 
 * @param tenantId - Tenant identifier
 * @param itemId - Item to check
 * @returns True if cost is stale and needs recalculation
 */
export async function isRolledCostStale(
  tenantId: string,
  itemId: string
): Promise<boolean> {
  // Get item's cost method and latest history
  const result = await query<{
    cost_method: string | null;
    rolled_cost: string | number | null;
    latest_snapshot: unknown;
    bom_version_id: string | null;
  }>(
    `SELECT 
       i.cost_method,
       i.rolled_cost,
       h.component_snapshot AS latest_snapshot,
       h.bom_version_id
     FROM items i
     LEFT JOIN LATERAL (
       SELECT component_snapshot, bom_version_id
       FROM item_cost_history
       WHERE item_id = i.id
         AND tenant_id = i.tenant_id
         AND cost_type = 'rolled'
       ORDER BY calculated_at DESC
       LIMIT 1
     ) h ON true
     WHERE i.id = $1 AND i.tenant_id = $2`,
    [itemId, tenantId]
  );

  if (result.rowCount === 0) {
    return false;
  }

  const row = result.rows[0];

  // If not using rolled costing, not stale
  if (row.cost_method !== 'rolled' || row.rolled_cost === null) {
    return false;
  }

  // If no history snapshot, cannot determine staleness (assume fresh)
  if (!row.latest_snapshot || !row.bom_version_id) {
    return false;
  }

  // Get current component costs
  const components = await getBomComponents(tenantId, row.bom_version_id);
  const conversionCache = new Map<string, number | null>();
  let snapshot: ComponentCostSnapshot[] | null = null;
  if (Array.isArray(row.latest_snapshot)) {
    snapshot = row.latest_snapshot as ComponentCostSnapshot[];
  } else if (typeof row.latest_snapshot === 'string') {
    try {
      const parsed = JSON.parse(row.latest_snapshot);
      snapshot = Array.isArray(parsed) ? (parsed as ComponentCostSnapshot[]) : null;
    } catch {
      snapshot = null;
    }
  }
  if (!snapshot || snapshot.length === 0) {
    return false;
  }

  // Check if any component cost has changed
  for (const snapshotComponent of snapshot) {
    const currentComponent = components.find(
      (c) => c.component_item_id === snapshotComponent.componentItemId
    );

    if (!currentComponent) {
      // Component removed from BOM - definitely stale
      return true;
    }

    const currentUnitCost = await getComponentUnitCostInCanonicalUom(
      tenantId,
      currentComponent,
      conversionCache
    );
    if (Math.abs(currentUnitCost - snapshotComponent.unitCost) > 0.000001) {
      // Cost changed - stale
      return true;
    }
  }

  // Check if new components were added
  if (components.length !== snapshot.length) {
    return true;
  }

  // All costs match - not stale
  return false;
}

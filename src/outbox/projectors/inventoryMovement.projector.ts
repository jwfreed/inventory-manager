import type { PoolClient } from 'pg';
import { createCostLayer, consumeCostLayers } from '../../services/costLayers.service';
import { calculateMovementCost, getItemStandardCost } from '../../services/costing.service';
import { MetricsService } from '../../services/metrics.service';
import { cacheAdapter } from '../../lib/redis';
import { publishEvent } from '../../lib/eventBus';

type MovementRow = {
  id: string;
  tenant_id: string;
  movement_type: string;
  external_ref: string | null;
  occurred_at: string;
};

type MovementLineRow = {
  id: string;
  item_id: string;
  location_id: string;
  quantity_delta: string | number;
  quantity_delta_canonical: string | number | null;
  uom: string;
  canonical_uom: string | null;
  unit_cost: string | number | null;
  reason_code: string | null;
};

function toNumber(value: unknown): number {
  return Number(value ?? 0);
}

function normalizeQty(line: MovementLineRow): number {
  return toNumber(line.quantity_delta_canonical ?? line.quantity_delta);
}

function normalizeUom(line: MovementLineRow): string {
  return line.canonical_uom ?? line.uom;
}

function isWorkOrderIssue(externalRef: string | null): boolean {
  if (!externalRef) return false;
  return externalRef.startsWith('work_order_issue') || externalRef.startsWith('work_order_batch_issue');
}

function isWorkOrderCompletion(externalRef: string | null): boolean {
  if (!externalRef) return false;
  return externalRef.startsWith('work_order_completion') || externalRef.startsWith('work_order_disassembly_completion');
}

function isShipment(externalRef: string | null, reasonCode: string | null): boolean {
  if (reasonCode === 'shipment') return true;
  if (!externalRef) return false;
  return externalRef.startsWith('shipment:');
}

function sourceTypeForMovement(movement: MovementRow): 'receipt' | 'production' | 'adjustment' | 'transfer_in' {
  if (movement.movement_type === 'adjustment') return 'adjustment';
  if (movement.movement_type === 'transfer') return 'transfer_in';
  if (movement.movement_type === 'receive') {
    return isWorkOrderCompletion(movement.external_ref) ? 'production' : 'receipt';
  }
  return 'receipt';
}

function consumptionTypeForMovement(
  movement: MovementRow,
  line: MovementLineRow
): 'issue' | 'production_input' | 'sale' | 'adjustment' | 'transfer_out' {
  if (movement.movement_type === 'adjustment') return 'adjustment';
  if (movement.movement_type === 'transfer') return 'transfer_out';
  if (movement.movement_type === 'issue') {
    if (isWorkOrderIssue(movement.external_ref)) return 'production_input';
    if (isShipment(movement.external_ref, line.reason_code)) return 'sale';
    return 'issue';
  }
  return 'issue';
}

async function hasCostLayerActivity(client: PoolClient, tenantId: string, movementId: string): Promise<boolean> {
  const layers = await client.query(
    `SELECT 1 FROM inventory_cost_layers WHERE tenant_id = $1 AND movement_id = $2 LIMIT 1`,
    [tenantId, movementId]
  );
  if (layers.rowCount > 0) return true;
  const consumptions = await client.query(
    `SELECT 1 FROM cost_layer_consumptions WHERE tenant_id = $1 AND movement_id = $2 LIMIT 1`,
    [tenantId, movementId]
  );
  return consumptions.rowCount > 0;
}

async function ensureUnitCost(
  client: PoolClient,
  tenantId: string,
  itemId: string,
  qty: number,
  unitCost: number | null
): Promise<number | null> {
  if (unitCost !== null && !Number.isNaN(unitCost)) return unitCost;
  const cost = await calculateMovementCost(tenantId, itemId, qty, client);
  if (cost.unitCost !== null) return cost.unitCost;
  return getItemStandardCost(tenantId, itemId, client);
}

export async function projectInventoryMovement(
  client: PoolClient,
  tenantId: string,
  movementId: string
) {
  const movementRes = await client.query<MovementRow>(
    `SELECT id, tenant_id, movement_type, external_ref, occurred_at
       FROM inventory_movements
      WHERE id = $1 AND tenant_id = $2`,
    [movementId, tenantId]
  );
  if (movementRes.rowCount === 0) {
    throw new Error('OUTBOX_MOVEMENT_NOT_FOUND');
  }
  const movement = movementRes.rows[0];

  const linesRes = await client.query<MovementLineRow>(
    `SELECT id, item_id, location_id, quantity_delta, quantity_delta_canonical, uom, canonical_uom, unit_cost, reason_code
       FROM inventory_movement_lines
      WHERE movement_id = $1 AND tenant_id = $2
      ORDER BY created_at ASC`,
    [movementId, tenantId]
  );

  const lines = linesRes.rows;
  if (lines.length === 0) {
    return;
  }

  const itemIds = Array.from(new Set(lines.map((line) => line.item_id)));
  const locationIds = Array.from(new Set(lines.map((line) => line.location_id)));

  const hasCosts = await hasCostLayerActivity(client, tenantId, movementId);
  const transferCostingHandledInPosting =
    movement.movement_type === 'transfer' || movement.movement_type === 'transfer_reversal';
  if (!hasCosts && !transferCostingHandledInPosting) {
    const sourceType = sourceTypeForMovement(movement);

    for (const line of lines) {
      const qty = normalizeQty(line);
      if (qty === 0) continue;
      const uom = normalizeUom(line);

      if (qty > 0) {
        const unitCost = await ensureUnitCost(client, tenantId, line.item_id, qty, toNumber(line.unit_cost));
        if (unitCost === null) continue;
        await createCostLayer({
          tenant_id: tenantId,
          item_id: line.item_id,
          location_id: line.location_id,
          uom,
          quantity: qty,
          unit_cost: unitCost,
          source_type: sourceType,
          source_document_id: line.id,
          movement_id: movementId,
          layer_date: new Date(movement.occurred_at),
          notes: `Projected from movement ${movementId}`,
          client
        });
      } else {
        const consumptionType = consumptionTypeForMovement(movement, line);
        await consumeCostLayers({
          tenant_id: tenantId,
          item_id: line.item_id,
          location_id: line.location_id,
          quantity: Math.abs(qty),
          consumption_type: consumptionType,
          consumption_document_id: line.id,
          movement_id: movementId,
          consumed_at: new Date(movement.occurred_at),
          notes: `Projected from movement ${movementId}`,
          client
        });
      }
    }
  }

  try {
    await MetricsService.invalidateCache(tenantId);
    await cacheAdapter.invalidate(tenantId, '*');
  } catch {
    // Cache invalidation should not fail the projection.
  }

  try {
    await publishEvent(tenantId, {
      id: movementId,
      type: 'inventory.movement.posted',
      occurredAt: new Date().toISOString(),
      data: {
        movementId,
        movementType: movement.movement_type,
        itemIds,
        locationIds
      }
    });
  } catch {
    // Event publish is best-effort.
  }
}

export async function projectInventoryMovementFromOutbox(
  client: PoolClient,
  tenantId: string,
  aggregateId: string
) {
  await projectInventoryMovement(client, tenantId, aggregateId);
}

 

import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { withTransaction } from '../../db';
import { recordAuditLog } from '../../lib/audit';
import { toNumber } from '../../lib/numbers';
import { validateSufficientStock } from '../stockValidation.service';
import { calculateMovementCost, updateItemQuantityOnHand } from '../costing.service';
import { consumeCostLayers, createCostLayer } from '../costLayers.service';
import { getCanonicalMovementFields } from '../uomCanonical.service';
import { fetchInventoryAdjustmentById } from './core.service';
import type { InventoryAdjustmentRow, InventoryAdjustmentLineRow, PostingContext } from './types';
import { createInventoryMovement, createInventoryMovementLine, enqueueInventoryMovementPosted } from '../../domains/inventory';
import { applyInventoryBalanceDelta } from '../../domains/inventory';

export async function postInventoryAdjustment(
  tenantId: string,
  id: string,
  context?: PostingContext
) {
  const adjustment = await withTransaction(async (client: PoolClient) => {
    const now = new Date();
    const adjustmentResult = await client.query<InventoryAdjustmentRow>(
      'SELECT * FROM inventory_adjustments WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [id, tenantId]
    );
    if (adjustmentResult.rowCount === 0) {
      throw new Error('ADJUSTMENT_NOT_FOUND');
    }
    const adjustmentRow = adjustmentResult.rows[0];
    if (adjustmentRow.status === 'posted') {
      return fetchInventoryAdjustmentById(tenantId, id, client);
    }
    if (adjustmentRow.status === 'canceled') {
      throw new Error('ADJUSTMENT_CANCELED');
    }

    const linesResult = await client.query<InventoryAdjustmentLineRow>(
      'SELECT * FROM inventory_adjustment_lines WHERE inventory_adjustment_id = $1 AND tenant_id = $2 ORDER BY line_number ASC',
      [id, tenantId]
    );
    if (linesResult.rowCount === 0) {
      throw new Error('ADJUSTMENT_NO_LINES');
    }

    // Collect negative lines for stock validation
    const negativeLines = linesResult.rows
      .map((line) => {
        const qty = toNumber(line.quantity_delta);
        if (qty >= 0) return null;
        return {
          itemId: line.item_id,
          locationId: line.location_id,
          uom: line.uom,
          quantityToConsume: Math.abs(qty)
        };
      })
      .filter(Boolean) as { itemId: string; locationId: string; uom: string; quantityToConsume: number }[];

    // Validate sufficient stock for negative adjustments
    const validation = negativeLines.length
      ? await validateSufficientStock(
          tenantId,
          new Date(adjustmentRow.occurred_at),
          negativeLines,
          {
            actorId: context?.actor?.id ?? null,
            actorRole: context?.actor?.role ?? null,
            overrideRequested: context?.overrideRequested,
            overrideReason: context?.overrideReason ?? null,
            overrideReference: `inventory_adjustment:${id}`
          },
          { client }
        )
      : {};

    // Create inventory movement
    const movementId = uuidv4();
    const movement = await createInventoryMovement(client, {
      id: movementId,
      tenantId,
      movementType: 'adjustment',
      status: 'posted',
      externalRef: `inventory_adjustment:${id}`,
      occurredAt: adjustmentRow.occurred_at,
      postedAt: now,
      notes: adjustmentRow.notes ?? null,
      metadata: validation.overrideMetadata ?? null,
      createdAt: now,
      updatedAt: now
    });

    if (!movement.created) {
      const lineCheck = await client.query(
        `SELECT 1 FROM inventory_movement_lines WHERE movement_id = $1 LIMIT 1`,
        [movement.id]
      );
      if (lineCheck.rowCount > 0) {
        await client.query(
          `UPDATE inventory_adjustments
              SET status = 'posted',
                  inventory_movement_id = $1,
                  updated_at = $2
            WHERE id = $3 AND tenant_id = $4`,
          [movement.id, now, id, tenantId]
        );
        await enqueueInventoryMovementPosted(client, tenantId, movement.id);
        return fetchInventoryAdjustmentById(tenantId, id, client);
      }
    }

    // Create movement lines with costing
    for (const line of linesResult.rows) {
      const qty = toNumber(line.quantity_delta);
      if (qty === 0) {
        throw new Error('ADJUSTMENT_LINE_ZERO');
      }
      const canonicalFields = await getCanonicalMovementFields(
        tenantId,
        line.item_id,
        qty,
        line.uom,
        client
      );
      const canonicalQty = canonicalFields.quantityDeltaCanonical;
      
      // Calculate cost for adjustment movement
      const costData = await calculateMovementCost(tenantId, line.item_id, canonicalQty, client);
      
      // Handle cost layers for adjustment
      if (qty > 0) {
        await createCostLayer({
          tenant_id: tenantId,
          item_id: line.item_id,
          location_id: line.location_id,
          uom: canonicalFields.canonicalUom,
          quantity: canonicalQty,
          unit_cost: costData.unitCost || 0,
          source_type: 'adjustment',
          source_document_id: line.id,
          movement_id: movement.id,
          notes: `Adjustment increase: ${line.reason_code || 'unspecified'}`,
          client
        });
      } else {
        await consumeCostLayers({
          tenant_id: tenantId,
          item_id: line.item_id,
          location_id: line.location_id,
          quantity: Math.abs(canonicalQty),
          consumption_type: 'adjustment',
          consumption_document_id: line.id,
          movement_id: movement.id,
          notes: `Adjustment decrease: ${line.reason_code || 'unspecified'}`,
          client
        });
      }
      
      await createInventoryMovementLine(client, {
        tenantId,
        movementId: movement.id,
        itemId: line.item_id,
        locationId: line.location_id,
        quantityDelta: canonicalQty,
        uom: canonicalFields.canonicalUom,
        quantityDeltaEntered: canonicalFields.quantityDeltaEntered,
        uomEntered: canonicalFields.uomEntered,
        quantityDeltaCanonical: canonicalFields.quantityDeltaCanonical,
        canonicalUom: canonicalFields.canonicalUom,
        uomDimension: canonicalFields.uomDimension,
        unitCost: costData.unitCost,
        extendedCost: costData.extendedCost,
        reasonCode: line.reason_code,
        lineNotes: line.notes ?? `Adjustment ${id} line ${line.line_number}`
      });

      // Update item quantity on hand for average cost tracking
      await updateItemQuantityOnHand(tenantId, line.item_id, canonicalQty, client);

      await applyInventoryBalanceDelta(client, {
        tenantId,
        itemId: line.item_id,
        locationId: line.location_id,
        uom: canonicalFields.canonicalUom,
        deltaOnHand: canonicalQty
      });
    }

    // Update adjustment status
    await client.query(
      `UPDATE inventory_adjustments
          SET status = 'posted',
              inventory_movement_id = $1,
              updated_at = $2
       WHERE id = $3 AND tenant_id = $4`,
      [movement.id, now, id, tenantId]
    );

    await enqueueInventoryMovementPosted(client, tenantId, movement.id);

    // Audit logging
    if (context?.actor) {
      await recordAuditLog(
        {
          tenantId,
          actorType: context.actor.type,
          actorId: context.actor.id ?? null,
          action: 'post',
          entityType: 'inventory_adjustment',
          entityId: id,
          occurredAt: now,
          metadata: { movementId: movement.id }
        },
        client
      );
    }

    // Log override if applicable
    if (validation.overrideMetadata && context?.actor) {
      await recordAuditLog(
        {
          tenantId,
          actorType: context.actor.type,
          actorId: context.actor.id ?? null,
          action: 'negative_override',
          entityType: 'inventory_movement',
          entityId: movement.id,
          occurredAt: now,
          metadata: {
            reason: validation.overrideMetadata.override_reason ?? null,
            adjustmentId: id,
            lines: negativeLines,
            reference: validation.overrideMetadata.override_reference ?? null
          }
        },
        client
      );
    }

    return fetchInventoryAdjustmentById(tenantId, id, client);
  });

  return adjustment;
}

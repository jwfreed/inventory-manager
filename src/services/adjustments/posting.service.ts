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
      throw new Error('ADJUSTMENT_ALREADY_POSTED');
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
      ? await validateSufficientStock(tenantId, new Date(adjustmentRow.occurred_at), negativeLines, {
          actorId: context?.actor?.id ?? null,
          actorRole: context?.actor?.role ?? null,
          overrideRequested: context?.overrideRequested,
          overrideReason: context?.overrideReason ?? null,
          overrideReference: `inventory_adjustment:${id}`
        })
      : {};

    // Create inventory movement
    const movementId = uuidv4();
    await client.query(
      `INSERT INTO inventory_movements (
          id, tenant_id, movement_type, status, external_ref, occurred_at, posted_at, notes, metadata, created_at, updated_at
       ) VALUES ($1, $2, 'adjustment', 'posted', $3, $4, $5, $6, $7, $5, $5)`,
      [
        movementId,
        tenantId,
        `inventory_adjustment:${id}`,
        adjustmentRow.occurred_at,
        now,
        adjustmentRow.notes ?? null,
        validation.overrideMetadata ?? null
      ]
    );

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
      
      // Calculate cost for adjustment movement
      const costData = await calculateMovementCost(tenantId, line.item_id, qty, client);
      
      // Handle cost layers for adjustment
      if (qty > 0) {
        // Positive adjustment - create new cost layer
        try {
          await createCostLayer({
            tenant_id: tenantId,
            item_id: line.item_id,
            location_id: line.location_id,
            uom: line.uom,
            quantity: qty,
            unit_cost: costData.unitCost || 0,
            source_type: 'adjustment',
            source_document_id: line.id,
            movement_id: movementId,
            notes: `Adjustment increase: ${line.reason_code || 'unspecified'}`
          });
        } catch (err) {
          console.warn('Failed to create cost layer for adjustment:', err);
        }
      } else {
        // Negative adjustment - consume from cost layers
        try {
          await consumeCostLayers({
            tenant_id: tenantId,
            item_id: line.item_id,
            location_id: line.location_id,
            quantity: Math.abs(qty),
            consumption_type: 'adjustment',
            consumption_document_id: line.id,
            movement_id: movementId,
            notes: `Adjustment decrease: ${line.reason_code || 'unspecified'}`
          });
        } catch (err) {
          console.warn('Failed to consume cost layers for adjustment:', err);
        }
      }
      
      await client.query(
        `INSERT INTO inventory_movement_lines (
            id, tenant_id, movement_id, item_id, location_id, quantity_delta, uom,
            quantity_delta_entered, uom_entered, quantity_delta_canonical, canonical_uom, uom_dimension,
            unit_cost, extended_cost, reason_code, line_notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          uuidv4(),
          tenantId,
          movementId,
          line.item_id,
          line.location_id,
          qty,
          line.uom,
          canonicalFields.quantityDeltaEntered,
          canonicalFields.uomEntered,
          canonicalFields.quantityDeltaCanonical,
          canonicalFields.canonicalUom,
          canonicalFields.uomDimension,
          costData.unitCost,
          costData.extendedCost,
          line.reason_code,
          line.notes ?? `Adjustment ${id} line ${line.line_number}`
        ]
      );

      // Update item quantity on hand for average cost tracking
      await updateItemQuantityOnHand(tenantId, line.item_id, qty, client);
    }

    // Update adjustment status
    await client.query(
      `UPDATE inventory_adjustments
          SET status = 'posted',
              inventory_movement_id = $1,
              updated_at = $2
       WHERE id = $3 AND tenant_id = $4`,
      [movementId, now, id, tenantId]
    );

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
          metadata: { movementId }
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
          entityId: movementId,
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

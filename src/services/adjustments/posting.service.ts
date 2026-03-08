import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { recordAuditLog } from '../../lib/audit';
import { IDEMPOTENCY_ENDPOINTS } from '../../lib/idempotencyEndpoints';
import { toNumber } from '../../lib/numbers';
import { validateSufficientStock } from '../stockValidation.service';
import { calculateMovementCost } from '../costing.service';
import { consumeCostLayers, createCostLayer } from '../costLayers.service';
import { getCanonicalMovementFields } from '../uomCanonical.service';
import { resolveWarehouseIdForLocation } from '../warehouseDefaults.service';
import { fetchInventoryAdjustmentById } from './core.service';
import type { InventoryAdjustmentRow, InventoryAdjustmentLineRow, PostingContext } from './types';
import { createInventoryMovement, createInventoryMovementLine } from '../../domains/inventory';
import {
  runInventoryCommand,
  type InventoryCommandEvent,
  type InventoryCommandProjectionOp
} from '../../modules/platform/application/runInventoryCommand';
import {
  buildMovementDeterministicHash,
  buildPostedDocumentReplayResult,
  buildInventoryBalanceProjectionOp,
  buildMovementPostedEvent,
  buildRefreshItemCostSummaryProjectionOp,
  sortDeterministicMovementLines,
} from '../../modules/platform/application/inventoryMutationSupport';
import { buildInventoryRegistryEvent } from '../../modules/platform/application/inventoryEventRegistry';

function buildInventoryAdjustmentPostedEvent(
  adjustmentId: string,
  movementId: string
): InventoryCommandEvent {
  return buildInventoryRegistryEvent('inventoryAdjustmentPosted', {
    payload: {
      adjustmentId,
      movementId
    }
  });
}

function inventoryAdjustmentPostIncompleteError(
  adjustmentId: string,
  details?: Record<string, unknown>
) {
  const error = new Error('ADJUSTMENT_POST_INCOMPLETE') as Error & {
    code?: string;
    details?: Record<string, unknown>;
  };
  error.code = 'ADJUSTMENT_POST_INCOMPLETE';
  error.details = {
    adjustmentId,
    hint: 'Inventory adjustment status is inconsistent with authoritative movement state.',
    ...(details ?? {})
  };
  return error;
}

async function buildInventoryAdjustmentReplayResult(params: {
  tenantId: string;
  adjustmentId: string;
  movementId: string;
  expectedLineCount: number;
  expectedDeterministicHash?: string | null;
  client: PoolClient;
}) {
  return buildPostedDocumentReplayResult({
    tenantId: params.tenantId,
    authoritativeMovements: [
      {
        movementId: params.movementId,
        expectedLineCount: params.expectedLineCount,
        expectedDeterministicHash: params.expectedDeterministicHash ?? null
      }
    ],
    client: params.client,
    fetchAggregateView: () =>
      fetchInventoryAdjustmentById(params.tenantId, params.adjustmentId, params.client),
    aggregateNotFoundError: new Error('ADJUSTMENT_NOT_FOUND'),
    authoritativeEvents: [
      buildMovementPostedEvent(params.movementId),
      buildInventoryAdjustmentPostedEvent(params.adjustmentId, params.movementId)
    ],
    responseStatus: 200
  });
}

export async function postInventoryAdjustment(
  tenantId: string,
  id: string,
  context?: PostingContext
) {
  let adjustmentRow: InventoryAdjustmentRow | null = null;
  let adjustmentLines: InventoryAdjustmentLineRow[] = [];
  let warehouseIdsByLocation = new Map<string, string>();

  return runInventoryCommand<any>({
    tenantId,
    endpoint: IDEMPOTENCY_ENDPOINTS.INVENTORY_ADJUSTMENTS_POST,
    operation: 'inventory_adjustment_post',
    retryOptions: { isolationLevel: 'SERIALIZABLE', retries: 2 },
    lockTargets: async (client) => {
        const adjustmentResult = await client.query<InventoryAdjustmentRow>(
          'SELECT * FROM inventory_adjustments WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
          [id, tenantId]
        );
        if (adjustmentResult.rowCount === 0) {
          throw new Error('ADJUSTMENT_NOT_FOUND');
        }
        adjustmentRow = adjustmentResult.rows[0];
        if (adjustmentRow.status === 'canceled') {
          throw new Error('ADJUSTMENT_CANCELED');
        }

        const linesResult = await client.query<InventoryAdjustmentLineRow>(
          `SELECT *
             FROM inventory_adjustment_lines
            WHERE inventory_adjustment_id = $1
              AND tenant_id = $2
            ORDER BY line_number ASC
            FOR UPDATE`,
          [id, tenantId]
        );
        if (linesResult.rowCount === 0) {
          throw new Error('ADJUSTMENT_NO_LINES');
        }
        adjustmentLines = linesResult.rows;

        if (adjustmentRow.status === 'posted' && adjustmentRow.inventory_movement_id) {
          return [];
        }
        if (adjustmentRow.status === 'posted' && !adjustmentRow.inventory_movement_id) {
          throw inventoryAdjustmentPostIncompleteError(id, {
            reason: 'adjustment_posted_without_movement'
          });
        }

        warehouseIdsByLocation = new Map<string, string>();
        for (const line of adjustmentLines) {
          if (!warehouseIdsByLocation.has(line.location_id)) {
            warehouseIdsByLocation.set(
              line.location_id,
              await resolveWarehouseIdForLocation(tenantId, line.location_id, client)
            );
          }
        }
        return adjustmentLines.map((line) => ({
          tenantId,
          warehouseId: warehouseIdsByLocation.get(line.location_id) ?? '',
          itemId: line.item_id
        }));
      },
    execute: async ({ client }) => {
        if (!adjustmentRow) {
          throw new Error('ADJUSTMENT_NOT_FOUND');
        }

        if (adjustmentRow.status === 'posted') {
          if (!adjustmentRow.inventory_movement_id) {
            throw inventoryAdjustmentPostIncompleteError(id, {
              reason: 'adjustment_posted_without_movement'
            });
          }
          return buildInventoryAdjustmentReplayResult({
            tenantId,
            adjustmentId: id,
            movementId: adjustmentRow.inventory_movement_id,
            expectedLineCount: adjustmentLines.length,
            client
          });
        }

        const now = new Date();
        const negativeLines = adjustmentLines
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

        const validation = negativeLines.length
          ? await validateSufficientStock(
              tenantId,
              new Date(adjustmentRow.occurred_at),
              negativeLines.map((line) => ({
                warehouseId: warehouseIdsByLocation.get(line.locationId) ?? '',
                ...line
              })),
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

        const projectionOps: InventoryCommandProjectionOp[] = [];
        const itemsToRefresh = new Set<string>();
        const preparedLines: Array<{
          line: InventoryAdjustmentLineRow;
          qty: number;
          warehouseId: string;
          canonicalFields: Awaited<ReturnType<typeof getCanonicalMovementFields>>;
        }> = [];
        for (const line of adjustmentLines) {
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
          preparedLines.push({
            line,
            qty,
            warehouseId: warehouseIdsByLocation.get(line.location_id) ?? '',
            canonicalFields
          });
        }

        const sortedPreparedLines = sortDeterministicMovementLines(
          preparedLines,
          (entry) => ({
            tenantId,
            warehouseId: entry.warehouseId,
            locationId: entry.line.location_id,
            itemId: entry.line.item_id,
            canonicalUom: entry.canonicalFields.canonicalUom,
            sourceLineId: entry.line.id
          })
        );
        const movementId = uuidv4();
        const movement = await createInventoryMovement(client, {
          id: movementId,
          tenantId,
          movementType: 'adjustment',
          status: 'posted',
          externalRef: `inventory_adjustment:${id}`,
          sourceType: 'inventory_adjustment_post',
          sourceId: id,
          occurredAt: adjustmentRow.occurred_at,
          postedAt: now,
          notes: adjustmentRow.notes ?? null,
          metadata: validation.overrideMetadata ?? null,
          movementDeterministicHash: buildMovementDeterministicHash(
            sortedPreparedLines.map(({ line, canonicalFields }) => ({
              itemId: line.item_id,
              locationId: line.location_id,
              quantityDelta: canonicalFields.quantityDeltaCanonical,
              uom: canonicalFields.canonicalUom,
              quantityDeltaEntered: canonicalFields.quantityDeltaEntered,
              uomEntered: canonicalFields.uomEntered,
              quantityDeltaCanonical: canonicalFields.quantityDeltaCanonical,
              canonicalUom: canonicalFields.canonicalUom,
              reasonCode: line.reason_code
            }))
          ),
          createdAt: now,
          updatedAt: now
        });

        if (!movement.created) {
          const lineCheck = await client.query(
            `SELECT 1
               FROM inventory_movement_lines
              WHERE tenant_id = $1
                AND movement_id = $2
              LIMIT 1`,
            [tenantId, movement.id]
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
            return buildInventoryAdjustmentReplayResult({
              tenantId,
              adjustmentId: id,
              movementId: movement.id,
              expectedLineCount: sortedPreparedLines.length,
              expectedDeterministicHash: buildMovementDeterministicHash(
                sortedPreparedLines.map(({ line, canonicalFields }) => ({
                  itemId: line.item_id,
                  locationId: line.location_id,
                  quantityDelta: canonicalFields.quantityDeltaCanonical,
                  uom: canonicalFields.canonicalUom,
                  quantityDeltaEntered: canonicalFields.quantityDeltaEntered,
                  uomEntered: canonicalFields.uomEntered,
                  quantityDeltaCanonical: canonicalFields.quantityDeltaCanonical,
                  canonicalUom: canonicalFields.canonicalUom,
                  reasonCode: line.reason_code
                }))
              ),
              client
            });
          }
          throw inventoryAdjustmentPostIncompleteError(id, {
            movementId: movement.id,
            reason: 'movement_exists_without_lines'
          });
        }

        for (const preparedLine of sortedPreparedLines) {
          const { line, qty, canonicalFields } = preparedLine;
          const canonicalQty = canonicalFields.quantityDeltaCanonical;
          const costData = await calculateMovementCost(tenantId, line.item_id, canonicalQty, client);

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

          projectionOps.push(
            buildInventoryBalanceProjectionOp({
              tenantId,
              itemId: line.item_id,
              locationId: line.location_id,
              uom: canonicalFields.canonicalUom,
              deltaOnHand: canonicalQty
            })
          );
          itemsToRefresh.add(line.item_id);
        }

        for (const itemId of itemsToRefresh.values()) {
          projectionOps.push(buildRefreshItemCostSummaryProjectionOp(tenantId, itemId));
        }

        await client.query(
          `UPDATE inventory_adjustments
              SET status = 'posted',
                  inventory_movement_id = $1,
                  updated_at = $2
           WHERE id = $3 AND tenant_id = $4`,
          [movement.id, now, id, tenantId]
        );

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

        const adjustment = await fetchInventoryAdjustmentById(tenantId, id, client);
        if (!adjustment) {
          throw new Error('ADJUSTMENT_NOT_FOUND');
        }
        return {
          responseBody: adjustment,
          responseStatus: 200,
          events: [
            buildMovementPostedEvent(movement.id),
            buildInventoryAdjustmentPostedEvent(id, movement.id)
          ],
          projectionOps
        };
    }
  });
}

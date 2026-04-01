import type { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { persistInventoryMovement } from '../../domains/inventory';
import { roundQuantity } from '../../lib/numbers';
import {
  buildInventoryBalanceProjectionOp
} from '../../modules/platform/application/inventoryMutationSupport';
import type { InventoryCommandProjectionOp } from '../../modules/platform/application/runInventoryCommand';
import { validateSufficientStock } from '../../services/stockValidation.service';
import { relocateTransferCostLayersInTx } from '../../services/transferCosting.service';
import type { PreparedTransferMutation } from './transferPolicy';
import type { TransferMovementPlan } from './transferPlan';

export type ExecutedTransferMutation = Readonly<{
  result: {
    movementId: string;
    created: boolean;
    replayed: boolean;
    idempotencyKey: string | null;
    sourceWarehouseId: string;
    destinationWarehouseId: string;
  };
  projectionOps: ReadonlyArray<InventoryCommandProjectionOp>;
}>;

function assertTransferExecutionConservation(plan: TransferMovementPlan) {
  const outbound = plan.lines[plan.outLineIndex];
  const inbound = plan.lines[plan.inLineIndex];

  if (!outbound || !inbound) {
    throw new Error('TRANSFER_LINE_DIRECTIONS_MISSING');
  }

  const outboundQty = roundQuantity(Math.abs(outbound.canonicalFields.quantityDeltaCanonical));
  const inboundQty = roundQuantity(inbound.canonicalFields.quantityDeltaCanonical);
  if (outbound.canonicalFields.quantityDeltaCanonical >= 0 || inbound.canonicalFields.quantityDeltaCanonical <= 0) {
    throw new Error('TRANSFER_PLAN_DIRECTION_INVALID');
  }
  if (outbound.canonicalFields.canonicalUom !== inbound.canonicalFields.canonicalUom) {
    throw new Error('TRANSFER_CANONICAL_MISMATCH');
  }
  if (Math.abs(outboundQty - inboundQty) > 1e-6) {
    throw new Error('TRANSFER_QUANTITY_IMBALANCE');
  }
}

function requirePersistedLineId(
  lineIds: string[],
  index: number
): string {
  const lineId = lineIds[index];
  if (!lineId) {
    throw new Error('TRANSFER_PERSISTED_LINE_ID_MISSING');
  }
  return lineId;
}

export async function executeTransferMovementPlan(
  prepared: PreparedTransferMutation,
  movementPlan: TransferMovementPlan,
  client: PoolClient
): Promise<ExecutedTransferMutation> {
  assertTransferExecutionConservation(movementPlan);

  const validation = await validateSufficientStock(
    prepared.tenantId,
    prepared.occurredAt,
    [
      {
        warehouseId: prepared.sourceWarehouseId,
        itemId: prepared.itemId,
        locationId: prepared.sourceLocationId,
        uom: prepared.uom,
        quantityToConsume: prepared.enteredQty
      }
    ],
    {
      actorId: prepared.actorId,
      overrideRequested: prepared.overrideNegative,
      overrideReason: prepared.overrideReason,
      overrideReference: `${prepared.sourceType}:${prepared.sourceId}`
    },
    { client }
  );

  const movementResult = await persistInventoryMovement(client, {
    id: uuidv4(),
    ...movementPlan.persistInput,
    lines: movementPlan.persistInput.lines.map((line) => ({ ...line })),
    metadata: validation.overrideMetadata ?? null
  });

  const result = {
    movementId: movementResult.movementId,
    created: movementResult.created,
    replayed: false,
    idempotencyKey: prepared.idempotencyKey,
    sourceWarehouseId: prepared.sourceWarehouseId,
    destinationWarehouseId: prepared.destinationWarehouseId
  };

  if (!movementResult.created) {
    return {
      result,
      projectionOps: []
    };
  }

  const outbound = movementPlan.lines[movementPlan.outLineIndex]!;
  const inbound = movementPlan.lines[movementPlan.inLineIndex]!;
  const outLineId = requirePersistedLineId(movementResult.lineIds, movementPlan.outLineIndex);
  const inLineId = requirePersistedLineId(movementResult.lineIds, movementPlan.inLineIndex);

  await relocateTransferCostLayersInTx({
    client,
    tenantId: prepared.tenantId,
    transferMovementId: movementResult.movementId,
    occurredAt: prepared.occurredAt,
    notes: prepared.notes,
    pairs: [
      {
        itemId: prepared.itemId,
        sourceLocationId: prepared.sourceLocationId,
        destinationLocationId: prepared.destinationLocationId,
        outLineId,
        inLineId,
        quantity: movementPlan.canonicalQuantity,
        uom: movementPlan.canonicalUom
      }
    ]
  });

  return {
    result,
    projectionOps: [
      buildInventoryBalanceProjectionOp({
        tenantId: prepared.tenantId,
        itemId: prepared.itemId,
        locationId: prepared.sourceLocationId,
        uom: outbound.canonicalFields.canonicalUom,
        deltaOnHand: outbound.canonicalFields.quantityDeltaCanonical
      }),
      buildInventoryBalanceProjectionOp({
        tenantId: prepared.tenantId,
        itemId: prepared.itemId,
        locationId: prepared.destinationLocationId,
        uom: inbound.canonicalFields.canonicalUom,
        deltaOnHand: inbound.canonicalFields.quantityDeltaCanonical
      })
    ]
  };
}

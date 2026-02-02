import type { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { roundQuantity, toNumber } from '../lib/numbers';
import { validateSufficientStock } from './stockValidation.service';
import { getCanonicalMovementFields } from './uomCanonical.service';
import { calculateMovementCost } from './costing.service';
import {
  createInventoryMovement,
  createInventoryMovementLine,
  applyInventoryBalanceDelta,
  enqueueInventoryMovementPosted
} from '../domains/inventory';

/**
 * Canonical transfer primitive for inventory movements.
 * Transfers NEVER create or mutate cost layers - cost is inherited from source.
 * QC disposition transfers existing inventory; cost layers are receipt-authored only.
 */
export type TransferInventoryInput = {
  tenantId: string;
  sourceLocationId: string;
  destinationLocationId: string;
  itemId: string;
  quantity: number;
  uom: string;
  sourceType: string;
  sourceId: string;
  movementType?: string;
  qcAction?: 'accept' | 'hold' | 'reject';
  reasonCode?: string;
  notes?: string;
  occurredAt?: Date;
  actorId?: string | null;
  overrideNegative?: boolean;
  overrideReason?: string | null;
  lotId?: string | null;
  serialNumbers?: string[] | null;
};

export type TransferInventoryResult = {
  movementId: string;
  created: boolean;
};

export async function transferInventory(
  input: TransferInventoryInput,
  client: PoolClient
): Promise<TransferInventoryResult> {
  const {
    tenantId,
    sourceLocationId,
    destinationLocationId,
    itemId,
    quantity,
    uom,
    sourceType,
    sourceId,
    movementType = 'transfer',
    qcAction,
    reasonCode = 'transfer',
    notes = 'Inventory transfer',
    occurredAt = new Date(),
    actorId = null,
    overrideNegative = false,
    overrideReason = null
  } = input;

  if (sourceLocationId === destinationLocationId) {
    throw new Error('TRANSFER_SAME_LOCATION');
  }

  const enteredQty = roundQuantity(toNumber(quantity));
  if (enteredQty <= 0) {
    throw new Error('TRANSFER_INVALID_QUANTITY');
  }

  // Validate destination location role
  const destCheck = await client.query(
    `SELECT role, is_sellable FROM locations WHERE id = $1 AND tenant_id = $2`,
    [destinationLocationId, tenantId]
  );
  if (destCheck.rowCount === 0) {
    throw new Error('TRANSFER_DESTINATION_NOT_FOUND');
  }
  const destLocation = destCheck.rows[0];

  if (sourceType === 'qc_event') {
    if (!qcAction) {
      throw new Error('QC_ACTION_REQUIRED');
    }
    const sourceCheck = await client.query(
      `SELECT role, is_sellable FROM locations WHERE id = $1 AND tenant_id = $2`,
      [sourceLocationId, tenantId]
    );
    if (sourceCheck.rowCount === 0) {
      throw new Error('TRANSFER_SOURCE_NOT_FOUND');
    }
    const sourceLocation = sourceCheck.rows[0];
    if (sourceLocation.role !== 'QA' || sourceLocation.is_sellable) {
      throw new Error('QC_SOURCE_MUST_BE_QA');
    }

    if (qcAction === 'accept') {
      if (destLocation.role !== 'SELLABLE') {
        throw new Error('QC_ACCEPT_REQUIRES_SELLABLE_ROLE');
      }
      if (!destLocation.is_sellable) {
        throw new Error('QC_ACCEPT_REQUIRES_SELLABLE_FLAG');
      }
    } else if (qcAction === 'hold') {
      if (destLocation.role !== 'HOLD') {
        throw new Error('QC_HOLD_REQUIRES_HOLD_ROLE');
      }
      if (destLocation.is_sellable) {
        throw new Error('QC_HOLD_MUST_NOT_BE_SELLABLE');
      }
    } else if (qcAction === 'reject') {
      if (destLocation.role !== 'REJECT') {
        throw new Error('QC_REJECT_REQUIRES_REJECT_ROLE');
      }
      if (destLocation.is_sellable) {
        throw new Error('QC_REJECT_MUST_NOT_BE_SELLABLE');
      }
    }
  }

  // Validate sufficient stock at source
  const validation = await validateSufficientStock(
    tenantId,
    occurredAt,
    [
      {
        itemId,
        locationId: sourceLocationId,
        uom,
        quantityToConsume: enteredQty
      }
    ],
    {
      actorId,
      overrideRequested: overrideNegative,
      overrideReason,
      overrideReference: `${sourceType}:${sourceId}`
    },
    { client }
  );

  const movementId = uuidv4();
  const externalRef = `${sourceType}:${sourceId}`;

  // Create transfer movement (idempotent via source_type + source_id uniqueness)
  const movementResult = await createInventoryMovement(client, {
    id: movementId,
    tenantId,
    movementType,
    status: 'posted',
    externalRef,
    sourceType,
    sourceId,
    occurredAt,
    postedAt: occurredAt,
    notes,
    metadata: validation.overrideMetadata ?? null,
    createdAt: occurredAt,
    updatedAt: occurredAt
  });

  if (!movementResult.created) {
    // Idempotent: movement already exists
    return { movementId: movementResult.id, created: false };
  }

  // Create outbound line (negative quantity at source)
  const canonicalOut = await getCanonicalMovementFields(tenantId, itemId, -enteredQty, uom, client);
  const costDataOut = await calculateMovementCost(tenantId, itemId, canonicalOut.quantityDeltaCanonical, client);

  await createInventoryMovementLine(client, {
    tenantId,
    movementId,
    itemId,
    locationId: sourceLocationId,
    quantityDelta: canonicalOut.quantityDeltaCanonical,
    uom: canonicalOut.canonicalUom,
    quantityDeltaEntered: canonicalOut.quantityDeltaEntered,
    uomEntered: canonicalOut.uomEntered,
    quantityDeltaCanonical: canonicalOut.quantityDeltaCanonical,
    canonicalUom: canonicalOut.canonicalUom,
    uomDimension: canonicalOut.uomDimension,
    unitCost: costDataOut.unitCost,
    extendedCost: costDataOut.extendedCost,
    reasonCode: `${reasonCode}_out`,
    lineNotes: `${notes} (outbound)`
  });

  await applyInventoryBalanceDelta(client, {
    tenantId,
    itemId,
    locationId: sourceLocationId,
    uom: canonicalOut.canonicalUom,
    deltaOnHand: canonicalOut.quantityDeltaCanonical
  });

  // Create inbound line (positive quantity at destination)
  const canonicalIn = await getCanonicalMovementFields(tenantId, itemId, enteredQty, uom, client);
  const costDataIn = await calculateMovementCost(tenantId, itemId, canonicalIn.quantityDeltaCanonical, client);

  await createInventoryMovementLine(client, {
    tenantId,
    movementId,
    itemId,
    locationId: destinationLocationId,
    quantityDelta: canonicalIn.quantityDeltaCanonical,
    uom: canonicalIn.canonicalUom,
    quantityDeltaEntered: canonicalIn.quantityDeltaEntered,
    uomEntered: canonicalIn.uomEntered,
    quantityDeltaCanonical: canonicalIn.quantityDeltaCanonical,
    canonicalUom: canonicalIn.canonicalUom,
    uomDimension: canonicalIn.uomDimension,
    unitCost: costDataIn.unitCost,
    extendedCost: costDataIn.extendedCost,
    reasonCode: `${reasonCode}_in`,
    lineNotes: `${notes} (inbound)`
  });

  await applyInventoryBalanceDelta(client, {
    tenantId,
    itemId,
    locationId: destinationLocationId,
    uom: canonicalIn.canonicalUom,
    deltaOnHand: canonicalIn.quantityDeltaCanonical
  });

  await enqueueInventoryMovementPosted(client, tenantId, movementId);

  return { movementId, created: true };
}

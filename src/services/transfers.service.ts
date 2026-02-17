import type { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { withTransactionRetry } from '../db';
import { roundQuantity, toNumber } from '../lib/numbers';
import { validateSufficientStock } from './stockValidation.service';
import { getCanonicalMovementFields } from './uomCanonical.service';
import {
  createInventoryMovement,
  createInventoryMovementLine,
  applyInventoryBalanceDelta,
  enqueueInventoryMovementPosted
} from '../domains/inventory';
import { relocateTransferCostLayersInTx, reverseTransferCostLayersInTx } from './transferCosting.service';

const TRANSFER_REVERSAL_MOVEMENT_TYPE = 'transfer_reversal';

/**
 * Canonical transfer primitive for inventory movements.
 * Transfers must relocate FIFO cost layers inside the posting transaction.
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

export type TransferVoidActor = {
  type: 'user' | 'system';
  id?: string | null;
};

function negateNullable(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return roundQuantity(-toNumber(value));
}

function assertReason(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed) {
    throw new Error('TRANSFER_VOID_REASON_REQUIRED');
  }
  return trimmed;
}

type MovementLineRow = {
  id: string;
  item_id: string;
  location_id: string;
  quantity_delta: string | number;
  uom: string;
  quantity_delta_entered: string | number | null;
  uom_entered: string | null;
  quantity_delta_canonical: string | number | null;
  canonical_uom: string | null;
  uom_dimension: string | null;
  unit_cost: string | number | null;
  extended_cost: string | number | null;
  reason_code: string | null;
  line_notes: string | null;
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
    return { movementId: movementResult.id, created: false };
  }

  const canonicalOut = await getCanonicalMovementFields(tenantId, itemId, -enteredQty, uom, client);
  const canonicalIn = await getCanonicalMovementFields(tenantId, itemId, enteredQty, uom, client);
  if (
    canonicalOut.canonicalUom !== canonicalIn.canonicalUom
    || Math.abs(Math.abs(canonicalOut.quantityDeltaCanonical) - canonicalIn.quantityDeltaCanonical) > 1e-6
  ) {
    throw new Error('TRANSFER_CANONICAL_MISMATCH');
  }

  const outLineId = await createInventoryMovementLine(client, {
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

  const inLineId = await createInventoryMovementLine(client, {
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

  await relocateTransferCostLayersInTx({
    client,
    tenantId,
    transferMovementId: movementId,
    occurredAt,
    notes,
    pairs: [
      {
        itemId,
        sourceLocationId,
        destinationLocationId,
        outLineId,
        inLineId,
        quantity: canonicalIn.quantityDeltaCanonical,
        uom: canonicalIn.canonicalUom
      }
    ]
  });

  await enqueueInventoryMovementPosted(client, tenantId, movementId);

  return { movementId, created: true };
}

export async function voidTransferMovement(
  tenantId: string,
  movementId: string,
  params: { reason: string; actor: TransferVoidActor; idempotencyKey?: string | null }
) {
  const reason = assertReason(params.reason);

  return withTransactionRetry(async (client) => {
    const now = new Date();

    const originalMovementResult = await client.query<{
      id: string;
      status: string;
      movement_type: string;
      reversal_of_movement_id: string | null;
    }>(
      `SELECT id, status, movement_type, reversal_of_movement_id
         FROM inventory_movements
        WHERE id = $1
          AND tenant_id = $2
        FOR UPDATE`,
      [movementId, tenantId]
    );
    if (originalMovementResult.rowCount === 0) {
      throw new Error('TRANSFER_NOT_FOUND');
    }
    const originalMovement = originalMovementResult.rows[0];
    if (originalMovement.status !== 'posted') {
      throw new Error('TRANSFER_NOT_POSTED');
    }
    if (
      originalMovement.movement_type === TRANSFER_REVERSAL_MOVEMENT_TYPE
      || originalMovement.reversal_of_movement_id !== null
    ) {
      throw new Error('TRANSFER_REVERSAL_INVALID_TARGET');
    }
    if (originalMovement.movement_type !== 'transfer') {
      throw new Error('TRANSFER_NOT_TRANSFER');
    }

    const existingReversal = await client.query<{ id: string }>(
      `SELECT id
         FROM inventory_movements
        WHERE tenant_id = $1
          AND reversal_of_movement_id = $2
        LIMIT 1`,
      [tenantId, movementId]
    );
    if (existingReversal.rowCount > 0) {
      throw new Error('TRANSFER_ALREADY_REVERSED');
    }

    const reversalMovement = await createInventoryMovement(client, {
      tenantId,
      movementType: TRANSFER_REVERSAL_MOVEMENT_TYPE,
      status: 'posted',
      externalRef: `transfer_void:${movementId}`,
      sourceType: 'transfer_void',
      sourceId: movementId,
      idempotencyKey: params.idempotencyKey ?? null,
      occurredAt: now,
      postedAt: now,
      notes: `Transfer void reversal ${movementId}: ${reason}`,
      reversalOfMovementId: movementId,
      reversalReason: reason,
      createdAt: now,
      updatedAt: now
    });

    if (!reversalMovement.created) {
      const existingMovementResult = await client.query<{
        id: string;
        movement_type: string;
        reversal_of_movement_id: string | null;
      }>(
        `SELECT id, movement_type, reversal_of_movement_id
           FROM inventory_movements
          WHERE id = $1
            AND tenant_id = $2
          FOR UPDATE`,
        [reversalMovement.id, tenantId]
      );
      const existingMovement = existingMovementResult.rows[0];
      if (
        existingMovement
        && existingMovement.movement_type === TRANSFER_REVERSAL_MOVEMENT_TYPE
        && existingMovement.reversal_of_movement_id === movementId
      ) {
        throw new Error('TRANSFER_ALREADY_REVERSED');
      }
      throw new Error('TRANSFER_VOID_CONFLICT');
    }

    const originalLinesResult = await client.query<MovementLineRow>(
      `SELECT id,
              item_id,
              location_id,
              quantity_delta,
              uom,
              quantity_delta_entered,
              uom_entered,
              quantity_delta_canonical,
              canonical_uom,
              uom_dimension,
              unit_cost,
              extended_cost,
              reason_code,
              line_notes
         FROM inventory_movement_lines
        WHERE tenant_id = $1
          AND movement_id = $2
        ORDER BY created_at ASC, id ASC
        FOR UPDATE`,
      [tenantId, movementId]
    );
    if (originalLinesResult.rowCount === 0) {
      throw new Error('TRANSFER_NOT_POSTED');
    }

    const reversalLineByOriginalLineId = new Map<string, string>();
    const balanceDeltaByKey = new Map<string, { itemId: string; locationId: string; uom: string; deltaOnHand: number }>();

    for (const line of originalLinesResult.rows) {
      const effectiveUom = line.canonical_uom ?? line.uom;
      const effectiveQty = roundQuantity(toNumber(line.quantity_delta_canonical ?? line.quantity_delta));
      const reversalLineId = await createInventoryMovementLine(client, {
        tenantId,
        movementId: reversalMovement.id,
        itemId: line.item_id,
        locationId: line.location_id,
        quantityDelta: roundQuantity(-toNumber(line.quantity_delta)),
        uom: line.uom,
        quantityDeltaEntered: negateNullable(line.quantity_delta_entered),
        uomEntered: line.uom_entered,
        quantityDeltaCanonical: negateNullable(line.quantity_delta_canonical),
        canonicalUom: line.canonical_uom,
        uomDimension: line.uom_dimension,
        unitCost: line.unit_cost != null ? roundQuantity(toNumber(line.unit_cost)) : null,
        extendedCost: negateNullable(line.extended_cost),
        reasonCode: line.reason_code ? `${line.reason_code}_reversal` : 'transfer_reversal',
        lineNotes: line.line_notes ? `Reversal of ${line.id}: ${line.line_notes}` : `Reversal of ${line.id}`,
        createdAt: now
      });
      reversalLineByOriginalLineId.set(line.id, reversalLineId);

      const key = `${line.item_id}|${line.location_id}|${effectiveUom}`;
      const current = balanceDeltaByKey.get(key) ?? {
        itemId: line.item_id,
        locationId: line.location_id,
        uom: effectiveUom,
        deltaOnHand: 0
      };
      current.deltaOnHand = roundQuantity(current.deltaOnHand - effectiveQty);
      balanceDeltaByKey.set(key, current);
    }

    await reverseTransferCostLayersInTx({
      client,
      tenantId,
      originalTransferMovementId: movementId,
      reversalMovementId: reversalMovement.id,
      occurredAt: now,
      notes: `Transfer reversal ${movementId}`,
      reversalLineByOriginalLineId
    });

    for (const delta of balanceDeltaByKey.values()) {
      if (Math.abs(delta.deltaOnHand) <= 1e-6) continue;
      try {
        await applyInventoryBalanceDelta(client, {
          tenantId,
          itemId: delta.itemId,
          locationId: delta.locationId,
          uom: delta.uom,
          deltaOnHand: delta.deltaOnHand
        });
      } catch (error: any) {
        if (error?.code === '23514' && error?.constraint === 'chk_inventory_balance_nonneg') {
          throw new Error('TRANSFER_REVERSAL_NOT_POSSIBLE_CONSUMED');
        }
        throw error;
      }
    }

    await enqueueInventoryMovementPosted(client, tenantId, reversalMovement.id);

    return {
      reversalMovementId: reversalMovement.id,
      reversalOfMovementId: movementId
    };
  }, { isolationLevel: 'SERIALIZABLE', retries: 6 });
}

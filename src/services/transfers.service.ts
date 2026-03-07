import type { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { roundQuantity, toNumber } from '../lib/numbers';
import { validateSufficientStock } from './stockValidation.service';
import { getCanonicalMovementFields } from './uomCanonical.service';
import { resolveWarehouseIdForLocation } from './warehouseDefaults.service';
import {
  createInventoryMovement,
  createInventoryMovementLine,
  applyInventoryBalanceDelta,
  enqueueInventoryMovementPosted
} from '../domains/inventory';
import { relocateTransferCostLayersInTx, reverseTransferCostLayersInTx } from './transferCosting.service';
import { hashTransactionalIdempotencyRequest } from '../lib/transactionalIdempotency';
import { IDEMPOTENCY_ENDPOINTS } from '../lib/idempotencyEndpoints';
import {
  runInventoryCommand,
  type InventoryCommandEvent,
  type InventoryCommandProjectionOp
} from '../modules/platform/application/runInventoryCommand';
import {
  buildInventoryBalanceProjectionOp,
  buildMovementPostedEvent
} from '../modules/platform/application/inventoryMutationSupport';

const TRANSFER_REVERSAL_MOVEMENT_TYPE = 'transfer_reversal';

/**
 * Canonical transfer primitive for inventory movements.
 * Transfers must relocate FIFO cost layers inside the posting transaction.
 */
export type TransferInventoryInput = {
  tenantId: string;
  sourceLocationId: string;
  destinationLocationId: string;
  warehouseId?: string | null;
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
  idempotencyKey?: string | null;
  lotId?: string | null;
  serialNumbers?: string[] | null;
  inventoryCommandEndpoint?: string | null;
  inventoryCommandOperation?: string | null;
  inventoryCommandRequestBody?: Record<string, unknown> | null;
};

export type TransferInventoryResult = {
  movementId: string;
  created: boolean;
  replayed: boolean;
  idempotencyKey: string | null;
  sourceWarehouseId: string;
  destinationWarehouseId: string;
};

export type TransferPostInput = {
  tenantId: string;
  sourceLocationId: string;
  destinationLocationId: string;
  warehouseId?: string | null;
  itemId: string;
  quantity: number;
  uom: string;
  occurredAt?: Date;
  reasonCode?: string;
  notes?: string;
  actorId?: string | null;
  overrideNegative?: boolean;
  overrideReason?: string | null;
  idempotencyKey?: string | null;
};

export type TransferPostResult = {
  movementId: string;
  transferId: string;
  created: boolean;
  replayed: boolean;
  idempotencyKey: string | null;
  sourceWarehouseId: string;
  destinationWarehouseId: string;
};

export type TransferVoidActor = {
  type: 'user' | 'system';
  id?: string | null;
};

type DomainError = Error & {
  code?: string;
  details?: Record<string, unknown>;
};

function domainError(code: string, details?: Record<string, unknown>): DomainError {
  const error = new Error(code) as DomainError;
  error.code = code;
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}

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

type PreparedTransferMutation = TransferInventoryInput & {
  enteredQty: number;
  sourceWarehouseId: string;
  destinationWarehouseId: string;
};

type TransferMutationExecution = {
  result: TransferInventoryResult;
  events: InventoryCommandEvent[];
  projectionOps: InventoryCommandProjectionOp[];
};

function compareInventoryLockTarget(
  left: { warehouseId: string; itemId: string },
  right: { warehouseId: string; itemId: string }
) {
  const warehouseCompare = left.warehouseId.localeCompare(right.warehouseId);
  if (warehouseCompare !== 0) return warehouseCompare;
  return left.itemId.localeCompare(right.itemId);
}

async function prepareTransferMutation(
  input: TransferInventoryInput,
  client: PoolClient
): Promise<PreparedTransferMutation> {
  const sourceWarehouseId = await resolveWarehouseIdForLocation(input.tenantId, input.sourceLocationId, client);
  const destinationWarehouseId = await resolveWarehouseIdForLocation(input.tenantId, input.destinationLocationId, client);
  const requestedWarehouseId = input.warehouseId?.trim() ? input.warehouseId.trim() : null;
  if (requestedWarehouseId) {
    if (sourceWarehouseId !== destinationWarehouseId || requestedWarehouseId !== sourceWarehouseId) {
      throw domainError('WAREHOUSE_SCOPE_MISMATCH', {
        providedWarehouseId: requestedWarehouseId,
        sourceWarehouseId,
        destinationWarehouseId
      });
    }
  }

  const enteredQty = roundQuantity(toNumber(input.quantity));
  if (enteredQty <= 0) {
    throw new Error('TRANSFER_INVALID_QUANTITY');
  }
  if (input.sourceLocationId === input.destinationLocationId) {
    throw new Error('TRANSFER_SAME_LOCATION');
  }

  const destCheck = await client.query(
    `SELECT role, is_sellable FROM locations WHERE id = $1 AND tenant_id = $2`,
    [input.destinationLocationId, input.tenantId]
  );
  if (destCheck.rowCount === 0) {
    throw new Error('TRANSFER_DESTINATION_NOT_FOUND');
  }
  const destLocation = destCheck.rows[0];

  if (input.sourceType === 'qc_event') {
    if (!input.qcAction) {
      throw new Error('QC_ACTION_REQUIRED');
    }
    const sourceCheck = await client.query(
      `SELECT role, is_sellable FROM locations WHERE id = $1 AND tenant_id = $2`,
      [input.sourceLocationId, input.tenantId]
    );
    if (sourceCheck.rowCount === 0) {
      throw new Error('TRANSFER_SOURCE_NOT_FOUND');
    }
    const sourceLocation = sourceCheck.rows[0];
    if (sourceLocation.role !== 'QA' || sourceLocation.is_sellable) {
      throw new Error('QC_SOURCE_MUST_BE_QA');
    }

    if (input.qcAction === 'accept') {
      if (destLocation.role !== 'SELLABLE') {
        throw new Error('QC_ACCEPT_REQUIRES_SELLABLE_ROLE');
      }
      if (!destLocation.is_sellable) {
        throw new Error('QC_ACCEPT_REQUIRES_SELLABLE_FLAG');
      }
    } else if (input.qcAction === 'hold') {
      if (destLocation.role !== 'HOLD') {
        throw new Error('QC_HOLD_REQUIRES_HOLD_ROLE');
      }
      if (destLocation.is_sellable) {
        throw new Error('QC_HOLD_MUST_NOT_BE_SELLABLE');
      }
    } else if (input.qcAction === 'reject') {
      if (destLocation.role !== 'REJECT') {
        throw new Error('QC_REJECT_REQUIRES_REJECT_ROLE');
      }
      if (destLocation.is_sellable) {
        throw new Error('QC_REJECT_MUST_NOT_BE_SELLABLE');
      }
    }
  }

  return {
    ...input,
    idempotencyKey: input.idempotencyKey?.trim() ? input.idempotencyKey.trim() : null,
    warehouseId: requestedWarehouseId,
    enteredQty,
    sourceWarehouseId,
    destinationWarehouseId
  };
}

function buildTransferLockTargets(prepared: PreparedTransferMutation) {
  return [
    {
      tenantId: prepared.tenantId,
      warehouseId: prepared.sourceWarehouseId,
      itemId: prepared.itemId
    },
    {
      tenantId: prepared.tenantId,
      warehouseId: prepared.destinationWarehouseId,
      itemId: prepared.itemId
    }
  ].sort(compareInventoryLockTarget);
}

function buildTransferInventoryRequestBody(input: TransferInventoryInput) {
  return {
    sourceLocationId: input.sourceLocationId,
    destinationLocationId: input.destinationLocationId,
    warehouseId: input.warehouseId?.trim() || null,
    itemId: input.itemId,
    quantity: roundQuantity(toNumber(input.quantity)),
    uom: input.uom,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    movementType: input.movementType ?? 'transfer',
    qcAction: input.qcAction ?? null,
    reasonCode: input.reasonCode ?? 'transfer',
    notes: input.notes ?? 'Inventory transfer',
    occurredAt: input.occurredAt ? input.occurredAt.toISOString() : null,
    overrideNegative: input.overrideNegative ?? false,
    overrideReason: input.overrideReason ?? null
  };
}

async function reconstructTransferReplayResult(
  tenantId: string,
  responseBody: TransferInventoryResult,
  normalizedIdempotencyKey: string | null,
  client: PoolClient
): Promise<TransferInventoryResult> {
  const movementId = responseBody.movementId;
  if (!movementId) {
    throw new Error('TRANSFER_REPLAY_MOVEMENT_ID_REQUIRED');
  }

  const movementResult = await client.query<{ id: string }>(
    `SELECT id
       FROM inventory_movements
      WHERE tenant_id = $1
        AND id = $2
      LIMIT 1`,
    [tenantId, movementId]
  );
  if (movementResult.rowCount === 0) {
    throw new Error('TRANSFER_REPLAY_MOVEMENT_NOT_FOUND');
  }

  const lineScopeResult = await client.query<{
    warehouse_id: string | null;
    effective_quantity: string | number;
  }>(
    `SELECT l.warehouse_id,
            COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) AS effective_quantity
       FROM inventory_movement_lines iml
       JOIN locations l
         ON l.id = iml.location_id
        AND l.tenant_id = iml.tenant_id
      WHERE iml.tenant_id = $1
        AND iml.movement_id = $2
      ORDER BY iml.created_at ASC, iml.id ASC`,
    [tenantId, movementId]
  );
  const sourceLine = lineScopeResult.rows.find((row) => toNumber(row.effective_quantity) < 0);
  const destinationLine = lineScopeResult.rows.find((row) => toNumber(row.effective_quantity) > 0);
  if (!sourceLine?.warehouse_id || !destinationLine?.warehouse_id) {
    throw new Error('TRANSFER_REPLAY_SCOPE_UNRESOLVED');
  }

  return {
    movementId,
    created: false,
    replayed: true,
    idempotencyKey: normalizedIdempotencyKey,
    sourceWarehouseId: sourceLine.warehouse_id,
    destinationWarehouseId: destinationLine.warehouse_id
  };
}

async function executeTransferInventoryWrapperMutation(
  prepared: PreparedTransferMutation,
  client: PoolClient
): Promise<TransferMutationExecution> {
  const validation = await validateSufficientStock(
    prepared.tenantId,
    prepared.occurredAt ?? new Date(),
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
      actorId: prepared.actorId ?? null,
      overrideRequested: prepared.overrideNegative,
      overrideReason: prepared.overrideReason,
      overrideReference: `${prepared.sourceType}:${prepared.sourceId}`
    },
    { client }
  );

  const movementId = uuidv4();
  const externalRef = `${prepared.sourceType}:${prepared.sourceId}`;
  const movementResult = await createInventoryMovement(client, {
    id: movementId,
    tenantId: prepared.tenantId,
    movementType: prepared.movementType ?? 'transfer',
    status: 'posted',
    externalRef,
    sourceType: prepared.sourceType,
    sourceId: prepared.sourceId,
    idempotencyKey: prepared.idempotencyKey,
    occurredAt: prepared.occurredAt ?? new Date(),
    postedAt: prepared.occurredAt ?? new Date(),
    notes: prepared.notes ?? 'Inventory transfer',
    metadata: validation.overrideMetadata ?? null,
    createdAt: prepared.occurredAt ?? new Date(),
    updatedAt: prepared.occurredAt ?? new Date()
  });

  const baseResult: TransferInventoryResult = {
    movementId: movementResult.id,
    created: movementResult.created,
    replayed: false,
    idempotencyKey: prepared.idempotencyKey ?? null,
    sourceWarehouseId: prepared.sourceWarehouseId,
    destinationWarehouseId: prepared.destinationWarehouseId
  };
  if (!movementResult.created) {
    return {
      result: baseResult,
      events: [],
      projectionOps: []
    };
  }

  const canonicalOut = await getCanonicalMovementFields(
    prepared.tenantId,
    prepared.itemId,
    -prepared.enteredQty,
    prepared.uom,
    client
  );
  const canonicalIn = await getCanonicalMovementFields(
    prepared.tenantId,
    prepared.itemId,
    prepared.enteredQty,
    prepared.uom,
    client
  );
  if (
    canonicalOut.canonicalUom !== canonicalIn.canonicalUom
    || Math.abs(Math.abs(canonicalOut.quantityDeltaCanonical) - canonicalIn.quantityDeltaCanonical) > 1e-6
  ) {
    throw new Error('TRANSFER_CANONICAL_MISMATCH');
  }

  const outLineId = await createInventoryMovementLine(client, {
    tenantId: prepared.tenantId,
    movementId: movementResult.id,
    itemId: prepared.itemId,
    locationId: prepared.sourceLocationId,
    quantityDelta: canonicalOut.quantityDeltaCanonical,
    uom: canonicalOut.canonicalUom,
    quantityDeltaEntered: canonicalOut.quantityDeltaEntered,
    uomEntered: canonicalOut.uomEntered,
    quantityDeltaCanonical: canonicalOut.quantityDeltaCanonical,
    canonicalUom: canonicalOut.canonicalUom,
    uomDimension: canonicalOut.uomDimension,
    reasonCode: `${prepared.reasonCode ?? 'transfer'}_out`,
    lineNotes: `${prepared.notes ?? 'Inventory transfer'} (outbound)`
  });

  const inLineId = await createInventoryMovementLine(client, {
    tenantId: prepared.tenantId,
    movementId: movementResult.id,
    itemId: prepared.itemId,
    locationId: prepared.destinationLocationId,
    quantityDelta: canonicalIn.quantityDeltaCanonical,
    uom: canonicalIn.canonicalUom,
    quantityDeltaEntered: canonicalIn.quantityDeltaEntered,
    uomEntered: canonicalIn.uomEntered,
    quantityDeltaCanonical: canonicalIn.quantityDeltaCanonical,
    canonicalUom: canonicalIn.canonicalUom,
    uomDimension: canonicalIn.uomDimension,
    reasonCode: `${prepared.reasonCode ?? 'transfer'}_in`,
    lineNotes: `${prepared.notes ?? 'Inventory transfer'} (inbound)`
  });

  await relocateTransferCostLayersInTx({
    client,
    tenantId: prepared.tenantId,
    transferMovementId: movementResult.id,
    occurredAt: prepared.occurredAt ?? new Date(),
    notes: prepared.notes ?? 'Inventory transfer',
    pairs: [
      {
        itemId: prepared.itemId,
        sourceLocationId: prepared.sourceLocationId,
        destinationLocationId: prepared.destinationLocationId,
        outLineId,
        inLineId,
        quantity: canonicalIn.quantityDeltaCanonical,
        uom: canonicalIn.canonicalUom
      }
    ]
  });

  return {
    result: baseResult,
    events: [buildMovementPostedEvent(movementResult.id, prepared.idempotencyKey ?? null)],
    projectionOps: [
      buildInventoryBalanceProjectionOp({
        tenantId: prepared.tenantId,
        itemId: prepared.itemId,
        locationId: prepared.sourceLocationId,
        uom: canonicalOut.canonicalUom,
        deltaOnHand: canonicalOut.quantityDeltaCanonical
      }),
      buildInventoryBalanceProjectionOp({
        tenantId: prepared.tenantId,
        itemId: prepared.itemId,
        locationId: prepared.destinationLocationId,
        uom: canonicalIn.canonicalUom,
        deltaOnHand: canonicalIn.quantityDeltaCanonical
      })
    ]
  };
}

export async function postInventoryTransfer(input: TransferPostInput): Promise<TransferPostResult> {
  const transfer = await transferInventory({
    tenantId: input.tenantId,
    sourceLocationId: input.sourceLocationId,
    destinationLocationId: input.destinationLocationId,
    warehouseId: input.warehouseId ?? null,
    itemId: input.itemId,
    quantity: input.quantity,
    uom: input.uom,
    sourceType: 'inventory_transfer',
    sourceId: input.idempotencyKey?.trim() ? `idempotency:${input.idempotencyKey.trim()}` : uuidv4(),
    movementType: 'transfer',
    reasonCode: input.reasonCode ?? 'transfer',
    notes: input.notes ?? 'Inventory transfer',
    occurredAt: input.occurredAt ?? new Date(),
    actorId: input.actorId ?? null,
    overrideNegative: input.overrideNegative ?? false,
    overrideReason: input.overrideReason ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    inventoryCommandEndpoint: IDEMPOTENCY_ENDPOINTS.INVENTORY_TRANSFERS_CREATE,
    inventoryCommandOperation: 'inventory_transfer_post',
    inventoryCommandRequestBody: buildTransferInventoryRequestBody({
      tenantId: input.tenantId,
      sourceLocationId: input.sourceLocationId,
      destinationLocationId: input.destinationLocationId,
      warehouseId: input.warehouseId ?? null,
      itemId: input.itemId,
      quantity: input.quantity,
      uom: input.uom,
      sourceType: 'inventory_transfer',
      sourceId: 'inventory_transfer',
      movementType: 'transfer',
      reasonCode: input.reasonCode ?? 'transfer',
      notes: input.notes ?? 'Inventory transfer',
      occurredAt: input.occurredAt,
      actorId: input.actorId ?? null,
      overrideNegative: input.overrideNegative ?? false,
      overrideReason: input.overrideReason ?? null
    })
  });

  return {
    movementId: transfer.movementId,
    transferId: transfer.movementId,
    created: transfer.created,
    replayed: transfer.replayed,
    idempotencyKey: transfer.idempotencyKey,
    sourceWarehouseId: transfer.sourceWarehouseId,
    destinationWarehouseId: transfer.destinationWarehouseId
  };
}

export async function transferInventory(
  input: TransferInventoryInput,
  client?: PoolClient
): Promise<TransferInventoryResult> {
  if (!client) {
    const endpoint = input.inventoryCommandEndpoint ?? IDEMPOTENCY_ENDPOINTS.INVENTORY_TRANSFERS_CREATE;
    const operation = input.inventoryCommandOperation ?? 'inventory_transfer';
    const normalizedIdempotencyKey = input.idempotencyKey?.trim() ? input.idempotencyKey.trim() : null;
    const requestHash = normalizedIdempotencyKey
      ? hashTransactionalIdempotencyRequest({
          method: 'POST',
          endpoint,
          body: input.inventoryCommandRequestBody ?? buildTransferInventoryRequestBody(input)
        })
      : null;
    let prepared: PreparedTransferMutation | null = null;

    return runInventoryCommand<TransferInventoryResult>({
      tenantId: input.tenantId,
      endpoint,
      operation,
      idempotencyKey: normalizedIdempotencyKey,
      requestHash,
      retryOptions: { isolationLevel: 'SERIALIZABLE', retries: 2 },
      onReplay: async ({ client: txClient, responseBody }) =>
        reconstructTransferReplayResult(
          input.tenantId,
          responseBody,
          normalizedIdempotencyKey,
          txClient
        ),
      lockTargets: async (tx) => {
        prepared = await prepareTransferMutation(
          {
            ...input,
            idempotencyKey: normalizedIdempotencyKey
          },
          tx
        );
        return buildTransferLockTargets(prepared);
      },
      execute: async ({ client: txClient }) => {
        if (!prepared) {
          throw new Error('TRANSFER_PREPARE_REQUIRED');
        }
        const execution = await executeTransferInventoryWrapperMutation(prepared, txClient);
        return {
          responseBody: execution.result,
          responseStatus: execution.result.created ? 201 : 200,
          events: execution.events,
          projectionOps: execution.projectionOps
        };
      }
    });
  }

  const {
    tenantId,
    sourceLocationId,
    destinationLocationId,
    warehouseId,
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
    overrideReason = null,
    idempotencyKey = null
  } = input;

  const sourceWarehouseId = await resolveWarehouseIdForLocation(tenantId, sourceLocationId, client);
  const destinationWarehouseId = await resolveWarehouseIdForLocation(tenantId, destinationLocationId, client);
  const requestedWarehouseId = warehouseId?.trim() ? warehouseId.trim() : null;
  if (requestedWarehouseId) {
    if (sourceWarehouseId !== destinationWarehouseId || requestedWarehouseId !== sourceWarehouseId) {
      throw domainError('WAREHOUSE_SCOPE_MISMATCH', {
        providedWarehouseId: requestedWarehouseId,
        sourceWarehouseId,
        destinationWarehouseId
      });
    }
  }

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
        warehouseId: sourceWarehouseId,
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
    idempotencyKey,
    occurredAt,
    postedAt: occurredAt,
    notes,
    metadata: validation.overrideMetadata ?? null,
    createdAt: occurredAt,
    updatedAt: occurredAt
  });

  if (!movementResult.created) {
    return {
      movementId: movementResult.id,
      created: false,
      replayed: false,
      idempotencyKey,
      sourceWarehouseId,
      destinationWarehouseId
    };
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

  return {
    movementId,
    created: true,
    replayed: false,
    idempotencyKey,
    sourceWarehouseId,
    destinationWarehouseId
  };
}

export async function voidTransferMovement(
  tenantId: string,
  movementId: string,
  params: { reason: string; actor: TransferVoidActor; idempotencyKey?: string | null }
) {
  const reason = assertReason(params.reason);
  const normalizedIdempotencyKey = params.idempotencyKey?.trim() ? params.idempotencyKey.trim() : null;
  const requestHash = normalizedIdempotencyKey
    ? hashTransactionalIdempotencyRequest({
        method: 'POST',
        endpoint: IDEMPOTENCY_ENDPOINTS.INVENTORY_TRANSFERS_VOID,
        body: {
          movementId,
          reason
        }
      })
    : null;

  let originalMovement:
    | {
        id: string;
        status: string;
        movement_type: string;
        reversal_of_movement_id: string | null;
      }
    | null = null;
  let originalLines: MovementLineRow[] = [];

  return runInventoryCommand<{
    reversalMovementId: string;
    reversalOfMovementId: string;
  }>({
    tenantId,
    endpoint: IDEMPOTENCY_ENDPOINTS.INVENTORY_TRANSFERS_VOID,
    operation: 'inventory_transfer_void',
    idempotencyKey: normalizedIdempotencyKey,
    requestHash,
    retryOptions: { isolationLevel: 'SERIALIZABLE', retries: 6 },
    lockTargets: async (client) => {
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
      originalMovement = originalMovementResult.rows[0];
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

      const originalLinesResult = await client.query<
        MovementLineRow & { warehouse_id: string | null }
      >(
        `SELECT iml.id,
                iml.item_id,
                iml.location_id,
                iml.quantity_delta,
                iml.uom,
                iml.quantity_delta_entered,
                iml.uom_entered,
                iml.quantity_delta_canonical,
                iml.canonical_uom,
                iml.uom_dimension,
                iml.unit_cost,
                iml.extended_cost,
                iml.reason_code,
                iml.line_notes,
                l.warehouse_id
           FROM inventory_movement_lines iml
           JOIN locations l
             ON l.id = iml.location_id
            AND l.tenant_id = iml.tenant_id
          WHERE iml.tenant_id = $1
            AND iml.movement_id = $2
          ORDER BY iml.created_at ASC, iml.id ASC
          FOR UPDATE`,
        [tenantId, movementId]
      );
      if (originalLinesResult.rowCount === 0) {
        throw new Error('TRANSFER_NOT_POSTED');
      }
      originalLines = originalLinesResult.rows;
      return originalLinesResult.rows
        .filter((line) => typeof line.warehouse_id === 'string' && line.warehouse_id.length > 0)
        .map((line) => ({
          tenantId,
          warehouseId: line.warehouse_id!,
          itemId: line.item_id
        }));
    },
    execute: async ({ client }) => {
      if (!originalMovement) {
        throw new Error('TRANSFER_NOT_FOUND');
      }
      const now = new Date();
      const reversalMovement = await createInventoryMovement(client, {
        tenantId,
        movementType: TRANSFER_REVERSAL_MOVEMENT_TYPE,
        status: 'posted',
        externalRef: `transfer_void:${movementId}`,
        sourceType: 'transfer_void',
        sourceId: movementId,
        idempotencyKey: normalizedIdempotencyKey,
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

      const reversalLineByOriginalLineId = new Map<string, string>();
      const projectionOps: InventoryCommandProjectionOp[] = [];

      for (const line of originalLines) {
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

        if (Math.abs(effectiveQty) <= 1e-6) {
          continue;
        }
        projectionOps.push(async (txClient) => {
          try {
            await applyInventoryBalanceDelta(txClient, {
              tenantId,
              itemId: line.item_id,
              locationId: line.location_id,
              uom: effectiveUom,
              deltaOnHand: roundQuantity(-effectiveQty)
            });
          } catch (error: any) {
            if (error?.code === '23514' && error?.constraint === 'chk_inventory_balance_nonneg') {
              throw new Error('TRANSFER_REVERSAL_NOT_POSSIBLE_CONSUMED');
            }
            throw error;
          }
        });
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

      return {
        responseBody: {
          reversalMovementId: reversalMovement.id,
          reversalOfMovementId: movementId
        },
        responseStatus: 201,
        events: [buildMovementPostedEvent(reversalMovement.id, normalizedIdempotencyKey)],
        projectionOps
      };
    }
  });
}

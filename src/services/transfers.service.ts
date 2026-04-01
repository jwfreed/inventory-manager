import type { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { roundQuantity, toNumber } from '../lib/numbers';
import { applyInventoryBalanceDelta, persistInventoryMovement } from '../domains/inventory';
import { reverseTransferCostLayersInTx } from './transferCosting.service';
import { hashTransactionalIdempotencyRequest } from '../lib/transactionalIdempotency';
import { IDEMPOTENCY_ENDPOINTS } from '../lib/idempotencyEndpoints';
import {
  runInventoryCommand,
  type InventoryCommandEvent,
  type InventoryCommandProjectionOp
} from '../modules/platform/application/runInventoryCommand';
import {
  buildMovementPostedEvent,
  buildPostedDocumentReplayResult,
  sortDeterministicMovementLines
} from '../modules/platform/application/inventoryMutationSupport';
import { buildInventoryRegistryEvent } from '../modules/platform/application/inventoryEventRegistry';
import {
  prepareTransferMutation as prepareTransferPolicy,
  type PreparedTransferMutation
} from '../domain/transfers/transferPolicy';
import { buildTransferMovementPlan as buildTransferMovementPlanDomain } from '../domain/transfers/transferPlan';
import { executeTransferMovementPlan } from '../domain/transfers/transferExecution';

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

export type { PreparedTransferMutation } from '../domain/transfers/transferPolicy';

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
  warehouse_id?: string | null;
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

export type TransferMutationExecution = {
  result: TransferInventoryResult;
  events: InventoryCommandEvent[];
  projectionOps: InventoryCommandProjectionOp[];
};

type PlannedTransferReversalLine = {
  id: string;
  sourceLineId: string;
  warehouseId: string;
  itemId: string;
  locationId: string;
  effectiveUom: string;
  effectiveQty: number;
  quantityDelta: number;
  quantityDeltaEntered: number | null;
  uomEntered: string | null;
  quantityDeltaCanonical: number | null;
  canonicalUom: string | null;
  uomDimension: string | null;
  unitCost: number | null;
  extendedCost: number | null;
  reasonCode: string;
  lineNotes: string;
  originalLineId: string;
};

function compareInventoryLockTarget(
  left: { warehouseId: string; itemId: string },
  right: { warehouseId: string; itemId: string }
) {
  const warehouseCompare = left.warehouseId.localeCompare(right.warehouseId);
  if (warehouseCompare !== 0) return warehouseCompare;
  return left.itemId.localeCompare(right.itemId);
}

function requireMovementLineWarehouseId(line: MovementLineRow): string {
  if (typeof line.warehouse_id !== 'string' || !line.warehouse_id.trim()) {
    throw new Error('TRANSFER_REPLAY_SCOPE_UNRESOLVED');
  }
  return line.warehouse_id;
}

export async function prepareTransferMutation(
  input: TransferInventoryInput,
  client: PoolClient
): Promise<PreparedTransferMutation> {
  return prepareTransferPolicy(input, client);
}

export function buildTransferLockTargets(prepared: PreparedTransferMutation) {
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

function buildTransferCreatedEvent(params: {
  transferId: string;
  movementId: string;
  sourceLocationId: string;
  destinationLocationId: string;
  itemId: string;
  quantity: number;
  uom: string;
  producerIdempotencyKey?: string | null;
}) {
  return buildInventoryRegistryEvent('inventoryTransferCreated', {
    producerIdempotencyKey: params.producerIdempotencyKey,
    payload: {
      transferId: params.transferId,
      movementId: params.movementId,
      sourceLocationId: params.sourceLocationId,
      destinationLocationId: params.destinationLocationId,
      itemId: params.itemId,
      quantity: roundQuantity(params.quantity),
      uom: params.uom
    }
  });
}

function buildTransferIssuedEvent(params: {
  transferId: string;
  movementId: string;
  sourceWarehouseId: string;
  producerIdempotencyKey?: string | null;
}) {
  return buildInventoryRegistryEvent('inventoryTransferIssued', {
    producerIdempotencyKey: params.producerIdempotencyKey,
    payload: {
      transferId: params.transferId,
      movementId: params.movementId,
      sourceWarehouseId: params.sourceWarehouseId
    }
  });
}

function buildTransferReceivedEvent(params: {
  transferId: string;
  movementId: string;
  destinationWarehouseId: string;
  producerIdempotencyKey?: string | null;
}) {
  return buildInventoryRegistryEvent('inventoryTransferReceived', {
    producerIdempotencyKey: params.producerIdempotencyKey,
    payload: {
      transferId: params.transferId,
      movementId: params.movementId,
      destinationWarehouseId: params.destinationWarehouseId
    }
  });
}

function buildTransferVoidedEvent(params: {
  transferId: string;
  reversalMovementId: string;
  reason: string;
  producerIdempotencyKey?: string | null;
}) {
  return buildInventoryRegistryEvent('inventoryTransferVoided', {
    producerIdempotencyKey: params.producerIdempotencyKey,
    payload: {
      transferId: params.transferId,
      reversalMovementId: params.reversalMovementId,
      reason: params.reason
    }
  });
}

function buildTransferEvents(params: {
  transferId: string;
  movementId: string;
  sourceLocationId: string;
  destinationLocationId: string;
  itemId: string;
  quantity: number;
  uom: string;
  sourceWarehouseId: string;
  destinationWarehouseId: string;
  producerIdempotencyKey?: string | null;
}) {
  // Immediate transfers do not model an in-transit lifecycle. These aggregate
  // events are appended in the same runInventoryCommand transaction as a single
  // posted stock relocation.
  return [
    buildMovementPostedEvent(params.movementId, params.producerIdempotencyKey),
    buildTransferCreatedEvent(params),
    buildTransferIssuedEvent({
      transferId: params.transferId,
      movementId: params.movementId,
      sourceWarehouseId: params.sourceWarehouseId,
      producerIdempotencyKey: params.producerIdempotencyKey
    }),
    buildTransferReceivedEvent({
      transferId: params.transferId,
      movementId: params.movementId,
      destinationWarehouseId: params.destinationWarehouseId,
      producerIdempotencyKey: params.producerIdempotencyKey
    })
  ];
}

function buildTransferReversalBalanceProjectionOp(params: {
  tenantId: string;
  itemId: string;
  locationId: string;
  uom: string;
  deltaOnHand: number;
}): InventoryCommandProjectionOp {
  return async (client) => {
    try {
      await applyInventoryBalanceDelta(client, params);
    } catch (error: any) {
      if (error?.code === '23514' && error?.constraint === 'chk_inventory_balance_nonneg') {
        throw new Error('TRANSFER_REVERSAL_NOT_POSSIBLE_CONSUMED');
      }
      throw error;
    }
  };
}

async function buildTransferMovementPlan(
  prepared: PreparedTransferMutation,
  client: PoolClient
) {
  // Deterministic planning remains delegated to the domain planner:
  // sortDeterministicMovementLines(...) and buildMovementDeterministicHash(...).
  return buildTransferMovementPlanDomain(prepared, client);
}

function buildTransferReversalPlan(params: {
  tenantId: string;
  originalLines: MovementLineRow[];
}) {
  const lines = sortDeterministicMovementLines(
    params.originalLines.map((line) => ({
      id: uuidv4(),
      sourceLineId: line.id,
      warehouseId: requireMovementLineWarehouseId(line),
      itemId: line.item_id,
      locationId: line.location_id,
      effectiveUom: line.canonical_uom ?? line.uom,
      effectiveQty: roundQuantity(toNumber(line.quantity_delta_canonical ?? line.quantity_delta)),
      quantityDelta: roundQuantity(-toNumber(line.quantity_delta)),
      quantityDeltaEntered: negateNullable(line.quantity_delta_entered),
      uomEntered: line.uom_entered,
      quantityDeltaCanonical: negateNullable(line.quantity_delta_canonical),
      canonicalUom: line.canonical_uom,
      uomDimension: line.uom_dimension,
      unitCost: line.unit_cost != null ? roundQuantity(toNumber(line.unit_cost)) : null,
      extendedCost: negateNullable(line.extended_cost),
      reasonCode: line.reason_code ? `${line.reason_code}_reversal` : 'transfer_reversal',
      lineNotes: line.line_notes ? `Reversal of ${line.id}: ${line.line_notes}` : `Reversal of ${line.id}`,
      originalLineId: line.id
    })),
    (line) => ({
      tenantId: params.tenantId,
      warehouseId: line.warehouseId,
      locationId: line.locationId,
      itemId: line.itemId,
      canonicalUom: line.canonicalUom ?? line.effectiveUom,
      sourceLineId: line.sourceLineId
    })
  );
  return { lines };
}

async function fetchTransferReplayView(
  tenantId: string,
  movementId: string,
  replayed: boolean,
  normalizedIdempotencyKey: string | null,
  client: PoolClient
): Promise<TransferInventoryResult> {
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
    replayed,
    idempotencyKey: normalizedIdempotencyKey,
    sourceWarehouseId: sourceLine.warehouse_id,
    destinationWarehouseId: destinationLine.warehouse_id
  };
}

export async function buildTransferReplayResult(params: {
  tenantId: string;
  movementId: string;
  normalizedIdempotencyKey: string | null;
  replayed: boolean;
  client: PoolClient;
  sourceLocationId: string;
  destinationLocationId: string;
  itemId: string;
  quantity: number;
  uom: string;
  sourceWarehouseId: string;
  destinationWarehouseId: string;
  expectedLineCount?: number;
  expectedDeterministicHash?: string | null;
}) {
  return buildPostedDocumentReplayResult({
    tenantId: params.tenantId,
    authoritativeMovements: [
      {
        movementId: params.movementId,
        expectedLineCount: params.expectedLineCount ?? 2,
        expectedDeterministicHash: params.expectedDeterministicHash ?? null
      }
    ],
    client: params.client,
    fetchAggregateView: () =>
      fetchTransferReplayView(
        params.tenantId,
        params.movementId,
        params.replayed,
        params.normalizedIdempotencyKey,
        params.client
      ),
    aggregateNotFoundError: new Error('TRANSFER_REPLAY_SCOPE_UNRESOLVED'),
    authoritativeEvents: buildTransferEvents({
      transferId: params.movementId,
      movementId: params.movementId,
      sourceLocationId: params.sourceLocationId,
      destinationLocationId: params.destinationLocationId,
      itemId: params.itemId,
      quantity: params.quantity,
      uom: params.uom,
      sourceWarehouseId: params.sourceWarehouseId,
      destinationWarehouseId: params.destinationWarehouseId,
      producerIdempotencyKey: params.normalizedIdempotencyKey
    })
  });
}

export async function executeTransferInventoryMutation(
  prepared: PreparedTransferMutation,
  client: PoolClient
): Promise<TransferMutationExecution> {
  const movementPlan = await buildTransferMovementPlan(prepared, client);
  const execution = await executeTransferMovementPlan(prepared, movementPlan, client);

  if (!execution.result.created) {
    const replay = await buildTransferReplayResult({
      tenantId: prepared.tenantId,
      movementId: execution.result.movementId,
      normalizedIdempotencyKey: prepared.idempotencyKey,
      replayed: false,
      client,
      sourceLocationId: prepared.sourceLocationId,
      destinationLocationId: prepared.destinationLocationId,
      itemId: prepared.itemId,
      quantity: prepared.enteredQty,
      uom: prepared.uom,
      sourceWarehouseId: prepared.sourceWarehouseId,
      destinationWarehouseId: prepared.destinationWarehouseId,
      expectedLineCount: movementPlan.expectedLineCount,
      expectedDeterministicHash: movementPlan.expectedDeterministicHash
    });
    return {
      result: {
        ...replay.responseBody,
        replayed: false
      },
      events: replay.events ?? [],
      projectionOps: []
    };
  }

  return {
    result: execution.result,
    events: buildTransferEvents({
      transferId: execution.result.movementId,
      movementId: execution.result.movementId,
      sourceLocationId: prepared.sourceLocationId,
      destinationLocationId: prepared.destinationLocationId,
      itemId: prepared.itemId,
      quantity: prepared.enteredQty,
      uom: prepared.uom,
      sourceWarehouseId: prepared.sourceWarehouseId,
      destinationWarehouseId: prepared.destinationWarehouseId,
      producerIdempotencyKey: prepared.idempotencyKey
    }),
    projectionOps: [...execution.projectionOps]
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
  input: TransferInventoryInput
): Promise<TransferInventoryResult> {
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
    onReplay: async ({ client: txClient, responseBody }) => {
      const movementId = responseBody.movementId;
      if (!movementId) {
        throw new Error('TRANSFER_REPLAY_MOVEMENT_ID_REQUIRED');
      }
      return (
        await buildTransferReplayResult({
          tenantId: input.tenantId,
          movementId,
          normalizedIdempotencyKey,
          replayed: true,
          client: txClient,
          sourceLocationId: input.sourceLocationId,
          destinationLocationId: input.destinationLocationId,
          itemId: input.itemId,
          quantity: roundQuantity(toNumber(input.quantity)),
          uom: input.uom,
          sourceWarehouseId: responseBody.sourceWarehouseId,
          destinationWarehouseId: responseBody.destinationWarehouseId,
          expectedLineCount: 2
        })
      ).responseBody;
    },
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
      const execution = await executeTransferInventoryMutation(prepared, txClient);
      return {
        responseBody: execution.result,
        responseStatus: execution.result.created ? 201 : 200,
        events: execution.events,
        projectionOps: execution.projectionOps
      };
    }
  });
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
    onReplay: async ({ client, responseBody }) => {
      const originalLinesResult = await client.query<MovementLineRow & { warehouse_id: string | null }>(
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
          ORDER BY iml.created_at ASC, iml.id ASC`,
        [tenantId, movementId]
      );
      const reversalPlan = buildTransferReversalPlan({
        tenantId,
        originalLines: originalLinesResult.rows
      });
      return (
        await buildPostedDocumentReplayResult({
          tenantId,
          authoritativeMovements: [
            {
              movementId: responseBody.reversalMovementId,
              expectedLineCount: reversalPlan.lines.length
            }
          ],
          client,
          fetchAggregateView: async () => ({
            reversalMovementId: responseBody.reversalMovementId,
            reversalOfMovementId: movementId
          }),
          aggregateNotFoundError: new Error('TRANSFER_VOID_CONFLICT'),
          authoritativeEvents: [
            buildMovementPostedEvent(responseBody.reversalMovementId, normalizedIdempotencyKey),
            buildTransferVoidedEvent({
              transferId: movementId,
              reversalMovementId: responseBody.reversalMovementId,
              reason,
              producerIdempotencyKey: normalizedIdempotencyKey
            })
          ]
        })
      ).responseBody;
    },
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
      if ((existingReversal.rowCount ?? 0) > 0) {
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
      const reversalPlan = buildTransferReversalPlan({
        tenantId,
        originalLines
      });
      const reversalMovementId = uuidv4();
      const reversalMovement = await persistInventoryMovement(client, {
        id: reversalMovementId,
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
        updatedAt: now,
        lines: reversalPlan.lines.map((line) => ({
          id: line.id,
          warehouseId: line.warehouseId,
          sourceLineId: line.sourceLineId,
          itemId: line.itemId,
          locationId: line.locationId,
          quantityDelta: line.quantityDelta,
          uom: line.canonicalUom ?? line.effectiveUom,
          quantityDeltaEntered: line.quantityDeltaEntered,
          uomEntered: line.uomEntered,
          quantityDeltaCanonical: line.quantityDeltaCanonical,
          canonicalUom: line.canonicalUom,
          uomDimension: line.uomDimension,
          unitCost: line.unitCost,
          extendedCost: line.extendedCost,
          reasonCode: line.reasonCode,
          lineNotes: line.lineNotes,
          createdAt: now
        }))
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
          [reversalMovement.movementId, tenantId]
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

      for (const line of reversalPlan.lines) {
        reversalLineByOriginalLineId.set(line.originalLineId, line.id);

        if (Math.abs(line.effectiveQty) <= 1e-6) {
          continue;
        }
        projectionOps.push(
          buildTransferReversalBalanceProjectionOp({
            tenantId,
            itemId: line.itemId,
            locationId: line.locationId,
            uom: line.effectiveUom,
            deltaOnHand: roundQuantity(-line.effectiveQty)
          })
        );
      }

      await reverseTransferCostLayersInTx({
        client,
        tenantId,
        originalTransferMovementId: movementId,
        reversalMovementId: reversalMovement.movementId,
        occurredAt: now,
        notes: `Transfer reversal ${movementId}`,
        reversalLineByOriginalLineId
      });

      return {
        responseBody: {
          reversalMovementId: reversalMovement.movementId,
          reversalOfMovementId: movementId
        },
        responseStatus: 201,
        events: [
          buildMovementPostedEvent(reversalMovement.movementId, normalizedIdempotencyKey),
          buildTransferVoidedEvent({
            transferId: movementId,
            reversalMovementId: reversalMovement.movementId,
            reason,
            producerIdempotencyKey: normalizedIdempotencyKey
          })
        ],
        projectionOps
      };
    }
  });
}

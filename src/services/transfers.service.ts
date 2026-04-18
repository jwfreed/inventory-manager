import type { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { withTransactionRetry } from '../db';
import {
  acquireAtpLocks,
  createAtpLockContext,
  type AtpLockContext
} from '../domains/inventory';
import { roundQuantity, toNumber } from '../lib/numbers';
import {
  claimTransactionalIdempotency,
  finalizeTransactionalIdempotency,
  hashTransactionalIdempotencyRequest
} from '../lib/transactionalIdempotency';
import { IDEMPOTENCY_ENDPOINTS } from '../lib/idempotencyEndpoints';
import {
  runInventoryCommand,
  type InventoryCommandEvent,
  type InventoryCommandProjectionOp
} from '../modules/platform/application/runInventoryCommand';
import {
  buildReplayCorruptionError,
  buildMovementPostedEvent,
  buildPostedDocumentReplayResult
} from '../modules/platform/application/inventoryMutationSupport';
import { buildInventoryRegistryEvent } from '../modules/platform/application/inventoryEventRegistry';
import { appendInventoryEventsWithDispatch } from '../modules/platform/infrastructure/inventoryEvents';
import {
  prepareTransferMutation as prepareTransferPolicy,
  type PreparedTransferMutation
} from '../domain/transfers/transferPolicy';
import { buildReplayDeterminismExpectation } from '../domain/inventory/mutationInvariants';
import {
  buildTransferMovementPlan,
  type TransferMovementPlan
} from '../domain/transfers/transferPlan';
import { executeTransferMovementPlan } from '../domain/transfers/transferExecution';
import {
  buildTransferReversalLockTargets,
  prepareTransferReversalPolicy
} from '../domain/transfers/transferReversalPolicy';
import { buildTransferReversalPlan } from '../domain/transfers/transferReversalPlan';
import { executeTransferReversalPlan } from '../domain/transfers/transferReversalExecution';

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

/**
 * Options for executing a transfer within an externally-owned transaction.
 * When provided, transferInventory executes the transfer logic directly using
 * the supplied client rather than opening its own runInventoryCommand boundary.
 * The caller is responsible for transaction lifecycle, commit, and rollback.
 */
export type TransferInventoryOptions = {
  client: PoolClient;
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

function assertReason(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed) {
    throw new Error('TRANSFER_VOID_REASON_REQUIRED');
  }
  return trimmed;
}

export type TransferMutationExecution = {
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

async function loadTransferOccurredAt(
  client: PoolClient,
  tenantId: string,
  movementId: string
) {
  const result = await client.query<{ occurred_at: Date | string }>(
    `SELECT occurred_at
       FROM inventory_movements
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, movementId]
  );
  if ((result.rowCount ?? 0) === 0) {
    throw buildReplayCorruptionError({
      tenantId,
      movementId,
      reason: 'authoritative_movement_missing'
    });
  }
  return new Date(result.rows[0]!.occurred_at);
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
      ORDER BY COALESCE(iml.event_timestamp, iml.created_at) ASC, iml.id ASC`,
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
      buildReplayDeterminismExpectation({
        movementId: params.movementId,
        expectedLineCount: params.expectedLineCount ?? 2,
        expectedDeterministicHash: params.expectedDeterministicHash ?? null
      })
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
  client: PoolClient,
  lockContext: AtpLockContext,
  prebuiltMovementPlan?: TransferMovementPlan
): Promise<TransferMutationExecution> {
  const movementPlan = prebuiltMovementPlan
    ?? await buildTransferMovementPlan(prepared, client);
  const execution = await executeTransferMovementPlan(prepared, movementPlan, client, lockContext);

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

async function loadTransferReversalOccurredAt(
  client: PoolClient,
  tenantId: string,
  reversalMovementId: string
) {
  const result = await client.query<{ occurred_at: Date | string }>(
    `SELECT occurred_at
       FROM inventory_movements
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, reversalMovementId]
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new Error('TRANSFER_VOID_CONFLICT');
  }
  return new Date(result.rows[0]!.occurred_at);
}

async function buildTransferReversalReplayResult(params: {
  tenantId: string;
  originalMovementId: string;
  reversalMovementId: string;
  reason: string;
  normalizedIdempotencyKey: string | null;
  client: PoolClient;
}) {
  const preparedReversal = await prepareTransferReversalPolicy(
    {
      tenantId: params.tenantId,
      originalMovementId: params.originalMovementId
    },
    params.client
  );
  const occurredAt = await loadTransferReversalOccurredAt(
    params.client,
    params.tenantId,
    params.reversalMovementId
  );
  const reversalPlan = buildTransferReversalPlan(preparedReversal, {
    occurredAt,
    idempotencyKey: params.normalizedIdempotencyKey,
    reason: params.reason
  });

  return buildPostedDocumentReplayResult({
    tenantId: params.tenantId,
    authoritativeMovements: [
      buildReplayDeterminismExpectation({
        movementId: params.reversalMovementId,
        expectedLineCount: reversalPlan.expectedLineCount,
        expectedDeterministicHash: reversalPlan.expectedDeterministicHash
      })
    ],
    client: params.client,
    fetchAggregateView: async () => ({
      reversalMovementId: params.reversalMovementId,
      reversalOfMovementId: params.originalMovementId
    }),
    aggregateNotFoundError: new Error('TRANSFER_VOID_CONFLICT'),
    authoritativeEvents: [
      buildMovementPostedEvent(params.reversalMovementId, params.normalizedIdempotencyKey),
      buildTransferVoidedEvent({
        transferId: params.originalMovementId,
        reversalMovementId: params.reversalMovementId,
        reason: params.reason,
        producerIdempotencyKey: params.normalizedIdempotencyKey
      })
    ]
  });
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
    occurredAt: input.occurredAt,
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

function compareTransferLockTargetForClient(
  left: { warehouseId: string; itemId: string; tenantId: string },
  right: { warehouseId: string; itemId: string; tenantId: string }
) {
  const warehouseCompare = left.warehouseId.localeCompare(right.warehouseId);
  if (warehouseCompare !== 0) return warehouseCompare;
  const itemCompare = left.itemId.localeCompare(right.itemId);
  if (itemCompare !== 0) return itemCompare;
  return left.tenantId.localeCompare(right.tenantId);
}

/**
 * Execute transfer logic using the active transaction client.
 * Handles idempotency claim/finalize, lock acquisition, execution, events,
 * and projection ops inside the provided transaction boundary. This is
 * the single orchestration path for standalone and caller-owned transfers.
 */
async function executeTransferWithClient(
  client: PoolClient,
  params: {
    input: TransferInventoryInput;
    endpoint: string;
    operation: string;
    normalizedIdempotencyKey: string | null;
    requestHash: string | null;
  }
): Promise<TransferInventoryResult> {
  const {
    input,
    endpoint,
    operation,
    normalizedIdempotencyKey,
    requestHash
  } = params;

  if (normalizedIdempotencyKey && requestHash) {
    const claim = await claimTransactionalIdempotency<TransferInventoryResult>(
      client,
      {
        tenantId: input.tenantId,
        key: normalizedIdempotencyKey,
        endpoint,
        requestHash
      }
    );
    if (claim.replayed) {
      const responseBody = claim.responseBody;
      const movementId = responseBody.movementId;
      if (!movementId) {
        throw new Error('TRANSFER_REPLAY_MOVEMENT_ID_REQUIRED');
      }
      const replayOccurredAt = input.occurredAt
        ?? await loadTransferOccurredAt(client, input.tenantId, movementId);
      const replayPrepared = await prepareTransferMutation(
        { ...input, occurredAt: replayOccurredAt, idempotencyKey: normalizedIdempotencyKey },
        client
      );
      const replayPlan = await buildTransferMovementPlan(replayPrepared, client);
      return (
        await buildTransferReplayResult({
          tenantId: input.tenantId,
          movementId,
          normalizedIdempotencyKey,
          replayed: true,
          client,
          sourceLocationId: input.sourceLocationId,
          destinationLocationId: input.destinationLocationId,
          itemId: input.itemId,
          quantity: roundQuantity(toNumber(input.quantity)),
          uom: input.uom,
          sourceWarehouseId: responseBody.sourceWarehouseId,
          destinationWarehouseId: responseBody.destinationWarehouseId,
          expectedLineCount: replayPlan.expectedLineCount,
          expectedDeterministicHash: replayPlan.expectedDeterministicHash
        })
      ).responseBody;
    }
  }

  const prepared = await prepareTransferMutation(
    { ...input, idempotencyKey: normalizedIdempotencyKey },
    client
  );
  const movementPlan = await buildTransferMovementPlan(prepared, client);
  const lockTargets = buildTransferLockTargets(prepared)
    .sort(compareTransferLockTargetForClient);
  const lockContext = createAtpLockContext({ operation, tenantId: input.tenantId });
  await acquireAtpLocks(client, lockTargets, { lockContext });

  const execution = await executeTransferInventoryMutation(
    prepared,
    client,
    lockContext,
    movementPlan
  );

  await appendInventoryEventsWithDispatch(
    client,
    execution.events.map((event) => ({
      tenantId: event.tenantId ?? input.tenantId,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      aggregateIdSource: event.aggregateIdSource,
      eventType: event.eventType,
      eventVersion: event.eventVersion,
      payload: event.payload,
      producerIdempotencyKey: event.producerIdempotencyKey ?? normalizedIdempotencyKey,
      dispatch: event.dispatch
    }))
  );
  for (const projectionOp of execution.projectionOps) {
    await projectionOp(client);
  }

  if (normalizedIdempotencyKey) {
    await finalizeTransactionalIdempotency(
      client,
      {
        tenantId: input.tenantId,
        key: normalizedIdempotencyKey,
        responseStatus: execution.result.created ? 201 : 200,
        responseBody: execution.result
      }
    );
  }

  return execution.result;
}

function runTransferCommandWithClient(params: {
  input: TransferInventoryInput;
  endpoint: string;
  operation: string;
  normalizedIdempotencyKey: string | null;
  requestHash: string | null;
}): Promise<TransferInventoryResult> {
  return withTransactionRetry(
    (client) => executeTransferWithClient(client, params),
    { isolationLevel: 'SERIALIZABLE', retries: 2 }
  );
}

export async function transferInventory(
  input: TransferInventoryInput,
  options?: TransferInventoryOptions
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

  const txClient = options?.client;
  if (txClient) {
    return executeTransferWithClient(txClient, {
      input,
      endpoint,
      operation,
      normalizedIdempotencyKey,
      requestHash
    });
  }

  return runTransferCommandWithClient({
    input,
    endpoint,
    operation,
    normalizedIdempotencyKey,
    requestHash
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
  let preparedReversal:
    | Awaited<ReturnType<typeof prepareTransferReversalPolicy>>
    | null = null;

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
      return (
        await buildTransferReversalReplayResult({
          tenantId,
          originalMovementId: movementId,
          reversalMovementId: responseBody.reversalMovementId,
          reason,
          normalizedIdempotencyKey,
          client
        })
      ).responseBody;
    },
    lockTargets: async (client) => {
      preparedReversal = await prepareTransferReversalPolicy(
        {
          tenantId,
          originalMovementId: movementId
        },
        client
      );
      return buildTransferReversalLockTargets(preparedReversal);
    },
    execute: async ({ client, lockContext }) => {
      if (!preparedReversal) {
        throw new Error('TRANSFER_REVERSAL_PREPARE_REQUIRED');
      }
      if (preparedReversal.existingReversal) {
        const replay = await buildTransferReversalReplayResult({
          tenantId,
          originalMovementId: movementId,
          reversalMovementId: preparedReversal.existingReversal.movementId,
          reason,
          normalizedIdempotencyKey,
          client
        });
        return {
          responseBody: replay.responseBody,
          responseStatus: replay.responseStatus,
          events: replay.events ?? [],
          projectionOps: []
        };
      }
      const reversalPlan = buildTransferReversalPlan(preparedReversal, {
        occurredAt: new Date(),
        idempotencyKey: normalizedIdempotencyKey,
        reason
      });
      const execution = await executeTransferReversalPlan(
        preparedReversal,
        reversalPlan,
        client,
        lockContext
      );
      if (!execution.result.created) {
        const replay = await buildTransferReversalReplayResult({
          tenantId,
          originalMovementId: movementId,
          reversalMovementId: execution.result.reversalMovementId,
          reason,
          normalizedIdempotencyKey,
          client
        });
        return {
          responseBody: replay.responseBody,
          responseStatus: replay.responseStatus,
          events: replay.events ?? [],
          projectionOps: []
        };
      }

      return {
        responseBody: {
          reversalMovementId: execution.result.reversalMovementId,
          reversalOfMovementId: movementId
        },
        responseStatus: 201,
        events: [
          buildMovementPostedEvent(execution.result.reversalMovementId, normalizedIdempotencyKey),
          buildTransferVoidedEvent({
            transferId: movementId,
            reversalMovementId: execution.result.reversalMovementId,
            reason,
            producerIdempotencyKey: normalizedIdempotencyKey
          })
        ],
        projectionOps: [...execution.projectionOps]
      };
    }
  });
}

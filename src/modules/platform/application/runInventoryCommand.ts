import type { PoolClient } from 'pg';
import { withTransactionRetry } from '../../../db';
import {
  claimTransactionalIdempotency,
  finalizeTransactionalIdempotency
} from '../../../lib/transactionalIdempotency';
import {
  acquireAtpLocks,
  createAtpLockContext,
  type AtpLockContext,
  type AtpLockTarget
} from '../../../domains/inventory/internal/atpLocks';
import {
  appendInventoryEventsWithDispatch,
  type InventoryEventDispatch
} from '../infrastructure/inventoryEvents';

export type InventoryCommandEvent = {
  tenantId?: string;
  aggregateType: string;
  aggregateId: string;
  aggregateIdSource: string;
  eventType: string;
  eventVersion: number;
  payload?: Record<string, unknown>;
  producerIdempotencyKey?: string | null;
  dispatch?: InventoryEventDispatch;
};

export type InventoryCommandProjectionOp = (client: PoolClient) => Promise<void>;

type InventoryCommandExecutionResult<T> = {
  responseBody: T;
  responseStatus?: number;
  events?: InventoryCommandEvent[];
  projectionOps?: InventoryCommandProjectionOp[];
};

type InventoryCommandLockTargets =
  | AtpLockTarget[]
  | ((client: PoolClient) => Promise<AtpLockTarget[]>);

function compareInventoryCommandLockTarget(
  left: AtpLockTarget,
  right: AtpLockTarget
) {
  const warehouseCompare = left.warehouseId.localeCompare(right.warehouseId);
  if (warehouseCompare !== 0) return warehouseCompare;
  const itemCompare = left.itemId.localeCompare(right.itemId);
  if (itemCompare !== 0) return itemCompare;
  return left.tenantId.localeCompare(right.tenantId);
}

export async function runInventoryCommand<T>(params: {
  tenantId: string;
  endpoint: string;
  operation?: string;
  idempotencyKey?: string | null;
  requestHash?: string | null;
  lockTargets?: InventoryCommandLockTargets;
  retryOptions?: Parameters<typeof withTransactionRetry>[1];
  onReplay?: (context: {
    client: PoolClient;
    responseBody: T;
  }) => Promise<T> | T;
  execute: (context: {
    client: PoolClient;
    lockContext: AtpLockContext;
  }) => Promise<InventoryCommandExecutionResult<T>>;
}): Promise<T> {
  const idempotencyKey = typeof params.idempotencyKey === 'string' && params.idempotencyKey.trim()
    ? params.idempotencyKey.trim()
    : null;
  const requestHash = typeof params.requestHash === 'string' && params.requestHash.trim()
    ? params.requestHash.trim()
    : null;

  if (idempotencyKey && !requestHash) {
    const error = new Error('IDEMPOTENCY_REQUEST_HASH_REQUIRED') as Error & {
      code?: string;
      details?: Record<string, unknown>;
    };
    error.code = 'IDEMPOTENCY_REQUEST_HASH_REQUIRED';
    error.details = {
      tenantId: params.tenantId,
      endpoint: params.endpoint
    };
    throw error;
  }

  return withTransactionRetry(async (client) => {
    if (idempotencyKey && requestHash) {
      const claim = await claimTransactionalIdempotency<T>(client, {
        tenantId: params.tenantId,
        key: idempotencyKey,
        endpoint: params.endpoint,
        requestHash
      });
      if (claim.replayed) {
        return params.onReplay
          ? await params.onReplay({ client, responseBody: claim.responseBody })
          : claim.responseBody;
      }
    }

    const lockContext = createAtpLockContext({
      operation: params.operation ?? params.endpoint,
      tenantId: params.tenantId
    });

    const lockTargets = Array.isArray(params.lockTargets)
      ? params.lockTargets
      : params.lockTargets
        ? await params.lockTargets(client)
        : [];
    const sortedLockTargets = [...lockTargets].sort(compareInventoryCommandLockTarget);
    await acquireAtpLocks(client, sortedLockTargets, { lockContext });

    const execution = await params.execute({ client, lockContext });
    await appendInventoryEventsWithDispatch(
      client,
      (execution.events ?? []).map((event) => ({
        tenantId: event.tenantId ?? params.tenantId,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        aggregateIdSource: event.aggregateIdSource,
        eventType: event.eventType,
        eventVersion: event.eventVersion,
        payload: event.payload,
        producerIdempotencyKey: event.producerIdempotencyKey ?? idempotencyKey,
        dispatch: event.dispatch
      }))
    );
    for (const projectionOp of execution.projectionOps ?? []) {
      await projectionOp(client);
    }

    if (idempotencyKey) {
      await finalizeTransactionalIdempotency(client, {
        tenantId: params.tenantId,
        key: idempotencyKey,
        responseStatus: execution.responseStatus ?? 200,
        responseBody: execution.responseBody
      });
    }

    return execution.responseBody;
  }, params.retryOptions);
}

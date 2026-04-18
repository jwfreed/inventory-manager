import type { PoolClient } from 'pg';
import { applyInventoryBalanceDelta } from '../../../domains/inventory';
import { refreshItemCostSummaryProjection } from '../../costing/infrastructure/itemCostSummary.projector';
import type { InventoryCommandEvent, InventoryCommandProjectionOp } from './runInventoryCommand';
import {
  buildInventoryRegistryEvent,
  validatePersistedInventoryEventRegistryRow
} from './inventoryEventRegistry';
import {
  buildMovementDeterministicHash,
  type MovementDeterministicHashLineInput
} from './inventoryMovementDeterminism';
export {
  buildMovementDeterministicHash,
  computeSourceLineId,
  computeSplitSourceLineIds,
  sortDeterministicMovementLines,
  type MovementDeterministicHashInput,
  type MovementDeterministicHashLineInput,
  type DeterministicMovementLineIdentity
} from './inventoryMovementDeterminism';

export function buildMovementPostedEvent(
  movementId: string,
  producerIdempotencyKey?: string | null
): InventoryCommandEvent {
  return buildInventoryRegistryEvent('inventoryMovementPosted', {
    producerIdempotencyKey,
    payload: { movementId }
  });
}

export async function inventoryEventVersionExists(
  client: PoolClient,
  tenantId: string,
  aggregateType: string,
  aggregateId: string,
  eventType: string,
  eventVersion: number
) {
  const res = await client.query(
    `SELECT 1
       FROM inventory_events
      WHERE tenant_id = $1
        AND aggregate_type = $2
        AND aggregate_id = $3
        AND event_type = $4
        AND event_version = $5
      LIMIT 1`,
    [tenantId, aggregateType, aggregateId, eventType, eventVersion]
  );
  return (res.rowCount ?? 0) > 0;
}

export async function authoritativeMovementExists(
  client: PoolClient,
  tenantId: string,
  movementId: string
) {
  const res = await client.query(
    `SELECT 1
       FROM inventory_movements
      WHERE tenant_id = $1
        AND id = $2
      LIMIT 1`,
    [tenantId, movementId]
  );
  return (res.rowCount ?? 0) > 0;
}

export async function authoritativeMovementReady(
  client: PoolClient,
  tenantId: string,
  movementId: string
) {
  const res = await client.query(
    `SELECT EXISTS (
         SELECT 1
           FROM inventory_movements m
          WHERE m.tenant_id = $1
            AND m.id = $2
       ) AS movement_exists,
       EXISTS (
         SELECT 1
           FROM inventory_movement_lines ml
          WHERE ml.tenant_id = $1
            AND ml.movement_id = $2
       ) AS has_lines`,
    [tenantId, movementId]
  );
  const row = res.rows[0] ?? {};
  return {
    movementExists: !!row.movement_exists,
    hasLines: !!row.has_lines,
    ready: !!row.movement_exists && !!row.has_lines
  };
}

type PersistedInventoryEventRow = {
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  event_version: number;
  payload: Record<string, unknown> | null;
};

export type AuthoritativeMovementReplayExpectation = {
  movementId: string;
  expectedLineCount?: number;
  expectedDeterministicHash?: string | null;
};

export function buildReplayCorruptionError(details: Record<string, unknown>) {
  const error = new Error('REPLAY_CORRUPTION_DETECTED') as Error & {
    code?: string;
    details?: Record<string, unknown>;
  };
  error.code = 'REPLAY_CORRUPTION_DETECTED';
  error.details = details;
  return error;
}

type PersistedMovementDeterministicHashRow = {
  created_at: Date | string;
  movement_type: string;
  occurred_at: Date | string;
  source_type: string | null;
  source_id: string | null;
  movement_deterministic_hash: string | null;
};

type PersistedMovementDeterministicHashLineRow = MovementDeterministicHashLineInput;

async function loadPersistedMovementDeterministicHashState(
  client: PoolClient,
  tenantId: string,
  movementId: string
) {
  const movementResult = await client.query<PersistedMovementDeterministicHashRow>(
    `SELECT created_at,
            movement_type,
            occurred_at,
            source_type,
            source_id,
            movement_deterministic_hash
       FROM inventory_movements
      WHERE tenant_id = $1
        AND id = $2
      LIMIT 1`,
    [tenantId, movementId]
  );
  if ((movementResult.rowCount ?? 0) === 0) {
    throw buildReplayCorruptionError({
      tenantId,
      movementId,
      reason: 'authoritative_movement_missing'
    });
  }

  const lineResult = await client.query<PersistedMovementDeterministicHashLineRow>(
    `SELECT item_id AS "itemId",
            location_id AS "locationId",
            quantity_delta AS "quantityDelta",
            uom,
            canonical_uom AS "canonicalUom",
            unit_cost AS "unitCost",
            reason_code AS "reasonCode"
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND movement_id = $2`,
    [tenantId, movementId]
  );

  return {
    movement: movementResult.rows[0],
    lines: lineResult.rows,
    lineCount: lineResult.rowCount ?? 0
  };
}

function computePersistedMovementDeterministicHash(params: {
  tenantId: string;
  movement: PersistedMovementDeterministicHashRow;
  lines: PersistedMovementDeterministicHashLineRow[];
}) {
  return buildMovementDeterministicHash({
    tenantId: params.tenantId,
    movementType: params.movement.movement_type,
    occurredAt: params.movement.occurred_at,
    sourceType: params.movement.source_type,
    sourceId: params.movement.source_id,
    lines: params.lines
  });
}

async function verifyAuthoritativeMovementReplayIntegrity(
  client: PoolClient,
  tenantId: string,
  expectation: AuthoritativeMovementReplayExpectation
) {
  const state = await loadPersistedMovementDeterministicHashState(
    client,
    tenantId,
    expectation.movementId
  );
  if (state.lineCount === 0) {
    throw buildReplayCorruptionError({
      tenantId,
      movementId: expectation.movementId,
      reason: 'authoritative_movement_missing_lines'
    });
  }

  const lineCount = state.lineCount;
  if (
    typeof expectation.expectedLineCount === 'number'
    && expectation.expectedLineCount !== lineCount
  ) {
    throw buildReplayCorruptionError({
      tenantId,
      movementId: expectation.movementId,
      reason: 'authoritative_movement_line_count_mismatch',
      expectedLineCount: expectation.expectedLineCount,
      actualLineCount: lineCount
    });
  }

  const storedDeterministicHash = state.movement.movement_deterministic_hash ?? null;
  if (!storedDeterministicHash) {
    throw buildReplayCorruptionError({
      tenantId,
      movementId: expectation.movementId,
      reason: 'authoritative_movement_hash_missing',
      createdAt: new Date(state.movement.created_at).toISOString()
    });
  }

  const computedDeterministicHash = computePersistedMovementDeterministicHash({
    tenantId,
    movement: state.movement,
    lines: state.lines
  });
  if (storedDeterministicHash && storedDeterministicHash !== computedDeterministicHash) {
    throw buildReplayCorruptionError({
      tenantId,
      movementId: expectation.movementId,
      reason: 'authoritative_movement_hash_mismatch',
      storedDeterministicHash,
      computedDeterministicHash
    });
  }
  if (
    expectation.expectedDeterministicHash
    && expectation.expectedDeterministicHash !== computedDeterministicHash
  ) {
    throw buildReplayCorruptionError({
      tenantId,
      movementId: expectation.movementId,
      reason: 'expected_movement_hash_mismatch',
      expectedDeterministicHash: expectation.expectedDeterministicHash,
      computedDeterministicHash
    });
  }
}

async function loadPersistedInventoryEvent(
  client: PoolClient,
  tenantId: string,
  aggregateType: string,
  aggregateId: string,
  eventType: string,
  eventVersion: number
) {
  const result = await client.query<PersistedInventoryEventRow>(
    `SELECT aggregate_type,
            aggregate_id,
            event_type,
            event_version,
            payload
       FROM inventory_events
      WHERE tenant_id = $1
        AND aggregate_type = $2
        AND aggregate_id = $3
        AND event_type = $4
        AND event_version = $5
      LIMIT 1`,
    [tenantId, aggregateType, aggregateId, eventType, eventVersion]
  );
  return result.rows[0] ?? null;
}

async function resolveReplayRepairEvents(params: {
  client: PoolClient;
  tenantId: string;
  authoritativeEvents: InventoryCommandEvent[];
}) {
  const events: InventoryCommandEvent[] = [];
  for (const event of params.authoritativeEvents) {
    const persistedEvent = await loadPersistedInventoryEvent(
      params.client,
      params.tenantId,
      event.aggregateType,
      event.aggregateId,
      event.eventType,
      event.eventVersion
    );
    if (!persistedEvent) {
      events.push(event);
      continue;
    }

    try {
      validatePersistedInventoryEventRegistryRow({
        aggregateType: persistedEvent.aggregate_type,
        aggregateId: persistedEvent.aggregate_id,
        eventType: persistedEvent.event_type,
        eventVersion: persistedEvent.event_version,
        payload: persistedEvent.payload ?? {}
      });
    } catch (error) {
      throw buildReplayCorruptionError({
        tenantId: params.tenantId,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        eventVersion: event.eventVersion,
        reason: 'inventory_event_registry_contract_violation',
        violation: (error as Error)?.message ?? 'INVENTORY_EVENT_REGISTRY_VALIDATION_FAILED'
      });
    }
  }

  return events;
}

export async function buildPostedDocumentReplayResult<T>(params: {
  tenantId: string;
  authoritativeMovements: AuthoritativeMovementReplayExpectation[];
  client: PoolClient;
  preFetchIntegrityCheck?: () => Promise<void> | void;
  fetchAggregateView: () => Promise<T | null>;
  aggregateNotFoundError: Error;
  authoritativeEvents: InventoryCommandEvent[];
  responseStatus?: number;
}) {
  for (const movement of params.authoritativeMovements) {
    await verifyAuthoritativeMovementReplayIntegrity(
      params.client,
      params.tenantId,
      movement
    );
  }

  if (params.preFetchIntegrityCheck) {
    await params.preFetchIntegrityCheck();
  }

  const aggregateView = await params.fetchAggregateView();
  if (!aggregateView) {
    throw params.aggregateNotFoundError;
  }

  const events = await resolveReplayRepairEvents({
    client: params.client,
    tenantId: params.tenantId,
    authoritativeEvents: params.authoritativeEvents
  });

  return {
    responseBody: aggregateView,
    responseStatus: params.responseStatus ?? 200,
    events
  };
}

export function buildInventoryBalanceProjectionOp(params: {
  tenantId: string;
  itemId: string;
  locationId: string;
  uom: string;
  deltaOnHand?: number;
  deltaReserved?: number;
  deltaAllocated?: number;
  mutationContext?: {
    movementId?: string | null;
    sourceLineId?: string | null;
    reasonCode?: string | null;
    eventTimestamp?: Date | string | null;
    stateTransition?: string | null;
  };
}): InventoryCommandProjectionOp {
  return async (client: PoolClient) => {
    await applyInventoryBalanceDelta(client, params);
  };
}

export function buildRefreshItemCostSummaryProjectionOp(
  tenantId: string,
  itemId: string
): InventoryCommandProjectionOp {
  return async (client: PoolClient) => {
    await refreshItemCostSummaryProjection(tenantId, itemId, client);
  };
}

export type MovementHashCoverageAuditFailure = {
  tenantId: string;
  movementId: string;
  reason: string;
  details?: Record<string, unknown> | null;
};

export type MovementHashCoverageAuditResult = {
  totalMovements: number;
  rowsMissingDeterministicHash: number;
  postCutoffRowsMissingHash: number;
  replayIntegrityFailures: {
    count: number;
    sample: MovementHashCoverageAuditFailure[];
  };
};

export async function auditMovementHashCoverage(
  client: PoolClient,
  params?: {
    tenantId?: string | null;
    sampleLimit?: number;
  }
): Promise<MovementHashCoverageAuditResult> {
  const tenantId = params?.tenantId ?? null;
  const sampleLimit = Math.max(0, Math.floor(params?.sampleLimit ?? 25));

  const countsResult = await client.query<{
    total_movements: string | number;
    rows_missing_deterministic_hash: string | number;
    post_cutoff_rows_missing_hash: string | number;
  }>(
    `SELECT COUNT(*)::int AS total_movements,
            COUNT(*) FILTER (
              WHERE movement_deterministic_hash IS NULL
            )::int AS rows_missing_deterministic_hash,
            COUNT(*) FILTER (
              WHERE movement_deterministic_hash IS NULL
            )::int AS post_cutoff_rows_missing_hash
       FROM inventory_movements
      WHERE ($1::uuid IS NULL OR tenant_id = $1)`,
    [tenantId]
  );

  const movementsResult = await client.query<{ tenant_id: string; id: string }>(
    `SELECT tenant_id, id
       FROM inventory_movements
      WHERE ($1::uuid IS NULL OR tenant_id = $1)
      ORDER BY created_at DESC, id DESC`,
    [tenantId]
  );

  let replayIntegrityFailureCount = 0;
  const replayIntegrityFailureSample: MovementHashCoverageAuditFailure[] = [];
  for (const row of movementsResult.rows) {
    try {
      await verifyAuthoritativeMovementReplayIntegrity(client, row.tenant_id, {
        movementId: row.id
      });
    } catch (error) {
      if (
        (error as Error & { code?: string })?.code !== 'REPLAY_CORRUPTION_DETECTED'
        && (error as Error)?.message !== 'REPLAY_CORRUPTION_DETECTED'
      ) {
        throw error;
      }

      replayIntegrityFailureCount += 1;
      if (replayIntegrityFailureSample.length < sampleLimit) {
        const details = (error as Error & { details?: Record<string, unknown> })?.details ?? {};
        replayIntegrityFailureSample.push({
          tenantId: row.tenant_id,
          movementId: row.id,
          reason: String(details.reason ?? 'replay_corruption_detected'),
          details
        });
      }
    }
  }

  const countsRow = countsResult.rows[0] ?? {
    total_movements: 0,
    rows_missing_deterministic_hash: 0,
    post_cutoff_rows_missing_hash: 0
  };

  return {
    totalMovements: Number(countsRow.total_movements ?? 0),
    rowsMissingDeterministicHash: Number(countsRow.rows_missing_deterministic_hash ?? 0),
    postCutoffRowsMissingHash: Number(countsRow.post_cutoff_rows_missing_hash ?? 0),
    replayIntegrityFailures: {
      count: replayIntegrityFailureCount,
      sample: replayIntegrityFailureSample
    }
  };
}

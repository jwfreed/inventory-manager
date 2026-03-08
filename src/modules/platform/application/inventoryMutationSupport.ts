import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { applyInventoryBalanceDelta } from '../../../domains/inventory';
import { refreshItemCostSummaryProjection } from '../../costing/infrastructure/itemCostSummary.projector';
import { toNumber } from '../../../lib/numbers';
import type { InventoryCommandEvent, InventoryCommandProjectionOp } from './runInventoryCommand';
import { buildInventoryRegistryEvent } from './inventoryEventRegistry';

export const MOVEMENT_HASH_REQUIRED_AFTER_MIGRATION_TS = 1774900000000;

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

export type MovementDeterministicHashLineInput = {
  itemId: string;
  locationId: string;
  quantityDelta: number | string;
  uom?: string | null;
  canonicalUom?: string | null;
  unitCost?: number | string | null;
  reasonCode?: string | null;
};

export type MovementDeterministicHashInput = {
  tenantId: string;
  movementType: string;
  occurredAt: Date | string;
  sourceType?: string | null;
  sourceId?: string | null;
  lines: MovementDeterministicHashLineInput[];
};

export type AuthoritativeMovementReplayExpectation = {
  movementId: string;
  expectedLineCount?: number;
  expectedDeterministicHash?: string | null;
};

type NormalizedMovementDeterministicHashLine = {
  itemId: string;
  locationId: string;
  canonicalUom: string;
  quantityDelta: string;
  unitCost: string | null;
  reasonCode: string;
};

type NormalizedMovementDeterministicHashEnvelope = {
  tenantId: string;
  movementType: string;
  occurredAt: string;
  sourceType: string;
  sourceId: string;
  lines: NormalizedMovementDeterministicHashLine[];
};

function normalizeMovementHashNumber(value: unknown): string {
  const numeric = toNumber(value);
  if (!Number.isFinite(numeric)) {
    return '0.000000000000';
  }
  return numeric.toFixed(12);
}

function normalizeMovementDeterministicHashLine(
  line: MovementDeterministicHashLineInput
): NormalizedMovementDeterministicHashLine {
  return {
    itemId: line.itemId,
    locationId: line.locationId,
    canonicalUom: line.canonicalUom ?? line.uom ?? '',
    quantityDelta: normalizeMovementHashNumber(line.quantityDelta),
    unitCost: line.unitCost === null || line.unitCost === undefined
      ? null
      : normalizeMovementHashNumber(line.unitCost),
    reasonCode: line.reasonCode ?? ''
  };
}

function compareMovementDeterministicHashLine(
  left: NormalizedMovementDeterministicHashLine,
  right: NormalizedMovementDeterministicHashLine
) {
  return (
    left.itemId.localeCompare(right.itemId)
    || left.locationId.localeCompare(right.locationId)
    || left.canonicalUom.localeCompare(right.canonicalUom)
    || left.quantityDelta.localeCompare(right.quantityDelta)
    || String(left.unitCost ?? '').localeCompare(String(right.unitCost ?? ''))
    || left.reasonCode.localeCompare(right.reasonCode)
  );
}

export function buildMovementDeterministicHash(
  input: MovementDeterministicHashInput
): string {
  const normalizedLines = input.lines
    .map(normalizeMovementDeterministicHashLine)
    .sort(compareMovementDeterministicHashLine);
  const normalizedEnvelope: NormalizedMovementDeterministicHashEnvelope = {
    tenantId: input.tenantId,
    movementType: input.movementType,
    occurredAt: new Date(input.occurredAt).toISOString(),
    sourceType: input.sourceType?.trim() ?? '',
    sourceId: input.sourceId?.trim() ?? '',
    lines: normalizedLines
  };
  return createHash('sha256').update(JSON.stringify(normalizedEnvelope)).digest('hex');
}

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

export async function persistMovementDeterministicHashFromLedger(
  client: PoolClient,
  tenantId: string,
  movementId: string
) {
  const state = await loadPersistedMovementDeterministicHashState(client, tenantId, movementId);
  if (state.lineCount === 0) {
    throw buildReplayCorruptionError({
      tenantId,
      movementId,
      reason: 'authoritative_movement_missing_lines'
    });
  }
  const movementDeterministicHash = computePersistedMovementDeterministicHash({
    tenantId,
    movement: state.movement,
    lines: state.lines
  });
  await client.query(
    `UPDATE inventory_movements
        SET movement_deterministic_hash = $3
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, movementId, movementDeterministicHash]
  );
  return movementDeterministicHash;
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
  const movementCreatedAtMs = new Date(state.movement.created_at).getTime();
  if (
    movementCreatedAtMs >= MOVEMENT_HASH_REQUIRED_AFTER_MIGRATION_TS
    && !storedDeterministicHash
  ) {
    throw buildReplayCorruptionError({
      tenantId,
      movementId: expectation.movementId,
      reason: 'authoritative_movement_hash_missing_post_migration',
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

  const events: InventoryCommandEvent[] = [];
  for (const event of params.authoritativeEvents) {
    if (!await inventoryEventVersionExists(
      params.client,
      params.tenantId,
      event.aggregateType,
      event.aggregateId,
      event.eventType,
      event.eventVersion
    )) {
      events.push(event);
    }
  }

  return {
    responseBody: aggregateView,
    responseStatus: params.responseStatus ?? 200,
    events
  };
}

type DeterministicMovementLineIdentity = {
  tenantId: string;
  warehouseId: string;
  locationId: string;
  itemId: string;
  canonicalUom: string;
  sourceLineId: string;
};

function compareDeterministicMovementLineIdentity(
  left: DeterministicMovementLineIdentity,
  right: DeterministicMovementLineIdentity
) {
  return (
    left.tenantId.localeCompare(right.tenantId)
    || left.warehouseId.localeCompare(right.warehouseId)
    || left.locationId.localeCompare(right.locationId)
    || left.itemId.localeCompare(right.itemId)
    || left.canonicalUom.localeCompare(right.canonicalUom)
    || left.sourceLineId.localeCompare(right.sourceLineId)
  );
}

export function sortDeterministicMovementLines<T>(
  lines: T[],
  getIdentity: (line: T) => DeterministicMovementLineIdentity
) {
  return [...lines].sort((left, right) =>
    compareDeterministicMovementLineIdentity(getIdentity(left), getIdentity(right))
  );
}

export function buildInventoryBalanceProjectionOp(params: {
  tenantId: string;
  itemId: string;
  locationId: string;
  uom: string;
  deltaOnHand?: number;
  deltaReserved?: number;
  deltaAllocated?: number;
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

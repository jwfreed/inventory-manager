import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { applyInventoryBalanceDelta } from '../../../domains/inventory';
import { refreshItemCostSummaryProjection } from '../../costing/infrastructure/itemCostSummary.projector';
import { toNumber } from '../../../lib/numbers';
import type { InventoryCommandEvent, InventoryCommandProjectionOp } from './runInventoryCommand';
import { buildInventoryRegistryEvent } from './inventoryEventRegistry';

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
  uom: string;
  quantityDeltaEntered?: number | string | null;
  uomEntered?: string | null;
  quantityDeltaCanonical?: number | string | null;
  canonicalUom?: string | null;
  reasonCode?: string | null;
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
  quantityDeltaCanonical: string;
  quantityDeltaEntered: string;
  uomEntered: string;
  reasonCode: string;
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
    canonicalUom: line.canonicalUom ?? line.uom,
    quantityDeltaCanonical: normalizeMovementHashNumber(
      line.quantityDeltaCanonical ?? line.quantityDelta
    ),
    quantityDeltaEntered: normalizeMovementHashNumber(
      line.quantityDeltaEntered ?? line.quantityDelta
    ),
    uomEntered: line.uomEntered ?? line.uom,
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
    || left.quantityDeltaCanonical.localeCompare(right.quantityDeltaCanonical)
    || left.quantityDeltaEntered.localeCompare(right.quantityDeltaEntered)
    || left.uomEntered.localeCompare(right.uomEntered)
    || left.reasonCode.localeCompare(right.reasonCode)
  );
}

export function buildMovementDeterministicHash(
  lines: MovementDeterministicHashLineInput[]
): string {
  const normalizedLines = lines
    .map(normalizeMovementDeterministicHashLine)
    .sort(compareMovementDeterministicHashLine);
  return createHash('sha256').update(JSON.stringify(normalizedLines)).digest('hex');
}

function buildReplayCorruptionError(details: Record<string, unknown>) {
  const error = new Error('REPLAY_CORRUPTION_DETECTED') as Error & {
    code?: string;
    details?: Record<string, unknown>;
  };
  error.code = 'REPLAY_CORRUPTION_DETECTED';
  error.details = details;
  return error;
}

async function verifyAuthoritativeMovementReplayIntegrity(
  client: PoolClient,
  tenantId: string,
  expectation: AuthoritativeMovementReplayExpectation
) {
  const movementResult = await client.query<{ movement_deterministic_hash: string | null }>(
    `SELECT movement_deterministic_hash
       FROM inventory_movements
      WHERE tenant_id = $1
        AND id = $2
      LIMIT 1`,
    [tenantId, expectation.movementId]
  );
  if ((movementResult.rowCount ?? 0) === 0) {
    throw buildReplayCorruptionError({
      tenantId,
      movementId: expectation.movementId,
      reason: 'authoritative_movement_missing'
    });
  }

  const lineResult = await client.query<MovementDeterministicHashLineInput>(
    `SELECT item_id AS "itemId",
            location_id AS "locationId",
            quantity_delta AS "quantityDelta",
            uom,
            quantity_delta_entered AS "quantityDeltaEntered",
            uom_entered AS "uomEntered",
            quantity_delta_canonical AS "quantityDeltaCanonical",
            canonical_uom AS "canonicalUom",
            reason_code AS "reasonCode"
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND movement_id = $2`,
    [tenantId, expectation.movementId]
  );
  if ((lineResult.rowCount ?? 0) === 0) {
    throw buildReplayCorruptionError({
      tenantId,
      movementId: expectation.movementId,
      reason: 'authoritative_movement_missing_lines'
    });
  }

  const lineCount = lineResult.rowCount ?? 0;
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

  const computedDeterministicHash = buildMovementDeterministicHash(lineResult.rows);
  const storedDeterministicHash = movementResult.rows[0]?.movement_deterministic_hash ?? null;
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

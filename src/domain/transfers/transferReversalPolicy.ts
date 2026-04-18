import type { PoolClient } from 'pg';
import { roundQuantity, toNumber } from '../../lib/numbers';
import {
  assertCanonicalUomConsistency,
  assertDirectionalQuantityConservation,
  assertExpectedLineCount
} from '../inventory/mutationInvariants';

const EPSILON = 1e-6;

export const TRANSFER_REVERSAL_MOVEMENT_TYPE = 'transfer_reversal' as const;
export const TRANSFER_REVERSAL_SOURCE_TYPE = 'transfer_void' as const;

type TransferReversalOriginalMovementRow = {
  id: string;
  status: string;
  movement_type: string;
  reversal_of_movement_id: string | null;
  occurred_at: Date | string;
};

type TransferReversalExistingMovementRow = {
  id: string;
  occurred_at: Date | string;
};

type TransferReversalOriginalLineRow = {
  id: string;
  item_id: string;
  location_id: string;
  warehouse_id: string | null;
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

export type TransferReversalOriginalLine = Readonly<{
  id: string;
  itemId: string;
  locationId: string;
  warehouseId: string;
  quantityDelta: number;
  uom: string;
  quantityDeltaEntered: number | null;
  uomEntered: string | null;
  quantityDeltaCanonical: number | null;
  canonicalUom: string | null;
  uomDimension: string | null;
  unitCost: number | null;
  extendedCost: number | null;
  reasonCode: string | null;
  lineNotes: string | null;
  effectiveUom: string;
  effectiveQuantity: number;
  originalDirection: 'out' | 'in';
}>;

export type PreparedTransferReversal = Readonly<{
  tenantId: string;
  originalMovementId: string;
  movementType: typeof TRANSFER_REVERSAL_MOVEMENT_TYPE;
  sourceType: typeof TRANSFER_REVERSAL_SOURCE_TYPE;
  sourceId: string;
  originalOccurredAt: Date;
  originalLines: ReadonlyArray<TransferReversalOriginalLine>;
  sourceLine: TransferReversalOriginalLine;
  destinationLine: TransferReversalOriginalLine;
  sourceWarehouseId: string;
  destinationWarehouseId: string;
  itemId: string;
  quantity: number;
  canonicalUom: string;
  existingReversal: Readonly<{
    movementId: string;
    occurredAt: Date;
  }> | null;
}>;

function domainError(code: string, details?: Record<string, unknown>) {
  const error = new Error(code) as Error & {
    code?: string;
    details?: Record<string, unknown>;
  };
  error.code = code;
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}

function requireWarehouseId(row: TransferReversalOriginalLineRow): string {
  if (typeof row.warehouse_id !== 'string' || !row.warehouse_id.trim()) {
    throw new Error('TRANSFER_REPLAY_SCOPE_UNRESOLVED');
  }
  return row.warehouse_id;
}

function normalizeLine(row: TransferReversalOriginalLineRow): TransferReversalOriginalLine {
  const effectiveQuantity = roundQuantity(
    Math.abs(toNumber(row.quantity_delta_canonical ?? row.quantity_delta))
  );
  if (effectiveQuantity <= EPSILON) {
    throw new Error('TRANSFER_INVALID_QUANTITY');
  }

  const quantityDelta = roundQuantity(toNumber(row.quantity_delta));
  const quantityDeltaCanonical = row.quantity_delta_canonical === null
    ? null
    : roundQuantity(toNumber(row.quantity_delta_canonical));

  return Object.freeze({
    id: row.id,
    itemId: row.item_id,
    locationId: row.location_id,
    warehouseId: requireWarehouseId(row),
    quantityDelta,
    uom: row.uom,
    quantityDeltaEntered: row.quantity_delta_entered === null
      ? null
      : roundQuantity(toNumber(row.quantity_delta_entered)),
    uomEntered: row.uom_entered,
    quantityDeltaCanonical,
    canonicalUom: row.canonical_uom,
    uomDimension: row.uom_dimension,
    unitCost: row.unit_cost === null ? null : roundQuantity(toNumber(row.unit_cost)),
    extendedCost: row.extended_cost === null ? null : roundQuantity(toNumber(row.extended_cost)),
    reasonCode: row.reason_code,
    lineNotes: row.line_notes,
    effectiveUom: row.canonical_uom ?? row.uom,
    effectiveQuantity,
    originalDirection: quantityDelta < 0 ? 'out' : 'in'
  });
}

function assertOriginalTransferStructure(
  originalMovementId: string,
  lines: ReadonlyArray<TransferReversalOriginalLine>
) {
  assertExpectedLineCount({
    actualLineCount: lines.length,
    expectedLineCount: 2,
    errorCode: 'TRANSFER_REVERSAL_ORIGINAL_LINE_COUNT_INVALID'
  });

  const sourceLine = lines.find((line) => line.originalDirection === 'out');
  const destinationLine = lines.find((line) => line.originalDirection === 'in');
  if (!sourceLine || !destinationLine) {
    throw new Error('TRANSFER_REVERSAL_DIRECTION_INVALID');
  }

  if (sourceLine.itemId !== destinationLine.itemId) {
    throw new Error('TRANSFER_REVERSAL_ITEM_MISMATCH');
  }
  if (sourceLine.locationId === destinationLine.locationId) {
    throw new Error('TRANSFER_REVERSAL_LOCATION_SCOPE_INVALID');
  }
  assertCanonicalUomConsistency({
    canonicalUoms: [sourceLine.effectiveUom, destinationLine.effectiveUom],
    errorCode: 'TRANSFER_REVERSAL_UOM_MISMATCH'
  });
  assertDirectionalQuantityConservation({
    outboundQuantity: sourceLine.effectiveQuantity,
    inboundQuantity: destinationLine.effectiveQuantity,
    errorCode: 'TRANSFER_REVERSAL_QUANTITY_IMBALANCE',
    epsilon: EPSILON
  });

  const originalOutbound = roundQuantity(Math.abs(sourceLine.quantityDeltaCanonical ?? sourceLine.quantityDelta));
  const originalInbound = roundQuantity(destinationLine.quantityDeltaCanonical ?? destinationLine.quantityDelta);
  try {
    assertDirectionalQuantityConservation({
      outboundQuantity: originalOutbound,
      inboundQuantity: originalInbound,
      errorCode: 'TRANSFER_REVERSAL_QUANTITY_IMBALANCE',
      epsilon: EPSILON
    });
  } catch {
    throw domainError('TRANSFER_REVERSAL_QUANTITY_IMBALANCE', {
      originalMovementId,
      originalOutbound,
      originalInbound
    });
  }

  return {
    sourceLine,
    destinationLine,
    itemId: sourceLine.itemId,
    quantity: sourceLine.effectiveQuantity,
    canonicalUom: sourceLine.effectiveUom
  };
}

async function loadOriginalMovement(
  client: PoolClient,
  tenantId: string,
  originalMovementId: string
) {
  const movementResult = await client.query<TransferReversalOriginalMovementRow>(
    `SELECT id,
            status,
            movement_type,
            reversal_of_movement_id,
            occurred_at
       FROM inventory_movements
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, originalMovementId]
  );
  if ((movementResult.rowCount ?? 0) === 0) {
    throw new Error('TRANSFER_NOT_FOUND');
  }

  const movement = movementResult.rows[0]!;
  if (movement.status !== 'posted') {
    throw new Error('TRANSFER_NOT_POSTED');
  }
  if (
    movement.movement_type === TRANSFER_REVERSAL_MOVEMENT_TYPE
    || movement.reversal_of_movement_id !== null
  ) {
    throw new Error('TRANSFER_REVERSAL_INVALID_TARGET');
  }
  if (movement.movement_type !== 'transfer') {
    throw new Error('TRANSFER_NOT_TRANSFER');
  }

  return movement;
}

async function loadOriginalLines(
  client: PoolClient,
  tenantId: string,
  originalMovementId: string
) {
  const result = await client.query<TransferReversalOriginalLineRow>(
    `SELECT iml.id,
            iml.item_id,
            iml.location_id,
            l.warehouse_id,
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
            iml.line_notes
       FROM inventory_movement_lines iml
       JOIN locations l
         ON l.id = iml.location_id
        AND l.tenant_id = iml.tenant_id
      WHERE iml.tenant_id = $1
        AND iml.movement_id = $2
      ORDER BY COALESCE(iml.event_timestamp, iml.created_at) ASC, iml.id ASC`,
    [tenantId, originalMovementId]
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new Error('TRANSFER_NOT_POSTED');
  }
  return result.rows.map(normalizeLine);
}

async function loadExistingReversal(
  client: PoolClient,
  tenantId: string,
  originalMovementId: string
) {
  const result = await client.query<TransferReversalExistingMovementRow>(
    `SELECT id, occurred_at
       FROM inventory_movements
      WHERE tenant_id = $1
        AND reversal_of_movement_id = $2
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
    [tenantId, originalMovementId]
  );
  if ((result.rowCount ?? 0) === 0) {
    return null;
  }
  const row = result.rows[0]!;
  return Object.freeze({
    movementId: row.id,
    occurredAt: new Date(row.occurred_at)
  });
}

async function assertDestinationQuantityUnconsumed(
  client: PoolClient,
  tenantId: string,
  originalMovementId: string
) {
  const result = await client.query<{
    link_count: string;
    transferred_quantity: string;
    remaining_quantity: string;
    consumed_quantity: string;
  }>(
    `WITH transfer_links AS (
       SELECT dest_cost_layer_id, quantity
         FROM cost_layer_transfer_links
        WHERE tenant_id = $1
          AND transfer_movement_id = $2
     )
     SELECT COUNT(*)::text AS link_count,
            COALESCE(SUM(tl.quantity), 0)::text AS transferred_quantity,
            COALESCE(SUM(dcl.remaining_quantity), 0)::text AS remaining_quantity,
            COALESCE(SUM(consumption.consumed_quantity), 0)::text AS consumed_quantity
       FROM transfer_links tl
       JOIN inventory_cost_layers dcl
         ON dcl.id = tl.dest_cost_layer_id
       LEFT JOIN LATERAL (
         SELECT SUM(c.consumed_quantity)::numeric AS consumed_quantity
           FROM cost_layer_consumptions c
          WHERE c.tenant_id = $1
            AND c.cost_layer_id = tl.dest_cost_layer_id
       ) consumption ON true`,
    [tenantId, originalMovementId]
  );

  const row = result.rows[0];
  const linkCount = Number(row?.link_count ?? 0);
  if (linkCount < 1) {
    throw new Error('TRANSFER_REVERSAL_COST_LINKS_REQUIRED');
  }

  const transferredQuantity = roundQuantity(Number(row?.transferred_quantity ?? 0));
  const remainingQuantity = roundQuantity(Number(row?.remaining_quantity ?? 0));
  const consumedQuantity = roundQuantity(Number(row?.consumed_quantity ?? 0));

  if (consumedQuantity > EPSILON || remainingQuantity + EPSILON < transferredQuantity) {
    throw domainError('TRANSFER_REVERSAL_NOT_POSSIBLE_CONSUMED', {
      originalMovementId,
      transferredQuantity,
      remainingQuantity,
      consumedQuantity
    });
  }
}

export async function prepareTransferReversalPolicy(
  params: {
    tenantId: string;
    originalMovementId: string;
  },
  client: PoolClient
): Promise<PreparedTransferReversal> {
  const originalMovement = await loadOriginalMovement(
    client,
    params.tenantId,
    params.originalMovementId
  );
  const originalLines = await loadOriginalLines(
    client,
    params.tenantId,
    params.originalMovementId
  );
  const structure = assertOriginalTransferStructure(params.originalMovementId, originalLines);
  const existingReversal = await loadExistingReversal(
    client,
    params.tenantId,
    params.originalMovementId
  );

  if (!existingReversal) {
    await assertDestinationQuantityUnconsumed(
      client,
      params.tenantId,
      params.originalMovementId
    );
  }

  return Object.freeze({
    tenantId: params.tenantId,
    originalMovementId: params.originalMovementId,
    movementType: TRANSFER_REVERSAL_MOVEMENT_TYPE,
    sourceType: TRANSFER_REVERSAL_SOURCE_TYPE,
    sourceId: params.originalMovementId,
    originalOccurredAt: new Date(originalMovement.occurred_at),
    originalLines: Object.freeze([...originalLines]),
    sourceLine: structure.sourceLine,
    destinationLine: structure.destinationLine,
    sourceWarehouseId: structure.sourceLine.warehouseId,
    destinationWarehouseId: structure.destinationLine.warehouseId,
    itemId: structure.itemId,
    quantity: structure.quantity,
    canonicalUom: structure.canonicalUom,
    existingReversal
  });
}

export function buildTransferReversalLockTargets(
  prepared: PreparedTransferReversal
) {
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
  ].sort((left, right) =>
    left.warehouseId.localeCompare(right.warehouseId)
    || left.itemId.localeCompare(right.itemId)
    || left.tenantId.localeCompare(right.tenantId)
  );
}

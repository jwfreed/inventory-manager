import type { PoolClient } from 'pg';
import type {
  PersistInventoryMovementInput,
  PersistInventoryMovementLineInput
} from '../../domains/inventory';
import {
  buildMovementDeterministicHash,
  sortDeterministicMovementLines
} from '../../modules/platform/application/inventoryMutationSupport';
import { roundQuantity } from '../../lib/numbers';
import { getCanonicalMovementFields, type CanonicalMovementFields } from '../../services/uomCanonical.service';
import type { PreparedTransferMutation } from './transferPolicy';

export type PlannedTransferMovementLine = Readonly<{
  direction: 'out' | 'in';
  warehouseId: string;
  itemId: string;
  locationId: string;
  sourceLineId: string;
  reasonCode: string;
  lineNotes: string;
  canonicalFields: Readonly<CanonicalMovementFields>;
}>;

export type TransferMovementPlan = Readonly<{
  lines: ReadonlyArray<PlannedTransferMovementLine>;
  outLineIndex: number;
  inLineIndex: number;
  expectedLineCount: number;
  expectedDeterministicHash: string;
  canonicalQuantity: number;
  canonicalUom: string;
  persistInput: Readonly<
    Omit<PersistInventoryMovementInput, 'id' | 'lines'> & {
      lines: ReadonlyArray<PersistInventoryMovementLineInput>;
    }
  >;
}>;

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

function assertTransferPlanSymmetry(
  outbound: CanonicalMovementFields,
  inbound: CanonicalMovementFields
) {
  const outboundQty = roundQuantity(Math.abs(outbound.quantityDeltaCanonical));
  const inboundQty = roundQuantity(inbound.quantityDeltaCanonical);

  if (outbound.quantityDeltaCanonical >= 0 || inbound.quantityDeltaCanonical <= 0) {
    throw new Error('TRANSFER_PLAN_DIRECTION_INVALID');
  }
  if (outbound.canonicalUom !== inbound.canonicalUom) {
    throw new Error('TRANSFER_CANONICAL_MISMATCH');
  }
  if (Math.abs(outboundQty - inboundQty) > 1e-6) {
    throw new Error('TRANSFER_QUANTITY_IMBALANCE');
  }
}

function mapPersistMovementLine(
  line: PlannedTransferMovementLine
): PersistInventoryMovementLineInput {
  return {
    warehouseId: line.warehouseId,
    sourceLineId: line.sourceLineId,
    itemId: line.itemId,
    locationId: line.locationId,
    quantityDelta: line.canonicalFields.quantityDeltaCanonical,
    uom: line.canonicalFields.canonicalUom,
    quantityDeltaEntered: line.canonicalFields.quantityDeltaEntered,
    uomEntered: line.canonicalFields.uomEntered,
    quantityDeltaCanonical: line.canonicalFields.quantityDeltaCanonical,
    canonicalUom: line.canonicalFields.canonicalUom,
    uomDimension: line.canonicalFields.uomDimension,
    unitCost: null,
    extendedCost: null,
    reasonCode: line.reasonCode,
    lineNotes: line.lineNotes
  };
}

export async function buildTransferMovementPlan(
  prepared: PreparedTransferMutation,
  client: PoolClient
): Promise<TransferMovementPlan> {
  const [canonicalOut, canonicalIn] = await Promise.all([
    getCanonicalMovementFields(
      prepared.tenantId,
      prepared.itemId,
      -prepared.enteredQty,
      prepared.uom,
      client
    ),
    getCanonicalMovementFields(
      prepared.tenantId,
      prepared.itemId,
      prepared.enteredQty,
      prepared.uom,
      client
    )
  ]);

  assertTransferPlanSymmetry(canonicalOut, canonicalIn);

  const lines = sortDeterministicMovementLines(
    [
      {
        direction: 'out' as const,
        warehouseId: prepared.sourceWarehouseId,
        itemId: prepared.itemId,
        locationId: prepared.sourceLocationId,
        sourceLineId: `${prepared.sourceType}:${prepared.sourceId}:out`,
        reasonCode: `${prepared.reasonCode}_out`,
        lineNotes: `${prepared.notes} (outbound)`,
        canonicalFields: Object.freeze(canonicalOut)
      },
      {
        direction: 'in' as const,
        warehouseId: prepared.destinationWarehouseId,
        itemId: prepared.itemId,
        locationId: prepared.destinationLocationId,
        sourceLineId: `${prepared.sourceType}:${prepared.sourceId}:in`,
        reasonCode: `${prepared.reasonCode}_in`,
        lineNotes: `${prepared.notes} (inbound)`,
        canonicalFields: Object.freeze(canonicalIn)
      }
    ],
    (line) => ({
      tenantId: prepared.tenantId,
      warehouseId: line.warehouseId,
      locationId: line.locationId,
      itemId: line.itemId,
      canonicalUom: line.canonicalFields.canonicalUom,
      sourceLineId: line.sourceLineId
    })
  );

  const outLineIndex = lines.findIndex((line) => line.direction === 'out');
  const inLineIndex = lines.findIndex((line) => line.direction === 'in');
  if (outLineIndex < 0 || inLineIndex < 0) {
    throw new Error('TRANSFER_LINE_DIRECTIONS_MISSING');
  }

  const canonicalQuantity = roundQuantity(lines[inLineIndex]!.canonicalFields.quantityDeltaCanonical);
  const canonicalUom = lines[inLineIndex]!.canonicalFields.canonicalUom;
  const expectedDeterministicHash = buildMovementDeterministicHash({
    tenantId: prepared.tenantId,
    movementType: prepared.movementType,
    occurredAt: prepared.occurredAt,
    sourceType: prepared.sourceType,
    sourceId: prepared.sourceId,
    lines: lines.map((line) => ({
      itemId: line.itemId,
      locationId: line.locationId,
      quantityDelta: line.canonicalFields.quantityDeltaCanonical,
      canonicalUom: line.canonicalFields.canonicalUom,
      unitCost: null,
      reasonCode: line.reasonCode
    }))
  });

  return deepFreeze({
    lines,
    outLineIndex,
    inLineIndex,
    expectedLineCount: lines.length,
    expectedDeterministicHash,
    canonicalQuantity,
    canonicalUom,
    persistInput: {
      tenantId: prepared.tenantId,
      movementType: prepared.movementType,
      status: 'posted',
      externalRef: `${prepared.sourceType}:${prepared.sourceId}`,
      sourceType: prepared.sourceType,
      sourceId: prepared.sourceId,
      idempotencyKey: prepared.idempotencyKey,
      occurredAt: prepared.occurredAt,
      postedAt: prepared.occurredAt,
      notes: prepared.notes,
      metadata: null,
      createdAt: prepared.occurredAt,
      updatedAt: prepared.occurredAt,
      lotId: prepared.lotId,
      lines: lines.map(mapPersistMovementLine)
    }
  });
}

import { v4 as uuidv4 } from 'uuid';
import type {
  PersistInventoryMovementInput,
  PersistInventoryMovementLineInput
} from '../../domains/inventory';
import {
  buildMovementDeterministicHash,
  sortDeterministicMovementLines
} from '../../modules/platform/application/inventoryMutationSupport';
import { roundQuantity } from '../../lib/numbers';
import type {
  PreparedTransferReversal,
  TransferReversalOriginalLine
} from './transferReversalPolicy';
import {
  assertCanonicalUomConsistency,
  assertDirectionalQuantityConservation,
  assertExpectedLineCount,
  assertMovementSymmetry
} from '../inventory/mutationInvariants';
import { invertMovementQuantityFields } from '../inventory/mutationTransforms';

const EPSILON = 1e-6;

export type PlannedTransferReversalLine = Readonly<{
  id: string;
  sourceLineId: string;
  originalLineId: string;
  originalDirection: 'out' | 'in';
  reversalDirection: 'out' | 'in';
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
}>;

export type TransferReversalPlan = Readonly<{
  occurredAt: Date;
  lines: ReadonlyArray<PlannedTransferReversalLine>;
  expectedLineCount: number;
  expectedDeterministicHash: string;
  expectedQuantity: number;
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

function mapReversalLine(
  line: TransferReversalOriginalLine
): PlannedTransferReversalLine {
  const inverted = invertMovementQuantityFields({
    quantityDelta: line.quantityDelta,
    quantityDeltaEntered: line.quantityDeltaEntered,
    quantityDeltaCanonical: line.quantityDeltaCanonical,
    extendedCost: line.extendedCost
  });
  return {
    id: uuidv4(),
    sourceLineId: line.id,
    originalLineId: line.id,
    originalDirection: line.originalDirection,
    reversalDirection: line.originalDirection === 'out' ? 'in' : 'out',
    warehouseId: line.warehouseId,
    itemId: line.itemId,
    locationId: line.locationId,
    effectiveUom: line.effectiveUom,
    effectiveQty: line.effectiveQuantity,
    quantityDelta: inverted.quantityDelta,
    quantityDeltaEntered: inverted.quantityDeltaEntered,
    uomEntered: line.uomEntered,
    quantityDeltaCanonical: inverted.quantityDeltaCanonical,
    canonicalUom: line.canonicalUom,
    uomDimension: line.uomDimension,
    unitCost: line.unitCost,
    extendedCost: inverted.extendedCost,
    reasonCode: line.reasonCode ? `${line.reasonCode}_reversal` : 'transfer_reversal',
    lineNotes: line.lineNotes ? `Reversal of ${line.id}: ${line.lineNotes}` : `Reversal of ${line.id}`
  };
}

function mapPersistMovementLine(
  line: PlannedTransferReversalLine,
  eventTimestamp: Date | string
): PersistInventoryMovementLineInput {
  return {
    id: line.id,
    warehouseId: line.warehouseId,
    sourceLineId: line.sourceLineId,
    eventTimestamp,
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
    lineNotes: line.lineNotes
  };
}

export function assertTransferReversalPlanInvariants(
  prepared: PreparedTransferReversal,
  lines: ReadonlyArray<PlannedTransferReversalLine>
) {
  assertExpectedLineCount({
    actualLineCount: lines.length,
    expectedLineCount: prepared.originalLines.length,
    errorCode: 'TRANSFER_REVERSAL_PLAN_LINE_COUNT_INVALID'
  });

  const originalLineIds = new Set(prepared.originalLines.map((line) => line.id));
  const reversalLineIds = new Set<string>();
  let originalOutbound = 0;
  let originalInbound = 0;
  let reversalOutbound = 0;
  let reversalInbound = 0;

  for (const line of lines) {
    if (!originalLineIds.has(line.originalLineId)) {
      throw new Error('TRANSFER_REVERSAL_LINE_MAPPING_INVALID');
    }
    if (reversalLineIds.has(line.originalLineId)) {
      throw new Error('TRANSFER_REVERSAL_LINE_MAPPING_DUPLICATE');
    }
    reversalLineIds.add(line.originalLineId);

    const originalLine = prepared.originalLines.find((entry) => entry.id === line.originalLineId);
    if (!originalLine) {
      throw new Error('TRANSFER_REVERSAL_LINE_MAPPING_INVALID');
    }

    if (line.locationId !== originalLine.locationId || line.warehouseId !== originalLine.warehouseId) {
      throw new Error('TRANSFER_REVERSAL_LOCATION_SCOPE_INVALID');
    }
    if (line.itemId !== originalLine.itemId) {
      throw new Error('TRANSFER_REVERSAL_ITEM_MISMATCH');
    }
    assertCanonicalUomConsistency({
      canonicalUoms: [line.canonicalUom ?? line.effectiveUom, originalLine.effectiveUom],
      errorCode: 'TRANSFER_REVERSAL_UOM_MISMATCH'
    });
    assertMovementSymmetry({
      originalQuantity: originalLine.quantityDelta,
      reversalQuantity: line.quantityDelta,
      errorCode: 'TRANSFER_REVERSAL_QUANTITY_SYMMETRY_INVALID',
      epsilon: EPSILON
    });
    if (line.quantityDeltaCanonical !== null && originalLine.quantityDeltaCanonical !== null) {
      assertMovementSymmetry({
        originalQuantity: originalLine.quantityDeltaCanonical,
        reversalQuantity: line.quantityDeltaCanonical,
        errorCode: 'TRANSFER_REVERSAL_CANONICAL_QUANTITY_SYMMETRY_INVALID',
        epsilon: EPSILON
      });
    }
    if (line.originalDirection === line.reversalDirection) {
      throw new Error('TRANSFER_REVERSAL_DIRECTION_INVALID');
    }

    if (originalLine.originalDirection === 'out') {
      originalOutbound = roundQuantity(originalOutbound + originalLine.effectiveQuantity);
    } else {
      originalInbound = roundQuantity(originalInbound + originalLine.effectiveQuantity);
    }

    if (line.reversalDirection === 'out') {
      reversalOutbound = roundQuantity(reversalOutbound + line.effectiveQty);
    } else {
      reversalInbound = roundQuantity(reversalInbound + line.effectiveQty);
    }
  }

  if (reversalLineIds.size !== prepared.originalLines.length) {
    throw new Error('TRANSFER_REVERSAL_LINE_MAPPING_INCOMPLETE');
  }
  assertDirectionalQuantityConservation({
    outboundQuantity: originalOutbound,
    inboundQuantity: originalInbound,
    errorCode: 'TRANSFER_REVERSAL_ORIGINAL_QUANTITY_IMBALANCE',
    epsilon: EPSILON
  });
  assertDirectionalQuantityConservation({
    outboundQuantity: reversalOutbound,
    inboundQuantity: reversalInbound,
    errorCode: 'TRANSFER_REVERSAL_PLAN_QUANTITY_IMBALANCE',
    epsilon: EPSILON
  });
  assertDirectionalQuantityConservation({
    outboundQuantity: originalOutbound,
    inboundQuantity: reversalInbound,
    errorCode: 'TRANSFER_REVERSAL_INBOUND_SYMMETRY_INVALID',
    epsilon: EPSILON
  });
  assertDirectionalQuantityConservation({
    outboundQuantity: originalInbound,
    inboundQuantity: reversalOutbound,
    errorCode: 'TRANSFER_REVERSAL_OUTBOUND_SYMMETRY_INVALID',
    epsilon: EPSILON
  });

  return {
    expectedQuantity: reversalOutbound,
    canonicalUom: prepared.canonicalUom
  };
}

export function buildTransferReversalPlan(
  prepared: PreparedTransferReversal,
  params: {
    occurredAt: Date;
    idempotencyKey: string | null;
    reason: string;
  }
): TransferReversalPlan {
  const lines = sortDeterministicMovementLines(
    prepared.originalLines.map(mapReversalLine),
    (line) => ({
      tenantId: prepared.tenantId,
      warehouseId: line.warehouseId,
      locationId: line.locationId,
      itemId: line.itemId,
      canonicalUom: line.canonicalUom ?? line.effectiveUom,
      sourceLineId: line.sourceLineId
    })
  );

  const invariantState = assertTransferReversalPlanInvariants(prepared, lines);
  const expectedDeterministicHash = buildMovementDeterministicHash({
    tenantId: prepared.tenantId,
    movementType: prepared.movementType,
    occurredAt: params.occurredAt,
    sourceType: prepared.sourceType,
    sourceId: prepared.sourceId,
    lines: lines.map((line) => ({
      itemId: line.itemId,
      locationId: line.locationId,
      quantityDelta: line.quantityDeltaCanonical ?? line.quantityDelta,
      canonicalUom: line.canonicalUom ?? line.effectiveUom,
      uom: line.canonicalUom ?? line.effectiveUom,
      unitCost: line.unitCost,
      reasonCode: line.reasonCode
    }))
  });

  return deepFreeze({
    occurredAt: params.occurredAt,
    lines,
    expectedLineCount: lines.length,
    expectedDeterministicHash,
    expectedQuantity: invariantState.expectedQuantity,
    canonicalUom: invariantState.canonicalUom,
    persistInput: {
      tenantId: prepared.tenantId,
      movementType: prepared.movementType,
      status: 'posted',
      externalRef: `transfer_void:${prepared.originalMovementId}`,
      sourceType: prepared.sourceType,
      sourceId: prepared.sourceId,
      idempotencyKey: params.idempotencyKey,
      occurredAt: params.occurredAt,
      postedAt: params.occurredAt,
      notes: `Transfer void reversal ${prepared.originalMovementId}: ${params.reason}`,
      metadata: null,
      reversalOfMovementId: prepared.originalMovementId,
      reversalReason: params.reason,
      createdAt: params.occurredAt,
      updatedAt: params.occurredAt,
      lines: lines.map((line) => mapPersistMovementLine(line, params.occurredAt))
    }
  });
}

import { roundQuantity } from '../../lib/numbers';

export const INVENTORY_MUTATION_EPSILON = 1e-6;

export type ReplayDeterminismExpectation = Readonly<{
  movementId: string;
  expectedLineCount?: number;
  expectedDeterministicHash?: string | null;
}>;

export type InventoryMutationDelta = Readonly<{
  itemId: string;
  locationId: string;
  uom: string;
  deltaOnHand: number;
}>;

export function assertExpectedLineCount(params: {
  actualLineCount: number;
  expectedLineCount: number;
  errorCode: string;
}) {
  if (params.actualLineCount !== params.expectedLineCount) {
    throw new Error(params.errorCode);
  }
  return params.actualLineCount;
}

export function assertQuantityEquality(params: {
  expectedQuantity: number;
  actualQuantity: number;
  errorCode: string;
  epsilon?: number;
}) {
  const expectedQuantity = roundQuantity(params.expectedQuantity);
  const actualQuantity = roundQuantity(params.actualQuantity);
  if (Math.abs(actualQuantity - expectedQuantity) > (params.epsilon ?? INVENTORY_MUTATION_EPSILON)) {
    throw new Error(params.errorCode);
  }
  return {
    expectedQuantity,
    actualQuantity
  };
}

export function assertDirectionalQuantityConservation(params: {
  outboundQuantity: number;
  inboundQuantity: number;
  errorCode: string;
  epsilon?: number;
}) {
  return assertQuantityEquality({
    expectedQuantity: roundQuantity(Math.abs(params.outboundQuantity)),
    actualQuantity: roundQuantity(Math.abs(params.inboundQuantity)),
    errorCode: params.errorCode,
    epsilon: params.epsilon
  });
}

export function assertMovementSymmetry(params: {
  originalQuantity: number;
  reversalQuantity: number;
  errorCode: string;
  epsilon?: number;
}) {
  return assertQuantityEquality({
    expectedQuantity: 0,
    actualQuantity: roundQuantity(params.originalQuantity + params.reversalQuantity),
    errorCode: params.errorCode,
    epsilon: params.epsilon
  });
}

export function assertCanonicalUomConsistency(params: {
  canonicalUoms: ReadonlyArray<string | null | undefined>;
  errorCode: string;
}) {
  const definedUoms = params.canonicalUoms.filter(
    (value): value is string => typeof value === 'string' && value.length > 0
  );
  if (definedUoms.length === 0) {
    return null;
  }
  const canonicalUom = definedUoms[0]!;
  for (const value of definedUoms) {
    if (value !== canonicalUom) {
      throw new Error(params.errorCode);
    }
  }
  return canonicalUom;
}

export function assertLocationInventoryReadyInvariant(params: {
  binCount: number;
  defaultCount: number;
  defaultBinId: string | null;
  errorCode?: string;
}) {
  if (params.binCount < 1 || params.defaultCount !== 1 || !params.defaultBinId) {
    throw new Error(params.errorCode ?? 'LOCATION_INVENTORY_NOT_READY');
  }
  return {
    binId: params.defaultBinId,
    defaultBinId: params.defaultBinId
  };
}

export function negateNullableQuantity(value: number | null): number | null {
  if (value === null) return null;
  return roundQuantity(-value);
}

export function invertMovementQuantityFields(params: {
  quantityDelta: number;
  quantityDeltaEntered: number | null;
  quantityDeltaCanonical: number | null;
  extendedCost: number | null;
}) {
  const quantityDelta = roundQuantity(-params.quantityDelta);
  const quantityDeltaEntered = negateNullableQuantity(params.quantityDeltaEntered);
  const quantityDeltaCanonical = negateNullableQuantity(params.quantityDeltaCanonical);
  const extendedCost = negateNullableQuantity(params.extendedCost);

  return {
    quantityDelta,
    quantityDeltaEntered,
    quantityDeltaCanonical,
    extendedCost,
    balanceQuantityDelta: quantityDeltaCanonical ?? quantityDelta
  };
}

function aggregateInventoryDeltas(
  entries: ReadonlyArray<InventoryMutationDelta>
) {
  const byKey = new Map<string, InventoryMutationDelta>();
  for (const entry of entries) {
    const deltaOnHand = roundQuantity(entry.deltaOnHand);
    const key = `${entry.itemId}|${entry.locationId}|${entry.uom}`;
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, {
        itemId: entry.itemId,
        locationId: entry.locationId,
        uom: entry.uom,
        deltaOnHand
      });
      continue;
    }
    byKey.set(key, {
      ...current,
      deltaOnHand: roundQuantity(current.deltaOnHand + deltaOnHand)
    });
  }
  return [...byKey.values()].sort((left, right) =>
    left.itemId.localeCompare(right.itemId)
    || left.locationId.localeCompare(right.locationId)
    || left.uom.localeCompare(right.uom)
  );
}

export function assertProjectionDeltaContract(params: {
  movementDeltas: ReadonlyArray<InventoryMutationDelta>;
  projectionDeltas: ReadonlyArray<InventoryMutationDelta>;
  errorCode: string;
  epsilon?: number;
}) {
  const epsilon = params.epsilon ?? INVENTORY_MUTATION_EPSILON;
  const movementDeltas = aggregateInventoryDeltas(params.movementDeltas);
  const projectionDeltas = aggregateInventoryDeltas(params.projectionDeltas);

  if (movementDeltas.length !== projectionDeltas.length) {
    throw new Error(params.errorCode);
  }

  for (let index = 0; index < movementDeltas.length; index += 1) {
    const movement = movementDeltas[index]!;
    const projection = projectionDeltas[index]!;
    if (
      movement.itemId !== projection.itemId
      || movement.locationId !== projection.locationId
      || movement.uom !== projection.uom
      || Math.abs(movement.deltaOnHand - projection.deltaOnHand) > epsilon
    ) {
      throw new Error(params.errorCode);
    }
  }

  return {
    movementDeltas,
    projectionDeltas
  };
}

export function buildReplayDeterminismExpectation(params: {
  movementId: string;
  expectedLineCount?: number;
  expectedDeterministicHash?: string | null;
}): ReplayDeterminismExpectation {
  return {
    movementId: params.movementId,
    ...(typeof params.expectedLineCount === 'number'
      ? { expectedLineCount: params.expectedLineCount }
      : {}),
    expectedDeterministicHash: params.expectedDeterministicHash ?? null
  };
}

import { createHash } from 'node:crypto';
import { toNumber } from '../../../lib/numbers';

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

export type DeterministicMovementLineIdentity = {
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

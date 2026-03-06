import { expect } from '@playwright/test';

type InvariantContext = {
  sku?: string;
  warehouseId?: string;
  locationId?: string;
  docId?: string;
};

type BucketValues = InvariantContext & {
  onHand: number;
  available: number;
  reserved: number;
  inTransit: number;
};

type OnHandAvailable = InvariantContext & {
  onHand: number;
  available: number;
};

type ConservationDeltaInput = InvariantContext & {
  sourceBefore: number;
  sourceAfter: number;
  destBefore: number;
  destAfter: number;
  qty: number;
};

type ReservedSupersetInput = InvariantContext & {
  reservedTotal: number;
  allocatedOpen: number;
};

function normalize(value: number): number {
  return Number(value.toFixed(6));
}

function contextLabel(context: InvariantContext): string {
  const entries = [
    context.sku ? `sku=${context.sku}` : null,
    context.warehouseId ? `warehouse=${context.warehouseId}` : null,
    context.locationId ? `location=${context.locationId}` : null,
    context.docId ? `doc=${context.docId}` : null
  ].filter(Boolean);
  return entries.length ? ` (${entries.join(', ')})` : '';
}

export function expectNonNegativeBuckets(values: BucketValues) {
  const context = contextLabel(values);
  expect(
    values.onHand,
    `Expected onHand >= 0${context}. Actual=${values.onHand}`
  ).toBeGreaterThanOrEqual(0);
  expect(
    values.available,
    `Expected available >= 0${context}. Actual=${values.available}`
  ).toBeGreaterThanOrEqual(0);
  expect(
    values.reserved,
    `Expected reserved >= 0${context}. Actual=${values.reserved}`
  ).toBeGreaterThanOrEqual(0);
  expect(
    values.inTransit,
    `Expected inTransit >= 0${context}. Actual=${values.inTransit}`
  ).toBeGreaterThanOrEqual(0);
}

export function expectAvailableLeqOnHand(values: OnHandAvailable) {
  const context = contextLabel(values);
  expect(
    normalize(values.available),
    [
      `Expected available <= onHand${context}.`,
      `available=${normalize(values.available)}`,
      `onHand=${normalize(values.onHand)}`
    ].join(' ')
  ).toBeLessThanOrEqual(normalize(values.onHand));
}

export function expectConservationDelta(input: ConservationDeltaInput) {
  const context = contextLabel(input);
  const sourceDelta = normalize(input.sourceBefore - input.sourceAfter);
  const destinationDelta = normalize(input.destAfter - input.destBefore);
  const totalBefore = normalize(input.sourceBefore + input.destBefore);
  const totalAfter = normalize(input.sourceAfter + input.destAfter);

  expect(
    sourceDelta,
    `Expected source delta == qty${context}. sourceDelta=${sourceDelta} qty=${normalize(input.qty)}`
  ).toBe(normalize(input.qty));
  expect(
    destinationDelta,
    `Expected destination delta == qty${context}. destinationDelta=${destinationDelta} qty=${normalize(input.qty)}`
  ).toBe(normalize(input.qty));
  expect(
    totalAfter,
    `Expected conservation totalAfter == totalBefore${context}. totalBefore=${totalBefore} totalAfter=${totalAfter}`
  ).toBe(totalBefore);
}

export function expectReservedSupersetOfAllocated(input: ReservedSupersetInput) {
  const context = contextLabel(input);
  expect(
    normalize(input.reservedTotal),
    [
      `Expected reservedTotal >= allocatedOpen${context}.`,
      `reservedTotal=${normalize(input.reservedTotal)}`,
      `allocatedOpen=${normalize(input.allocatedOpen)}`
    ].join(' ')
  ).toBeGreaterThanOrEqual(normalize(input.allocatedOpen));
}

export function expectZeroReservedImpliesZeroAllocated(input: ReservedSupersetInput) {
  const context = contextLabel(input);
  const normalizedReserved = normalize(input.reservedTotal);
  const normalizedAllocated = normalize(input.allocatedOpen);
  if (normalizedReserved === 0) {
    expect(
      normalizedAllocated,
      `Expected allocatedOpen == 0 when reservedTotal == 0${context}. allocatedOpen=${normalizedAllocated}`
    ).toBe(0);
  }
}

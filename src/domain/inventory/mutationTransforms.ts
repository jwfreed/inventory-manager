import { roundQuantity } from '../../lib/numbers';

// pure transformation helpers

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

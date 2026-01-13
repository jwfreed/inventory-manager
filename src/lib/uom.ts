import { roundQuantity } from './numbers';

const MASS_FACTORS: Record<string, number> = {
  mg: 0.001,
  g: 1,
  kg: 1000
};

export type NormalizedQuantity = { quantity: number; uom: string };

/**
 * Normalizes mass units to grams. Non-mass units are returned unchanged.
 * Accepted mass units: mg, g, kg (case-insensitive).
 */
export function normalizeMassQuantity(quantity: number, uom: string): NormalizedQuantity {
  const key = uom.toLowerCase();
  const factor = MASS_FACTORS[key];
  if (!factor) {
    return { quantity: roundQuantity(quantity), uom };
  }
  const inGrams = roundQuantity(quantity * factor);
  return { quantity: inGrams, uom: 'g' };
}

/**
 * Convenience to normalize only when unit is mass; otherwise pass-through.
 */
export function normalizeQuantityByUom(quantity: number, uom: string): NormalizedQuantity {
  return normalizeMassQuantity(quantity, uom);
}

export function getMassConversionFactor(fromUom: string, toUom: string): number | null {
  const fromKey = fromUom.toLowerCase();
  const toKey = toUom.toLowerCase();
  const fromFactor = MASS_FACTORS[fromKey];
  const toFactor = MASS_FACTORS[toKey];
  if (!fromFactor || !toFactor) {
    return null;
  }
  return fromFactor / toFactor;
}

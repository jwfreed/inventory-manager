/**
 * Converts common numeric-like inputs into a number.
 *
 * Behavior matches the project's existing helpers:
 * - number => itself
 * - string => parseFloat (NaN => 0)
 * - null/undefined => 0
 * - other => Number(value) (NaN => 0)
 */
export function toNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (value === null || value === undefined) {
    return 0;
  }
  const num = Number(value);
  return Number.isNaN(num) ? 0 : num;
}

/**
 * Rounds to 6 decimal places (inventory quantity precision).
 *
 * Behavior matches prior implementations: `parseFloat(value.toFixed(6))`.
 */
export function roundQuantity(value: number): number {
  return parseFloat(value.toFixed(6));
}

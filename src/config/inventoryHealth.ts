export type InventoryHealthGateConfig = {
  maxLedgerVariancePct: number;
  maxLedgerValueVariance: number;
  maxCycleCountVariancePct: number;
  failOnNegativeInventory: boolean;
};

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  return fallback;
}

export function getInventoryHealthGateConfig(): InventoryHealthGateConfig {
  return {
    maxLedgerVariancePct: parseNumber(process.env.INVENTORY_HEALTH_MAX_VARIANCE_PCT, 1),
    maxLedgerValueVariance: parseNumber(process.env.INVENTORY_HEALTH_MAX_VALUE_VARIANCE, 0),
    maxCycleCountVariancePct: parseNumber(process.env.INVENTORY_HEALTH_MAX_CYCLE_VARIANCE_PCT, 2),
    failOnNegativeInventory: parseBoolean(process.env.INVENTORY_HEALTH_FAIL_ON_NEGATIVE, true)
  };
}

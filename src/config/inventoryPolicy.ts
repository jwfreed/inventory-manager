export type InventoryNegativePolicy = {
  allowNegativeInventory: boolean;
  allowNegativeWithOverride: boolean;
  overrideRequiresReason: boolean;
  overrideRequiresRole: boolean;
  allowedRolesForOverride: string[];
};

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  return fallback;
}

function parseRoles(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function getInventoryNegativePolicy(): InventoryNegativePolicy {
  return {
    allowNegativeInventory: parseBoolean(process.env.ALLOW_NEGATIVE_INVENTORY, false),
    allowNegativeWithOverride: parseBoolean(process.env.ALLOW_NEGATIVE_WITH_OVERRIDE, false),
    overrideRequiresReason: parseBoolean(process.env.NEGATIVE_OVERRIDE_REQUIRES_REASON, true),
    overrideRequiresRole: parseBoolean(process.env.NEGATIVE_OVERRIDE_REQUIRES_ROLE, true),
    allowedRolesForOverride: parseRoles(process.env.NEGATIVE_OVERRIDE_ALLOWED_ROLES, [
      'admin',
      'inventory_manager'
    ])
  };
}

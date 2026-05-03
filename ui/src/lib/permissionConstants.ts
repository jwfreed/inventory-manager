/**
 * Centralized permission constants for all known UI permissions.
 * Backend is the source of truth — these strings must match exactly what
 * the backend sends in the user's permission list.
 *
 * Use these constants instead of raw strings to get autocomplete and
 * catch typos at compile time.
 */
export const PERMISSIONS = {
  // Inventory
  INVENTORY_READ: 'inventory:read',
  INVENTORY_TRANSFERS_WRITE: 'inventory:transfers:write',
  INVENTORY_COUNTS_WRITE: 'inventory:counts:write',
  INVENTORY_ADJUSTMENTS_WRITE: 'inventory:adjustments:write',
  INVENTORY_QC_WRITE: 'inventory:qc:write',
  INVENTORY_PUTAWAY_WRITE: 'inventory:putaway:write',

  // Outbound / Order to Cash
  OUTBOUND_READ: 'outbound:read',
  OUTBOUND_WRITE: 'outbound:write',
  OUTBOUND_POST: 'outbound:post',

  // Finance / AP
  FINANCE_READ: 'finance:read',
  FINANCE_WRITE: 'finance:write',

  // Purchasing / Receiving
  PURCHASING_READ: 'purchasing:read',
  PURCHASING_WRITE: 'purchasing:write',

  // Master Data
  MASTERDATA_READ: 'masterdata:read',
  MASTERDATA_WRITE: 'masterdata:write',

  // Reports / KPIs
  REPORTS_READ: 'reports:read',

  // Production / Work Orders
  PRODUCTION_READ: 'production:read',
  PRODUCTION_WRITE: 'production:write',

  // Compliance / NCRs
  COMPLIANCE_READ: 'compliance:read',

  // Planning / Replenishment
  PLANNING_READ: 'planning:read',
  PLANNING_WRITE: 'planning:write',

  // Admin
  ADMIN_HEALTH: 'admin:health',
  ADMIN_IMPORTS: 'admin:imports',
} as const

export type KnownPermission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS]

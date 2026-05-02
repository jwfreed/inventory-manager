export const roles = ['operator', 'supervisor', 'manager', 'admin'] as const;

export type Role = (typeof roles)[number];

export const permissions = [
  'inventory:read',
  'inventory:adjustments:write',
  'inventory:adjustments:post',
  'inventory:transfers:write',
  'inventory:putaway:write',
  'inventory:putaway:post',
  'inventory:counts:write',
  'inventory:counts:post',
  'inventory:qc:write',
  'inventory:ledger:void',
  'inventory:lpn:write',
  'purchasing:read',
  'purchasing:write',
  'purchasing:approve',
  'purchasing:void',
  'production:read',
  'production:write',
  'production:execute',
  'production:post',
  'outbound:read',
  'outbound:write',
  'outbound:allocate',
  'outbound:post',
  'finance:read',
  'finance:write',
  'finance:approve',
  'compliance:read',
  'compliance:write',
  'compliance:admin',
  'masterdata:read',
  'masterdata:write',
  'planning:read',
  'planning:write',
  'costlayers:read',
  'costlayers:write',
  'reports:read',
  'reports:write',
  'audit:read',
  'admin:reconcile',
  'admin:imports',
  'admin:outbox',
  'admin:health',
  'users:read',
  'users:write'
] as const;

export type Permission = (typeof permissions)[number];

const operatorPermissions = [
  'inventory:read',
  'inventory:transfers:write',
  'inventory:putaway:write',
  'inventory:putaway:post',
  'inventory:counts:write',
  'inventory:qc:write',
  'inventory:lpn:write',
  'purchasing:read',
  'production:read',
  'production:execute',
  'production:post',
  'outbound:read',
  'compliance:read',
  'masterdata:read',
  'planning:read',
  'reports:read'
] as const satisfies readonly Permission[];

const supervisorPermissions = [
  ...operatorPermissions,
  'inventory:adjustments:write',
  'inventory:counts:post',
  'purchasing:write',
  'outbound:write',
  'outbound:allocate',
  'outbound:post',
  'compliance:write',
  'audit:read'
] as const satisfies readonly Permission[];

const managerPermissions = [
  ...supervisorPermissions,
  'inventory:adjustments:post',
  'inventory:ledger:void',
  'purchasing:approve',
  'purchasing:void',
  'production:write',
  'finance:read',
  'finance:write',
  'compliance:admin',
  'masterdata:write',
  'planning:write',
  'costlayers:read',
  'reports:write'
] as const satisfies readonly Permission[];

const adminPermissions = permissions;

export const rolePermissions = {
  operator: operatorPermissions,
  supervisor: supervisorPermissions,
  manager: managerPermissions,
  admin: adminPermissions
} as const satisfies Record<Role, readonly Permission[]>;

const permissionSets: Record<Role, ReadonlySet<Permission>> = {
  operator: new Set(rolePermissions.operator),
  supervisor: new Set(rolePermissions.supervisor),
  manager: new Set(rolePermissions.manager),
  admin: new Set(rolePermissions.admin)
};

export function isRole(value: string | null | undefined): value is Role {
  return roles.includes(value as Role);
}

export function hasPermission(role: string | null | undefined, permission: Permission): boolean {
  if (!isRole(role)) return false;
  return permissionSets[role].has(permission);
}

export type RoutePermissionRule = {
  methods: readonly string[];
  path: string;
  permission: Permission;
};

export const routePermissionRules = [
  { methods: ['POST'], path: '/admin/inventory-ledger/reconcile', permission: 'admin:reconcile' },
  { methods: ['GET'], path: '/admin/inventory-health', permission: 'admin:health' },
  { methods: ['POST'], path: '/admin/outbox/process', permission: 'admin:outbox' },
  { methods: ['POST'], path: '/admin/imports/upload', permission: 'admin:imports' },
  { methods: ['GET'], path: '/admin/imports/:id', permission: 'admin:imports' },
  { methods: ['POST'], path: '/admin/imports/:id/validate', permission: 'admin:imports' },
  { methods: ['POST'], path: '/admin/imports/:id/apply', permission: 'admin:imports' },

  { methods: ['GET'], path: '/audit-log', permission: 'audit:read' },

  { methods: ['POST'], path: '/qc/accept', permission: 'inventory:qc:write' },
  { methods: ['POST'], path: '/qc/reject', permission: 'inventory:qc:write' },
  { methods: ['POST'], path: '/qc/hold-dispositions', permission: 'inventory:qc:write' },
  { methods: ['POST'], path: '/qc-events', permission: 'inventory:qc:write' },
  { methods: ['PATCH'], path: '/ncrs/:id/disposition', permission: 'inventory:qc:write' },

  { methods: ['POST'], path: '/inventory-adjustments', permission: 'inventory:adjustments:write' },
  { methods: ['PUT'], path: '/inventory-adjustments/:id', permission: 'inventory:adjustments:write' },
  { methods: ['DELETE'], path: '/inventory-adjustments/:id', permission: 'inventory:adjustments:write' },
  { methods: ['POST'], path: '/inventory-adjustments/:id/cancel', permission: 'inventory:adjustments:write' },
  { methods: ['POST'], path: '/inventory-adjustments/:id/post', permission: 'inventory:adjustments:post' },
  { methods: ['POST'], path: '/inventory-transfers', permission: 'inventory:transfers:write' },
  { methods: ['POST'], path: '/putaways', permission: 'inventory:putaway:write' },
  { methods: ['POST'], path: '/putaways/:id/post', permission: 'inventory:putaway:post' },
  { methods: ['POST'], path: '/inventory-counts', permission: 'inventory:counts:write' },
  { methods: ['PATCH'], path: '/inventory-counts/:id', permission: 'inventory:counts:write' },
  { methods: ['POST'], path: '/inventory-counts/:id/post', permission: 'inventory:counts:post' },
  { methods: ['POST'], path: '/inventory-movements/:id/void-transfer', permission: 'inventory:ledger:void' },
  { methods: ['POST'], path: '/lpns', permission: 'inventory:lpn:write' },
  { methods: ['PATCH'], path: '/lpns/:id', permission: 'inventory:lpn:write' },
  { methods: ['POST'], path: '/lpns/:id/move', permission: 'inventory:lpn:write' },
  { methods: ['POST'], path: '/lpns/refresh-view', permission: 'inventory:lpn:write' },

  { methods: ['POST'], path: '/purchase-orders', permission: 'purchasing:write' },
  { methods: ['PUT'], path: '/purchase-orders/:id', permission: 'purchasing:write' },
  { methods: ['POST'], path: '/purchase-orders/:id/approve', permission: 'purchasing:approve' },
  { methods: ['POST'], path: '/purchase-order-lines/:id/close', permission: 'purchasing:write' },
  { methods: ['POST'], path: '/purchase-orders/:id/close', permission: 'purchasing:void' },
  { methods: ['DELETE'], path: '/purchase-orders/:id', permission: 'purchasing:void' },
  { methods: ['POST'], path: '/purchase-orders/:id/cancel', permission: 'purchasing:write' },
  { methods: ['POST'], path: '/purchase-order-receipts', permission: 'purchasing:write' },
  { methods: ['DELETE'], path: '/purchase-order-receipts/:id', permission: 'purchasing:void' },
  { methods: ['POST'], path: '/purchase-order-receipts/:id/void', permission: 'purchasing:void' },
  { methods: ['POST'], path: '/purchase-order-receipts/:id/close', permission: 'purchasing:void' },

  { methods: ['POST'], path: '/work-orders', permission: 'production:write' },
  { methods: ['PATCH'], path: '/work-orders/:id', permission: 'production:write' },
  { methods: ['PATCH'], path: '/work-orders/:id/default-locations', permission: 'production:write' },
  { methods: ['POST'], path: '/work-orders/:id/status/:status', permission: 'production:write' },
  { methods: ['POST'], path: '/work-orders/:id/use-active-bom', permission: 'production:write' },
  { methods: ['POST'], path: '/work-orders/:id/disassemble', permission: 'production:post' },
  { methods: ['POST'], path: '/work-orders/:id/issues', permission: 'production:execute' },
  { methods: ['POST'], path: '/work-orders/:id/issues/:issueId/post', permission: 'production:post' },
  { methods: ['POST'], path: '/work-orders/:id/completions', permission: 'production:execute' },
  { methods: ['POST'], path: '/work-orders/:id/completions/:completionId/post', permission: 'production:post' },
  { methods: ['POST'], path: '/work-orders/:id/record-batch', permission: 'production:post' },
  { methods: ['POST'], path: '/work-orders/:id/report-production', permission: 'production:post' },
  { methods: ['POST'], path: '/work-orders/:id/void-report-production', permission: 'production:post' },
  { methods: ['POST'], path: '/work-orders/:id/report-scrap', permission: 'production:post' },
  { methods: ['POST'], path: '/work-orders/:id/reverse', permission: 'production:post' },
  { methods: ['POST'], path: '/boms', permission: 'production:write' },
  { methods: ['POST'], path: '/boms/:id/activate', permission: 'production:write' },
  { methods: ['POST'], path: '/work-centers', permission: 'production:write' },
  { methods: ['PATCH'], path: '/work-centers/:id', permission: 'production:write' },
  { methods: ['POST'], path: '/routings', permission: 'production:write' },
  { methods: ['PATCH'], path: '/routings/:id', permission: 'production:write' },

  { methods: ['POST'], path: '/sales-orders', permission: 'outbound:write' },
  { methods: ['POST'], path: '/reservations', permission: 'outbound:allocate' },
  { methods: ['POST'], path: '/reservations/:id/allocate', permission: 'outbound:allocate' },
  { methods: ['POST'], path: '/reservations/:id/cancel', permission: 'outbound:allocate' },
  { methods: ['POST'], path: '/reservations/:id/fulfill', permission: 'outbound:post' },
  { methods: ['POST'], path: '/shipments', permission: 'outbound:write' },
  { methods: ['POST'], path: '/shipments/:id/post', permission: 'outbound:post' },
  { methods: ['POST'], path: '/returns', permission: 'outbound:write' },
  { methods: ['POST'], path: '/return-receipts', permission: 'outbound:write' },
  { methods: ['POST'], path: '/return-receipts/:id/post', permission: 'outbound:post' },
  { methods: ['POST'], path: '/return-receipts/:id/lines', permission: 'outbound:write' },
  { methods: ['POST'], path: '/return-dispositions', permission: 'inventory:qc:write' },
  { methods: ['POST'], path: '/return-dispositions/:id/post', permission: 'outbound:post' },
  { methods: ['POST'], path: '/return-dispositions/:id/lines', permission: 'inventory:qc:write' },
  { methods: ['POST'], path: '/waves', permission: 'outbound:write' },
  { methods: ['POST'], path: '/pick-batches', permission: 'outbound:write' },
  { methods: ['POST'], path: '/pick-tasks', permission: 'outbound:write' },
  { methods: ['POST'], path: '/shipping-containers', permission: 'outbound:write' },
  { methods: ['POST'], path: '/shipping-containers/:id/items', permission: 'outbound:write' },
  { methods: ['DELETE'], path: '/shipping-containers/:id/items/:itemId', permission: 'outbound:write' },

  { methods: ['POST'], path: '/items', permission: 'masterdata:write' },
  { methods: ['POST'], path: '/items/metrics', permission: 'masterdata:read' },
  { methods: ['PUT'], path: '/items/:id', permission: 'masterdata:write' },
  { methods: ['POST'], path: '/locations', permission: 'masterdata:write' },
  { methods: ['PUT'], path: '/locations/:id', permission: 'masterdata:write' },
  { methods: ['POST'], path: '/locations/templates/standard-warehouse', permission: 'masterdata:write' },
  { methods: ['POST'], path: '/uoms/convert', permission: 'masterdata:read' },
  { methods: ['PATCH'], path: '/items/:id/uom', permission: 'masterdata:write' },
  { methods: ['POST'], path: '/items/:itemId/uom-conversions', permission: 'masterdata:write' },
  { methods: ['DELETE'], path: '/uom-conversions/:id', permission: 'masterdata:write' },

  { methods: ['POST'], path: '/vendors', permission: 'finance:write' },
  { methods: ['PUT'], path: '/vendors/:id', permission: 'finance:write' },
  { methods: ['DELETE'], path: '/vendors/:id', permission: 'finance:write' },
  { methods: ['POST'], path: '/vendor-invoices', permission: 'finance:write' },
  { methods: ['PUT'], path: '/vendor-invoices/:id', permission: 'finance:write' },
  { methods: ['POST'], path: '/vendor-invoices/:id/approve', permission: 'finance:approve' },
  { methods: ['POST'], path: '/vendor-invoices/:id/void', permission: 'finance:approve' },
  { methods: ['POST'], path: '/vendor-payments', permission: 'finance:write' },
  { methods: ['PUT'], path: '/vendor-payments/:id', permission: 'finance:write' },
  { methods: ['POST'], path: '/vendor-payments/:id/post', permission: 'finance:approve' },
  { methods: ['POST'], path: '/vendor-payments/:id/void', permission: 'finance:approve' },

  { methods: ['POST'], path: '/api/cost-layers', permission: 'costlayers:write' },
  { methods: ['POST'], path: '/api/cost-layers/consume', permission: 'costlayers:write' },
  { methods: ['DELETE'], path: '/api/cost-layers/:layerId', permission: 'costlayers:write' },
  { methods: ['POST'], path: '/api/items/:id/roll-cost', permission: 'costlayers:write' },
  { methods: ['POST'], path: '/api/boms/:id/cost-preview', permission: 'costlayers:read' },
  { methods: ['POST'], path: '/api/items/roll-costs', permission: 'costlayers:write' },

  { methods: ['POST'], path: '/mps/plans', permission: 'planning:write' },
  { methods: ['POST'], path: '/mps/plans/:id/periods', permission: 'planning:write' },
  { methods: ['POST'], path: '/mps/plans/:id/demand-inputs', permission: 'planning:write' },
  { methods: ['POST'], path: '/mrp/runs', permission: 'planning:write' },
  { methods: ['POST'], path: '/mrp/runs/:id/item-policies', permission: 'planning:write' },
  { methods: ['POST'], path: '/mrp/runs/:id/gross-requirements', permission: 'planning:write' },
  { methods: ['POST'], path: '/mrp/runs/:id/load-sales-demand', permission: 'planning:write' },
  { methods: ['POST'], path: '/mrp/runs/:id/compute', permission: 'planning:write' },
  { methods: ['POST'], path: '/mrp/planned-orders/:id/firm', permission: 'planning:write' },
  { methods: ['POST'], path: '/mrp/planned-orders/:id/release', permission: 'planning:write' },
  { methods: ['POST'], path: '/replenishment/policies', permission: 'planning:write' },
  { methods: ['POST'], path: '/kpis/runs', permission: 'planning:write' },
  { methods: ['POST'], path: '/kpis/compute/dashboard', permission: 'planning:write' },
  { methods: ['POST'], path: '/kpis/runs/:id/snapshots', permission: 'planning:write' },
  { methods: ['POST'], path: '/kpis/runs/:id/rollup-inputs', permission: 'planning:write' },
  { methods: ['POST'], path: '/drp/nodes', permission: 'planning:write' },
  { methods: ['POST'], path: '/drp/lanes', permission: 'planning:write' },
  { methods: ['POST'], path: '/drp/runs', permission: 'planning:write' },
  { methods: ['POST'], path: '/drp/runs/:id/periods', permission: 'planning:write' },
  { methods: ['POST'], path: '/drp/runs/:id/item-policies', permission: 'planning:write' },
  { methods: ['POST'], path: '/drp/runs/:id/gross-requirements', permission: 'planning:write' },

  { methods: ['POST'], path: '/lots', permission: 'compliance:write' },
  { methods: ['POST'], path: '/inventory-movement-lines/:id/lots', permission: 'compliance:write' },
  { methods: ['POST'], path: '/recalls/cases', permission: 'compliance:admin' },
  { methods: ['PATCH'], path: '/recalls/cases/:id', permission: 'compliance:admin' },
  { methods: ['POST'], path: '/recalls/cases/:id/targets', permission: 'compliance:admin' },
  { methods: ['POST'], path: '/recalls/cases/:id/trace-runs', permission: 'compliance:admin' },
  { methods: ['POST'], path: '/recalls/trace-runs/:id/impacted-shipments', permission: 'compliance:admin' },
  { methods: ['POST'], path: '/recalls/trace-runs/:id/impacted-lots', permission: 'compliance:admin' },
  { methods: ['POST'], path: '/recalls/cases/:id/actions', permission: 'compliance:admin' },
  { methods: ['POST'], path: '/recalls/cases/:id/communications', permission: 'compliance:admin' },

  { methods: ['POST'], path: '/metrics/compute/abc-classification', permission: 'reports:write' },
  { methods: ['POST'], path: '/metrics/compute/slow-dead-stock', permission: 'reports:write' },
  { methods: ['POST'], path: '/metrics/compute/turns-doi', permission: 'reports:write' },
  { methods: ['POST'], path: '/metrics/compute/all', permission: 'reports:write' },
  { methods: ['POST'], path: '/metrics/cache/invalidate', permission: 'reports:write' },
  { methods: ['POST'], path: '/metrics/job/trigger', permission: 'reports:write' },
  { methods: ['POST'], path: '/atp/check', permission: 'inventory:read' }
] as const satisfies readonly RoutePermissionRule[];


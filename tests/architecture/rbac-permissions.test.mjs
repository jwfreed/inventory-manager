import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const {
  permissions,
  rolePermissions,
  hasPermission,
  routePermissionRules
} = require('../../src/config/permissions.ts');
const {
  findRoutePermission,
  requirePermission
} = require('../../src/middleware/permissions.middleware.ts');
const { assertNonProductionEnvironment } = require('../../scripts/lib/productionGuard.ts');

const mountedRouteFiles = {
  'src/routes/vendors.routes.ts': '',
  'src/routes/vendorInvoices.routes.ts': '',
  'src/routes/vendorPayments.routes.ts': '',
  'src/routes/purchaseOrders.routes.ts': '',
  'src/routes/receipts.routes.ts': '',
  'src/routes/qc.routes.ts': '',
  'src/routes/ncr.routes.ts': '',
  'src/routes/putaways.routes.ts': '',
  'src/routes/transfers.routes.ts': '',
  'src/routes/closeout.routes.ts': '',
  'src/routes/adjustments.routes.ts': '',
  'src/routes/counts.routes.ts': '',
  'src/routes/boms.routes.ts': '',
  'src/routes/routings.routes.ts': '',
  'src/routes/workOrders.routes.ts': '',
  'src/routes/workOrderExecution.routes.ts': '',
  'src/routes/orderToCash.routes.ts': '',
  'src/routes/masterData.routes.ts': '',
  'src/routes/ledger.routes.ts': '',
  'src/routes/imports.routes.ts': '',
  'src/routes/picking.routes.ts': '',
  'src/routes/shippingContainers.routes.ts': '',
  'src/routes/returnsExtended.routes.ts': '',
  'src/routes/planning.routes.ts': '',
  'src/routes/drp.routes.ts': '',
  'src/routes/compliance.routes.ts': '',
  'src/routes/audit.routes.ts': '',
  'src/routes/licensePlates.routes.ts': '',
  'src/routes/inventoryLedgerReconcile.routes.ts': '',
  'src/routes/inventoryHealth.routes.ts': '',
  'src/routes/outboxAdmin.routes.ts': '',
  'src/routes/costLayers.routes.ts': '/api/cost-layers',
  'src/routes/costs.routes.ts': '/api',
  'src/routes/metrics.routes.ts': '/metrics',
  'src/routes/atp.routes.ts': '/atp'
};

function mockResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

function normalizePath(value) {
  if (!value || value === '/') return '/';
  return `/${value.replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

function joinRoutePath(prefix, routePath) {
  return normalizePath(`${normalizePath(prefix)}${normalizePath(routePath)}`.replace(/^\/\//, '/'));
}

test('role permission matrix is centralized and admin has every permission', () => {
  assert.ok(permissions.length > 0, 'permissions must not be empty');
  assert.deepEqual([...rolePermissions.admin].sort(), [...permissions].sort(), 'admin must retain every permission');

  for (const [role, assigned] of Object.entries(rolePermissions)) {
    for (const permission of assigned) {
      assert.ok(permissions.includes(permission), `${role} references unknown permission ${permission}`);
      assert.equal(hasPermission(role, permission), true, `${role} should have ${permission}`);
    }
  }

  assert.equal(hasPermission('operator', 'inventory:adjustments:post'), false);
  assert.equal(hasPermission('manager', 'inventory:adjustments:post'), true);
  assert.equal(hasPermission('unknown-role', 'inventory:read'), false);
});

test('requirePermission returns 401, 403, and allowed outcomes distinctly', () => {
  const missingAuthRes = mockResponse();
  let nextCalls = 0;
  requirePermission('inventory:read')({}, missingAuthRes, () => {
    nextCalls += 1;
  });
  assert.equal(missingAuthRes.statusCode, 401);
  assert.match(missingAuthRes.headers['www-authenticate'], /Bearer/);
  assert.equal(nextCalls, 0);

  const forbiddenRes = mockResponse();
  requirePermission('finance:approve')({ auth: { role: 'manager' } }, forbiddenRes, () => {
    nextCalls += 1;
  });
  assert.equal(forbiddenRes.statusCode, 403);
  assert.equal(nextCalls, 0);

  const allowedRes = mockResponse();
  requirePermission('purchasing:approve')({ auth: { role: 'manager' } }, allowedRes, () => {
    nextCalls += 1;
  });
  assert.equal(allowedRes.statusCode, 200);
  assert.equal(nextCalls, 1);
});

test('representative critical routes resolve to required permissions', () => {
  const expected = [
    ['POST', '/inventory-adjustments/123/post', 'inventory:adjustments:post'],
    ['POST', '/inventory-movements/123/void-transfer', 'inventory:ledger:void'],
    ['POST', '/qc/accept', 'inventory:qc:write'],
    ['PATCH', '/ncrs/123/disposition', 'inventory:qc:write'],
    ['POST', '/purchase-orders/123/approve', 'purchasing:approve'],
    ['POST', '/vendor-invoices/123/approve', 'finance:approve'],
    ['POST', '/work-orders/123/report-production', 'production:post'],
    ['POST', '/shipments/123/post', 'outbound:post'],
    ['POST', '/recalls/cases', 'compliance:admin'],
    ['POST', '/api/cost-layers/consume', 'costlayers:write'],
    ['GET', '/audit-log', 'audit:read']
  ];

  for (const [method, routePath, permission] of expected) {
    assert.equal(findRoutePermission(method, routePath), permission, `${method} ${routePath}`);
  }
});

test('every mounted business write route has an explicit permission rule', async () => {
  const missing = [];
  const routePattern = /router\.(post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/gims;

  for (const [relativePath, mountPrefix] of Object.entries(mountedRouteFiles)) {
    const absolutePath = path.resolve(process.cwd(), relativePath);
    const source = await readFile(absolutePath, 'utf8');
    for (const match of source.matchAll(routePattern)) {
      const method = match[1].toUpperCase();
      const fullPath = joinRoutePath(mountPrefix, match[2]);
      if (!findRoutePermission(method, fullPath)) {
        missing.push(`${method} ${fullPath} (${relativePath})`);
      }
    }
  }

  assert.equal(missing.length, 0, [
    'RBAC_ROUTE_PERMISSION_GUARD_FAILED: every mounted business write route needs an explicit permission rule.',
    ...missing
  ].join('\n'));
});

test('route permission rules only reference declared permissions', () => {
  for (const rule of routePermissionRules) {
    assert.ok(permissions.includes(rule.permission), `${rule.path} references unknown permission ${rule.permission}`);
  }
});

test('destructive script production guard fails closed', () => {
  assert.throws(
    () => assertNonProductionEnvironment('guard-test', { NODE_ENV: 'production' }),
    /refused to run/
  );
  assert.doesNotThrow(() => assertNonProductionEnvironment('guard-test', { NODE_ENV: 'development' }));
});


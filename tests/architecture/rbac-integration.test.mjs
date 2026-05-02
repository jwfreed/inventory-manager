/**
 * RBAC integration tests — Express-level validation.
 *
 * These tests operate entirely in-process (no database, no HTTP server).
 * They exercise the middleware logic directly against mocked req/res objects
 * to validate 401 / 403 / 200 behaviour for both write and sensitive read routes,
 * including prefixed mounts and multi-segment dynamic params.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { findRoutePermission, requireRoutePermission, requirePermission } = require('../../src/middleware/permissions.middleware.ts');
const { hasPermission } = require('../../src/config/permissions.ts');

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
    },
  };
}

function mockReq(method, path, auth) {
  return { method, path, auth };
}

// ── Phase 1: sensitive GET routes resolve to correct permissions ───────────

test('sensitive GET routes resolve to required permissions', () => {
  const expected = [
    // inventory
    ['GET', '/inventory-movements', 'inventory:read'],
    ['GET', '/inventory-movements/window', 'inventory:read'],
    ['GET', '/inventory-movements/uuid-123', 'inventory:read'],
    ['GET', '/inventory-movements/uuid-123/lines', 'inventory:read'],
    ['GET', '/inventory-movements/uuid-123/lots', 'inventory:read'],
    ['GET', '/inventory-adjustments', 'inventory:read'],
    ['GET', '/inventory-adjustments/uuid-123', 'inventory:read'],
    ['GET', '/inventory-counts', 'inventory:read'],
    ['GET', '/inventory-snapshot', 'inventory:read'],
    ['GET', '/inventory-snapshot/summary', 'inventory:read'],
    ['GET', '/inventory/changes', 'inventory:read'],
    ['GET', '/putaways/uuid-123', 'inventory:read'],
    ['GET', '/items/uuid-123/inventory', 'inventory:read'],
    ['GET', '/locations/uuid-123/inventory', 'inventory:read'],
    ['GET', '/lpns', 'inventory:read'],
    ['GET', '/lpns/uuid-123', 'inventory:read'],
    ['GET', '/atp', 'inventory:read'],
    ['GET', '/atp/detail', 'inventory:read'],
    ['GET', '/events', 'inventory:read'],
    ['GET', '/events/clients', 'inventory:read'],
    // purchasing
    ['GET', '/purchase-orders', 'purchasing:read'],
    ['GET', '/purchase-orders/uuid-123', 'purchasing:read'],
    ['GET', '/purchase-order-receipts', 'purchasing:read'],
    ['GET', '/purchase-order-receipts/uuid-123', 'purchasing:read'],
    ['GET', '/purchase-order-receipts/uuid-123/reconciliation', 'purchasing:read'],
    ['GET', '/vendors', 'purchasing:read'],
    ['GET', '/supplier-scorecards', 'purchasing:read'],
    ['GET', '/supplier-scorecards/vendor-abc', 'purchasing:read'],
    ['GET', '/supplier-scorecards/rankings/delivery', 'purchasing:read'],
    ['GET', '/supplier-scorecards/rankings/quality', 'purchasing:read'],
    ['GET', '/supplier-scorecards/issues/quality', 'purchasing:read'],
    ['GET', '/supplier-performance/lead-time-reliability', 'purchasing:read'],
    ['GET', '/supplier-performance/price-variance-trends', 'purchasing:read'],
    ['GET', '/supplier-performance/vendor-fill-rate', 'purchasing:read'],
    ['GET', '/supplier-performance/quality-rate', 'purchasing:read'],
    // finance
    ['GET', '/vendor-invoices', 'finance:read'],
    ['GET', '/vendor-invoices/uuid-123', 'finance:read'],
    ['GET', '/vendor-payments', 'finance:read'],
    ['GET', '/vendor-payments/uuid-123', 'finance:read'],
    ['GET', '/vendors/vendor-abc/unpaid-invoices', 'finance:read'],
    ['GET', '/api/currencies', 'finance:read'],
    ['GET', '/api/exchange-rates', 'finance:read'],
    // production
    ['GET', '/work-orders', 'production:read'],
    ['GET', '/work-orders/uuid-123', 'production:read'],
    ['GET', '/work-orders/uuid-123/requirements', 'production:read'],
    ['GET', '/work-orders/uuid-123/readiness', 'production:read'],
    ['GET', '/work-orders/uuid-123/disassembly-plan', 'production:read'],
    ['GET', '/work-orders/uuid-123/execution', 'production:read'],
    ['GET', '/work-orders/uuid-123/qc-events', 'production:read'],
    ['GET', '/boms/uuid-123', 'production:read'],
    ['GET', '/work-centers', 'production:read'],
    ['GET', '/work-centers/uuid-123', 'production:read'],
    ['GET', '/routings/uuid-123', 'production:read'],
    ['GET', '/production-overview', 'production:read'],
    ['GET', '/production-overview/volume-trend', 'production:read'],
    ['GET', '/production-overview/top-bottom-skus', 'production:read'],
    // outbound
    ['GET', '/sales-orders', 'outbound:read'],
    ['GET', '/sales-orders/uuid-123', 'outbound:read'],
    ['GET', '/reservations', 'outbound:read'],
    ['GET', '/reservations/uuid-123', 'outbound:read'],
    ['GET', '/shipments', 'outbound:read'],
    ['GET', '/shipments/uuid-123', 'outbound:read'],
    ['GET', '/returns', 'outbound:read'],
    ['GET', '/return-receipts', 'outbound:read'],
    ['GET', '/return-dispositions', 'outbound:read'],
    ['GET', '/pick-batches', 'outbound:read'],
    ['GET', '/pick-tasks', 'outbound:read'],
    ['GET', '/shipping-containers', 'outbound:read'],
    ['GET', '/shipping-containers/uuid-123', 'outbound:read'],
    // compliance
    ['GET', '/ncrs', 'compliance:read'],
    ['GET', '/ncrs/uuid-123', 'compliance:read'],
    ['GET', '/lots', 'compliance:read'],
    ['GET', '/lots/uuid-123', 'compliance:read'],
    ['GET', '/recalls/cases', 'compliance:read'],
    ['GET', '/recalls/cases/uuid-123', 'compliance:read'],
    ['GET', '/recalls/cases/uuid-123/targets', 'compliance:read'],
    ['GET', '/recalls/cases/uuid-123/trace-runs', 'compliance:read'],
    ['GET', '/recalls/cases/uuid-123/actions', 'compliance:read'],
    ['GET', '/recalls/cases/uuid-123/communications', 'compliance:read'],
    ['GET', '/recalls/trace-runs/uuid-123', 'compliance:read'],
    ['GET', '/recalls/trace-runs/uuid-123/impacted-shipments', 'compliance:read'],
    ['GET', '/recalls/trace-runs/uuid-123/impacted-lots', 'compliance:read'],
    // master data
    ['GET', '/items', 'masterdata:read'],
    ['GET', '/items/uuid-123', 'masterdata:read'],
    ['GET', '/items/uuid-123/metrics', 'masterdata:read'],
    ['GET', '/locations', 'masterdata:read'],
    ['GET', '/locations/uuid-123', 'masterdata:read'],
    ['GET', '/uoms', 'masterdata:read'],
    // planning
    ['GET', '/mps/plans', 'planning:read'],
    ['GET', '/mps/plans/uuid-123', 'planning:read'],
    ['GET', '/mrp/runs', 'planning:read'],
    ['GET', '/mrp/runs/uuid-123', 'planning:read'],
    ['GET', '/replenishment/policies', 'planning:read'],
    ['GET', '/replenishment/recommendations', 'planning:read'],
    ['GET', '/kpis/runs', 'planning:read'],
    ['GET', '/kpis/snapshots', 'planning:read'],
    ['GET', '/drp/nodes', 'planning:read'],
    ['GET', '/drp/runs', 'planning:read'],
    ['GET', '/drp/runs/uuid-123/planned-transfers', 'planning:read'],
    // reports & metrics
    ['GET', '/reports/inventory-valuation', 'reports:read'],
    ['GET', '/reports/movement-transactions', 'reports:read'],
    ['GET', '/reports/bom-consumption-variance', 'reports:read'],
    ['GET', '/metrics/abc-classification', 'reports:read'],
    ['GET', '/metrics/inventory-aging', 'reports:read'],
    ['GET', '/metrics/cache/stats', 'reports:write'],
    ['GET', '/metrics/job/status', 'reports:write'],
    ['GET', '/api/dashboard/overview', 'reports:read'],
    ['GET', '/api/dashboard/inventory-integrity', 'reports:read'],
    ['GET', '/api/dashboard/system-readiness', 'reports:read'],
    // cost layers
    ['GET', '/api/cost-layers/available', 'costlayers:read'],
    ['GET', '/api/cost-layers/average-cost', 'costlayers:read'],
    ['GET', '/api/cost-layers/cogs', 'costlayers:read'],
    ['GET', '/api/cost-layers/item/item-uuid', 'costlayers:read'],
    ['GET', '/api/cost-layers/layer-uuid/consumptions', 'costlayers:read'],
    ['GET', '/api/items/uuid-123/cost-history', 'costlayers:read'],
  ];

  for (const [method, routePath, permission] of expected) {
    assert.equal(
      findRoutePermission(method, routePath),
      permission,
      `${method} ${routePath} should require ${permission}`
    );
  }
});

// ── Phase 2: dynamic params match across multi-segment routes ─────────────

test('multi-segment dynamic param GET routes resolve correctly', () => {
  assert.equal(findRoutePermission('GET', '/work-orders/uuid-1/issues/uuid-2'), 'production:read');
  assert.equal(findRoutePermission('GET', '/work-orders/uuid-1/completions/uuid-2'), 'production:read');
  assert.equal(findRoutePermission('GET', '/inventory-movement-lines/uuid-1/lots'), 'compliance:read');
  assert.equal(findRoutePermission('GET', '/recalls/trace-runs/uuid-1/impacted-shipments'), 'compliance:read');
  assert.equal(findRoutePermission('GET', '/drp/runs/uuid-1/item-policies'), 'planning:read');
  assert.equal(findRoutePermission('GET', '/mrp/runs/uuid-1/planned-orders'), 'planning:read');
  assert.equal(findRoutePermission('GET', '/mps/plans/uuid-1/plan-lines'), 'planning:read');
});

// ── Phase 2: prefixed mounts resolve with full path ───────────────────────

test('prefixed mount GET routes resolve with full path', () => {
  // /atp prefix
  assert.equal(findRoutePermission('GET', '/atp'), 'inventory:read');
  assert.equal(findRoutePermission('GET', '/atp/detail'), 'inventory:read');
  // /supplier-scorecards prefix
  assert.equal(findRoutePermission('GET', '/supplier-scorecards'), 'purchasing:read');
  assert.equal(findRoutePermission('GET', '/supplier-scorecards/rankings/delivery'), 'purchasing:read');
  // /supplier-performance prefix
  assert.equal(findRoutePermission('GET', '/supplier-performance/lead-time-reliability'), 'purchasing:read');
  // /reports prefix
  assert.equal(findRoutePermission('GET', '/reports/inventory-valuation'), 'reports:read');
  assert.equal(findRoutePermission('GET', '/reports/yield-variance'), 'reports:read');
  // /metrics prefix
  assert.equal(findRoutePermission('GET', '/metrics/turns-doi'), 'reports:read');
  // /api/dashboard prefix
  assert.equal(findRoutePermission('GET', '/api/dashboard/excess-inventory'), 'reports:read');
  assert.equal(findRoutePermission('GET', '/api/dashboard/forecast-accuracy'), 'reports:read');
  // /api/cost-layers prefix
  assert.equal(findRoutePermission('GET', '/api/cost-layers/available'), 'costlayers:read');
  // /api prefix (costs router)
  assert.equal(findRoutePermission('GET', '/api/currencies'), 'finance:read');
  assert.equal(findRoutePermission('GET', '/api/exchange-rates'), 'finance:read');
});

// ── Phase 3: middleware enforces 401 when no auth present ─────────────────

test('requireRoutePermission returns 401 for GET sensitive route with no auth', () => {
  const res = mockResponse();
  let nexted = 0;
  requireRoutePermission(
    mockReq('GET', '/inventory-movements', undefined),
    res,
    () => { nexted += 1; }
  );
  assert.equal(res.statusCode, 401, 'unauthenticated request must be rejected with 401');
  assert.equal(nexted, 0, 'next must not be called');
  assert.match(res.headers['www-authenticate'] ?? '', /Bearer/);
});

// ── Phase 3: middleware enforces 403 when role lacks permission ───────────

test('requireRoutePermission returns 403 when role lacks required GET permission', () => {
  const res = mockResponse();
  let nexted = 0;
  // operator does not have finance:read
  requireRoutePermission(
    mockReq('GET', '/vendor-invoices', { role: 'operator' }),
    res,
    () => { nexted += 1; }
  );
  assert.equal(res.statusCode, 403, 'insufficient permission must yield 403');
  assert.equal(nexted, 0);
});

test('requireRoutePermission returns 403 for supervisor lacking costlayers:read', () => {
  const res = mockResponse();
  let nexted = 0;
  // supervisor does not have costlayers:read
  requireRoutePermission(
    mockReq('GET', '/api/cost-layers/available', { role: 'supervisor' }),
    res,
    () => { nexted += 1; }
  );
  assert.equal(res.statusCode, 403);
  assert.equal(nexted, 0);
});

// ── Phase 3: middleware allows when role has permission ───────────────────

test('requireRoutePermission calls next when operator reads inventory', () => {
  const res = mockResponse();
  let nexted = 0;
  requireRoutePermission(
    mockReq('GET', '/inventory-movements', { role: 'operator' }),
    res,
    () => { nexted += 1; }
  );
  assert.equal(res.statusCode, 200, 'authorized request must not set error status');
  assert.equal(nexted, 1, 'next must be called exactly once');
});

test('requireRoutePermission calls next when manager reads finance', () => {
  const res = mockResponse();
  let nexted = 0;
  requireRoutePermission(
    mockReq('GET', '/vendor-invoices', { role: 'manager' }),
    res,
    () => { nexted += 1; }
  );
  assert.equal(nexted, 1);
});

test('requireRoutePermission calls next when admin reads cost layers', () => {
  const res = mockResponse();
  let nexted = 0;
  requireRoutePermission(
    mockReq('GET', '/api/cost-layers/available', { role: 'admin' }),
    res,
    () => { nexted += 1; }
  );
  assert.equal(nexted, 1);
});

// ── Phase 3: write route enforcement preserved ────────────────────────────

test('requireRoutePermission returns 403 for POST write route without auth', () => {
  const res = mockResponse();
  let nexted = 0;
  requireRoutePermission(
    mockReq('POST', '/inventory-adjustments', undefined),
    res,
    () => { nexted += 1; }
  );
  assert.equal(res.statusCode, 401);
  assert.equal(nexted, 0);
});

test('requireRoutePermission blocks write route for insufficient role', () => {
  const res = mockResponse();
  let nexted = 0;
  // operator lacks inventory:adjustments:write
  requireRoutePermission(
    mockReq('POST', '/inventory-adjustments', { role: 'operator' }),
    res,
    () => { nexted += 1; }
  );
  assert.equal(res.statusCode, 403);
  assert.equal(nexted, 0);
});

test('requireRoutePermission fails closed for unregistered write route', () => {
  const res = mockResponse();
  let nexted = 0;
  requireRoutePermission(
    mockReq('DELETE', '/some-unknown-route', { role: 'admin' }),
    res,
    () => { nexted += 1; }
  );
  assert.equal(res.statusCode, 403, 'unregistered write route must be denied');
  assert.equal(nexted, 0);
});

// ── Phase 5: permission semantics — vendor writes reclassified ────────────

test('vendor writes require masterdata:write not finance:write', () => {
  assert.equal(findRoutePermission('POST', '/vendors'), 'masterdata:write');
  assert.equal(findRoutePermission('PUT', '/vendors/uuid-123'), 'masterdata:write');
  assert.equal(findRoutePermission('DELETE', '/vendors/uuid-123'), 'masterdata:write');
});

test('manager can write vendors via masterdata:write', () => {
  assert.equal(hasPermission('manager', 'masterdata:write'), true);
  assert.equal(hasPermission('supervisor', 'masterdata:write'), false);
  assert.equal(hasPermission('operator', 'masterdata:write'), false);
});

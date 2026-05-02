import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'rbac-express-integration-secret';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const express = require('express');
const request = require('supertest');
const { signAccessToken } = require('../../src/lib/auth.ts');
const { requireAuth } = require('../../src/middleware/auth.middleware.ts');
const { destructiveGuard } = require('../../src/middleware/destructiveGuard.middleware.ts');
const { requireRoutePermission } = require('../../src/middleware/permissions.middleware.ts');

const tenantId = '00000000-0000-0000-0000-000000000001';

function tokenFor(role) {
  return signAccessToken({
    sub: `test-${role}`,
    tenantId,
    role
  });
}

function buildApp(observedRequests = []) {
  const app = express();
  const costLayersRouter = express.Router();

  costLayersRouter.post('/', (req, res) => {
    res.status(201).json({ route: 'cost-layers-root', role: req.auth.role });
  });
  costLayersRouter.post('/consume', (req, res) => {
    res.status(204).send();
  });

  app.use(express.json());
  app.use(requireAuth);
  app.use(destructiveGuard);
  app.use((req, _res, next) => {
    observedRequests.push({
      method: req.method,
      path: req.path,
      originalUrl: req.originalUrl,
      baseUrl: req.baseUrl,
      url: req.url
    });
    next();
  });
  app.use(requireRoutePermission);

  app.post('/inventory-adjustments/:id/post', (req, res) => {
    res.status(204).send();
  });
  app.get('/audit-log', (req, res) => {
    res.status(200).json({ route: 'audit-log', role: req.auth.role });
  });
  app.use('/api/cost-layers', costLayersRouter);
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found.', path: req.path });
  });

  return app;
}

test('Express RBAC returns 401 for unauthenticated protected writes', async () => {
  const app = buildApp();

  const res = await request(app).post('/inventory-adjustments/adj-1/post').send({});

  assert.equal(res.status, 401);
  assert.match(res.headers['www-authenticate'], /^Bearer /);
  assert.equal(res.body.error, 'Missing access token.');
});

test('Express RBAC returns 403 for authenticated users without the required permission', async () => {
  const app = buildApp();

  const res = await request(app)
    .post('/inventory-adjustments/adj-1/post')
    .set('Authorization', `Bearer ${tokenFor('operator')}`)
    .send({});

  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'Insufficient permission.');
  assert.equal(res.body.permission, 'inventory:adjustments:post');
});

test('Express RBAC allows authenticated users with the required permission', async () => {
  const app = buildApp();

  const res = await request(app)
    .post('/inventory-adjustments/adj-1/post')
    .set('Authorization', `Bearer ${tokenFor('manager')}`)
    .send({});

  assert.equal(res.status, 204);
});

test('Express RBAC evaluates mounted /api route prefixes using the real request path', async () => {
  const observedRequests = [];
  const app = buildApp(observedRequests);

  const denied = await request(app)
    .post('/api/cost-layers/consume?lot=LOT-1')
    .set('Authorization', `Bearer ${tokenFor('manager')}`)
    .send({ quantity: 1 });

  assert.equal(denied.status, 403);
  assert.equal(denied.body.permission, 'costlayers:write');
  assert.deepEqual(observedRequests.at(-1), {
    method: 'POST',
    path: '/api/cost-layers/consume',
    originalUrl: '/api/cost-layers/consume?lot=LOT-1',
    baseUrl: '',
    url: '/api/cost-layers/consume?lot=LOT-1'
  });

  const allowed = await request(app)
    .post('/api/cost-layers/consume?lot=LOT-1')
    .set('Authorization', `Bearer ${tokenFor('admin')}`)
    .send({ quantity: 1 });

  assert.equal(allowed.status, 204);
});

test('Express RBAC ignores query strings and accepts normalized trailing slashes', async () => {
  const app = buildApp();

  const adjustment = await request(app)
    .post('/inventory-adjustments/adj-1/post/?source=test')
    .set('Authorization', `Bearer ${tokenFor('manager')}`)
    .send({});

  assert.equal(adjustment.status, 204);

  const mountedRoot = await request(app)
    .post('/api/cost-layers/?source=test')
    .set('Authorization', `Bearer ${tokenFor('admin')}`)
    .send({});

  assert.equal(mountedRoot.status, 201);
  assert.equal(mountedRoot.body.route, 'cost-layers-root');
});

test('Express RBAC lets unknown authenticated GET routes fall through to 404', async () => {
  const app = buildApp();

  const res = await request(app)
    .get('/unknown-report?range=today')
    .set('Authorization', `Bearer ${tokenFor('operator')}`);

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Not found.');
});

test('Express RBAC fails closed for unknown authenticated write routes', async () => {
  const app = buildApp();

  const res = await request(app)
    .post('/unknown-mutation?force=true')
    .set('Authorization', `Bearer ${tokenFor('admin')}`)
    .send({});

  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'No permission rule registered for this write route.');
});

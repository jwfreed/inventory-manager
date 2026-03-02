import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';

async function apiRequest(method, path, { token, body, params, headers } = {}) {
  const url = new URL(baseUrl + path);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  const mergedHeaders = { 'Content-Type': 'application/json', ...(headers ?? {}) };
  if (token) mergedHeaders.Authorization = `Bearer ${token}`;
  const res = await fetch(url.toString(), {
    method,
    headers: mergedHeaders,
    body: body ? JSON.stringify(body) : undefined
  });
  const contentType = res.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await res.json().catch(() => null)
    : await res.text().catch(() => '');
  return { res, payload };
}

async function createItem(token, defaultLocationId, prefix) {
  const sku = `${prefix}-${randomUUID().slice(0, 8)}`;
  const res = await apiRequest('POST', '/items', {
    token,
    body: {
      sku,
      name: `Item ${sku}`,
      type: 'finished',
      defaultUom: 'each',
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId,
      active: true
    }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload.id;
}

test('production areas and routings are tenant-scoped with per-tenant code uniqueness', { timeout: 180000 }, async () => {
  const suffix = randomUUID().slice(0, 8);
  const tenantA = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug: `routing-scope-a-${suffix}`,
    tenantName: 'Routing Scope Tenant A'
  });
  const tenantB = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug: `routing-scope-b-${suffix}`,
    tenantName: 'Routing Scope Tenant B'
  });

  const tokenA = tenantA.accessToken;
  const tokenB = tenantB.accessToken;
  const defaultsA = (await ensureStandardWarehouse({ token: tokenA, apiRequest, scope: import.meta.url })).defaults;
  const defaultsB = (await ensureStandardWarehouse({ token: tokenB, apiRequest, scope: `${import.meta.url}:tenant-b` })).defaults;

  const itemA = await createItem(tokenA, defaultsA.QA.id, 'TENANT-A');
  const itemB = await createItem(tokenB, defaultsB.QA.id, 'TENANT-B');
  const sharedCode = `PA-SHARED-${suffix}`;

  const areaA = await apiRequest('POST', '/work-centers', {
    token: tokenA,
    body: {
      code: sharedCode,
      name: 'Production Area A',
      locationId: defaultsA.QA.id,
      status: 'active'
    }
  });
  assert.equal(areaA.res.status, 201, JSON.stringify(areaA.payload));

  const duplicateSameTenant = await apiRequest('POST', '/work-centers', {
    token: tokenA,
    body: {
      code: sharedCode,
      name: 'Duplicate A',
      locationId: defaultsA.QA.id,
      status: 'active'
    }
  });
  assert.equal(duplicateSameTenant.res.status, 409, JSON.stringify(duplicateSameTenant.payload));

  const areaB = await apiRequest('POST', '/work-centers', {
    token: tokenB,
    body: {
      code: sharedCode,
      name: 'Production Area B',
      locationId: defaultsB.QA.id,
      status: 'active'
    }
  });
  assert.equal(areaB.res.status, 201, JSON.stringify(areaB.payload));

  const crossAreaRead = await apiRequest('GET', `/work-centers/${areaA.payload.id}`, { token: tokenB });
  assert.equal(crossAreaRead.res.status, 404, JSON.stringify(crossAreaRead.payload));

  const routingA = await apiRequest('POST', '/routings', {
    token: tokenA,
    body: {
      itemId: itemA,
      name: 'Default A',
      version: 'v1',
      isDefault: true,
      status: 'active',
      steps: [
        {
          sequenceNumber: 10,
          workCenterId: areaA.payload.id,
          runTimeMinutes: 15,
          setupTimeMinutes: 5,
          machineTimeMinutes: 10
        }
      ]
    }
  });
  assert.equal(routingA.res.status, 201, JSON.stringify(routingA.payload));

  const crossRoutingRead = await apiRequest('GET', `/routings/${routingA.payload.id}`, { token: tokenB });
  assert.equal(crossRoutingRead.res.status, 404, JSON.stringify(crossRoutingRead.payload));

  const routingB = await apiRequest('POST', '/routings', {
    token: tokenB,
    body: {
      itemId: itemB,
      name: 'Default B',
      version: 'v1',
      isDefault: true,
      status: 'active',
      steps: [
        {
          sequenceNumber: 10,
          workCenterId: areaB.payload.id,
          runTimeMinutes: 12,
          setupTimeMinutes: 4,
          machineTimeMinutes: 9
        }
      ]
    }
  });
  assert.equal(routingB.res.status, 201, JSON.stringify(routingB.payload));

  const crossItemList = await apiRequest('GET', `/items/${itemA}/routings`, { token: tokenB });
  assert.equal(crossItemList.res.status, 200, JSON.stringify(crossItemList.payload));
  assert.equal(Array.isArray(crossItemList.payload), true);
  assert.equal(crossItemList.payload.length, 0);
});

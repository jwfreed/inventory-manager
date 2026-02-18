import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ensureSession } from '../api/helpers/ensureSession.mjs';
import { getDbPool } from '../helpers/dbPool.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const {
  getAllEffectiveBomEdges,
  getEffectiveBomLinesForParent
} = require('../../src/services/bomEdges.service.ts');

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = process.env.SEED_TENANT_SLUG || 'default';

async function apiRequest(method, path, { token, body, params } = {}) {
  const url = new URL(baseUrl + path);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url.toString(), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const contentType = res.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const payload = isJson ? await res.json().catch(() => null) : await res.text().catch(() => '');
  return { res, payload };
}

async function getSession() {
  const session = await ensureSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'Phantom BOM Cycle Detection Tenant'
  });
  return session.accessToken;
}

async function createItem(token, defaultLocationId, sku, { isPhantom = false, type = 'wip' } = {}) {
  const res = await apiRequest('POST', '/items', {
    token,
    body: {
      sku,
      name: sku,
      type,
      isPhantom,
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

async function createBom(token, outputItemId, bomCode, components) {
  const res = await apiRequest('POST', '/boms', {
    token,
    body: {
      bomCode,
      outputItemId,
      defaultUom: 'each',
      version: {
        versionNumber: 1,
        yieldQuantity: 1,
        yieldUom: 'each',
        components: components.map((component, index) => ({
          lineNumber: index + 1,
          componentItemId: component.componentItemId,
          uom: 'each',
          quantityPer: component.quantityPer ?? 1
        }))
      }
    }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload;
}

async function activateBomVersion(token, versionId) {
  return activateBomVersionWithRange(token, versionId, {
    effectiveFrom: new Date(Date.now() - 60_000).toISOString()
  });
}

async function activateBomVersionWithRange(token, versionId, { effectiveFrom, effectiveTo } = {}) {
  const res = await apiRequest('POST', `/boms/${versionId}/activate`, {
    token,
    body: {
      effectiveFrom: effectiveFrom ?? new Date(Date.now() - 60_000).toISOString(),
      ...(effectiveTo ? { effectiveTo } : {})
    }
  });
  assert.equal(res.res.status, 200, JSON.stringify(res.payload));
  return res.payload;
}

async function createProductionWorkOrder(token, outputItemId, bomId) {
  const res = await apiRequest('POST', '/work-orders', {
    token,
    body: {
      kind: 'production',
      outputItemId,
      outputUom: 'each',
      quantityPlanned: 1,
      bomId
    }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload;
}

async function assertCycleConflict(payload, expectedCode) {
  assert.ok(payload?.error && typeof payload.error === 'object', JSON.stringify(payload));
  assert.equal(payload.error.code, expectedCode, JSON.stringify(payload));
  assert.equal(typeof payload.error.message, 'string');
  assert.ok(Array.isArray(payload.error.details?.path), JSON.stringify(payload));
  const path = payload.error.details.path;
  assert.ok(path.length >= 2, `expected cycle path length >= 2, got ${path.length}`);
  assert.equal(path[0], path[path.length - 1], `cycle path must start/end at same item: ${JSON.stringify(path)}`);
}

function sumRequiredQuantity(lines, itemId) {
  return lines
    .filter((line) => line.componentItemId === itemId)
    .reduce((sum, line) => sum + Number(line.quantityRequired ?? 0), 0);
}

test('detects simple phantom BOM cycle A -> B -> A with deterministic path', async () => {
  const token = await getSession();
  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:simple-cycle` });
  const sellable = defaults.SELLABLE;
  const unique = Date.now().toString(36);

  const itemA = await createItem(token, sellable.id, `PHC-A-${unique}`, { isPhantom: true });
  const itemB = await createItem(token, sellable.id, `PHC-B-${unique}`, { isPhantom: true });

  const bomA = await createBom(token, itemA, `BOM-A-${unique}`, [{ componentItemId: itemB }]);
  const bomB = await createBom(token, itemB, `BOM-B-${unique}`, [{ componentItemId: itemA }]);
  await activateBomVersion(token, bomA.versions[0].id);
  await activateBomVersion(token, bomB.versions[0].id);

  const wo = await createProductionWorkOrder(token, itemA, bomA.id);
  const reqRes = await apiRequest('GET', `/work-orders/${wo.id}/requirements`, { token });

  assert.equal(reqRes.res.status, 409, JSON.stringify(reqRes.payload));
  await assertCycleConflict(reqRes.payload, 'BOM_CYCLE_DETECTED');
  assert.deepEqual(reqRes.payload.error.details.path, [itemA, itemB, itemA]);
});

test('detects longer phantom BOM cycle A -> B -> C -> A', async () => {
  const token = await getSession();
  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:long-cycle` });
  const sellable = defaults.SELLABLE;
  const unique = `${Date.now().toString(36)}-long`;

  const itemA = await createItem(token, sellable.id, `PHL-A-${unique}`, { isPhantom: true });
  const itemB = await createItem(token, sellable.id, `PHL-B-${unique}`, { isPhantom: true });
  const itemC = await createItem(token, sellable.id, `PHL-C-${unique}`, { isPhantom: true });

  const bomA = await createBom(token, itemA, `BOM-LA-${unique}`, [{ componentItemId: itemB }]);
  const bomB = await createBom(token, itemB, `BOM-LB-${unique}`, [{ componentItemId: itemC }]);
  const bomC = await createBom(token, itemC, `BOM-LC-${unique}`, [{ componentItemId: itemA }]);
  await activateBomVersion(token, bomA.versions[0].id);
  await activateBomVersion(token, bomB.versions[0].id);
  await activateBomVersion(token, bomC.versions[0].id);

  const wo = await createProductionWorkOrder(token, itemA, bomA.id);
  const reqRes = await apiRequest('GET', `/work-orders/${wo.id}/requirements`, { token });

  assert.equal(reqRes.res.status, 409, JSON.stringify(reqRes.payload));
  await assertCycleConflict(reqRes.payload, 'BOM_CYCLE_DETECTED');
  assert.deepEqual(reqRes.payload.error.details.path, [itemA, itemB, itemC, itemA]);
});

test('expands non-cyclic phantom chain successfully', async () => {
  const token = await getSession();
  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:non-cycle` });
  const sellable = defaults.SELLABLE;
  const unique = `${Date.now().toString(36)}-ok`;

  const itemA = await createItem(token, sellable.id, `PHN-A-${unique}`, { isPhantom: true });
  const itemB = await createItem(token, sellable.id, `PHN-B-${unique}`, { isPhantom: true });
  const itemC = await createItem(token, sellable.id, `PHN-C-${unique}`, { isPhantom: false, type: 'raw' });

  const bomA = await createBom(token, itemA, `BOM-NA-${unique}`, [{ componentItemId: itemB }]);
  const bomB = await createBom(token, itemB, `BOM-NB-${unique}`, [{ componentItemId: itemC }]);
  await activateBomVersion(token, bomA.versions[0].id);
  await activateBomVersion(token, bomB.versions[0].id);

  const wo = await createProductionWorkOrder(token, itemA, bomA.id);
  const reqRes = await apiRequest('GET', `/work-orders/${wo.id}/requirements`, { token });

  assert.equal(reqRes.res.status, 200, JSON.stringify(reqRes.payload));
  assert.ok(Array.isArray(reqRes.payload.lines), JSON.stringify(reqRes.payload));
  assert.equal(reqRes.payload.lines.length, 1, JSON.stringify(reqRes.payload));
  assert.equal(reqRes.payload.lines[0].componentItemId, itemC);
});

test('DAG reuse expands shared subassembly on both branches (no visited-skip undercount)', async () => {
  const token = await getSession();
  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:dag-reuse` });
  const sellable = defaults.SELLABLE;
  const unique = `${Date.now().toString(36)}-dag`;

  const itemA = await createItem(token, sellable.id, `PHDAG-A-${unique}`, { isPhantom: true });
  const itemB = await createItem(token, sellable.id, `PHDAG-B-${unique}`, { isPhantom: true });
  const itemC = await createItem(token, sellable.id, `PHDAG-C-${unique}`, { isPhantom: true });
  const itemX = await createItem(token, sellable.id, `PHDAG-X-${unique}`, { isPhantom: false, type: 'raw' });

  const bomA = await createBom(token, itemA, `BOM-DAG-A-${unique}`, [
    { componentItemId: itemB },
    { componentItemId: itemC }
  ]);
  const bomB = await createBom(token, itemB, `BOM-DAG-B-${unique}`, [{ componentItemId: itemX }]);
  const bomC = await createBom(token, itemC, `BOM-DAG-C-${unique}`, [{ componentItemId: itemX }]);
  await activateBomVersion(token, bomA.versions[0].id);
  await activateBomVersion(token, bomB.versions[0].id);
  await activateBomVersion(token, bomC.versions[0].id);

  const wo = await createProductionWorkOrder(token, itemA, bomA.id);
  const reqRes = await apiRequest('GET', `/work-orders/${wo.id}/requirements`, { token });

  assert.equal(reqRes.res.status, 200, JSON.stringify(reqRes.payload));
  assert.ok(Array.isArray(reqRes.payload.lines), JSON.stringify(reqRes.payload));
  const xTotal = sumRequiredQuantity(reqRes.payload.lines, itemX);
  assert.ok(Math.abs(xTotal - 2) < 1e-6, `expected X total requirement 2, got ${xTotal}`);
});

test('phantom semantics: recurse only when component item is marked phantom', async () => {
  const token = await getSession();
  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:phantom-semantics` });
  const sellable = defaults.SELLABLE;
  const unique = `${Date.now().toString(36)}-sem`;

  const itemA = await createItem(token, sellable.id, `PHSEM-A-${unique}`, { isPhantom: true });
  const itemB = await createItem(token, sellable.id, `PHSEM-B-${unique}`, { isPhantom: false, type: 'wip' });
  const itemC = await createItem(token, sellable.id, `PHSEM-C-${unique}`, { isPhantom: true, type: 'wip' });
  const itemY = await createItem(token, sellable.id, `PHSEM-Y-${unique}`, { isPhantom: false, type: 'raw' });
  const itemZ = await createItem(token, sellable.id, `PHSEM-Z-${unique}`, { isPhantom: false, type: 'raw' });

  const bomA = await createBom(token, itemA, `BOM-SEM-A-${unique}`, [
    { componentItemId: itemB },
    { componentItemId: itemC }
  ]);
  const bomB = await createBom(token, itemB, `BOM-SEM-B-${unique}`, [{ componentItemId: itemY }]);
  const bomC = await createBom(token, itemC, `BOM-SEM-C-${unique}`, [{ componentItemId: itemZ }]);
  await activateBomVersion(token, bomA.versions[0].id);
  await activateBomVersion(token, bomB.versions[0].id);
  await activateBomVersion(token, bomC.versions[0].id);

  const wo = await createProductionWorkOrder(token, itemA, bomA.id);
  const reqRes = await apiRequest('GET', `/work-orders/${wo.id}/requirements`, { token });

  assert.equal(reqRes.res.status, 200, JSON.stringify(reqRes.payload));
  assert.ok(Array.isArray(reqRes.payload.lines), JSON.stringify(reqRes.payload));
  const bTotal = sumRequiredQuantity(reqRes.payload.lines, itemB);
  const yTotal = sumRequiredQuantity(reqRes.payload.lines, itemY);
  const zTotal = sumRequiredQuantity(reqRes.payload.lines, itemZ);
  assert.ok(Math.abs(bTotal - 1) < 1e-6, `expected non-phantom B to remain direct requirement, got ${bTotal}`);
  assert.ok(Math.abs(yTotal) < 1e-6, `expected no recursion into non-phantom B BOM, got Y=${yTotal}`);
  assert.ok(Math.abs(zTotal - 1) < 1e-6, `expected recursion into phantom C BOM, got Z=${zTotal}`);
});

test('effective BOM edge selection parity: runtime parent lines and at-rest edges match for same asOf', async () => {
  const session = await ensureSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'Phantom BOM Cycle Detection Tenant'
  });
  const token = session.accessToken;
  const db = getDbPool();
  const tenantId = session.tenant?.id
    ?? (await apiRequest('GET', '/auth/me', { token })).payload?.tenant?.id
    ?? null;
  assert.ok(token);
  assert.ok(tenantId);
  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:edge-parity` });
  const sellable = defaults.SELLABLE;
  const unique = `${Date.now().toString(36)}-parity`;

  const parent = await createItem(token, sellable.id, `PHEP-P-${unique}`, { isPhantom: true });
  const oldPhantom = await createItem(token, sellable.id, `PHEP-OLD-${unique}`, { isPhantom: true, type: 'wip' });
  const currentPhantom = await createItem(token, sellable.id, `PHEP-CUR-${unique}`, { isPhantom: true, type: 'wip' });
  const currentRaw = await createItem(token, sellable.id, `PHEP-RAW-${unique}`, { isPhantom: false, type: 'raw' });

  const oldBom = await createBom(token, parent, `BOM-PHEP-OLD-${unique}`, [{ componentItemId: oldPhantom }]);
  const currentBom = await createBom(token, parent, `BOM-PHEP-CUR-${unique}`, [
    { componentItemId: currentPhantom },
    { componentItemId: currentRaw }
  ]);

  const oldFrom = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const oldTo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  await activateBomVersionWithRange(token, oldBom.versions[0].id, { effectiveFrom: oldFrom, effectiveTo: oldTo });
  await activateBomVersion(token, currentBom.versions[0].id);

  const asOfIso = new Date().toISOString();
  const parentEffective = await getEffectiveBomLinesForParent(db, tenantId, parent, asOfIso);
  assert.ok(parentEffective, 'expected effective BOM for parent');
  const phantomFromParent = parentEffective.components
    .filter((line) => line.componentIsPhantom)
    .map((line) => `${line.componentItemId}:${line.id}`)
    .sort();

  const allEdges = await getAllEffectiveBomEdges(db, tenantId, asOfIso);
  const allForParent = allEdges
    .filter((edge) => edge.parentItemId === parent)
    .map((edge) => `${edge.componentItemId}:${edge.lineId}`)
    .sort();

  assert.deepEqual(allForParent, phantomFromParent, JSON.stringify({ allForParent, phantomFromParent }));
  assert.equal(
    allForParent.some((key) => key.startsWith(`${oldPhantom}:`)),
    false,
    `expired BOM edge should not be included: ${JSON.stringify(allForParent)}`
  );
});

test('fails with deterministic max-depth guard for very deep phantom chains', async () => {
  const token = await getSession();
  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:depth-guard` });
  const sellable = defaults.SELLABLE;
  const unique = `${Date.now().toString(36)}-depth`;

  const phantomIds = [];
  for (let i = 0; i < 22; i += 1) {
    const itemId = await createItem(token, sellable.id, `PHD-${i}-${unique}`, { isPhantom: true });
    phantomIds.push(itemId);
  }
  const leafItemId = await createItem(token, sellable.id, `PHD-LEAF-${unique}`, { isPhantom: false, type: 'raw' });

  const boms = [];
  for (let i = 0; i < phantomIds.length; i += 1) {
    const childId = i === phantomIds.length - 1 ? leafItemId : phantomIds[i + 1];
    const bom = await createBom(
      token,
      phantomIds[i],
      `BOM-D-${i}-${unique}`,
      [{ componentItemId: childId }]
    );
    boms.push(bom);
  }
  for (const bom of boms) {
    await activateBomVersion(token, bom.versions[0].id);
  }

  const wo = await createProductionWorkOrder(token, phantomIds[0], boms[0].id);
  const reqRes = await apiRequest('GET', `/work-orders/${wo.id}/requirements`, { token });

  assert.equal(reqRes.res.status, 409, JSON.stringify(reqRes.payload));
  assert.equal(reqRes.payload?.error?.code, 'BOM_MAX_DEPTH_EXCEEDED', JSON.stringify(reqRes.payload));
  assert.equal(typeof reqRes.payload?.error?.message, 'string');
  const details = reqRes.payload?.error?.details;
  assert.ok(details && typeof details === 'object', JSON.stringify(reqRes.payload));
  assert.equal(typeof details.maxDepth, 'number');
  assert.equal(typeof details.currentDepth, 'number');
  assert.equal(typeof details.maxDepthSource, 'string');
  assert.ok(Array.isArray(details.pathSample), JSON.stringify(reqRes.payload));
  assert.ok(details.pathSample.length >= 2, JSON.stringify(reqRes.payload));
  if (details.pathTruncated) {
    assert.equal(details.pathTruncated, true);
  } else {
    assert.ok(Array.isArray(details.path), JSON.stringify(reqRes.payload));
  }
});

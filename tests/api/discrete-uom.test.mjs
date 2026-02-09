import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { ensureSession } from './helpers/ensureSession.mjs';
import { ensureStandardWarehouse } from './helpers/warehouse-bootstrap.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '')
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com'
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local'
const tenantSlug = process.env.SEED_TENANT_SLUG || 'default'

async function apiRequest(method, path, { token, body, params } = {}) {
  const url = new URL(baseUrl + path)
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue
      url.searchParams.set(key, String(value))
    }
  }
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(url.toString(), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const contentType = res.headers.get('content-type') || ''
  const isJson = contentType.includes('application/json')
  const payload = isJson ? await res.json().catch(() => null) : await res.text().catch(() => '')
  return { res, payload }
}

async function getSession() {
  const session = await ensureSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug: tenantSlug,
    tenantName: 'Discrete UOM Tenant'
  });
  return session.accessToken;
}

test('count items reject fractional quantities on posting', async () => {
  const token = await getSession()
  const unique = Date.now()

  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url})
  const locationId = defaults.SELLABLE.id

  const itemRes = await apiRequest('POST', '/items', {
    token,
    body: {
      sku: `DISC-ITEM-${unique}`,
      name: 'Discrete UOM Item',
      type: 'finished',
      defaultUom: 'each',
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId: locationId,
    },
  })
  assert.equal(itemRes.res.status, 201)

  const adjustmentRes = await apiRequest('POST', '/inventory-adjustments', {
    token,
    body: {
      occurredAt: new Date().toISOString(),
      notes: 'Fractional count adjustment',
      lines: [
        {
          lineNumber: 1,
          itemId: itemRes.payload.id,
          locationId: locationId,
          uom: 'each',
          quantityDelta: 1.5,
          reasonCode: 'correction',
        },
      ],
    },
  })
  assert.equal(adjustmentRes.res.status, 201)
  const adjustmentId = adjustmentRes.payload.id

  const postRes = await apiRequest('POST', `/inventory-adjustments/${adjustmentId}/post`, { token, body: {} })
  assert.equal(postRes.res.status, 400)
  assert.equal(postRes.payload?.error?.code, 'DISCRETE_UOM_REQUIRES_INTEGER')

  const getRes = await apiRequest('GET', `/inventory-adjustments/${adjustmentId}`, { token })
  assert.equal(getRes.res.status, 200)
  assert.equal(getRes.payload.inventoryMovementId, null)
})

test('count items accept whole number quantities on posting', async () => {
  const token = await getSession()
  const unique = Date.now()

  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url})
  const locationId = defaults.SELLABLE.id

  const itemRes = await apiRequest('POST', '/items', {
    token,
    body: {
      sku: `DISC-ITEM-WHOLE-${unique}`,
      name: 'Discrete UOM Item Whole',
      type: 'finished',
      defaultUom: 'each',
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId: locationId,
    },
  })
  assert.equal(itemRes.res.status, 201)

  const adjustmentRes = await apiRequest('POST', '/inventory-adjustments', {
    token,
    body: {
      occurredAt: new Date().toISOString(),
      notes: 'Whole count adjustment',
      lines: [
        {
          lineNumber: 1,
          itemId: itemRes.payload.id,
          locationId: locationId,
          uom: 'each',
          quantityDelta: 2,
          reasonCode: 'correction',
        },
      ],
    },
  })
  assert.equal(adjustmentRes.res.status, 201)
  const adjustmentId = adjustmentRes.payload.id

  const postRes = await apiRequest('POST', `/inventory-adjustments/${adjustmentId}/post`, { token, body: {} })
  assert.equal(postRes.res.status, 200)
})

test('mass items allow fractional quantities on posting', async () => {
  const token = await getSession()
  const unique = Date.now()

  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url})
  const locationId = defaults.SELLABLE.id

  const itemRes = await apiRequest('POST', '/items', {
    token,
    body: {
      sku: `DISC-ITEM-MASS-${unique}`,
      name: 'Mass Item',
      type: 'raw',
      defaultUom: 'g',
      uomDimension: 'mass',
      canonicalUom: 'g',
      stockingUom: 'g',
      defaultLocationId: locationId,
    },
  })
  assert.equal(itemRes.res.status, 201)

  const adjustmentRes = await apiRequest('POST', '/inventory-adjustments', {
    token,
    body: {
      occurredAt: new Date().toISOString(),
      notes: 'Fractional mass adjustment',
      lines: [
        {
          lineNumber: 1,
          itemId: itemRes.payload.id,
          locationId: locationId,
          uom: 'g',
          quantityDelta: 1.5,
          reasonCode: 'correction',
        },
      ],
    },
  })
  assert.equal(adjustmentRes.res.status, 201)
  const adjustmentId = adjustmentRes.payload.id

  const postRes = await apiRequest('POST', `/inventory-adjustments/${adjustmentId}/post`, { token, body: {} })
  assert.equal(postRes.res.status, 200)
})

test('count UOM conversions require integer factors', async () => {
  const token = await getSession()
  const unique = Date.now()

  const itemRes = await apiRequest('POST', '/items', {
    token,
    body: {
      sku: `DISC-ITEM-CONV-${unique}`,
      name: 'Count conversion item',
      type: 'packaging',
      defaultUom: 'each',
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
    },
  })
  assert.equal(itemRes.res.status, 201)

  const conversionRes = await apiRequest('POST', `/items/${itemRes.payload.id}/uom-conversions`, {
    token,
    body: { fromUom: 'each', toUom: 'case', factor: 0.5 },
  })
  assert.equal(conversionRes.res.status, 400)
  assert.equal(conversionRes.payload?.error?.code, 'COUNT_CONVERSION_FACTOR_MUST_BE_INTEGER')
})

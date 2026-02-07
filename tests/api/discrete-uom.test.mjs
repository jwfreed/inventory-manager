import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '')
const adminEmail = process.env.SEED_ADMIN_EMAIL || `ci-admin+${randomUUID().slice(0,8)}@example.com`
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local'
const tenantSlug = process.env.SEED_TENANT_SLUG || `default-${randomUUID().slice(0,8)}`

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

async function ensureSession() {
  const bootstrap = await apiRequest('POST', '/auth/bootstrap', {
    body: {
      adminEmail,
      adminPassword,
      tenantSlug,
      tenantName: 'Discrete UOM Tenant',
    },
  })
  if (bootstrap.res.ok) return bootstrap.payload.accessToken
  assert.equal(bootstrap.res.status, 409)

  const login = await apiRequest('POST', '/auth/login', {
    body: { email: adminEmail, password: adminPassword, tenantSlug },
  })
  assert.equal(login.res.status, 200)
  return login.payload.accessToken
}

test('count items reject fractional quantities on posting', async () => {
  const token = await ensureSession()
  const unique = Date.now()

  const locationRes = await apiRequest('POST', '/locations', {
    token,
    body: { code: `DISC-LOC-${unique}`, name: 'Discrete UOM Location', type: 'warehouse', active: true },
  })
  assert.equal(locationRes.res.status, 201)

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
      defaultLocationId: locationRes.payload.id,
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
          locationId: locationRes.payload.id,
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
  const token = await ensureSession()
  const unique = Date.now()

  const locationRes = await apiRequest('POST', '/locations', {
    token,
    body: { code: `DISC-LOC-WHOLE-${unique}`, name: 'Discrete UOM Location Whole', type: 'warehouse', active: true },
  })
  assert.equal(locationRes.res.status, 201)

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
      defaultLocationId: locationRes.payload.id,
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
          locationId: locationRes.payload.id,
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
  const token = await ensureSession()
  const unique = Date.now()

  const locationRes = await apiRequest('POST', '/locations', {
    token,
    body: { code: `DISC-LOC-MASS-${unique}`, name: 'Mass Location', type: 'warehouse', active: true },
  })
  assert.equal(locationRes.res.status, 201)

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
      defaultLocationId: locationRes.payload.id,
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
          locationId: locationRes.payload.id,
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
  const token = await ensureSession()
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

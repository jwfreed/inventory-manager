import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

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

async function ensureSession() {
  const bootstrap = await apiRequest('POST', '/auth/bootstrap', {
    body: {
      adminEmail,
      adminPassword,
      tenantSlug,
      tenantName: 'Negative Stock Tenant',
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

test('posting work order issue and batch blocks on insufficient usable stock', async () => {
  const token = await ensureSession()
  assert.ok(token)
  const unique = Date.now()

  const locationRes = await apiRequest('POST', '/locations', {
    token,
    body: { code: `NEG-LOC-${unique}`, name: 'Negative Test Location', type: 'warehouse', active: true },
  })
  assert.equal(locationRes.res.status, 201)
  const locationId = locationRes.payload.id

  const itemRes = await apiRequest('POST', '/items', {
    token,
    body: {
      sku: `NEG-ITEM-${unique}`,
      name: 'Negative Test Item',
      type: 'finished',
      defaultUom: 'each',
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId: locationId,
      active: true,
    },
  })
  assert.equal(itemRes.res.status, 201)
  const itemId = itemRes.payload.id

  const workOrderRes = await apiRequest('POST', '/work-orders', {
    token,
    body: {
      kind: 'disassembly',
      outputItemId: itemId,
      outputUom: 'each',
      quantityPlanned: 10,
      description: 'Negative stock disassembly test',
    },
  })
  assert.equal(workOrderRes.res.status, 201)
  const workOrderId = workOrderRes.payload.id

  const issueRes = await apiRequest('POST', `/work-orders/${workOrderId}/issues`, {
    token,
    body: {
      occurredAt: new Date().toISOString(),
      notes: 'Issue test',
      lines: [
        { componentItemId: itemId, fromLocationId: locationId, uom: 'each', quantityIssued: 5 },
      ],
    },
  })
  assert.equal(issueRes.res.status, 201)
  const issueId = issueRes.payload.id

  const postIssueRes = await apiRequest('POST', `/work-orders/${workOrderId}/issues/${issueId}/post`, {
    token,
    body: {},
  })
  assert.equal(postIssueRes.res.status, 409)
  assert.equal(postIssueRes.payload?.error?.code, 'INSUFFICIENT_STOCK')

  const batchRes = await apiRequest('POST', `/work-orders/${workOrderId}/record-batch`, {
    token,
    body: {
      occurredAt: new Date().toISOString(),
      notes: 'Batch test',
      consumeLines: [
        { componentItemId: itemId, fromLocationId: locationId, uom: 'each', quantity: 5 },
      ],
      produceLines: [
        { outputItemId: itemId, toLocationId: locationId, uom: 'each', quantity: 5 },
      ],
    },
  })
  assert.equal(batchRes.res.status, 409)
  assert.equal(batchRes.payload?.error?.code, 'INSUFFICIENT_STOCK')

  const overrideAllowed = Boolean(batchRes.payload?.error?.details?.overrideAllowed)
  if (overrideAllowed) {
    const overrideRes = await apiRequest('POST', `/work-orders/${workOrderId}/record-batch`, {
      token,
      body: {
        occurredAt: new Date().toISOString(),
        notes: 'Batch override test',
        overrideNegative: true,
        overrideReason: 'Testing negative override',
        consumeLines: [
          { componentItemId: itemId, fromLocationId: locationId, uom: 'each', quantity: 5 },
        ],
        produceLines: [
          { outputItemId: itemId, toLocationId: locationId, uom: 'each', quantity: 5 },
        ],
      },
    })
    assert.equal(overrideRes.res.status, 201)
    assert.ok(overrideRes.payload?.issueMovementId)
  }
})

test('posting negative inventory adjustment blocks on insufficient stock', async () => {
  const token = await ensureSession()
  assert.ok(token)
  const unique = Date.now()

  const locationRes = await apiRequest('POST', '/locations', {
    token,
    body: { code: `NEG-LOC-ADJ-${unique}`, name: 'Negative Adj Location', type: 'warehouse', active: true },
  })
  assert.equal(locationRes.res.status, 201)
  const locationId = locationRes.payload.id

  const itemRes = await apiRequest('POST', '/items', {
    token,
    body: {
      sku: `NEG-ITEM-ADJ-${unique}`,
      name: 'Negative Adjustment Item',
      type: 'raw',
      defaultUom: 'each',
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId: locationId,
      active: true,
    },
  })
  assert.equal(itemRes.res.status, 201)
  const itemId = itemRes.payload.id

  const adjustmentRes = await apiRequest('POST', '/inventory-adjustments', {
    token,
    body: {
      occurredAt: new Date().toISOString(),
      notes: 'Negative adjustment test',
      lines: [
        {
          lineNumber: 1,
          itemId,
          locationId,
          uom: 'each',
          quantityDelta: -5,
          reasonCode: 'shrinkage',
        },
      ],
    },
  })
  assert.equal(adjustmentRes.res.status, 201)
  const adjustmentId = adjustmentRes.payload.id

  const postRes = await apiRequest('POST', `/inventory-adjustments/${adjustmentId}/post`, {
    token,
    body: {},
  })
  assert.equal(postRes.res.status, 409)
  assert.equal(postRes.payload?.error?.code, 'INSUFFICIENT_STOCK')
})

test('reservation creates backorder when insufficient on-hand', async () => {
  const token = await ensureSession()
  assert.ok(token)
  const unique = Date.now()

  const locationRes = await apiRequest('POST', '/locations', {
    token,
    body: { code: `NEG-LOC-BO-${unique}`, name: 'Negative Backorder Location', type: 'warehouse', active: true },
  })
  assert.equal(locationRes.res.status, 201)
  const locationId = locationRes.payload.id

  const itemRes = await apiRequest('POST', '/items', {
    token,
    body: {
      sku: `NEG-ITEM-BO-${unique}`,
      name: 'Negative Backorder Item',
      type: 'finished',
      defaultUom: 'each',
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId: locationId,
      active: true,
    },
  })
  assert.equal(itemRes.res.status, 201)
  const itemId = itemRes.payload.id

  const reservationsRes = await apiRequest('POST', '/reservations', {
    token,
    body: {
      reservations: [
        {
          demandType: 'sales_order_line',
          demandId: randomUUID(),
          itemId,
          locationId,
          uom: 'each',
          quantityReserved: 7,
        },
      ],
    },
  })
  assert.equal(reservationsRes.res.status, 201)

  const snapshotRes = await apiRequest('GET', '/inventory-snapshot', {
    token,
    params: { itemId, locationId },
  })
  assert.equal(snapshotRes.res.status, 200)
  const row = snapshotRes.payload?.data?.find((entry) => entry.uom === 'each')
  assert.ok(row)
  assert.equal(Number(row.onHand ?? 0), 0)
  assert.equal(Number(row.backordered ?? 0), 7)
})

test('inventory snapshot aggregates canonical quantities with UOM conversion', async () => {
  const token = await ensureSession()
  assert.ok(token)
  const unique = Date.now()

  const locationRes = await apiRequest('POST', '/locations', {
    token,
    body: { code: `NEG-LOC-UOM-${unique}`, name: 'Negative UOM Location', type: 'warehouse', active: true },
  })
  assert.equal(locationRes.res.status, 201)
  const locationId = locationRes.payload.id

  const itemRes = await apiRequest('POST', '/items', {
    token,
    body: {
      sku: `NEG-ITEM-UOM-${unique}`,
      name: 'Negative UOM Item',
      type: 'raw',
      defaultUom: 'g',
      uomDimension: 'mass',
      canonicalUom: 'g',
      stockingUom: 'g',
      defaultLocationId: locationId,
      active: true,
    },
  })
  assert.equal(itemRes.res.status, 201)
  const itemId = itemRes.payload.id

  const conversionRes = await apiRequest('POST', `/items/${itemId}/uom-conversions`, {
    token,
    body: { fromUom: 'kg', toUom: 'g', factor: 1000 },
  })
  assert.equal(conversionRes.res.status, 201)

  const adjustmentRes = await apiRequest('POST', '/inventory-adjustments', {
    token,
    body: {
      occurredAt: new Date().toISOString(),
      notes: 'UOM conversion test',
      lines: [
        {
          lineNumber: 1,
          itemId,
          locationId,
          uom: 'kg',
          quantityDelta: 1,
          reasonCode: 'correction',
        },
      ],
    },
  })
  assert.equal(adjustmentRes.res.status, 201)
  const adjustmentId = adjustmentRes.payload.id

  const postRes = await apiRequest('POST', `/inventory-adjustments/${adjustmentId}/post`, {
    token,
    body: {},
  })
  assert.equal(postRes.res.status, 200)

  const snapshotRes = await apiRequest('GET', '/inventory-snapshot', {
    token,
    params: { itemId, locationId, uom: 'g' },
  })
  assert.equal(snapshotRes.res.status, 200)
  const row = snapshotRes.payload?.data?.find((entry) => entry.uom === 'g')
  assert.ok(row)
  assert.equal(Number(row.onHand ?? 0), 1000)
})

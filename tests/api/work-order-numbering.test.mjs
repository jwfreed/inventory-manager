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
    tenantName: 'Work Order Numbering Tenant'
  });
  return session.accessToken;
}

test('work orders get sequential identifiers and ignore client-supplied numbers', async () => {
  const token = await getSession()
  assert.ok(token)
  const unique = Date.now()

  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url})
  const locationId = defaults.SELLABLE.id

  const itemRes = await apiRequest('POST', '/items', {
    token,
    body: {
      sku: `WO-ITEM-${unique}`,
      name: 'WO Numbering Item',
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

  const overrideNumber = `WO-OVERRIDE-${unique}`
  const woARes = await apiRequest('POST', '/work-orders', {
    token,
    body: {
      workOrderNumber: overrideNumber,
      kind: 'disassembly',
      outputItemId: itemRes.payload.id,
      outputUom: 'each',
      quantityPlanned: 1,
      description: 'First numbering test',
    },
  })
  assert.equal(woARes.res.status, 201)
  const woA = woARes.payload
  assert.match(woA.number, /^WO-\d{6}$/)
  assert.notEqual(woA.number, overrideNumber)

  const woBRes = await apiRequest('POST', '/work-orders', {
    token,
    body: {
      kind: 'disassembly',
      outputItemId: itemRes.payload.id,
      outputUom: 'each',
      quantityPlanned: 1,
      description: 'Second numbering test',
    },
  })
  assert.equal(woBRes.res.status, 201)
  const woB = woBRes.payload
  assert.match(woB.number, /^WO-\d{6}$/)
  assert.notEqual(woB.number, woA.number)

  const woANum = Number(woA.number.replace('WO-', ''))
  const woBNum = Number(woB.number.replace('WO-', ''))
  assert.ok(Number.isFinite(woANum) && Number.isFinite(woBNum))
  assert.ok(woBNum > woANum)

  const patchRes = await apiRequest('PATCH', `/work-orders/${woA.id}`, {
    token,
    body: {
      description: 'Updated description',
      number: 'WO-000000',
    },
  })
  assert.equal(patchRes.res.status, 200)
  assert.equal(patchRes.payload.number, woA.number)
  assert.equal(patchRes.payload.description, 'Updated description')
})

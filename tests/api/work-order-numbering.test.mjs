import test from 'node:test'
import assert from 'node:assert/strict'

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
      tenantName: 'Work Order Numbering Tenant',
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

test('work orders get sequential identifiers and ignore client-supplied numbers', async () => {
  const token = await ensureSession()
  assert.ok(token)
  const unique = Date.now()

  const locationRes = await apiRequest('POST', '/locations', {
    token,
    body: { code: `WO-LOC-${unique}`, name: 'WO Numbering Location', type: 'warehouse', active: true },
  })
  assert.equal(locationRes.res.status, 201)

  const itemRes = await apiRequest('POST', '/items', {
    token,
    body: {
      sku: `WO-ITEM-${unique}`,
      name: 'WO Numbering Item',
      type: 'finished',
      defaultUom: 'ea',
      defaultLocationId: locationRes.payload.id,
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
      outputUom: 'ea',
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
      outputUom: 'ea',
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

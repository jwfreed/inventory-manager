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
      tenantName: 'Phase0 Tenant',
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

test('auth works and purchase orders list is reachable', async () => {
  const token = await ensureSession()
  assert.ok(token)
  const { res, payload } = await apiRequest('GET', '/purchase-orders', { token, params: { limit: 5 } })
  assert.equal(res.status, 200)
  assert.ok(payload && typeof payload === 'object')
})

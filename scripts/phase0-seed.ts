type SeedConfig = {
  baseUrl: string
  prefix: string
  adminEmail: string
  adminPassword: string
  tenantSlug: string
}

type ApiError = Error & { status?: number; details?: unknown }

type Session = { accessToken: string }

type Item = { id: string; sku: string; name: string }

type Location = { id: string; code: string; name: string; type: string }

type Vendor = { id: string; code: string; name: string }

type PurchaseOrder = { id: string; poNumber?: string; po_number?: string }

type PurchaseOrderLine = { id: string; itemId: string; uom: string; quantityOrdered: number }

function loadConfig(): SeedConfig {
  const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '')
  const prefix = process.env.SEED_PREFIX || 'PHASE0'
  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@example.com'
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!'
  const tenantSlug = process.env.SEED_TENANT_SLUG || 'default'
  return { baseUrl, prefix, adminEmail, adminPassword, tenantSlug }
}

function toApiError(err: unknown): ApiError {
  if (err instanceof Error) return err as ApiError
  return new Error(String(err)) as ApiError
}

async function apiRequest<T>(
  config: SeedConfig,
  method: 'GET' | 'POST',
  path: string,
  opts: { token?: string; params?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
): Promise<T> {
  const url = new URL(config.baseUrl + path)
  if (opts.params) {
    for (const [key, value] of Object.entries(opts.params)) {
      if (value === undefined) continue
      url.searchParams.set(key, String(value))
    }
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: method === 'POST' ? JSON.stringify(opts.body ?? {}) : undefined,
  })

  const contentType = res.headers.get('content-type') || ''
  const isJson = contentType.includes('application/json')
  const payload = isJson ? await res.json().catch(() => null) : await res.text().catch(() => '')

  if (!res.ok) {
    const message =
      (payload && typeof payload === 'object' && 'error' in (payload as any) && String((payload as any).error)) ||
      (typeof payload === 'string' && payload) ||
      res.statusText ||
      `HTTP ${res.status}`
    const err = new Error(message) as ApiError
    err.status = res.status
    err.details = payload
    throw err
  }

  return payload as T
}

async function ensureSession(config: SeedConfig): Promise<string> {
  try {
    const session = await apiRequest<Session>(config, 'POST', '/auth/bootstrap', {
      body: {
        adminEmail: config.adminEmail,
        adminPassword: config.adminPassword,
        tenantSlug: config.tenantSlug,
        tenantName: `${config.prefix} Tenant`,
      },
    })
    return session.accessToken
  } catch (err) {
    const e = toApiError(err)
    if (e.status !== 409) throw err
  }

  const session = await apiRequest<Session>(config, 'POST', '/auth/login', {
    body: {
      email: config.adminEmail,
      password: config.adminPassword,
      tenantSlug: config.tenantSlug,
    },
  })
  return session.accessToken
}

async function findItemBySku(config: SeedConfig, token: string, sku: string): Promise<Item | null> {
  const res = await apiRequest<{ data?: any[] } | any[]>(config, 'GET', '/items', {
    token,
    params: { search: sku, limit: 50, offset: 0 },
  })
  const rows = Array.isArray(res) ? res : res.data ?? []
  const found = rows.find((row) => (row?.sku ?? '').toLowerCase() === sku.toLowerCase())
  return found ? ({ id: found.id, sku: found.sku, name: found.name } as Item) : null
}

async function ensureItem(config: SeedConfig, token: string, sku: string, name: string) {
  const existing = await findItemBySku(config, token, sku)
  if (existing) return existing
  return apiRequest<Item>(config, 'POST', '/items', {
    token,
    body: { sku, name, description: `Seeded by ${config.prefix}`, defaultUom: 'ea' },
  })
}

async function findLocationByCode(config: SeedConfig, token: string, code: string): Promise<Location | null> {
  const res = await apiRequest<{ data?: any[] } | any[]>(config, 'GET', '/locations', {
    token,
    params: { search: code, limit: 50, offset: 0 },
  })
  const rows = Array.isArray(res) ? res : res.data ?? []
  const found = rows.find((row) => (row?.code ?? '').toLowerCase() === code.toLowerCase())
  return found ? ({ id: found.id, code: found.code, name: found.name, type: found.type } as Location) : null
}

async function ensureLocation(
  config: SeedConfig,
  token: string,
  code: string,
  name: string,
  type: string,
) {
  const existing = await findLocationByCode(config, token, code)
  if (existing) return existing
  return apiRequest<Location>(config, 'POST', '/locations', {
    token,
    body: { code, name, type, active: true },
  })
}

async function findVendorByCode(config: SeedConfig, token: string, code: string): Promise<Vendor | null> {
  const res = await apiRequest<{ data?: any[] }>(config, 'GET', '/vendors', {
    token,
    params: { limit: 200 },
  })
  const rows = res.data ?? []
  const found = rows.find((row) => (row?.code ?? '').toLowerCase() === code.toLowerCase())
  return found ? ({ id: found.id, code: found.code, name: found.name } as Vendor) : null
}

async function ensureVendor(config: SeedConfig, token: string, code: string, name: string) {
  const existing = await findVendorByCode(config, token, code)
  if (existing) return existing
  return apiRequest<Vendor>(config, 'POST', '/vendors', {
    token,
    body: { code, name, active: true },
  })
}

async function listPurchaseOrders(config: SeedConfig, token: string): Promise<PurchaseOrder[]> {
  const res = await apiRequest<{ data?: PurchaseOrder[] }>(config, 'GET', '/purchase-orders', {
    token,
    params: { limit: 200, offset: 0 },
  })
  return res.data ?? []
}

async function ensurePurchaseOrder(
  config: SeedConfig,
  token: string,
  poNumber: string,
  vendorId: string,
  shipToLocationId: string,
  receivingLocationId: string,
  line: { itemId: string; uom: string; quantityOrdered: number },
) {
  const existing = (await listPurchaseOrders(config, token)).find(
    (row) => (row.poNumber ?? row.po_number) === poNumber,
  )
  if (existing) return existing

  return apiRequest<PurchaseOrder>(config, 'POST', '/purchase-orders', {
    token,
    body: {
      poNumber,
      vendorId,
      status: 'draft',
      orderDate: new Date().toISOString().slice(0, 10),
      expectedDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      shipToLocationId,
      receivingLocationId,
      notes: `Seeded by ${config.prefix}`,
      lines: [{ lineNumber: 1, itemId: line.itemId, uom: line.uom, quantityOrdered: line.quantityOrdered }],
    },
  })
}

async function run() {
  const config = loadConfig()
  const token = await ensureSession(config)

  const recvCode = `${config.prefix}-RECV`
  const storCode = `${config.prefix}-STOR`
  const vendorCode = `${config.prefix}-VEND`
  const itemSku = `${config.prefix}-ITEM`
  const poNumber = `${config.prefix}-PO-001`

  const receiving = await ensureLocation(config, token, recvCode, `${config.prefix} Receiving`, 'receiving')
  const storage = await ensureLocation(config, token, storCode, `${config.prefix} Storage`, 'storage')
  const vendor = await ensureVendor(config, token, vendorCode, `${config.prefix} Vendor`)
  const item = await ensureItem(config, token, itemSku, `${config.prefix} Item`)

  await ensurePurchaseOrder(config, token, poNumber, vendor.id, storage.id, receiving.id, {
    itemId: item.id,
    uom: 'ea',
    quantityOrdered: 10,
  })

  // eslint-disable-next-line no-console
  console.log(`[phase0-seed] Seed complete for prefix ${config.prefix}.`)
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[phase0-seed] Seed failed:', err)
  process.exit(1)
})

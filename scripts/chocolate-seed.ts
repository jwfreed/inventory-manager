/* eslint-disable no-console */
import { Client } from 'pg'
import { v4 as uuidv4 } from 'uuid'
import { hashPassword } from '../src/lib/auth'
import { assertNonProductionEnvironment } from './lib/productionGuard'

/**
 * Canonical chocolate seed with optional destructive reset and 1,000-bar demo flow.
 *
 * Required:
 * - API running (API_BASE_URL)
 * - DB migrated (npm run migrate)
 * - Optional: CONFIRM_CANONICAL_RESET=1 to run destructive reset before seeding
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type SeedMode = 'completed' | 'manual'

type SeedConfig = {
  mode: SeedMode
  baseUrl: string
  prefix: string
  adminEmail: string
  adminPassword: string
  tenantSlug: string
  tenantName: string
  logLevel: LogLevel
  timeoutMs: number
  reset: boolean
  allowLocalAuthRepair: boolean
}

type ApiError = Error & { status?: number; details?: unknown }

type Session = {
  accessToken: string
  user?: { email?: string }
  tenant?: { id?: string; slug?: string }
}

type AuthenticatedSession = {
  accessToken: string
  adminEmail: string
}

type Item = {
  id: string
  sku: string
  name: string
  description?: string | null
  type?: 'raw' | 'wip' | 'finished' | 'packaging'
  defaultUom?: string | null
  uomDimension?: 'mass' | 'volume' | 'count' | 'length' | 'area' | 'time' | null
  canonicalUom?: string | null
  stockingUom?: string | null
  defaultLocationId?: string | null
  weight?: number | null
  weightUom?: string | null
  isPurchasable?: boolean
  isManufactured?: boolean
}

type Location = {
  id: string
  code: string
  name: string
  type: string
  role?: string | null
  isSellable?: boolean
  warehouseId?: string | null
  parentLocationId?: string | null
}

type Bom = { id: string; bomCode: string; versions: { id: string; status: string }[] }

type CreateBomResponse = {
  id: string
  bomCode: string
  versions: { id: string; status: string }[]
}

type Vendor = { id: string; code: string; name: string }

type Customer = { id: string; code: string; name: string }

type PurchaseOrder = {
  id: string
  poNumber: string
  status: string
  lines: Array<{ id: string; itemId: string; uom: string; quantityOrdered: string | number }>
}

type Receipt = {
  id: string
  purchaseOrderId: string
  status?: string
  inventoryMovementId?: string | null
  lines: Array<{ id: string; itemId: string; uom: string; quantityReceived: string | number }>
}

type SalesOrder = {
  id: string
  soNumber: string
  status: string
  lines: Array<{ id: string; itemId: string; uom: string; quantityOrdered: string | number }>
}

type Reservation = {
  id: string
  status: string
  demandId: string
  itemId: string
  locationId: string
  warehouseId: string
  uom: string
  quantityReserved: string | number
  quantityFulfilled: string | number | null
}

type Shipment = {
  id: string
  salesOrderId: string
  status: string | null
  inventoryMovementId: string | null
  externalRef: string | null
  lines: Array<{ salesOrderLineId: string; uom: string; quantityShipped: string | number }>
}

export const DEMO_FLOW_QUANTITY = 1000

export const DEMO_FINISHED_GOOD = {
  sku: 'SIAMAYA-MILK-CHOCOLATE-BAR-75G',
  name: 'Milk Chocolate Bar 75g',
  type: 'finished' as const,
  defaultUom: 'each',
  uomDimension: 'count' as const,
  canonicalUom: 'each',
  stockingUom: 'each',
  weight: 75,
  weightUom: 'g',
  isPurchasable: false,
  isManufactured: true,
}

export const DEMO_BOM_CODE = 'SIAMAYA-BOM-MILK-CHOCOLATE-BAR-75G'

export const DEMO_BOM_COMPONENTS = [
  {
    key: 'cacaoNibs',
    sku: 'SIAMAYA-MILK-CHOC-CACAO-NIBS',
    name: 'Cacao nibs',
    type: 'raw' as const,
    uom: 'g',
    dimension: 'mass' as const,
    quantityPer: 30,
    unitCost: 0.04,
  },
  {
    key: 'sugar',
    sku: 'SIAMAYA-MILK-CHOC-SUGAR',
    name: 'Sugar',
    type: 'raw' as const,
    uom: 'g',
    dimension: 'mass' as const,
    quantityPer: 20,
    unitCost: 0.015,
  },
  {
    key: 'milkPowder',
    sku: 'SIAMAYA-MILK-CHOC-MILK-POWDER',
    name: 'Milk powder',
    type: 'raw' as const,
    uom: 'g',
    dimension: 'mass' as const,
    quantityPer: 15,
    unitCost: 0.03,
  },
  {
    key: 'cacaoButter',
    sku: 'SIAMAYA-MILK-CHOC-CACAO-BUTTER',
    name: 'Cacao butter',
    type: 'raw' as const,
    uom: 'g',
    dimension: 'mass' as const,
    quantityPer: 9.5,
    unitCost: 0.05,
  },
  {
    key: 'lecithin',
    sku: 'SIAMAYA-MILK-CHOC-LECITHIN',
    name: 'Lecithin',
    type: 'raw' as const,
    uom: 'g',
    dimension: 'mass' as const,
    quantityPer: 0.5,
    unitCost: 0.08,
  },
  {
    key: 'foilWrapper',
    sku: 'SIAMAYA-MILK-CHOC-FOIL-WRAPPER',
    name: 'Foil wrapper',
    type: 'packaging' as const,
    uom: 'each',
    dimension: 'count' as const,
    quantityPer: 1,
    unitCost: 0.2,
  },
]

export const DEMO_SUPPLIER = {
  code: 'SIAMAYA-DEMO-INGREDIENT-SUPPLIER',
  name: 'Siamaya Demo Ingredient Supplier',
}

export const DEMO_CUSTOMER = {
  code: 'SIAMAYA-DEMO-CUSTOMER',
  name: 'Siamaya Demo Customer',
}

export const DEMO_PO = {
  number: 'PO-MILK-CHOC-1000-INGREDIENTS',
  vendorReference: 'SIAMAYA-DEMO-INGREDIENTS-1000',
}

export const DEMO_SO = {
  number: 'SO-MILK-CHOC-1000-BARS',
  customerReference: 'SIAMAYA-DEMO-CUSTOMER-1000-BARS',
}

export const DEMO_DATES = {
  orderDate: '2026-01-15',
  expectedDate: '2026-01-16',
  receiptAt: '2026-01-16T09:00:00.000Z',
  qcAt: '2026-01-16T10:00:00.000Z',
  productionAt: '2026-01-16T13:00:00.000Z',
  requestedShipDate: '2026-01-17',
  shippedAt: '2026-01-17T15:00:00.000Z',
}

export const DEMO_FLOW_IDS = {
  shipmentExternalRef: 'SHIP-MILK-CHOC-1000-BARS',
  workOrderDescription: 'seed:siamaya:milk-chocolate-1000:work-order:v1',
}

const MANUAL_DEMO = {
  rawMaterialLocationCodes: {
    receiving: 'FACTORY_RECEIVING',
    rawStore: 'FACTORY_RM_STORE',
    packStore: 'FACTORY_PACK_STORE',
    production: 'FACTORY_PRODUCTION',
    fgStage: 'FACTORY_FG_STAGE',
    shipping: 'FACTORY_SHIPPING',
  },
}

export const DEMO_SKUS = [
  DEMO_FINISHED_GOOD.sku,
  ...DEMO_BOM_COMPONENTS.map((component) => component.sku),
]

function componentRequirement(quantityPer: number) {
  return quantityPer * DEMO_FLOW_QUANTITY
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} must be set`)
  return value
}

function parseBool(value: string | undefined): boolean {
  if (!value) return false
  return ['1', 'true', 'yes', 'y', 'on'].includes(value.toLowerCase())
}

function loadConfig(): SeedConfig {
  const rawMode = process.env.CHOCOLATE_SEED_MODE || process.env.SEED_MODE || 'completed'
  if (rawMode !== 'completed' && rawMode !== 'manual') {
    throw new Error(`Unsupported seed mode ${rawMode}; expected completed or manual`)
  }
  const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3100').replace(/\/$/, '')
  const prefix = process.env.SEED_PREFIX || 'SIAMAYA-CHOC'
  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com'
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local'
  const tenantSlug = process.env.SEED_TENANT_SLUG || 'siamaya'
  const tenantName = process.env.SEED_TENANT_NAME || 'SIAMAYA'
  const logLevel = (process.env.LOG_LEVEL as LogLevel) || 'info'
  const timeoutMs = Number(process.env.TIMEOUT_MS || '15000')
  const reset = parseBool(process.env.CONFIRM_CANONICAL_RESET)
  const allowLocalAuthRepair = parseBool(process.env.ALLOW_LOCAL_AUTH_REPAIR)
  return {
    mode: rawMode,
    baseUrl,
    prefix,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName,
    logLevel,
    timeoutMs,
    reset,
    allowLocalAuthRepair,
  }
}

function makeLogger(level: LogLevel) {
  const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
  const min = order[level] ?? order.info
  const should = (l: LogLevel) => order[l] >= min
  const log =
    (l: LogLevel) =>
    (msg: string, extra?: unknown) => {
      if (!should(l)) return
      const line = `[choc-seed] ${l.toUpperCase()} ${msg}`
      if (extra === undefined) {
        console.log(line)
      } else {
        console.log(line, extra)
      }
    }
  return {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
  }
}

function toApiError(err: unknown): ApiError {
  if (err instanceof Error) return err as ApiError
  return new Error(String(err)) as ApiError
}

async function apiRequest<T>(
  config: SeedConfig,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  opts: {
    token?: string
    params?: Record<string, string | number | boolean | undefined>
    body?: unknown
    idempotencyKey?: string
  } = {},
): Promise<T> {
  const url = new URL(config.baseUrl + path)
  if (opts.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      if (v === undefined) continue
      url.searchParams.set(k, String(v))
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs)

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey
    const res = await fetch(url.toString(), {
      method,
      headers,
      body: method === 'POST' || method === 'PUT' ? JSON.stringify(opts.body ?? {}) : undefined,
      signal: controller.signal,
    })

    const contentType = res.headers.get('content-type') || ''
    const isJson = contentType.includes('application/json')
    const payload = isJson ? await res.json().catch(() => null) : await res.text().catch(() => '')

    if (!res.ok) {
      const payloadError =
        payload && typeof payload === 'object' && 'error' in (payload as any)
          ? (payload as any).error
          : undefined
      const message =
        (payloadError !== undefined
          ? typeof payloadError === 'string'
            ? payloadError
            : JSON.stringify(payloadError)
          : undefined) ||
        (typeof payload === 'string' && payload) ||
        res.statusText ||
        `HTTP ${res.status}`
      const e = new Error(message) as ApiError
      e.status = res.status
      e.details = payload
      throw e
    }

    return payload as T
  } finally {
    clearTimeout(timeout)
  }
}

async function tryLogin(config: SeedConfig): Promise<AuthenticatedSession | null> {
  try {
    const session = await apiRequest<Session>(config, 'POST', '/auth/login', {
      body: {
        email: config.adminEmail,
        password: config.adminPassword,
        tenantSlug: config.tenantSlug,
      },
    })
    if (session.tenant?.slug && session.tenant.slug !== config.tenantSlug) {
      throw new Error(`Authenticated into ${session.tenant.slug}, expected ${config.tenantSlug}`)
    }
    return {
      accessToken: session.accessToken,
      adminEmail: session.user?.email ?? config.adminEmail,
    }
  } catch (err) {
    const e = toApiError(err)
    if ([400, 401, 403, 404].includes(e.status ?? 0)) return null
    throw err
  }
}

async function ensureSession(config: SeedConfig, log: ReturnType<typeof makeLogger>): Promise<AuthenticatedSession> {
  const existingLogin = await tryLogin(config)
  if (existingLogin) {
    log.info(`Authenticated with existing Siamaya admin: ${existingLogin.adminEmail}`)
    return existingLogin
  }

  if (!config.allowLocalAuthRepair) {
    throw new Error(
      `Unable to authenticate ${config.adminEmail} into tenant ${config.tenantSlug}. ` +
        'Refusing to create memberships or repair local auth without ALLOW_LOCAL_AUTH_REPAIR=1.',
    )
  }

  log.warn('ALLOW_LOCAL_AUTH_REPAIR=1 enabled; local tenant/admin auth repair may create access or reset password.')
  await ensureLocalTenantAdminPrincipal(config, log)
  const repairedPrincipalLogin = await tryLogin(config)
  if (repairedPrincipalLogin) {
    log.info(`Authenticated with local Siamaya admin: ${repairedPrincipalLogin.adminEmail}`)
    return repairedPrincipalLogin
  }
  throw new Error(`Unable to authenticate ${config.adminEmail} into tenant ${config.tenantSlug} after local auth repair`)
}

async function resetOperationalData(config: SeedConfig, log: ReturnType<typeof makeLogger>) {
  if (!config.reset) {
    log.error('Refusing to reset without CONFIRM_CANONICAL_RESET=1')
    throw new Error('RESET_CONFIRMATION_REQUIRED')
  }
  const databaseUrl = requiredEnv('DATABASE_URL')
  const client = new Client({ connectionString: databaseUrl })
  const tables = [
    'idempotency_keys',
    'inventory_movement_lpns',
    'inventory_movement_lots',
    'inventory_movement_lines',
    'inventory_movements',
    'inventory_cost_layers',
    'cost_layer_consumptions',
    'inventory_reservations',
    'inventory_backorders',
    'inventory_adjustment_lines',
    'inventory_adjustments',
    'cycle_count_lines',
    'cycle_counts',
    'work_order_execution_lines',
    'work_order_executions',
    'work_order_material_issue_lines',
    'work_order_material_issues',
    'work_orders',
    'putaway_lines',
    'putaways',
    'qc_events',
    'purchase_order_receipt_lines',
    'purchase_order_receipts',
    'purchase_order_lines',
    'purchase_orders',
    'sales_order_shipment_lines',
    'sales_order_shipments',
    'sales_order_lines',
    'sales_orders',
    'license_plates',
    'uom_conversions',
    'bom_version_lines',
    'bom_versions',
    'boms',
    'items',
  ]

  await client.connect()
  try {
    log.info('Truncating operational tables...')
    await client.query(`TRUNCATE TABLE ${tables.join(', ')} CASCADE;`)
    const { rows } = await client.query<{ proc: string | null }>(
      `SELECT to_regprocedure('refresh_inventory_levels_by_lpn()') AS proc`,
    )
    if (rows[0]?.proc) {
      log.info('Skipping inventory_levels_by_lpn refresh (non-essential for seed).')
    }
    log.info('Operational reset complete.')
  } finally {
    await client.end()
  }
}

async function ensureLocalTenantAdminPrincipal(config: SeedConfig, log: ReturnType<typeof makeLogger>) {
  if (!config.allowLocalAuthRepair) {
    throw new Error('Local auth repair requires ALLOW_LOCAL_AUTH_REPAIR=1.')
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Local demo seeds cannot create or repair auth principals in production.')
  }
  await withDbClient(async (client) => {
    await client.query('BEGIN')
    try {
      await client.query(
        `INSERT INTO currencies (code, name, symbol, decimal_places, active)
         VALUES ('THB', 'Thai Baht', 'THB', 2, true)
         ON CONFLICT (code) DO NOTHING`,
      )

      const tenantRes = await client.query<{ id: string }>('SELECT id FROM tenants WHERE slug = $1', [
        config.tenantSlug,
      ])
      const tenantId = tenantRes.rows[0]?.id ?? uuidv4()
      if (!tenantRes.rows[0]) {
        await client.query(
          `INSERT INTO tenants (id, name, slug, parent_tenant_id, created_at)
           VALUES ($1, $2, $3, NULL, now())`,
          [tenantId, config.tenantName, config.tenantSlug],
        )
        log.info(`Tenant created: ${config.tenantSlug} (${tenantId})`)
      } else {
        await client.query(
          `UPDATE tenants SET name = $1 WHERE id = $2`,
          [config.tenantName, tenantId],
        )
      }

      const userRes = await client.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [
        config.adminEmail,
      ])
      const passwordHash = await hashPassword(config.adminPassword)
      const userId = userRes.rows[0]?.id ?? uuidv4()
      if (!userRes.rows[0]) {
        await client.query(
          `INSERT INTO users (id, email, password_hash, full_name, base_currency, active, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'THB', true, now(), now())`,
          [userId, config.adminEmail, passwordHash, 'Siamaya Admin'],
        )
        log.info(`Admin user created: ${config.adminEmail} (${userId})`)
      } else {
        await client.query(
          `UPDATE users
              SET password_hash = $1,
                  base_currency = COALESCE(base_currency, 'THB'),
                  active = true,
                  updated_at = now()
            WHERE id = $2`,
          [passwordHash, userId],
        )
      }

      const membershipRes = await client.query<{ id: string; role: string; status: string }>(
        `SELECT id, role, status
           FROM tenant_memberships
          WHERE tenant_id = $1
            AND user_id = $2
          LIMIT 1`,
        [tenantId, userId],
      )
      const membership = membershipRes.rows[0]
      if (!membership) {
        await client.query(
          `INSERT INTO tenant_memberships (id, tenant_id, user_id, role, status, created_at)
           VALUES ($1, $2, $3, 'admin', 'active', now())`,
          [uuidv4(), tenantId, userId],
        )
        log.info(`Admin tenant membership created: ${config.adminEmail} -> ${config.tenantSlug}`)
      } else if (membership.role !== 'admin' || membership.status !== 'active') {
        await client.query(
          `UPDATE tenant_memberships
              SET role = 'admin',
                  status = 'active'
            WHERE id = $1`,
          [membership.id],
        )
        log.info(`Admin tenant membership repaired: ${config.adminEmail} -> ${config.tenantSlug}`)
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  })
}

async function findItemBySku(config: SeedConfig, token: string, sku: string): Promise<Item | null> {
  const res = await apiRequest<{ data?: any[] } | any[]>(config, 'GET', '/items', {
    token,
    params: { search: sku, limit: 50, offset: 0 },
  })
  const rows = Array.isArray(res) ? res : res.data ?? []
  const found = rows.find((r) => (r?.sku ?? '').toLowerCase() === sku.toLowerCase())
  return found ? (found as Item) : null
}

async function ensureItem(
  config: SeedConfig,
  token: string,
  log: ReturnType<typeof makeLogger>,
  payload: {
    sku: string
    name: string
    description?: string
    type: 'raw' | 'wip' | 'finished' | 'packaging'
    defaultUom: string
    uomDimension: 'mass' | 'count'
    canonicalUom: string
    stockingUom: string
    defaultLocationId?: string | null
    weight?: number | null
    weightUom?: string | null
    isPurchasable?: boolean
    isManufactured?: boolean
  },
): Promise<Item> {
  const existing = await findItemBySku(config, token, payload.sku)
  if (existing) {
    const needsUpdate =
      (payload.isPurchasable !== undefined && existing.isPurchasable !== payload.isPurchasable) ||
      (payload.isManufactured !== undefined && existing.isManufactured !== payload.isManufactured) ||
      (payload.defaultLocationId !== undefined && existing.defaultLocationId !== payload.defaultLocationId)
    if (needsUpdate) {
      const updated = await apiRequest<Item>(config, 'PUT', `/items/${existing.id}`, {
        token,
        body: {
          sku: payload.sku,
          name: payload.name,
          description: payload.description ?? existing.description ?? undefined,
          type: payload.type,
          defaultUom: payload.defaultUom,
          uomDimension: payload.uomDimension,
          canonicalUom: payload.canonicalUom,
          stockingUom: payload.stockingUom,
          defaultLocationId: payload.defaultLocationId ?? null,
          weight: payload.weight ?? existing.weight ?? null,
          weightUom: payload.weightUom ?? existing.weightUom ?? null,
          isPurchasable: payload.isPurchasable,
          isManufactured: payload.isManufactured,
        },
      }).catch(async (error) => {
        const e = toApiError(error)
        if (e.status !== 404) throw error
        return existing
      })
      if (updated !== existing) {
        log.info(`Item updated: ${payload.sku} (${updated.id})`)
        return updated
      }
    }
    log.info(`Item exists: ${payload.sku} (${existing.id})`)
    return existing
  }

  const created = await apiRequest<Item>(config, 'POST', '/items', {
    token,
    body: {
      sku: payload.sku,
      name: payload.name,
      description: payload.description ?? undefined,
      type: payload.type,
      defaultUom: payload.defaultUom,
      uomDimension: payload.uomDimension,
      canonicalUom: payload.canonicalUom,
      stockingUom: payload.stockingUom,
      defaultLocationId: payload.defaultLocationId ?? null,
      weight: payload.weight ?? null,
      weightUom: payload.weightUom ?? null,
      isPurchasable: payload.isPurchasable,
      isManufactured: payload.isManufactured,
    },
  })
  log.info(`Item created: ${payload.sku} (${created.id})`)
  return created
}

async function findLocationByCode(config: SeedConfig, token: string, code: string): Promise<Location | null> {
  const res = await apiRequest<{ data?: any[] } | any[]>(config, 'GET', '/locations', {
    token,
    params: { search: code, limit: 100, offset: 0 },
  })
  const rows = Array.isArray(res) ? res : res.data ?? []
  const found = rows.find((r) => (r?.code ?? '').toLowerCase() === code.toLowerCase())
  return found ? (found as Location) : null
}

async function ensureLocation(
  config: SeedConfig,
  token: string,
  log: ReturnType<typeof makeLogger>,
  code: string,
  name: string,
  type: Location['type'],
  opts: { role?: string | null; isSellable?: boolean; parentLocationId?: string | null } = {},
): Promise<Location> {
  const existing = await findLocationByCode(config, token, code)
  if (existing) {
    const expectedParentLocationId = type === 'warehouse' ? null : (opts.parentLocationId ?? null)
    const expectedRole = opts.role ?? null
    const expectedSellable = opts.isSellable ?? false
    if (
      existing.name !== name ||
      existing.type !== type ||
      (existing.role ?? null) !== expectedRole ||
      Boolean(existing.isSellable) !== expectedSellable ||
      (existing.parentLocationId ?? null) !== expectedParentLocationId
    ) {
      const updated = await apiRequest<Location>(config, 'PUT', `/locations/${existing.id}`, {
        token,
        body: {
          code,
          name,
          type,
          active: true,
          role: opts.role ?? undefined,
          isSellable: opts.isSellable,
          parentLocationId: expectedParentLocationId,
        },
      })
      log.info(`Location updated: ${code} (${updated.id})`)
      return updated
    }
    log.info(`Location exists: ${code} (${existing.id})`)
    return existing
  }

  const created = await apiRequest<Location>(config, 'POST', '/locations', {
    token,
    body: {
      code,
      name,
      type,
      active: true,
      role: opts.role ?? undefined,
      isSellable: opts.isSellable,
      parentLocationId: type === 'warehouse' ? null : (opts.parentLocationId ?? null),
    },
  })
  log.info(`Location created: ${code} (${created.id})`)
  return created
}

async function ensureUomConversion(
  config: SeedConfig,
  token: string,
  log: ReturnType<typeof makeLogger>,
  itemId: string,
  fromUom: string,
  toUom: string,
  factor: number,
) {
  const existing = await apiRequest<{ conversions?: Record<string, string>[] } | Record<string, string>[]>(
    config,
    'GET',
    `/items/${itemId}/uom-conversions`,
    { token },
  )
  const conversions = Array.isArray(existing) ? existing : existing.conversions ?? []
  const found = conversions.some(
    (c) =>
      (c.fromUom ?? c.from_uom)?.toLowerCase() === fromUom.toLowerCase() &&
      (c.toUom ?? c.to_uom)?.toLowerCase() === toUom.toLowerCase(),
  )
  if (found) {
    log.info(`UOM conversion exists: ${fromUom} -> ${toUom}`)
    return
  }
  await apiRequest(config, 'POST', `/items/${itemId}/uom-conversions`, {
    token,
    body: { fromUom, toUom, factor },
  })
  log.info(`UOM conversion created: ${fromUom} -> ${toUom}`)
}

async function listBomsForItem(config: SeedConfig, token: string, itemId: string): Promise<Bom[]> {
  const res = await apiRequest<{ boms?: Bom[] }>(config, 'GET', `/items/${itemId}/boms`, { token })
  return res.boms ?? []
}

async function activateBomVersion(
  config: SeedConfig,
  token: string,
  log: ReturnType<typeof makeLogger>,
  versionId: string,
) {
  const effectiveFrom = new Date().toISOString()
  await apiRequest<Bom>(config, 'POST', `/boms/${versionId}/activate`, {
    token,
    body: { effectiveFrom },
  })
  log.info(`BOM version activated: ${versionId}`)
}

async function ensureBom(
  config: SeedConfig,
  token: string,
  log: ReturnType<typeof makeLogger>,
  payload: {
    bomCode: string
    outputItemId: string
    defaultUom: string
    version: {
      yieldQuantity: number
      yieldUom: string
      components: { lineNumber: number; componentItemId: string; uom: string; quantityPer: number }[]
    }
  },
): Promise<Bom> {
  const existing = await listBomsForItem(config, token, payload.outputItemId)
  const found = existing.find((b) => b.bomCode === payload.bomCode)
  if (found) {
    log.info(`BOM exists: ${payload.bomCode} (${found.id})`)
    const inactive = found.versions.find((v) => v.status !== 'active')
    if (inactive) {
      await activateBomVersion(config, token, log, inactive.id)
      inactive.status = 'active'
    }
    return found
  }

  const created = await apiRequest<CreateBomResponse>(config, 'POST', '/boms', {
    token,
    body: payload,
  })
  log.info(`BOM created: ${payload.bomCode} (${created.id})`)
  const firstVersion = created.versions[0]
  if (firstVersion) {
    await activateBomVersion(config, token, log, firstVersion.id)
  }
  return created as Bom
}

async function withDbClient<T>(handler: (client: Client) => Promise<T>): Promise<T> {
  const databaseUrl = requiredEnv('DATABASE_URL')
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    return await handler(client)
  } finally {
    await client.end()
  }
}

async function resolveTenantId(config: SeedConfig): Promise<string> {
  return withDbClient(async (client) => {
    const res = await client.query<{ id: string }>('SELECT id FROM tenants WHERE slug = $1', [config.tenantSlug])
    const tenantId = res.rows[0]?.id
    if (!tenantId) throw new Error(`Tenant not found: ${config.tenantSlug}`)
    return tenantId
  })
}

async function ensureStandardWarehouseTemplate(
  config: SeedConfig,
  token: string,
  log: ReturnType<typeof makeLogger>,
) {
  const result = await apiRequest<{ created?: Location[]; skipped?: string[] }>(
    config,
    'POST',
    '/locations/templates/standard-warehouse',
    { token, body: { includeReceivingQc: true } },
  )
  log.info(
    `Warehouse template ready (created=${result.created?.length ?? 0}, skipped=${result.skipped?.length ?? 0})`,
  )
}

async function getDemoWarehouseContext(tenantId: string) {
  return withDbClient(async (client) => {
    const warehouseRes = await client.query<Location>(
      `SELECT id, code, name, type
         FROM locations
        WHERE tenant_id = $1
          AND type = 'warehouse'
        ORDER BY CASE WHEN code = 'MAIN' THEN 0 ELSE 1 END, created_at ASC
        LIMIT 1`,
      [tenantId],
    )
    const warehouse = warehouseRes.rows[0]
    if (!warehouse) throw new Error('Demo warehouse root was not created')

    const defaultsRes = await client.query<Location>(
      `SELECT l.id, l.code, l.name, l.type, l.role, l.is_sellable AS "isSellable",
              l.warehouse_id AS "warehouseId", l.parent_location_id AS "parentLocationId"
         FROM warehouse_default_location wdl
         JOIN locations l
           ON l.id = wdl.location_id
          AND l.tenant_id = wdl.tenant_id
        WHERE wdl.tenant_id = $1
          AND wdl.warehouse_id = $2
          AND wdl.role = ANY($3::text[])`,
      [tenantId, warehouse.id, ['SELLABLE', 'QA']],
    )
    const byRole = new Map(defaultsRes.rows.map((row) => [row.role, row]))
    const sellable = byRole.get('SELLABLE')
    const qa = byRole.get('QA')
    if (!sellable || !qa) {
      throw new Error('Warehouse template did not create SELLABLE and QA defaults')
    }
    return { warehouse, sellable, qa }
  })
}

async function ensureOperationalLocations(
  config: SeedConfig,
  token: string,
  log: ReturnType<typeof makeLogger>,
  warehouse: Location,
) {
  const receiving = await ensureLocation(
    config,
    token,
    log,
    MANUAL_DEMO.rawMaterialLocationCodes.receiving,
    'Factory Receiving',
    'bin',
    { role: 'HOLD', parentLocationId: warehouse.id, isSellable: false },
  )
  const rawStore = await ensureLocation(
    config,
    token,
    log,
    MANUAL_DEMO.rawMaterialLocationCodes.rawStore,
    'Factory Raw Material Store',
    'bin',
    { role: 'SELLABLE', parentLocationId: warehouse.id, isSellable: true },
  )
  const packStore = await ensureLocation(
    config,
    token,
    log,
    MANUAL_DEMO.rawMaterialLocationCodes.packStore,
    'Factory Packaging Store',
    'bin',
    { role: 'PACKAGING', parentLocationId: warehouse.id, isSellable: false },
  )
  const production = await ensureLocation(
    config,
    token,
    log,
    MANUAL_DEMO.rawMaterialLocationCodes.production,
    'Factory Production',
    'bin',
    { role: 'WIP', parentLocationId: warehouse.id, isSellable: false },
  )
  const fgStage = await ensureLocation(
    config,
    token,
    log,
    MANUAL_DEMO.rawMaterialLocationCodes.fgStage,
    'Factory Finished Goods Sellable Stage',
    'bin',
    { role: 'FG_SELLABLE', parentLocationId: warehouse.id, isSellable: true },
  )
  const shipping = await ensureLocation(
    config,
    token,
    log,
    MANUAL_DEMO.rawMaterialLocationCodes.shipping,
    'Factory Shipping',
    'bin',
    { role: 'FG_SELLABLE', parentLocationId: warehouse.id, isSellable: true },
  )

  return { receiving, rawStore, packStore, production, fgStage, shipping }
}

async function ensureVendor(
  config: SeedConfig,
  token: string,
  log: ReturnType<typeof makeLogger>,
): Promise<Vendor> {
  const list = await apiRequest<{ data?: Vendor[] } | Vendor[]>(config, 'GET', '/vendors', {
    token,
    params: { active: true },
  })
  const rows = Array.isArray(list) ? list : list.data ?? []
  const existing = rows.find((row) => row.code === DEMO_SUPPLIER.code)
  if (existing) {
    log.info(`Vendor exists: ${DEMO_SUPPLIER.code} (${existing.id})`)
    return existing
  }

  const created = await apiRequest<Vendor>(config, 'POST', '/vendors', {
    token,
    body: {
      code: DEMO_SUPPLIER.code,
      name: DEMO_SUPPLIER.name,
      email: 'supplier@example.test',
      contactName: 'Siamaya Demo Supplier Contact',
      notes: 'Seeded supplier for 1,000 milk chocolate bar demo.',
    },
  })
  log.info(`Vendor created: ${DEMO_SUPPLIER.code} (${created.id})`)
  return created
}

async function ensureCustomer(tenantId: string, log: ReturnType<typeof makeLogger>): Promise<Customer> {
  return withDbClient(async (client) => {
    const existing = await client.query<Customer>(
      `SELECT id, code, name
         FROM customers
        WHERE code = $1
          AND tenant_id = $2
        LIMIT 1`,
      [DEMO_CUSTOMER.code, tenantId],
    )
    if (existing.rows[0]) {
      log.info(`Customer exists: ${DEMO_CUSTOMER.code} (${existing.rows[0].id})`)
      return existing.rows[0]
    }

    const conflicting = await client.query<Customer>(
      `SELECT id, code, name
         FROM customers
        WHERE code = $1
          AND tenant_id <> $2
        LIMIT 1`,
      [DEMO_CUSTOMER.code, tenantId],
    )
    if (conflicting.rows[0]) {
      throw new Error(`Customer code ${DEMO_CUSTOMER.code} already exists for a different tenant`)
    }

    const id = uuidv4()
    const created = await client.query<Customer>(
      `INSERT INTO customers (id, tenant_id, code, name, email, phone, active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, true, now(), now())
       RETURNING id, code, name`,
      [id, tenantId, DEMO_CUSTOMER.code, DEMO_CUSTOMER.name, 'customer@example.test', '+1-555-0100'],
    )
    log.info(`Customer created: ${DEMO_CUSTOMER.code} (${id})`)
    return created.rows[0]
  })
}

async function findPurchaseOrderByNumber(
  config: SeedConfig,
  token: string,
  poNumber: string,
): Promise<PurchaseOrder | null> {
  const list = await apiRequest<{ data?: Array<{ id: string; poNumber: string }> }>(config, 'GET', '/purchase-orders', {
    token,
    params: { search: poNumber, limit: 20, offset: 0 },
  })
  const summary = (list.data ?? []).find((row) => row.poNumber === poNumber)
  if (!summary) return null
  return apiRequest<PurchaseOrder>(config, 'GET', `/purchase-orders/${summary.id}`, { token })
}

async function ensureDemoPurchaseOrder(
  config: SeedConfig,
  token: string,
  log: ReturnType<typeof makeLogger>,
  vendor: Vendor,
  componentItems: Array<{ spec: (typeof DEMO_BOM_COMPONENTS)[number]; item: Item }>,
  warehouse: Location,
): Promise<PurchaseOrder> {
  const existing = await findPurchaseOrderByNumber(config, token, DEMO_PO.number)
  if (existing) {
    log.info(`Purchase order exists: ${DEMO_PO.number} (${existing.id})`)
    return existing
  }

  const created = await apiRequest<PurchaseOrder>(config, 'POST', '/purchase-orders', {
    token,
    body: {
      poNumber: DEMO_PO.number,
      vendorId: vendor.id,
      status: 'approved',
      orderDate: DEMO_DATES.orderDate,
      expectedDate: DEMO_DATES.expectedDate,
      shipToLocationId: warehouse.id,
      receivingLocationId: warehouse.id,
      vendorReference: DEMO_PO.vendorReference,
      notes: 'Demo purchase order for exactly the components required to make 1,000 Milk Chocolate Bar 75g units.',
      lines: componentItems.map(({ spec, item }, index) => ({
        lineNumber: index + 1,
        itemId: item.id,
        uom: spec.uom,
        quantityOrdered: componentRequirement(spec.quantityPer),
        unitCost: spec.unitCost,
        currencyCode: 'THB',
        notes: `Required for ${DEMO_FLOW_QUANTITY} bars at ${spec.quantityPer} ${spec.uom} per bar.`,
      })),
    },
  })
  log.info(`Purchase order created: ${DEMO_PO.number} (${created.id})`)
  return created
}

async function ensureDemoReceipt(
  config: SeedConfig,
  token: string,
  log: ReturnType<typeof makeLogger>,
  po: PurchaseOrder,
  componentItems: Array<{ spec: (typeof DEMO_BOM_COMPONENTS)[number]; item: Item }>,
): Promise<Receipt> {
  const poLine = po.lines[0]
  if (!poLine) throw new Error('Demo purchase order has no lines')
  const idempotencyKey = 'seed:siamaya:milk-chocolate-1000:receipt:v1'
  const unitCostByItemId = new Map(componentItems.map(({ spec, item }) => [item.id, spec.unitCost]))
  const receipt = await apiRequest<Receipt>(config, 'POST', '/purchase-order-receipts', {
    token,
    idempotencyKey,
    body: {
      purchaseOrderId: po.id,
      receivedAt: DEMO_DATES.receiptAt,
      externalRef: 'RCPT-MILK-CHOC-1000-INGREDIENTS',
      notes: 'Demo receipt for the ingredients and packaging required for exactly 1,000 milk chocolate bars.',
      idempotencyKey,
      lines: po.lines.map((line) => ({
        purchaseOrderLineId: line.id,
        uom: line.uom,
        quantityReceived: Number(line.quantityOrdered),
        unitCost: unitCostByItemId.get(line.itemId) ?? 0,
      })),
    },
  })
  log.info(`Receipt ready for ${DEMO_PO.number} (${receipt.id})`)
  return receipt
}

async function ensureDemoQcAccepted(
  config: SeedConfig,
  token: string,
  log: ReturnType<typeof makeLogger>,
  receipt: Receipt,
) {
  if (receipt.lines.length === 0) throw new Error('Demo receipt has no lines')
  for (const [index, receiptLine] of receipt.lines.entries()) {
    const idempotencyKey = `seed:siamaya:milk-chocolate-1000:qc-accept:${index + 1}:v1`
    const result = await apiRequest<{ id: string } | { eventId: string; replayed?: boolean }>(
      config,
      'POST',
      '/qc-events',
      {
        token,
        idempotencyKey,
        body: {
          purchaseOrderReceiptLineId: receiptLine.id,
          eventType: 'accept',
          quantity: Number(receiptLine.quantityReceived),
          uom: receiptLine.uom,
          reasonCode: 'demo_accept',
          notes: 'Demo QC accept for milk chocolate ingredient receipt.',
          actorType: 'system',
          actorId: 'chocolate-seed',
        },
      },
    )
    log.info(`QC accept ready (${(result as any).eventId ?? (result as any).id})`)
  }
}

async function findSalesOrderByNumber(
  config: SeedConfig,
  token: string,
  soNumber: string,
): Promise<SalesOrder | null> {
  const list = await apiRequest<{ data?: Array<{ id: string; soNumber?: string; so_number?: string }> }>(
    config,
    'GET',
    '/sales-orders',
    {
      token,
      params: { limit: 100, offset: 0 },
    },
  )
  const summary = (list.data ?? []).find((row) => (row.soNumber ?? row.so_number) === soNumber)
  if (!summary) return null
  return apiRequest<SalesOrder>(config, 'GET', `/sales-orders/${summary.id}`, { token })
}

async function ensureDemoSalesOrder(
  config: SeedConfig,
  token: string,
  log: ReturnType<typeof makeLogger>,
  customer: Customer,
  item: Item,
  warehouse: Location,
  sellable: Location,
): Promise<SalesOrder> {
  const existing = await findSalesOrderByNumber(config, token, DEMO_SO.number)
  if (existing) {
    log.info(`Sales order exists: ${DEMO_SO.number} (${existing.id})`)
    return existing
  }

  const created = await apiRequest<SalesOrder>(config, 'POST', '/sales-orders', {
    token,
    body: {
      soNumber: DEMO_SO.number,
      customerId: customer.id,
      warehouseId: warehouse.id,
      status: 'submitted',
      orderDate: DEMO_DATES.orderDate,
      requestedShipDate: DEMO_DATES.requestedShipDate,
      shipFromLocationId: sellable.id,
      customerReference: DEMO_SO.customerReference,
      notes: 'Demo sales order for exactly 1,000 milk chocolate bars.',
      lines: [
        {
          lineNumber: 1,
          itemId: item.id,
          uom: DEMO_FINISHED_GOOD.defaultUom,
          quantityOrdered: DEMO_FLOW_QUANTITY,
          unitPrice: 3.5,
          currencyCode: 'THB',
          notes: 'Demo outbound finished goods.',
        },
      ],
    },
  })
  log.info(`Sales order created: ${DEMO_SO.number} (${created.id})`)
  return created
}

async function ensureDemoReservation(
  config: SeedConfig,
  token: string,
  log: ReturnType<typeof makeLogger>,
  so: SalesOrder,
  item: Item,
  warehouse: Location,
  sellable: Location,
): Promise<Reservation> {
  const soLine = so.lines[0]
  if (!soLine) throw new Error('Demo sales order has no lines')
  const idempotencyKey = 'seed:siamaya:milk-chocolate-1000:reservation:v1'
  const result = await apiRequest<{ data: Reservation[] }>(config, 'POST', '/reservations', {
    token,
    idempotencyKey,
    body: {
      reservations: [
        {
          demandType: 'sales_order_line',
          demandId: soLine.id,
          itemId: item.id,
          locationId: sellable.id,
          warehouseId: warehouse.id,
          uom: DEMO_FINISHED_GOOD.defaultUom,
          quantityReserved: DEMO_FLOW_QUANTITY,
          allowBackorder: false,
          notes: 'Demo reservation for exactly 1,000 milk chocolate bars.',
        },
      ],
    },
  })
  const reservation = result.data[0]
  if (!reservation) throw new Error('Demo reservation was not created')
  log.info(`Reservation ready (${reservation.id}, status=${reservation.status})`)
  return reservation
}

async function findShipmentByExternalRef(
  config: SeedConfig,
  token: string,
  externalRef: string,
): Promise<Shipment | null> {
  const list = await apiRequest<{ data?: Array<{ id: string; external_ref?: string; externalRef?: string }> }>(
    config,
    'GET',
    '/shipments',
    { token, params: { limit: 100, offset: 0 } },
  )
  const summary = (list.data ?? []).find((row) => (row.externalRef ?? row.external_ref) === externalRef)
  if (!summary) return null
  return apiRequest<Shipment>(config, 'GET', `/shipments/${summary.id}`, { token })
}

async function ensureDemoShipment(
  config: SeedConfig,
  token: string,
  log: ReturnType<typeof makeLogger>,
  so: SalesOrder,
  sellable: Location,
): Promise<Shipment> {
  const existing = await findShipmentByExternalRef(config, token, DEMO_FLOW_IDS.shipmentExternalRef)
  if (existing) {
    log.info(`Shipment exists: ${DEMO_FLOW_IDS.shipmentExternalRef} (${existing.id}, status=${existing.status})`)
    return existing
  }
  const soLine = so.lines[0]
  if (!soLine) throw new Error('Demo sales order has no lines')

  const created = await apiRequest<Shipment>(config, 'POST', '/shipments', {
    token,
    body: {
      salesOrderId: so.id,
      shippedAt: DEMO_DATES.shippedAt,
      shipFromLocationId: sellable.id,
      externalRef: DEMO_FLOW_IDS.shipmentExternalRef,
      autoAllocateReservations: true,
      notes: 'Demo shipment for exactly 1,000 milk chocolate bars.',
      lines: [
        {
          salesOrderLineId: soLine.id,
          uom: DEMO_FINISHED_GOOD.defaultUom,
          quantityShipped: DEMO_FLOW_QUANTITY,
        },
      ],
    },
  })
  log.info(`Shipment created: ${DEMO_FLOW_IDS.shipmentExternalRef} (${created.id})`)
  return created
}

async function ensureDemoShipmentPosted(
  config: SeedConfig,
  token: string,
  log: ReturnType<typeof makeLogger>,
  shipment: Shipment,
): Promise<Shipment> {
  if (shipment.status === 'posted' && shipment.inventoryMovementId) {
    log.info(`Shipment already posted: ${DEMO_FLOW_IDS.shipmentExternalRef} (${shipment.inventoryMovementId})`)
    return shipment
  }
  const posted = await apiRequest<Shipment>(config, 'POST', `/shipments/${shipment.id}/post`, {
    token,
    idempotencyKey: 'seed:siamaya:milk-chocolate-1000:shipment-post:v1',
    body: {},
  })
  log.info(`Shipment posted: ${DEMO_FLOW_IDS.shipmentExternalRef} (${posted.inventoryMovementId})`)
  return posted
}

async function markDemoSalesOrderShipped(tenantId: string, shipment: Shipment) {
  if (shipment.status !== 'posted' || !shipment.inventoryMovementId) return
  await withDbClient(async (client) => {
    await client.query(
      `UPDATE sales_orders
          SET status = 'shipped',
              updated_at = now()
        WHERE tenant_id = $1
          AND so_number = $2
          AND status <> 'shipped'`,
      [tenantId, DEMO_SO.number],
    )
  })
}

async function findDemoWorkOrder(tenantId: string) {
  return withDbClient(async (client) => {
    const result = await client.query<{ id: string; status: string }>(
      `SELECT id, status
         FROM work_orders
        WHERE tenant_id = $1
          AND description = $2
        ORDER BY created_at ASC
        LIMIT 1`,
      [tenantId, DEMO_FLOW_IDS.workOrderDescription],
    )
    return result.rows[0] ?? null
  })
}

async function ensureDemoWorkOrder(
  config: SeedConfig,
  token: string,
  tenantId: string,
  log: ReturnType<typeof makeLogger>,
  finishedItem: Item,
  bom: Bom,
  consumeLocation: Location,
  produceLocation: Location,
) {
  const existing = await findDemoWorkOrder(tenantId)
  if (existing) {
    log.info(`Work order exists: ${existing.id} (${existing.status})`)
    return existing
  }
  const activeVersion = bom.versions.find((version) => version.status === 'active') ?? bom.versions[0]
  const created = await apiRequest<{ id: string; status: string }>(config, 'POST', '/work-orders', {
    token,
    body: {
      kind: 'production',
      bomId: bom.id,
      bomVersionId: activeVersion?.id,
      outputItemId: finishedItem.id,
      outputUom: DEMO_FINISHED_GOOD.defaultUom,
      quantityPlanned: DEMO_FLOW_QUANTITY,
      defaultConsumeLocationId: consumeLocation.id,
      defaultProduceLocationId: produceLocation.id,
      scheduledStartAt: DEMO_DATES.receiptAt,
      scheduledDueAt: DEMO_DATES.requestedShipDate,
      description: DEMO_FLOW_IDS.workOrderDescription,
    },
  })
  log.info(`Work order created: ${created.id} (${created.status})`)
  return created
}

async function hasDemoProductionReport(tenantId: string, workOrderId: string) {
  return withDbClient(async (client) => {
    const result = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM work_order_executions
        WHERE tenant_id = $1
          AND work_order_id = $2
          AND idempotency_key = $3
          AND status = 'posted'`,
      [tenantId, workOrderId, 'seed:siamaya:milk-chocolate-1000:report-production:v1'],
    )
    return Number(result.rows[0]?.count ?? 0) > 0
  })
}

async function ensureDemoProductionReported(
  config: SeedConfig,
  token: string,
  tenantId: string,
  log: ReturnType<typeof makeLogger>,
  workOrderId: string,
) {
  if (await hasDemoProductionReport(tenantId, workOrderId)) {
    log.info(`Production report exists for work order: ${workOrderId}`)
    return
  }
  const idempotencyKey = 'seed:siamaya:milk-chocolate-1000:report-production:v1'
  const result = await apiRequest<{ productionReportId: string; replayed?: boolean }>(
    config,
    'POST',
    `/work-orders/${workOrderId}/report-production`,
    {
      token,
      idempotencyKey,
      body: {
        warehouseId: undefined,
        outputQty: DEMO_FLOW_QUANTITY,
        outputUom: DEMO_FINISHED_GOOD.defaultUom,
        productionBatchId: 'SIAMAYA-MILK-CHOC-1000-BATCH',
        outputLotCode: 'SIAMAYA-MILK-CHOC-1000-LOT',
        occurredAt: DEMO_DATES.productionAt,
        notes: 'Seeded completed demo production for 1,000 Milk Chocolate Bar 75g units.',
        idempotencyKey,
      },
    },
  )
  log.info(`Production reported: ${result.productionReportId}`)
}

async function countBusinessWorkflowRecords(tenantId: string) {
  return withDbClient(async (client) => {
    const result = await client.query<Record<string, string>>(
      `SELECT
         (SELECT COUNT(*)::text FROM purchase_orders WHERE tenant_id = $1) AS purchase_orders,
         (SELECT COUNT(*)::text FROM purchase_order_receipts WHERE tenant_id = $1) AS purchase_order_receipts,
         (SELECT COUNT(*)::text FROM work_orders WHERE tenant_id = $1) AS work_orders,
         (SELECT COUNT(*)::text FROM sales_orders WHERE tenant_id = $1) AS sales_orders,
         (SELECT COUNT(*)::text FROM inventory_reservations WHERE tenant_id = $1) AS inventory_reservations,
         (SELECT COUNT(*)::text FROM sales_order_shipments WHERE tenant_id = $1) AS sales_order_shipments`,
      [tenantId],
    )
    const row = result.rows[0] ?? {}
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]))
  })
}

async function assertManualWorkflowPrerequisitesOnly(tenantId: string) {
  return withDbClient(async (client) => {
    const result = await client.query<Record<string, string>>(
      `SELECT
         (SELECT COUNT(*)::text
            FROM purchase_orders
           WHERE tenant_id = $1
             AND po_number = $2) AS demo_po,
         (SELECT COUNT(*)::text
            FROM purchase_order_receipts por
            JOIN purchase_orders po
              ON po.id = por.purchase_order_id
             AND po.tenant_id = por.tenant_id
           WHERE por.tenant_id = $1
             AND po.po_number = $2) AS receipts_linked_to_demo_po,
         (SELECT COUNT(*)::text
            FROM work_orders
           WHERE tenant_id = $1
             AND description = $5) AS demo_work_orders,
         (SELECT COUNT(*)::text
            FROM sales_orders
           WHERE tenant_id = $1
             AND so_number = $3) AS demo_so,
         (SELECT COUNT(*)::text
            FROM inventory_reservations r
            JOIN sales_order_lines sol
              ON sol.id = r.demand_id
             AND sol.tenant_id = r.tenant_id
            JOIN sales_orders so
              ON so.id = sol.sales_order_id
             AND so.tenant_id = sol.tenant_id
           WHERE r.tenant_id = $1
             AND so.so_number = $3) AS reservations_linked_to_demo_so,
         (SELECT COUNT(*)::text
            FROM sales_order_shipments
           WHERE tenant_id = $1
             AND external_ref = $4) AS demo_shipments`,
      [tenantId, DEMO_PO.number, DEMO_SO.number, DEMO_FLOW_IDS.shipmentExternalRef, DEMO_FLOW_IDS.workOrderDescription],
    )
    const row = Object.fromEntries(
      Object.entries(result.rows[0] ?? {}).map(([key, value]) => [key, Number(value)]),
    )
    const failures = Object.entries(row).filter(([key, value]) => {
      if (key === 'demo_po' || key === 'demo_so') return value !== 1
      return value !== 0
    })
    if (failures.length > 0) {
      throw new Error(
        `Manual seed prerequisite-only verification failed: ${failures
          .map(([key, value]) => `${key}=${value}`)
          .join(', ')}`,
      )
    }
    return row
  })
}

async function verifyManualTopologyAndBom(tenantId: string) {
  return withDbClient(async (client) => {
    const result = await client.query<{
      location_failures: string | null
      bom_active_versions: string
      bom_lines: string
      mass_conversions: string
    }>(
      `WITH expected_locations(code, role, sellable) AS (
         VALUES
           ('FACTORY_RECEIVING', 'HOLD', false),
           ('FACTORY_RM_STORE', 'SELLABLE', true),
           ('FACTORY_PACK_STORE', 'PACKAGING', false),
           ('FACTORY_PRODUCTION', 'WIP', false),
           ('FACTORY_FG_STAGE', 'FG_SELLABLE', true),
           ('FACTORY_SHIPPING', 'FG_SELLABLE', true)
       ),
       location_checks AS (
         SELECT e.code,
                l.id,
                l.role,
                l.is_sellable
           FROM expected_locations e
           LEFT JOIN locations l
             ON l.tenant_id = $1
            AND l.code = e.code
            AND l.role = e.role
            AND l.is_sellable = e.sellable
       ),
       demo_bom AS (
         SELECT b.id
           FROM boms b
           JOIN items i
             ON i.id = b.output_item_id
            AND i.tenant_id = b.tenant_id
          WHERE b.tenant_id = $1
            AND b.bom_code = $2
            AND i.sku = $3
       ),
       active_versions AS (
         SELECT bv.id
           FROM bom_versions bv
           JOIN demo_bom b ON b.id = bv.bom_id
          WHERE bv.tenant_id = $1
            AND bv.status = 'active'
       ),
       mass_items AS (
         SELECT id
           FROM items
          WHERE tenant_id = $1
            AND sku = ANY($4::text[])
       )
       SELECT
         (SELECT string_agg(code, ', ' ORDER BY code)
            FROM location_checks
           WHERE id IS NULL) AS location_failures,
         (SELECT COUNT(*)::text FROM active_versions) AS bom_active_versions,
         (SELECT COUNT(*)::text
            FROM bom_version_lines bvl
            JOIN active_versions av ON av.id = bvl.bom_version_id
           WHERE bvl.tenant_id = $1) AS bom_lines,
         (SELECT COUNT(*)::text
            FROM uom_conversions uc
            JOIN mass_items mi ON mi.id = uc.item_id
           WHERE uc.tenant_id = $1
             AND uc.from_uom = 'kg'
             AND uc.to_uom = 'g'
             AND uc.factor = 1000) AS mass_conversions`,
      [
        tenantId,
        DEMO_BOM_CODE,
        DEMO_FINISHED_GOOD.sku,
        DEMO_BOM_COMPONENTS.filter((component) => component.dimension === 'mass').map((component) => component.sku),
      ],
    )
    const row = result.rows[0]
    const failures: string[] = []
    if (row?.location_failures) failures.push(`location topology missing/incorrect: ${row.location_failures}`)
    if (Number(row?.bom_active_versions ?? 0) < 1) failures.push('active BOM version missing')
    if (Number(row?.bom_lines ?? 0) !== DEMO_BOM_COMPONENTS.length) {
      failures.push(`BOM line count ${row?.bom_lines}`)
    }
    const expectedMassConversions = DEMO_BOM_COMPONENTS.filter((component) => component.dimension === 'mass').length
    if (Number(row?.mass_conversions ?? 0) !== expectedMassConversions) {
      failures.push(`mass UOM conversions ${row?.mass_conversions}`)
    }
    if (failures.length > 0) {
      throw new Error(`Manual seed prerequisite verification failed: ${failures.join('; ')}`)
    }
    return row
  })
}

async function ensureMilkChocolateManufacturingPrerequisites(
  config: SeedConfig,
  token: string,
  tenantId: string,
  log: ReturnType<typeof makeLogger>,
) {
  await ensureStandardWarehouseTemplate(config, token, log)
  const { warehouse, sellable, qa } = await getDemoWarehouseContext(tenantId)
  const operations = await ensureOperationalLocations(config, token, log, warehouse)
  const vendor = await ensureVendor(config, token, log)
  const customer = await ensureCustomer(tenantId, log)
  const finishedItem = await ensureItem(config, token, log, {
    sku: DEMO_FINISHED_GOOD.sku,
    name: DEMO_FINISHED_GOOD.name,
    description: '75 g Siamaya demo milk chocolate bar used for 1,000-bar workflows.',
    type: DEMO_FINISHED_GOOD.type,
    defaultUom: DEMO_FINISHED_GOOD.defaultUom,
    uomDimension: DEMO_FINISHED_GOOD.uomDimension,
    canonicalUom: DEMO_FINISHED_GOOD.canonicalUom,
    stockingUom: DEMO_FINISHED_GOOD.stockingUom,
    defaultLocationId: operations.fgStage.id,
    weight: DEMO_FINISHED_GOOD.weight,
    weightUom: DEMO_FINISHED_GOOD.weightUom,
    isPurchasable: DEMO_FINISHED_GOOD.isPurchasable,
    isManufactured: DEMO_FINISHED_GOOD.isManufactured,
  })

  const componentItems: Array<{
    spec: (typeof DEMO_BOM_COMPONENTS)[number]
    item: Item
    location: Location
  }> = []
  for (const spec of DEMO_BOM_COMPONENTS) {
    const location = operations.rawStore
    const item = await ensureItem(config, token, log, {
      sku: spec.sku,
      name: spec.name,
      type: spec.type,
      defaultUom: spec.uom,
      uomDimension: spec.dimension,
      canonicalUom: spec.uom,
      stockingUom: spec.uom,
      defaultLocationId: location.id,
      isPurchasable: true,
      isManufactured: false,
    })
    if (spec.dimension === 'mass') {
      await ensureUomConversion(config, token, log, item.id, 'kg', 'g', 1000)
    }
    componentItems.push({ spec, item, location })
  }

  const bom = await ensureBom(config, token, log, {
    bomCode: DEMO_BOM_CODE,
    outputItemId: finishedItem.id,
    defaultUom: DEMO_FINISHED_GOOD.defaultUom,
    version: {
      yieldQuantity: 1,
      yieldUom: DEMO_FINISHED_GOOD.defaultUom,
      components: componentItems.map(({ spec, item }, index) => ({
        lineNumber: index + 1,
        componentItemId: item.id,
        uom: spec.uom,
        quantityPer: spec.quantityPer,
      })),
    },
  })

  return { warehouse, sellable, qa, operations, vendor, customer, finishedItem, componentItems, bom }
}

async function verifyDemoSeed(tenantId: string) {
  return withDbClient(async (client) => {
    const result = await client.query<{
      po_line_count: string | null
      po_component_total_ok: string | null
      so_quantity: string | null
      shipped_quantity: string | null
      consumed_line_count: string | null
      consumed_component_total_ok: string | null
      negative_balance_count: string | null
      backorder_count: string | null
      reservation_status: string | null
      reservation_qty: string | null
      fulfilled_qty: string | null
      shipment_status: string | null
      shipment_movement_id: string | null
      sellable_on_hand: string | null
      sellable_available: string | null
    }>(
      `WITH demo_item AS (
         SELECT id FROM items WHERE tenant_id = $1 AND sku = $2
       ),
       demo_components AS (
         SELECT i.id, i.sku, v.required_qty, v.uom
           FROM (VALUES ${DEMO_BOM_COMPONENTS.map((_, index) => `($${7 + index * 3}::text, $${8 + index * 3}::numeric, $${9 + index * 3}::text)`).join(', ')}) AS v(sku, required_qty, uom)
           JOIN items i
             ON i.tenant_id = $1
            AND i.sku = v.sku
       ),
       demo_po AS (
         SELECT po.id
           FROM purchase_orders po
          WHERE po.tenant_id = $1
            AND po.po_number = $3
       ),
       demo_so AS (
         SELECT so.id
           FROM sales_orders so
          WHERE so.tenant_id = $1
            AND so.so_number = $4
       ),
       demo_shipment AS (
         SELECT s.id, s.status, s.inventory_movement_id
           FROM sales_order_shipments s
          WHERE s.tenant_id = $1
            AND s.external_ref = $5
       )
       SELECT
         (SELECT COUNT(*)::text
            FROM purchase_order_lines pol
            JOIN demo_po po ON po.id = pol.purchase_order_id
            JOIN demo_components c ON c.id = pol.item_id
           WHERE pol.tenant_id = $1) AS po_line_count,
         (SELECT COUNT(*)::text
            FROM purchase_order_lines pol
            JOIN demo_po po ON po.id = pol.purchase_order_id
            JOIN demo_components c
              ON c.id = pol.item_id
             AND c.uom = pol.uom
             AND ABS(c.required_qty - pol.quantity_ordered) < 0.000001
           WHERE pol.tenant_id = $1) AS po_component_total_ok,
         (SELECT SUM(sol.quantity_ordered)::text
            FROM sales_order_lines sol
            JOIN demo_so so ON so.id = sol.sales_order_id
            JOIN demo_item i ON i.id = sol.item_id
           WHERE sol.tenant_id = $1 AND sol.uom = $6) AS so_quantity,
         (SELECT SUM(ssl.quantity_shipped)::text
            FROM sales_order_shipment_lines ssl
            JOIN demo_shipment s ON s.id = ssl.sales_order_shipment_id
            JOIN sales_order_lines sol ON sol.id = ssl.sales_order_line_id AND sol.tenant_id = ssl.tenant_id
            JOIN demo_item i ON i.id = sol.item_id
           WHERE ssl.tenant_id = $1 AND ssl.uom = $6) AS shipped_quantity,
         (SELECT COUNT(*)::text
            FROM inventory_movement_lines iml
            JOIN inventory_movements im
              ON im.id = iml.movement_id
             AND im.tenant_id = iml.tenant_id
            JOIN demo_components c
              ON c.id = iml.item_id
             AND c.uom = iml.uom
             AND ABS(c.required_qty + iml.quantity_delta) < 0.000001
           WHERE iml.tenant_id = $1
             AND im.source_type = 'work_order_batch_post_issue') AS consumed_component_total_ok,
         (SELECT COUNT(*)::text
            FROM inventory_movement_lines iml
            JOIN inventory_movements im
              ON im.id = iml.movement_id
             AND im.tenant_id = iml.tenant_id
            JOIN demo_components c ON c.id = iml.item_id
           WHERE iml.tenant_id = $1
             AND im.source_type = 'work_order_batch_post_issue') AS consumed_line_count,
         (SELECT COUNT(*)::text
            FROM inventory_balance
           WHERE tenant_id = $1
             AND on_hand < -0.000001) AS negative_balance_count,
         (SELECT COUNT(*)::text
            FROM inventory_backorders
           WHERE tenant_id = $1
             AND status NOT IN ('fulfilled', 'cancelled', 'canceled')) AS backorder_count,
         (SELECT r.status
            FROM inventory_reservations r
            JOIN sales_order_lines sol ON sol.id = r.demand_id AND sol.tenant_id = r.tenant_id
            JOIN demo_so so ON so.id = sol.sales_order_id
            JOIN demo_item i ON i.id = r.item_id
           WHERE r.tenant_id = $1
           ORDER BY r.created_at DESC
           LIMIT 1) AS reservation_status,
         (SELECT r.quantity_reserved::text
            FROM inventory_reservations r
            JOIN sales_order_lines sol ON sol.id = r.demand_id AND sol.tenant_id = r.tenant_id
            JOIN demo_so so ON so.id = sol.sales_order_id
            JOIN demo_item i ON i.id = r.item_id
           WHERE r.tenant_id = $1
           ORDER BY r.created_at DESC
           LIMIT 1) AS reservation_qty,
         (SELECT r.quantity_fulfilled::text
            FROM inventory_reservations r
            JOIN sales_order_lines sol ON sol.id = r.demand_id AND sol.tenant_id = r.tenant_id
            JOIN demo_so so ON so.id = sol.sales_order_id
            JOIN demo_item i ON i.id = r.item_id
           WHERE r.tenant_id = $1
           ORDER BY r.created_at DESC
           LIMIT 1) AS fulfilled_qty,
         (SELECT status FROM demo_shipment LIMIT 1) AS shipment_status,
         (SELECT inventory_movement_id::text FROM demo_shipment LIMIT 1) AS shipment_movement_id,
         (SELECT ib.on_hand::text
            FROM inventory_balance ib
            JOIN demo_item i ON i.id = ib.item_id
            JOIN locations l ON l.id = ib.location_id AND l.tenant_id = ib.tenant_id
           WHERE ib.tenant_id = $1
             AND l.role = 'SELLABLE'
             AND ib.uom = $6
           ORDER BY ib.updated_at DESC NULLS LAST
           LIMIT 1) AS sellable_on_hand,
         (SELECT (ib.on_hand - ib.reserved - ib.allocated)::text
            FROM inventory_balance ib
            JOIN demo_item i ON i.id = ib.item_id
            JOIN locations l ON l.id = ib.location_id AND l.tenant_id = ib.tenant_id
           WHERE ib.tenant_id = $1
             AND l.role = 'SELLABLE'
             AND ib.uom = $6
           ORDER BY ib.updated_at DESC NULLS LAST
           LIMIT 1) AS sellable_available`,
      [
        tenantId,
        DEMO_FINISHED_GOOD.sku,
        DEMO_PO.number,
        DEMO_SO.number,
        DEMO_FLOW_IDS.shipmentExternalRef,
        DEMO_FINISHED_GOOD.defaultUom,
        ...DEMO_BOM_COMPONENTS.flatMap((component) => [
          component.sku,
          componentRequirement(component.quantityPer),
          component.uom,
        ]),
      ],
    )
    const row = result.rows[0]
    const expected = String(DEMO_FLOW_QUANTITY)
    const failures: string[] = []
    if (Number(row?.po_line_count ?? 0) !== DEMO_BOM_COMPONENTS.length) failures.push(`PO line count ${row?.po_line_count}`)
    if (Number(row?.po_component_total_ok ?? 0) !== DEMO_BOM_COMPONENTS.length) {
      failures.push(`PO component totals ${row?.po_component_total_ok}`)
    }
    if (Number(row?.so_quantity ?? 0) !== DEMO_FLOW_QUANTITY) failures.push(`SO quantity ${row?.so_quantity}`)
    if (Number(row?.shipped_quantity ?? 0) !== DEMO_FLOW_QUANTITY) {
      failures.push(`shipped quantity ${row?.shipped_quantity}`)
    }
    if (Number(row?.consumed_line_count ?? 0) !== DEMO_BOM_COMPONENTS.length) {
      failures.push(`consumed line count ${row?.consumed_line_count}`)
    }
    if (Number(row?.consumed_component_total_ok ?? 0) !== DEMO_BOM_COMPONENTS.length) {
      failures.push(`consumed component totals ${row?.consumed_component_total_ok}`)
    }
    if (Number(row?.negative_balance_count ?? 0) !== 0) failures.push(`negative balances ${row?.negative_balance_count}`)
    if (Number(row?.backorder_count ?? 0) !== 0) failures.push(`backorders ${row?.backorder_count}`)
    if (row?.reservation_status !== 'FULFILLED') failures.push(`reservation status ${row?.reservation_status}`)
    if (Number(row?.reservation_qty ?? 0) !== DEMO_FLOW_QUANTITY) failures.push(`reservation qty ${row?.reservation_qty}`)
    if (Number(row?.fulfilled_qty ?? 0) !== DEMO_FLOW_QUANTITY) failures.push(`fulfilled qty ${row?.fulfilled_qty}`)
    if (row?.shipment_status !== 'posted') failures.push(`shipment status ${row?.shipment_status}`)
    if (!row?.shipment_movement_id) failures.push('shipment movement missing')
    if (failures.length > 0) {
      throw new Error(`Demo seed verification failed: ${failures.join(', ')}; expected ${expected} ${DEMO_FINISHED_GOOD.defaultUom}`)
    }
    return row
  })
}

async function seedMilkChocolateDemo(
  config: SeedConfig,
  token: string,
  tenantId: string,
  log: ReturnType<typeof makeLogger>,
) {
  const context = await ensureMilkChocolateManufacturingPrerequisites(
    config,
    token,
    tenantId,
    log,
  )
  const { warehouse, vendor, customer, finishedItem, componentItems, bom, operations } = context
  const po = await ensureDemoPurchaseOrder(config, token, log, vendor, componentItems, warehouse)
  const receipt = await ensureDemoReceipt(config, token, log, po, componentItems)
  await ensureDemoQcAccepted(config, token, log, receipt)
  const workOrder = await ensureDemoWorkOrder(
    config,
    token,
    tenantId,
    log,
    finishedItem,
    bom,
    context.sellable,
    operations.fgStage,
  )
  await ensureDemoProductionReported(config, token, tenantId, log, workOrder.id)
  const so = await ensureDemoSalesOrder(config, token, log, customer, finishedItem, warehouse, operations.fgStage)
  await ensureDemoReservation(config, token, log, so, finishedItem, warehouse, operations.fgStage)
  const shipment = await ensureDemoShipment(config, token, log, so, operations.fgStage)
  const postedShipment = await ensureDemoShipmentPosted(config, token, log, shipment)
  await markDemoSalesOrderShipped(tenantId, postedShipment)
  const verification = await verifyDemoSeed(tenantId)
  log.info('Milk chocolate demo verification passed.', verification)
}

async function verifyManualSeed(
  config: SeedConfig,
  token: string,
  tenantId: string,
  log: ReturnType<typeof makeLogger>,
  context: Awaited<ReturnType<typeof ensureMilkChocolateManufacturingPrerequisites>>,
) {
  const countsAfter = await countBusinessWorkflowRecords(tenantId)
  const workflowPrerequisitesOnly = await assertManualWorkflowPrerequisitesOnly(tenantId)
  const prerequisiteVerification = await verifyManualTopologyAndBom(tenantId)

  const itemVisible = await findItemBySku(config, token, DEMO_FINISHED_GOOD.sku)
  if (!itemVisible) throw new Error(`Manual seed item is not visible through API: ${DEMO_FINISHED_GOOD.sku}`)
  const vendors = await apiRequest<{ data?: Vendor[] } | Vendor[]>(config, 'GET', '/vendors', {
    token,
    params: { active: true },
  })
  const vendorRows = Array.isArray(vendors) ? vendors : vendors.data ?? []
  if (!vendorRows.some((row) => row.code === DEMO_SUPPLIER.code)) {
    throw new Error(`Manual seed supplier is not visible through API: ${DEMO_SUPPLIER.code}`)
  }
  const rawStoreVisible = await findLocationByCode(config, token, MANUAL_DEMO.rawMaterialLocationCodes.rawStore)
  if (!rawStoreVisible) throw new Error('Manual seed raw material location is not visible through API')

  log.info('Manual Siamaya prerequisite verification passed.', {
    transactionalRecordCounts: countsAfter,
    workflowPrerequisitesOnly,
    prerequisiteVerification,
    finishedItemSku: context.finishedItem.sku,
    supplierCode: context.vendor.code,
    customerCode: context.customer.code,
    warehouseCode: context.warehouse.code,
  })
}

async function seedManualSiamayaScenario(
  config: SeedConfig,
  token: string,
  tenantId: string,
  log: ReturnType<typeof makeLogger>,
) {
  const context = await ensureMilkChocolateManufacturingPrerequisites(config, token, tenantId, log)
  await ensureDemoPurchaseOrder(config, token, log, context.vendor, context.componentItems, context.warehouse)
  await ensureDemoSalesOrder(
    config,
    token,
    log,
    context.customer,
    context.finishedItem,
    context.warehouse,
    context.operations.fgStage,
  )
  await verifyManualSeed(config, token, tenantId, log, context)
  log.info('Siamaya manual UI scenario seed complete.')
}

function printDemoSummary(config: SeedConfig, adminEmail: string, mode: SeedMode) {
  console.log('')
  console.log('Siamaya 1,000 Milk Chocolate Bar demo seed summary')
  console.log(`Tenant: ${config.tenantSlug}`)
  console.log(`Admin login: ${adminEmail}`)
  console.log(`Finished good SKU: ${DEMO_FINISHED_GOOD.sku}`)
  console.log(`BOM code: ${DEMO_BOM_CODE}`)
  console.log(`Purchase order: ${DEMO_PO.number}`)
  console.log(`Sales order: ${DEMO_SO.number}`)
  if (mode === 'manual') {
    console.log('Next manual demo steps:')
    console.log('1. Receive the purchase order ingredient and wrapper lines.')
    console.log('2. QC accept the received lines if the UI shows them in QA.')
    console.log('3. Put away ingredients and wrappers if the UI presents a putaway task.')
    console.log('4. Create or execute production for 1,000 bars using the active BOM.')
    console.log('5. Confirm finished goods are available in finished goods sellable stock.')
    console.log('6. Reserve 1,000 finished bars to the sales order.')
    console.log('7. Create and post the shipment for 1,000 bars.')
  } else {
    console.log(`Completed mode posted shipment: ${DEMO_FLOW_IDS.shipmentExternalRef}`)
  }
  console.log('')
}

export async function runChocolateSeed(overrides: Partial<SeedConfig> = {}) {
  assertNonProductionEnvironment('chocolate-seed')
  const config = { ...loadConfig(), ...overrides }
  const log = makeLogger(config.logLevel)

  log.info('Seed starting.', {
    mode: config.mode,
    tenantSlug: config.tenantSlug,
    adminEmail: config.adminEmail,
    reset: config.reset ? 'enabled' : 'disabled',
    authRepair: config.allowLocalAuthRepair ? 'enabled' : 'disabled',
  })

  if (config.reset) {
    await resetOperationalData(config, log)
  }

  const session = await ensureSession(config, log)
  const token = session.accessToken
  const tenantId = await resolveTenantId(config)
  log.info('Seed tenant context resolved.', {
    tenantSlug: config.tenantSlug,
    tenantId,
    adminEmail: session.adminEmail,
    reset: config.reset ? 'enabled' : 'disabled',
    authRepair: config.allowLocalAuthRepair ? 'enabled' : 'disabled',
  })

  if (config.mode === 'manual') {
    await seedManualSiamayaScenario(config, token, tenantId, log)
    printDemoSummary(config, session.adminEmail, 'manual')
    return
  }

  await seedMilkChocolateDemo(config, token, tenantId, log)
  printDemoSummary(config, session.adminEmail, 'completed')
  log.info('Chocolate canonical seed complete.')
}

if (require.main === module) {
  runChocolateSeed().catch((err) => {
    console.error('[choc-seed] Failed:', err)
    process.exit(1)
  })
}

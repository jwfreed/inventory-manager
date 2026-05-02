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
type SeedMode = 'completed' | 'manual'

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
  seedOpeningBalances: boolean
  openingBalanceMassG: number
  openingBalanceCount: number
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

const DEMO = {
  itemSku: 'SIAMAYA-MILK-CHOCOLATE-BAR',
  itemName: 'Milk Chocolate Bar',
  vendorCode: 'SIAMAYA-DEMO-CHOCOLATE-SUPPLIER',
  vendorName: 'Demo Chocolate Supplier',
  customerCode: 'SIAMAYA-DEMO-CUSTOMER',
  customerName: 'Demo Customer',
  poNumber: 'PO-COMPLETED-1000-MILK-CHOCOLATE',
  soNumber: 'SO-COMPLETED-1000-MILK-CHOCOLATE',
  shipmentExternalRef: 'SHIP-COMPLETED-1000-MILK-CHOCOLATE',
  quantity: 1000,
  uom: 'each',
  orderDate: '2026-01-15',
  expectedDate: '2026-01-16',
  receiptAt: '2026-01-16T09:00:00.000Z',
  qcAt: '2026-01-16T10:00:00.000Z',
  requestedShipDate: '2026-01-17',
  shippedAt: '2026-01-17T15:00:00.000Z',
}

const MANUAL_DEMO = {
  bomCode: 'SIAMAYA-BOM-MILK-CHOCOLATE-BAR',
  rawMaterialLocationCodes: {
    receiving: 'FACTORY_RECEIVING',
    rawStore: 'FACTORY_RM_STORE',
    packStore: 'FACTORY_PACK_STORE',
    production: 'FACTORY_PRODUCTION',
    fgStage: 'FACTORY_FG_STAGE',
  },
  components: [
    {
      key: 'cacaoNibs',
      sku: 'SIAMAYA-MILK-CHOC-CACAO-NIBS',
      name: 'Milk Chocolate Cacao Nibs',
      type: 'raw' as const,
      uom: 'g',
      dimension: 'mass' as const,
      quantityPer: 30,
      topUpQuantity: 33000,
      store: 'rawStore' as const,
    },
    {
      key: 'sugar',
      sku: 'SIAMAYA-MILK-CHOC-SUGAR',
      name: 'Milk Chocolate Sugar',
      type: 'raw' as const,
      uom: 'g',
      dimension: 'mass' as const,
      quantityPer: 20,
      topUpQuantity: 22000,
      store: 'rawStore' as const,
    },
    {
      key: 'milkPowder',
      sku: 'SIAMAYA-MILK-CHOC-MILK-POWDER',
      name: 'Milk Chocolate Milk Powder',
      type: 'raw' as const,
      uom: 'g',
      dimension: 'mass' as const,
      quantityPer: 15,
      topUpQuantity: 16500,
      store: 'rawStore' as const,
    },
    {
      key: 'cacaoButter',
      sku: 'SIAMAYA-MILK-CHOC-CACAO-BUTTER',
      name: 'Milk Chocolate Cacao Butter',
      type: 'raw' as const,
      uom: 'g',
      dimension: 'mass' as const,
      quantityPer: 10,
      topUpQuantity: 11000,
      store: 'rawStore' as const,
    },
    {
      key: 'lecithin',
      sku: 'SIAMAYA-MILK-CHOC-LECITHIN',
      name: 'Milk Chocolate Lecithin',
      type: 'raw' as const,
      uom: 'g',
      dimension: 'mass' as const,
      quantityPer: 0.5,
      topUpQuantity: 600,
      store: 'rawStore' as const,
    },
    {
      key: 'foilWrap',
      sku: 'SIAMAYA-MILK-CHOC-FOIL-WRAP',
      name: 'Milk Chocolate Foil Wrapper',
      type: 'packaging' as const,
      uom: 'each',
      dimension: 'count' as const,
      quantityPer: 1,
      topUpQuantity: 1100,
      store: 'packStore' as const,
    },
  ],
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
  const seedOpeningBalances = parseBool(process.env.SEED_OPENING_BALANCE)
  const openingBalanceMassG = Number(process.env.OPENING_BALANCE_MASS_G || '0')
  const openingBalanceCount = Number(process.env.OPENING_BALANCE_COUNT || '0')
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
    seedOpeningBalances,
    openingBalanceMassG,
    openingBalanceCount,
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

async function createOpeningBalance(
  config: SeedConfig,
  token: string,
  item: Item,
  locationId: string,
  uom: string,
  quantity: number,
) {
  const now = new Date().toISOString()
  const adjustment = await apiRequest<{ id: string }>(config, 'POST', '/inventory-adjustments', {
    token,
    body: {
      occurredAt: now,
      notes: `opening_balance:${now}`,
      lines: [
        {
          itemId: item.id,
          locationId,
          uom,
          quantityDelta: quantity,
          reasonCode: 'opening_balance',
          notes: `opening_balance:${now}`,
        },
      ],
    },
  })
  await apiRequest(config, 'POST', `/inventory-adjustments/${adjustment.id}/post`, { token, body: {} })
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
    { role: 'RM_STORE', parentLocationId: warehouse.id, isSellable: false },
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

  return { receiving, rawStore, packStore, production, fgStage }
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
  const existing = rows.find((row) => row.code === DEMO.vendorCode)
  if (existing) {
    log.info(`Vendor exists: ${DEMO.vendorCode} (${existing.id})`)
    return existing
  }

  const created = await apiRequest<Vendor>(config, 'POST', '/vendors', {
    token,
    body: {
      code: DEMO.vendorCode,
      name: DEMO.vendorName,
      email: 'supplier@example.test',
      contactName: 'Demo Supplier Contact',
      notes: 'Seeded supplier for 1,000 milk chocolate bar demo.',
    },
  })
  log.info(`Vendor created: ${DEMO.vendorCode} (${created.id})`)
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
      [DEMO.customerCode, tenantId],
    )
    if (existing.rows[0]) {
      log.info(`Customer exists: ${DEMO.customerCode} (${existing.rows[0].id})`)
      return existing.rows[0]
    }

    const conflicting = await client.query<Customer>(
      `SELECT id, code, name
         FROM customers
        WHERE code = $1
          AND tenant_id <> $2
        LIMIT 1`,
      [DEMO.customerCode, tenantId],
    )
    if (conflicting.rows[0]) {
      throw new Error(`Customer code ${DEMO.customerCode} already exists for a different tenant`)
    }

    const id = uuidv4()
    const created = await client.query<Customer>(
      `INSERT INTO customers (id, tenant_id, code, name, email, phone, active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, true, now(), now())
       RETURNING id, code, name`,
      [id, tenantId, DEMO.customerCode, DEMO.customerName, 'customer@example.test', '+1-555-0100'],
    )
    log.info(`Customer created: ${DEMO.customerCode} (${id})`)
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
  item: Item,
  warehouse: Location,
): Promise<PurchaseOrder> {
  const existing = await findPurchaseOrderByNumber(config, token, DEMO.poNumber)
  if (existing) {
    log.info(`Purchase order exists: ${DEMO.poNumber} (${existing.id})`)
    return existing
  }

  const created = await apiRequest<PurchaseOrder>(config, 'POST', '/purchase-orders', {
    token,
    body: {
      poNumber: DEMO.poNumber,
      vendorId: vendor.id,
      status: 'submitted',
      orderDate: DEMO.orderDate,
      expectedDate: DEMO.expectedDate,
      shipToLocationId: warehouse.id,
      receivingLocationId: warehouse.id,
      vendorReference: 'DEMO-PO-1000-BARS',
      notes: 'Demo purchase order for exactly 1,000 milk chocolate bars.',
      lines: [
        {
          lineNumber: 1,
          itemId: item.id,
          uom: DEMO.uom,
          quantityOrdered: DEMO.quantity,
          unitCost: 1.5,
          currencyCode: 'THB',
          notes: 'Demo inbound finished goods.',
        },
      ],
    },
  })
  log.info(`Purchase order created: ${DEMO.poNumber} (${created.id})`)
  return created
}

async function ensureDemoReceipt(
  config: SeedConfig,
  token: string,
  log: ReturnType<typeof makeLogger>,
  po: PurchaseOrder,
): Promise<Receipt> {
  const poLine = po.lines[0]
  if (!poLine) throw new Error('Demo purchase order has no lines')
  const idempotencyKey = 'seed:siamaya:milk-chocolate-1000:receipt:v1'
  const receipt = await apiRequest<Receipt>(config, 'POST', '/purchase-order-receipts', {
    token,
    idempotencyKey,
    body: {
      purchaseOrderId: po.id,
      receivedAt: DEMO.receiptAt,
      externalRef: 'RCPT-DEMO-1000-MILK-CHOCOLATE',
      notes: 'Demo receipt for exactly 1,000 milk chocolate bars.',
      idempotencyKey,
      lines: [
        {
          purchaseOrderLineId: poLine.id,
          uom: DEMO.uom,
          quantityReceived: DEMO.quantity,
          unitCost: 1.5,
        },
      ],
    },
  })
  log.info(`Receipt ready for ${DEMO.poNumber} (${receipt.id})`)
  return receipt
}

async function ensureDemoQcAccepted(
  config: SeedConfig,
  token: string,
  log: ReturnType<typeof makeLogger>,
  receipt: Receipt,
) {
  const receiptLine = receipt.lines[0]
  if (!receiptLine) throw new Error('Demo receipt has no lines')
  const idempotencyKey = 'seed:siamaya:milk-chocolate-1000:qc-accept:v1'
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
        quantity: DEMO.quantity,
        uom: DEMO.uom,
        reasonCode: 'demo_accept',
        notes: 'Demo QC accept for exactly 1,000 milk chocolate bars.',
        actorType: 'system',
        actorId: 'chocolate-seed',
      },
    },
  )
  log.info(`QC accept ready (${(result as any).eventId ?? (result as any).id})`)
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
  const existing = await findSalesOrderByNumber(config, token, DEMO.soNumber)
  if (existing) {
    log.info(`Sales order exists: ${DEMO.soNumber} (${existing.id})`)
    return existing
  }

  const created = await apiRequest<SalesOrder>(config, 'POST', '/sales-orders', {
    token,
    body: {
      soNumber: DEMO.soNumber,
      customerId: customer.id,
      warehouseId: warehouse.id,
      status: 'submitted',
      orderDate: DEMO.orderDate,
      requestedShipDate: DEMO.requestedShipDate,
      shipFromLocationId: sellable.id,
      customerReference: 'DEMO-CUSTOMER-PO-1000-BARS',
      notes: 'Demo sales order for exactly 1,000 milk chocolate bars.',
      lines: [
        {
          lineNumber: 1,
          itemId: item.id,
          uom: DEMO.uom,
          quantityOrdered: DEMO.quantity,
          unitPrice: 3.5,
          currencyCode: 'THB',
          notes: 'Demo outbound finished goods.',
        },
      ],
    },
  })
  log.info(`Sales order created: ${DEMO.soNumber} (${created.id})`)
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
          uom: DEMO.uom,
          quantityReserved: DEMO.quantity,
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
  const existing = await findShipmentByExternalRef(config, token, DEMO.shipmentExternalRef)
  if (existing) {
    log.info(`Shipment exists: ${DEMO.shipmentExternalRef} (${existing.id}, status=${existing.status})`)
    return existing
  }
  const soLine = so.lines[0]
  if (!soLine) throw new Error('Demo sales order has no lines')

  const created = await apiRequest<Shipment>(config, 'POST', '/shipments', {
    token,
    body: {
      salesOrderId: so.id,
      shippedAt: DEMO.shippedAt,
      shipFromLocationId: sellable.id,
      externalRef: DEMO.shipmentExternalRef,
      autoAllocateReservations: true,
      notes: 'Demo shipment for exactly 1,000 milk chocolate bars.',
      lines: [
        {
          salesOrderLineId: soLine.id,
          uom: DEMO.uom,
          quantityShipped: DEMO.quantity,
        },
      ],
    },
  })
  log.info(`Shipment created: ${DEMO.shipmentExternalRef} (${created.id})`)
  return created
}

async function ensureDemoShipmentPosted(
  config: SeedConfig,
  token: string,
  log: ReturnType<typeof makeLogger>,
  shipment: Shipment,
): Promise<Shipment> {
  if (shipment.status === 'posted' && shipment.inventoryMovementId) {
    log.info(`Shipment already posted: ${DEMO.shipmentExternalRef} (${shipment.inventoryMovementId})`)
    return shipment
  }
  const posted = await apiRequest<Shipment>(config, 'POST', `/shipments/${shipment.id}/post`, {
    token,
    idempotencyKey: 'seed:siamaya:milk-chocolate-1000:shipment-post:v1',
    body: {},
  })
  log.info(`Shipment posted: ${DEMO.shipmentExternalRef} (${posted.inventoryMovementId})`)
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
      [tenantId, DEMO.soNumber],
    )
  })
}

async function getInventoryOnHand(
  tenantId: string,
  itemId: string,
  locationId: string,
  uom: string,
): Promise<number> {
  return withDbClient(async (client) => {
    const res = await client.query<{ on_hand: string | null }>(
      `SELECT COALESCE(SUM(on_hand), 0)::text AS on_hand
         FROM inventory_balance
        WHERE tenant_id = $1
          AND item_id = $2
          AND location_id = $3
          AND uom = $4`,
      [tenantId, itemId, locationId, uom],
    )
    return Number(res.rows[0]?.on_hand ?? 0)
  })
}

async function topUpInventory(
  config: SeedConfig,
  token: string,
  tenantId: string,
  log: ReturnType<typeof makeLogger>,
  entry: { item: Item; location: Location; uom: string; targetOnHand: number; reasonCode: string },
) {
  const current = await getInventoryOnHand(tenantId, entry.item.id, entry.location.id, entry.uom)
  const delta = entry.targetOnHand - current
  if (delta <= 0) {
    log.info(`Inventory sufficient: ${entry.item.sku} at ${entry.location.code} (${current} ${entry.uom})`)
    return
  }
  const now = new Date().toISOString()
  const adjustment = await apiRequest<{ id: string }>(config, 'POST', '/inventory-adjustments', {
    token,
    body: {
      occurredAt: now,
      notes: `${entry.reasonCode}:manual_seed_top_up:${entry.item.sku}:${entry.location.code}`,
      lines: [
        {
          itemId: entry.item.id,
          locationId: entry.location.id,
          uom: entry.uom,
          quantityDelta: delta,
          reasonCode: entry.reasonCode,
          notes: `${entry.reasonCode}: top up to ${entry.targetOnHand} ${entry.uom} for Siamaya manual demo.`,
        },
      ],
    },
  })
  await apiRequest(config, 'POST', `/inventory-adjustments/${adjustment.id}/post`, { token, body: {} })
  log.info(`Inventory topped up: ${entry.item.sku} +${delta} ${entry.uom} at ${entry.location.code}`)
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

function assertCountsUnchanged(
  before: Record<string, number>,
  after: Record<string, number>,
) {
  const changed = Object.keys(before).filter((key) => before[key] !== after[key])
  if (changed.length > 0) {
    throw new Error(`Manual seed created or removed transactional records: ${changed.join(', ')}`)
  }
}

async function assertNoReservedManualWorkflowArtifacts(tenantId: string) {
  return withDbClient(async (client) => {
    const result = await client.query<Record<string, string>>(
      `SELECT
         (SELECT COUNT(*)::text
            FROM purchase_orders
           WHERE tenant_id = $1
             AND po_number LIKE 'PO-SIAMAYA-%') AS po_siamaya,
         (SELECT COUNT(*)::text
            FROM purchase_order_receipts por
            JOIN purchase_orders po
              ON po.id = por.purchase_order_id
             AND po.tenant_id = por.tenant_id
           WHERE por.tenant_id = $1
             AND po.po_number LIKE 'PO-SIAMAYA-%') AS receipts_linked_to_siamaya_po,
         (SELECT COUNT(*)::text
            FROM work_orders
           WHERE tenant_id = $1
             AND (
               work_order_number LIKE 'WO-SIAMAYA-%'
               OR COALESCE(number, '') LIKE 'WO-SIAMAYA-%'
             )) AS wo_siamaya,
         (SELECT COUNT(*)::text
            FROM sales_orders
           WHERE tenant_id = $1
             AND so_number LIKE 'SO-SIAMAYA-%') AS so_siamaya,
         (SELECT COUNT(*)::text
            FROM inventory_reservations r
            JOIN sales_order_lines sol
              ON sol.id = r.demand_id
             AND sol.tenant_id = r.tenant_id
            JOIN sales_orders so
              ON so.id = sol.sales_order_id
             AND so.tenant_id = sol.tenant_id
           WHERE r.tenant_id = $1
             AND so.so_number LIKE 'SO-SIAMAYA-%') AS reservations_linked_to_siamaya_so,
         (SELECT COUNT(*)::text
            FROM sales_order_shipments
           WHERE tenant_id = $1
             AND external_ref LIKE 'SHIP-SIAMAYA-%') AS ship_siamaya`,
      [tenantId],
    )
    const row = Object.fromEntries(
      Object.entries(result.rows[0] ?? {}).map(([key, value]) => [key, Number(value)]),
    )
    const failures = Object.entries(row).filter(([, value]) => value !== 0)
    if (failures.length > 0) {
      throw new Error(
        `Manual seed reserved-prefix verification failed: ${failures
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
           ('FACTORY_RM_STORE', 'RM_STORE', false),
           ('FACTORY_PACK_STORE', 'PACKAGING', false),
           ('FACTORY_PRODUCTION', 'WIP', false),
           ('FACTORY_FG_STAGE', 'FG_SELLABLE', true)
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
        MANUAL_DEMO.bomCode,
        DEMO.itemSku,
        MANUAL_DEMO.components.filter((component) => component.dimension === 'mass').map((component) => component.sku),
      ],
    )
    const row = result.rows[0]
    const failures: string[] = []
    if (row?.location_failures) failures.push(`location topology missing/incorrect: ${row.location_failures}`)
    if (Number(row?.bom_active_versions ?? 0) < 1) failures.push('active BOM version missing')
    if (Number(row?.bom_lines ?? 0) !== MANUAL_DEMO.components.length) {
      failures.push(`BOM line count ${row?.bom_lines}`)
    }
    const expectedMassConversions = MANUAL_DEMO.components.filter((component) => component.dimension === 'mass').length
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
  options: { topUpComponentInventory: boolean },
) {
  await ensureStandardWarehouseTemplate(config, token, log)
  const { warehouse, sellable, qa } = await getDemoWarehouseContext(tenantId)
  const operations = await ensureOperationalLocations(config, token, log, warehouse)
  const vendor = await ensureVendor(config, token, log)
  const customer = await ensureCustomer(tenantId, log)
  const finishedItem = await ensureItem(config, token, log, {
    sku: DEMO.itemSku,
    name: DEMO.itemName,
    description: '75 g Siamaya demo milk chocolate bar used for 1,000-bar workflows.',
    type: 'finished',
    defaultUom: DEMO.uom,
    uomDimension: 'count',
    canonicalUom: DEMO.uom,
    stockingUom: DEMO.uom,
    defaultLocationId: operations.fgStage.id,
    weight: 75,
    weightUom: 'g',
    isPurchasable: true,
    isManufactured: true,
  })

  const componentItems: Array<{
    spec: (typeof MANUAL_DEMO.components)[number]
    item: Item
    location: Location
  }> = []
  for (const spec of MANUAL_DEMO.components) {
    const location = spec.store === 'packStore' ? operations.packStore : operations.rawStore
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

  await ensureBom(config, token, log, {
    bomCode: MANUAL_DEMO.bomCode,
    outputItemId: finishedItem.id,
    defaultUom: DEMO.uom,
    version: {
      yieldQuantity: 1,
      yieldUom: DEMO.uom,
      components: componentItems.map(({ spec, item }, index) => ({
        lineNumber: index + 1,
        componentItemId: item.id,
        uom: spec.uom,
        quantityPer: spec.quantityPer,
      })),
    },
  })

  if (options.topUpComponentInventory) {
    for (const { spec, item, location } of componentItems) {
      await topUpInventory(config, token, tenantId, log, {
        item,
        location,
        uom: spec.uom,
        targetOnHand: spec.topUpQuantity,
        reasonCode: 'manual_seed_opening_balance',
      })
    }
  }

  return { warehouse, sellable, qa, operations, vendor, customer, finishedItem, componentItems }
}

async function verifyDemoSeed(tenantId: string) {
  return withDbClient(async (client) => {
    const result = await client.query<{
      po_quantity: string | null
      so_quantity: string | null
      shipped_quantity: string | null
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
         (SELECT SUM(pol.quantity_ordered)::text
            FROM purchase_order_lines pol
            JOIN demo_po po ON po.id = pol.purchase_order_id
            JOIN demo_item i ON i.id = pol.item_id
           WHERE pol.tenant_id = $1 AND pol.uom = $6) AS po_quantity,
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
      [tenantId, DEMO.itemSku, DEMO.poNumber, DEMO.soNumber, DEMO.shipmentExternalRef, DEMO.uom],
    )
    const row = result.rows[0]
    const expected = String(DEMO.quantity)
    const failures: string[] = []
    if (Number(row?.po_quantity ?? 0) !== DEMO.quantity) failures.push(`PO quantity ${row?.po_quantity}`)
    if (Number(row?.so_quantity ?? 0) !== DEMO.quantity) failures.push(`SO quantity ${row?.so_quantity}`)
    if (Number(row?.shipped_quantity ?? 0) !== DEMO.quantity) {
      failures.push(`shipped quantity ${row?.shipped_quantity}`)
    }
    if (row?.reservation_status !== 'FULFILLED') failures.push(`reservation status ${row?.reservation_status}`)
    if (Number(row?.reservation_qty ?? 0) !== DEMO.quantity) failures.push(`reservation qty ${row?.reservation_qty}`)
    if (Number(row?.fulfilled_qty ?? 0) !== DEMO.quantity) failures.push(`fulfilled qty ${row?.fulfilled_qty}`)
    if (row?.shipment_status !== 'posted') failures.push(`shipment status ${row?.shipment_status}`)
    if (!row?.shipment_movement_id) failures.push('shipment movement missing')
    if (failures.length > 0) {
      throw new Error(`Demo seed verification failed: ${failures.join(', ')}; expected ${expected} ${DEMO.uom}`)
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
  const { warehouse, sellable, vendor, customer, finishedItem } = await ensureMilkChocolateManufacturingPrerequisites(
    config,
    token,
    tenantId,
    log,
    { topUpComponentInventory: false },
  )
  const po = await ensureDemoPurchaseOrder(config, token, log, vendor, finishedItem, warehouse)
  const receipt = await ensureDemoReceipt(config, token, log, po)
  await ensureDemoQcAccepted(config, token, log, receipt)
  const so = await ensureDemoSalesOrder(config, token, log, customer, finishedItem, warehouse, sellable)
  await ensureDemoReservation(config, token, log, so, finishedItem, warehouse, sellable)
  const shipment = await ensureDemoShipment(config, token, log, so, sellable)
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
  countsBefore: Record<string, number>,
) {
  const countsAfter = await countBusinessWorkflowRecords(tenantId)
  assertCountsUnchanged(countsBefore, countsAfter)
  const reservedWorkflowArtifacts = await assertNoReservedManualWorkflowArtifacts(tenantId)
  const prerequisiteVerification = await verifyManualTopologyAndBom(tenantId)

  const itemVisible = await findItemBySku(config, token, DEMO.itemSku)
  if (!itemVisible) throw new Error(`Manual seed item is not visible through API: ${DEMO.itemSku}`)
  const vendors = await apiRequest<{ data?: Vendor[] } | Vendor[]>(config, 'GET', '/vendors', {
    token,
    params: { active: true },
  })
  const vendorRows = Array.isArray(vendors) ? vendors : vendors.data ?? []
  if (!vendorRows.some((row) => row.code === DEMO.vendorCode)) {
    throw new Error(`Manual seed supplier is not visible through API: ${DEMO.vendorCode}`)
  }
  const rawStoreVisible = await findLocationByCode(config, token, MANUAL_DEMO.rawMaterialLocationCodes.rawStore)
  if (!rawStoreVisible) throw new Error('Manual seed raw material location is not visible through API')

  const failures: string[] = []
  for (const { spec, item, location } of context.componentItems) {
    const onHand = await getInventoryOnHand(tenantId, item.id, location.id, spec.uom)
    if (onHand < spec.topUpQuantity) {
      failures.push(`${item.sku} on-hand ${onHand} ${spec.uom}; expected at least ${spec.topUpQuantity}`)
    }
  }
  if (failures.length > 0) {
    throw new Error(`Manual seed inventory verification failed: ${failures.join('; ')}`)
  }

  log.info('Manual Siamaya prerequisite verification passed.', {
    transactionalRecordCounts: countsAfter,
    reservedWorkflowArtifacts,
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
  const countsBefore = await countBusinessWorkflowRecords(tenantId)
  const context = await ensureMilkChocolateManufacturingPrerequisites(config, token, tenantId, log, {
    topUpComponentInventory: true,
  })
  await verifyManualSeed(config, token, tenantId, log, context, countsBefore)
  log.info('Siamaya manual UI scenario seed complete.')
}

async function main() {
  assertNonProductionEnvironment('chocolate-seed')
  const config = loadConfig()
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
    return
  }

  const mainLocation = await ensureLocation(config, token, log, 'MAIN', 'Main Warehouse', 'warehouse')

  const sku = (base: string) => (config.prefix ? `${config.prefix}-${base}` : base)

  const items = {
    rawCacao: await ensureItem(config, token, log, {
      sku: sku('RAW-CACAO-BEANS'),
      name: 'Raw cacao beans',
      type: 'raw',
      defaultUom: 'g',
      uomDimension: 'mass',
      canonicalUom: 'g',
      stockingUom: 'g',
      defaultLocationId: mainLocation.id,
    }),
    sugar: await ensureItem(config, token, log, {
      sku: sku('SUGAR'),
      name: 'Sugar',
      type: 'raw',
      defaultUom: 'g',
      uomDimension: 'mass',
      canonicalUom: 'g',
      stockingUom: 'g',
      defaultLocationId: mainLocation.id,
    }),
    cacaoButter: await ensureItem(config, token, log, {
      sku: sku('CACAO-BUTTER'),
      name: 'Cacao butter',
      type: 'raw',
      defaultUom: 'g',
      uomDimension: 'mass',
      canonicalUom: 'g',
      stockingUom: 'g',
      defaultLocationId: mainLocation.id,
    }),
    milkPowder: await ensureItem(config, token, log, {
      sku: sku('MILK-POWDER'),
      name: 'Milk powder',
      type: 'raw',
      defaultUom: 'g',
      uomDimension: 'mass',
      canonicalUom: 'g',
      stockingUom: 'g',
      defaultLocationId: mainLocation.id,
    }),
    lecithin: await ensureItem(config, token, log, {
      sku: sku('LECITHIN'),
      name: 'Lecithin',
      type: 'raw',
      defaultUom: 'g',
      uomDimension: 'mass',
      canonicalUom: 'g',
      stockingUom: 'g',
      defaultLocationId: mainLocation.id,
    }),
    durianPowder: await ensureItem(config, token, log, {
      sku: sku('DURIAN-POWDER'),
      name: 'Durian powder',
      type: 'raw',
      defaultUom: 'g',
      uomDimension: 'mass',
      canonicalUom: 'g',
      stockingUom: 'g',
      defaultLocationId: mainLocation.id,
    }),
    cacaoNibs: await ensureItem(config, token, log, {
      sku: sku('CACAO-NIBS'),
      name: 'Cacao nibs',
      type: 'wip',
      defaultUom: 'g',
      uomDimension: 'mass',
      canonicalUom: 'g',
      stockingUom: 'g',
      defaultLocationId: mainLocation.id,
    }),
    baseMilk: await ensureItem(config, token, log, {
      sku: sku('BASE-MILK-50'),
      name: 'Base นม 50% (Milk)',
      type: 'wip',
      defaultUom: 'g',
      uomDimension: 'mass',
      canonicalUom: 'g',
      stockingUom: 'g',
      defaultLocationId: mainLocation.id,
    }),
    durianBaseMix: await ensureItem(config, token, log, {
      sku: sku('DURIAN-BASE-MIX'),
      name: 'Durian chocolate base mix',
      type: 'wip',
      defaultUom: 'g',
      uomDimension: 'mass',
      canonicalUom: 'g',
      stockingUom: 'g',
      defaultLocationId: mainLocation.id,
    }),
    barBig: await ensureItem(config, token, log, {
      sku: sku('DURIAN-BAR-BIG'),
      name: 'Durian chocolate bar - Big (75 g)',
      type: 'finished',
      defaultUom: 'each',
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId: mainLocation.id,
      weight: 75,
      weightUom: 'g',
    }),
    barSmall: await ensureItem(config, token, log, {
      sku: sku('DURIAN-BAR-SMALL'),
      name: 'Durian chocolate bar - Small (20 g)',
      type: 'finished',
      defaultUom: 'each',
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId: mainLocation.id,
      weight: 20,
      weightUom: 'g',
    }),
    foilWrap: await ensureItem(config, token, log, {
      sku: sku('FOIL-WRAP'),
      name: 'Foil wrapper',
      type: 'packaging',
      defaultUom: 'g',
      uomDimension: 'mass',
      canonicalUom: 'g',
      stockingUom: 'g',
      defaultLocationId: mainLocation.id,
    }),
    innerBox: await ensureItem(config, token, log, {
      sku: sku('INNER-BOX'),
      name: 'Inner box (big)',
      type: 'packaging',
      defaultUom: 'each',
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId: mainLocation.id,
    }),
    innerBoxSmall: await ensureItem(config, token, log, {
      sku: sku('INNER-BOX-SMALL'),
      name: 'Inner box (small)',
      type: 'packaging',
      defaultUom: 'each',
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId: mainLocation.id,
    }),
    whiteBox: await ensureItem(config, token, log, {
      sku: sku('WHITE-BOX-12'),
      name: 'White box (holds 12 bars)',
      type: 'packaging',
      defaultUom: 'each',
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId: mainLocation.id,
    }),
    shippingBox: await ensureItem(config, token, log, {
      sku: sku('SHIPPING-BOX-10'),
      name: 'Shipping box (holds 10 white boxes)',
      type: 'packaging',
      defaultUom: 'each',
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId: mainLocation.id,
    }),
  }

  await ensureBom(config, token, log, {
    bomCode: sku('BOM-CACAO-NIBS-YIELD'),
    outputItemId: items.cacaoNibs.id,
    defaultUom: 'g',
    version: {
      yieldQuantity: 75000,
      yieldUom: 'g',
      components: [
        {
          lineNumber: 1,
          componentItemId: items.rawCacao.id,
          uom: 'g',
          quantityPer: 100000,
        },
      ],
    },
  })

  await ensureBom(config, token, log, {
    bomCode: sku('BOM-BASE-MILK-50'),
    outputItemId: items.baseMilk.id,
    defaultUom: 'g',
    version: {
      yieldQuantity: 1000,
      yieldUom: 'g',
      components: [
        { lineNumber: 1, componentItemId: items.cacaoNibs.id, uom: 'g', quantityPer: 400 },
        { lineNumber: 2, componentItemId: items.sugar.id, uom: 'g', quantityPer: 350 },
        { lineNumber: 3, componentItemId: items.cacaoButter.id, uom: 'g', quantityPer: 100 },
        { lineNumber: 4, componentItemId: items.milkPowder.id, uom: 'g', quantityPer: 150 },
        { lineNumber: 5, componentItemId: items.lecithin.id, uom: 'g', quantityPer: 3 },
      ],
    },
  })

  await ensureBom(config, token, log, {
    bomCode: sku('BOM-DURIAN-BASE-MIX'),
    outputItemId: items.durianBaseMix.id,
    defaultUom: 'g',
    version: {
      yieldQuantity: 1025,
      yieldUom: 'g',
      components: [
        { lineNumber: 1, componentItemId: items.baseMilk.id, uom: 'g', quantityPer: 1000 },
        { lineNumber: 2, componentItemId: items.durianPowder.id, uom: 'g', quantityPer: 25 },
      ],
    },
  })

  const whiteBoxPerBar = 1 / 12
  const shippingBoxPerBar = 1 / 120

  await ensureBom(config, token, log, {
    bomCode: sku('BOM-DURIAN-BAR-BIG'),
    outputItemId: items.barBig.id,
    defaultUom: 'each',
    version: {
      yieldQuantity: 1,
      yieldUom: 'each',
      components: [
        { lineNumber: 1, componentItemId: items.durianBaseMix.id, uom: 'g', quantityPer: 75 },
        { lineNumber: 2, componentItemId: items.foilWrap.id, uom: 'g', quantityPer: 3 },
      ],
    },
  })

  await ensureBom(config, token, log, {
    bomCode: sku('BOM-DURIAN-BAR-SMALL'),
    outputItemId: items.barSmall.id,
    defaultUom: 'each',
    version: {
      yieldQuantity: 1,
      yieldUom: 'each',
      components: [
        { lineNumber: 1, componentItemId: items.durianBaseMix.id, uom: 'g', quantityPer: 20 },
        { lineNumber: 2, componentItemId: items.foilWrap.id, uom: 'g', quantityPer: 1 },
      ],
    },
  })

  await ensureBom(config, token, log, {
    bomCode: sku('BOM-INNER-BOX-BIG'),
    outputItemId: items.innerBox.id,
    defaultUom: 'each',
    version: {
      yieldQuantity: 1,
      yieldUom: 'each',
      components: [
        { lineNumber: 1, componentItemId: items.barBig.id, uom: 'each', quantityPer: 1 },
      ],
    },
  })

  await ensureBom(config, token, log, {
    bomCode: sku('BOM-INNER-BOX-SMALL'),
    outputItemId: items.innerBoxSmall.id,
    defaultUom: 'each',
    version: {
      yieldQuantity: 1,
      yieldUom: 'each',
      components: [
        { lineNumber: 1, componentItemId: items.barSmall.id, uom: 'each', quantityPer: 1 },
      ],
    },
  })

  await ensureBom(config, token, log, {
    bomCode: sku('BOM-WHITE-BOX-12'),
    outputItemId: items.whiteBox.id,
    defaultUom: 'each',
    version: {
      yieldQuantity: 1,
      yieldUom: 'each',
      components: [
        { lineNumber: 1, componentItemId: items.innerBox.id, uom: 'each', quantityPer: 12 },
      ],
    },
  })

  await ensureBom(config, token, log, {
    bomCode: sku('BOM-SHIPPING-BOX-10'),
    outputItemId: items.shippingBox.id,
    defaultUom: 'each',
    version: {
      yieldQuantity: 1,
      yieldUom: 'each',
      components: [
        { lineNumber: 1, componentItemId: items.whiteBox.id, uom: 'each', quantityPer: 10 },
      ],
    },
  })

  if (config.seedOpeningBalances) {
    const massItemsKg = [
      items.rawCacao,
      items.sugar,
      items.cacaoButter,
      items.cacaoNibs,
      items.baseMilk,
      items.durianBaseMix,
    ]
    for (const item of massItemsKg) {
      await ensureUomConversion(config, token, log, item.id, 'kg', 'g', 1000)
    }

    const itemsForBalances: Array<{ item: Item; uom: string; quantity: number }> = [
      { item: items.rawCacao, uom: 'kg', quantity: 50 },
      { item: items.sugar, uom: 'kg', quantity: 40 },
      { item: items.cacaoButter, uom: 'kg', quantity: 25 },
      { item: items.cacaoNibs, uom: 'kg', quantity: 30 },
      { item: items.baseMilk, uom: 'kg', quantity: 20 },
      { item: items.durianBaseMix, uom: 'kg', quantity: 10 },
      { item: items.milkPowder, uom: 'g', quantity: 15000 },
      { item: items.lecithin, uom: 'g', quantity: 2000 },
      { item: items.durianPowder, uom: 'g', quantity: 5000 },
      { item: items.barBig, uom: 'each', quantity: 200 },
      { item: items.barSmall, uom: 'each', quantity: 400 },
      { item: items.foilWrap, uom: 'g', quantity: 3000 },
      { item: items.innerBox, uom: 'each', quantity: 1000 },
      { item: items.innerBoxSmall, uom: 'each', quantity: 1000 },
      { item: items.whiteBox, uom: 'each', quantity: 120 },
      { item: items.shippingBox, uom: 'each', quantity: 20 },
    ]

    for (const entry of itemsForBalances) {
      await createOpeningBalance(config, token, entry.item, mainLocation.id, entry.uom, entry.quantity)
      log.info(`Opening balance posted for ${entry.item.sku}`)
    }
  }

  await seedMilkChocolateDemo(config, token, tenantId, log)

  log.info('Chocolate canonical seed complete.')
}

main().catch((err) => {
  console.error('[choc-seed] Failed:', err)
  process.exit(1)
})

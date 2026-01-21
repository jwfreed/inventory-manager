/* eslint-disable no-console */
import { Client } from 'pg'

/**
 * Canonical chocolate seed with optional destructive reset.
 *
 * Required:
 * - API running (API_BASE_URL)
 * - DB migrated (npm run migrate)
 * - CONFIRM_CANONICAL_RESET=1 to run destructive reset
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

type SeedConfig = {
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
}

type ApiError = Error & { status?: number; details?: unknown }

type Session = { accessToken: string }

type Item = { id: string; sku: string; name: string }

type Location = { id: string; code: string; name: string; type: string }

type Bom = { id: string; bomCode: string; versions: { id: string; status: string }[] }

type CreateBomResponse = {
  id: string
  bomCode: string
  versions: { id: string; status: string }[]
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
  const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '')
  const prefix = process.env.SEED_PREFIX || 'CHOC'
  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@example.com'
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!'
  const tenantSlug = process.env.SEED_TENANT_SLUG || 'default'
  const tenantName = process.env.SEED_TENANT_NAME || 'Chocolate Tenant'
  const logLevel = (process.env.LOG_LEVEL as LogLevel) || 'info'
  const timeoutMs = Number(process.env.TIMEOUT_MS || '15000')
  const reset = parseBool(process.env.CONFIRM_CANONICAL_RESET)
  const seedOpeningBalances = parseBool(process.env.SEED_OPENING_BALANCE)
  const openingBalanceMassG = Number(process.env.OPENING_BALANCE_MASS_G || '0')
  const openingBalanceCount = Number(process.env.OPENING_BALANCE_COUNT || '0')
  return {
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
  method: 'GET' | 'POST',
  path: string,
  opts: { token?: string; params?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
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
    const res = await fetch(url.toString(), {
      method,
      headers,
      body: method === 'POST' ? JSON.stringify(opts.body ?? {}) : undefined,
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

async function ensureSession(config: SeedConfig): Promise<string> {
  try {
    const session = await apiRequest<Session>(config, 'POST', '/auth/bootstrap', {
      body: {
        adminEmail: config.adminEmail,
        adminPassword: config.adminPassword,
        tenantSlug: config.tenantSlug,
        tenantName: config.tenantName,
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

async function findItemBySku(config: SeedConfig, token: string, sku: string): Promise<Item | null> {
  const res = await apiRequest<{ data?: any[] } | any[]>(config, 'GET', '/items', {
    token,
    params: { search: sku, limit: 50, offset: 0 },
  })
  const rows = Array.isArray(res) ? res : res.data ?? []
  const found = rows.find((r) => (r?.sku ?? '').toLowerCase() === sku.toLowerCase())
  return found ? ({ id: found.id, sku: found.sku, name: found.name } as Item) : null
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
  },
): Promise<Item> {
  const existing = await findItemBySku(config, token, payload.sku)
  if (existing) {
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
  return found
    ? ({ id: found.id, code: found.code, name: found.name, type: found.type } as Location)
    : null
}

async function ensureLocation(
  config: SeedConfig,
  token: string,
  log: ReturnType<typeof makeLogger>,
  code: string,
  name: string,
  type: Location['type'],
): Promise<Location> {
  const existing = await findLocationByCode(config, token, code)
  if (existing) {
    log.info(`Location exists: ${code} (${existing.id})`)
    return existing
  }

  const created = await apiRequest<Location>(config, 'POST', '/locations', {
    token,
    body: { code, name, type, active: true, parentLocationId: null },
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
  const existing = await apiRequest<{ conversions?: { fromUom: string; toUom: string }[] }>(
    config,
    'GET',
    `/items/${itemId}/uom-conversions`,
    { token },
  )
  const conversions = existing.conversions ?? []
  const found = conversions.some(
    (c) => c.fromUom?.toLowerCase() === fromUom.toLowerCase() && c.toUom?.toLowerCase() === toUom.toLowerCase(),
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

async function main() {
  const config = loadConfig()
  const log = makeLogger(config.logLevel)

  await resetOperationalData(config, log)

  const token = await ensureSession(config)
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

  log.info('Chocolate canonical seed complete.')
}

main().catch((err) => {
  console.error('[choc-seed] Failed:', err)
  process.exit(1)
})

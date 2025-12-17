/* eslint-disable no-console */
/**
 * Chocolate factory seed (Durian bars) — idempotent by SKU/code.
 *
 * Requirements:
 * - API running (default http://localhost:3000)
 * - DB migrated
 * - Mass base unit: grams (all mass quantities expressed in g)
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

type SeedConfig = {
  baseUrl: string
  prefix: string
  logLevel: LogLevel
  timeoutMs: number
}

type ApiError = Error & { status?: number; details?: unknown }

type Item = { id: string; sku: string; name: string }
type Location = { id: string; code: string; name: string; type: string }
type Bom = { id: string; bomCode: string; versions: { id: string; status: string }[] }

type CreateBomResponse = {
  id: string
  bomCode: string
  versions: { id: string; status: string }[]
}

function loadConfig(): SeedConfig {
  const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '')
  const prefix = process.env.SEED_PREFIX || 'CHOC'
  const logLevel = (process.env.LOG_LEVEL as LogLevel) || 'info'
  const timeoutMs = Number(process.env.TIMEOUT_MS || '15000')
  return { baseUrl, prefix, logLevel, timeoutMs }
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
  const e = new Error(String(err)) as ApiError
  return e
}

async function apiRequest<T>(
  config: SeedConfig,
  method: 'GET' | 'POST',
  path: string,
  opts: { params?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
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
    const res = await fetch(url.toString(), {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(opts.body ?? {}) : undefined,
      signal: controller.signal,
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
  } finally {
    clearTimeout(timeout)
  }
}

async function findItemBySku(config: SeedConfig, sku: string): Promise<Item | null> {
  const res = await apiRequest<{ data?: any[] } | any[]>(config, 'GET', '/items', {
    params: { search: sku, limit: 50, offset: 0 },
  })
  const rows = Array.isArray(res) ? res : res.data ?? []
  const found = rows.find((r) => (r?.sku ?? '').toLowerCase() === sku.toLowerCase())
  return found ? ({ id: found.id, sku: found.sku, name: found.name } as Item) : null
}

async function ensureItem(config: SeedConfig, log: ReturnType<typeof makeLogger>, sku: string, name: string) {
  const existing = await findItemBySku(config, sku)
  if (existing) {
    log.info(`Item exists: ${sku} (${existing.id})`)
    return existing
  }

  const created = await apiRequest<Item>(config, 'POST', '/items', {
    body: { sku, name, description: `Seeded by ${config.prefix}` },
  })
  log.info(`Item created: ${sku} (${created.id})`)
  return created
}

async function findLocationByCode(config: SeedConfig, code: string): Promise<Location | null> {
  const res = await apiRequest<{ data?: any[] } | any[]>(config, 'GET', '/locations', {
    params: { search: code, limit: 100, offset: 0 },
  })
  const rows = Array.isArray(res) ? res : res.data ?? []
  const found = rows.find((r) => (r?.code ?? '').toLowerCase() === code.toLowerCase())
  return found
    ? ({
        id: found.id,
        code: found.code,
        name: found.name,
        type: found.type,
      } as Location)
    : null
}

async function ensureLocation(config: SeedConfig, log: ReturnType<typeof makeLogger>, code: string, name: string, type: Location['type']) {
  const existing = await findLocationByCode(config, code)
  if (existing) {
    log.info(`Location exists: ${code} (${existing.id})`)
    return existing
  }

  const created = await apiRequest<Location>(config, 'POST', '/locations', {
    body: { code, name, type, active: true, parentLocationId: null },
  })
  log.info(`Location created: ${code} (${created.id})`)
  return created
}

async function listBomsForItem(config: SeedConfig, itemId: string): Promise<Bom[]> {
  const res = await apiRequest<{ boms?: Bom[] }>(config, 'GET', `/items/${itemId}/boms`)
  return res.boms ?? []
}

async function ensureBom(
  config: SeedConfig,
  log: ReturnType<typeof makeLogger>,
  payload: {
    bomCode: string
    outputItemId: string
    defaultUom: string
    version: {
      yieldQuantity: number
      yieldUom: string
      components: { lineNumber: number; componentItemId: string; uom: string; quantityPer: number; scrapFactor?: number }[]
    }
  },
): Promise<Bom> {
  const existing = await listBomsForItem(config, payload.outputItemId)
  const found = existing.find((b) => b.bomCode === payload.bomCode)
  if (found) {
    log.info(`BOM exists: ${payload.bomCode} (${found.id})`)
    // Activate the first non-active version if needed
    const inactive = found.versions.find((v) => v.status !== 'active')
    if (inactive) {
      await activateBomVersion(config, log, inactive.id)
    }
    return found
  }

  const created = await apiRequest<CreateBomResponse>(config, 'POST', '/boms', {
    body: {
      ...payload,
      notes: `Seeded by ${config.prefix}`,
      version: {
        versionNumber: 1,
        effectiveFrom: new Date().toISOString(),
        yieldQuantity: payload.version.yieldQuantity,
        yieldUom: payload.version.yieldUom,
        components: payload.version.components,
      },
    },
  })
  log.info(`BOM created: ${payload.bomCode} (${created.id})`)
  const versionId = created.versions[0]?.id
  if (versionId) {
    await activateBomVersion(config, log, versionId)
  }
  return { id: created.id, bomCode: created.bomCode, versions: created.versions }
}

async function activateBomVersion(config: SeedConfig, log: ReturnType<typeof makeLogger>, versionId: string) {
  try {
    await apiRequest(config, 'POST', `/boms/${versionId}/activate`, {
      body: { effectiveFrom: new Date().toISOString() },
    })
    log.info(`Activated BOM version ${versionId}`)
  } catch (err) {
    const e = toApiError(err)
    if (e.status === 409) {
      log.info(`BOM version already active ${versionId}`)
      return
    }
    throw err
  }
}

async function main() {
  const config = loadConfig()
  const log = makeLogger(config.logLevel)
  log.info(`Base URL ${config.baseUrl}, prefix ${config.prefix}`)

  // Locations (minimal footprint)
  const locRM = await ensureLocation(config, log, `${config.prefix}-RM-STOCK`, 'Raw material stock', 'warehouse')
  const locWip = await ensureLocation(config, log, `${config.prefix}-WIP-KITCHEN`, 'Kitchen / WIP', 'bin')
  const locPack = await ensureLocation(config, log, `${config.prefix}-PACK-STAGE`, 'Packaging stage', 'bin')
  const locFg = await ensureLocation(config, log, `${config.prefix}-FG-STOCK`, 'Finished goods', 'bin')

  // Items
  const items: Record<string, Item> = {}
  const itemDefs: [string, string][] = [
    ['CHOC-BEANS', 'Cacao beans'],
    ['CHOC-NIBS', 'Cacao nibs / โกโก้นิบส์'],
    ['CHOC-BASE', 'Base นม 50% (Milk)'],
    ['CHOC-SUGAR', 'Sugar / น้ำตาล'],
    ['CHOC-BUTTER', 'Cacao butter / โกโก้บัตเตอร์'],
    ['CHOC-MILKPOW', 'Milk Powder / นมผง'],
    ['CHOC-LECITHIN', 'Lecithin / เลซิติน'],
    ['CHOC-DURIAN', 'Durian powder / ผงทุเรียน'],
    ['CHOC-BAR-BIG-RAW', 'Durian big bar (unwrapped)'],
    ['CHOC-FOIL', 'Foil wrap'],
    ['CHOC-BAR-BIG-WRAP', 'Durian big bar (wrapped)'],
    ['CHOC-BOX', 'Retail box (single bar)'],
    ['CHOC-SHIP', 'Shipping box'],
    ['CHOC-BAR-BIG-PACK', 'Durian big bar retail pack'],
  ]
  for (const [sku, name] of itemDefs) {
    items[sku] = await ensureItem(config, log, `${config.prefix}-${sku}`, name)
  }

  // BOMs
  // 1) Nibs: 100kg beans -> 75kg nibs (all in grams)
  await ensureBom(config, log, {
    bomCode: `${config.prefix}-BOM-NIBS`,
    outputItemId: items['CHOC-NIBS'].id,
    defaultUom: 'g',
    version: {
      yieldQuantity: 75000,
      yieldUom: 'g',
      components: [
        { lineNumber: 1, componentItemId: items['CHOC-BEANS'].id, uom: 'g', quantityPer: 100000 },
      ],
    },
  })

  // 2) Base นม 50% (Milk) per 1000 g
  await ensureBom(config, log, {
    bomCode: `${config.prefix}-BOM-BASE`,
    outputItemId: items['CHOC-BASE'].id,
    defaultUom: 'g',
    version: {
      yieldQuantity: 1000,
      yieldUom: 'g',
      components: [
        { lineNumber: 1, componentItemId: items['CHOC-NIBS'].id, uom: 'g', quantityPer: 400 },
        { lineNumber: 2, componentItemId: items['CHOC-SUGAR'].id, uom: 'g', quantityPer: 350 },
        { lineNumber: 3, componentItemId: items['CHOC-BUTTER'].id, uom: 'g', quantityPer: 100 },
        { lineNumber: 4, componentItemId: items['CHOC-MILKPOW'].id, uom: 'g', quantityPer: 150 },
        { lineNumber: 5, componentItemId: items['CHOC-LECITHIN'].id, uom: 'g', quantityPer: 3 },
      ],
    },
  })

  // Per-bar mass and durian (derived from 400-bar batch: 29268.292683g base, 731.707317g durian)
  const basePerBar = 29268.292683 / 400 // g
  const durianPerBar = 731.707317 / 400 // g

  // 3) Unwrapped bar (1 ea)
  await ensureBom(config, log, {
    bomCode: `${config.prefix}-BOM-BAR-RAW`,
    outputItemId: items['CHOC-BAR-BIG-RAW'].id,
    defaultUom: 'ea',
    version: {
      yieldQuantity: 1,
      yieldUom: 'ea',
      components: [
        { lineNumber: 1, componentItemId: items['CHOC-BASE'].id, uom: 'g', quantityPer: basePerBar },
        { lineNumber: 2, componentItemId: items['CHOC-DURIAN'].id, uom: 'g', quantityPer: durianPerBar },
      ],
    },
  })

  // 4) Wrapped bar (consumes foil)
  await ensureBom(config, log, {
    bomCode: `${config.prefix}-BOM-BAR-WRAP`,
    outputItemId: items['CHOC-BAR-BIG-WRAP'].id,
    defaultUom: 'ea',
    version: {
      yieldQuantity: 1,
      yieldUom: 'ea',
      components: [
        { lineNumber: 1, componentItemId: items['CHOC-BAR-BIG-RAW'].id, uom: 'ea', quantityPer: 1 },
        { lineNumber: 2, componentItemId: items['CHOC-FOIL'].id, uom: 'ea', quantityPer: 1 },
      ],
    },
  })

  // 5) Retail pack (default 12 bars → 1 shipping box; can change pack size by editing BOM or scaling WO qty)
  const packBars = 12
  await ensureBom(config, log, {
    bomCode: `${config.prefix}-BOM-BAR-PACK`,
    outputItemId: items['CHOC-BAR-BIG-PACK'].id,
    defaultUom: 'ea',
    version: {
      yieldQuantity: 1, // 1 shipping box
      yieldUom: 'ea',
      components: [
        { lineNumber: 1, componentItemId: items['CHOC-BAR-BIG-WRAP'].id, uom: 'ea', quantityPer: packBars },
        { lineNumber: 2, componentItemId: items['CHOC-BOX'].id, uom: 'ea', quantityPer: packBars },
        { lineNumber: 3, componentItemId: items['CHOC-SHIP'].id, uom: 'ea', quantityPer: 1 },
      ],
    },
  })

  log.info('Seed complete')
  log.info(`Locations: RM=${locRM.id} WIP=${locWip.id} PACK=${locPack.id} FG=${locFg.id}`)
  log.info(`Key items: NIBS=${items['CHOC-NIBS'].id} BASE=${items['CHOC-BASE'].id} RAW_BAR=${items['CHOC-BAR-BIG-RAW'].id} WRAP_BAR=${items['CHOC-BAR-BIG-WRAP'].id} PACK=${items['CHOC-BAR-BIG-PACK'].id}`)
}

main().catch((err) => {
  const e = toApiError(err)
  console.error('[choc-seed] ERROR', e.message)
  if (e.details) console.error(e.details)
  process.exit(1)
})

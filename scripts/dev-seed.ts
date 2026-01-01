type LogLevel = 'debug' | 'info' | 'warn' | 'error'

type SeedConfig = {
  baseUrl: string
  prefix: string
  logLevel: LogLevel
  timeoutMs: number
}

type ApiError = Error & { status?: number; details?: unknown }

type Paging = { limit: number; offset: number }

type Item = { id: string; sku: string; name: string }
type Location = { id: string; code: string; name: string; type: string; parentLocationId?: string | null }
type Vendor = { id: string; code: string; name: string }
type PurchaseOrderLine = { id: string; itemId: string; uom: string; quantityOrdered: number | string }
type PurchaseOrder = { id: string; poNumber?: string; po_number?: string; lines?: PurchaseOrderLine[] }
type ReceiptLine = { id: string; purchaseOrderLineId: string; uom: string; quantityReceived: number }
type Receipt = { id: string; purchaseOrderId: string; receivedToLocationId?: string | null; lines: ReceiptLine[] }
type Putaway = {
  id: string
  status: string
  purchaseOrderReceiptId?: string | null
  inventoryMovementId?: string | null
}
type Movement = { id: string; status: string; externalRef?: string | null; external_ref?: string | null }
type MovementLine = { itemId?: string; item_id?: string; locationId?: string; location_id?: string; quantityDelta?: number; quantity_delta?: number; uom?: string }

type SeedState = {
  version: 1
  byKey: Record<string, { receiptId?: string; putawayId?: string; putawayMovementId?: string }>
}

function loadConfig(): SeedConfig {
  const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '')
  const prefix = process.env.SEED_PREFIX || 'DEVSEED'
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
      const line = `[dev-seed] ${l.toUpperCase()} ${msg}`
      if (extra === undefined) {
        // eslint-disable-next-line no-console
        console.log(line)
      } else {
        // eslint-disable-next-line no-console
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

function stateKey(config: SeedConfig) {
  return `${config.baseUrl}::${config.prefix}`
}

async function loadState(): Promise<SeedState> {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const file = path.join(process.cwd(), 'scripts', '.dev-seed-state.json')
  try {
    const raw = await fs.readFile(file, 'utf8')
    const parsed = JSON.parse(raw) as SeedState
    if (!parsed || parsed.version !== 1 || typeof parsed.byKey !== 'object') {
      return { version: 1, byKey: {} }
    }
    return parsed
  } catch {
    return { version: 1, byKey: {} }
  }
}

async function saveState(state: SeedState): Promise<void> {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const file = path.join(process.cwd(), 'scripts', '.dev-seed-state.json')
  await fs.writeFile(file, JSON.stringify(state, null, 2) + '\n', 'utf8')
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

  try {
    const created = await apiRequest<Item>(config, 'POST', '/items', {
      body: { sku, name, description: `Seeded by ${config.prefix}` },
    })
    log.info(`Item created: ${sku} (${created.id})`)
    return created
  } catch (err) {
    const e = toApiError(err)
    if (e.status === 409) {
      const again = await findItemBySku(config, sku)
      if (again) {
        log.info(`Item reused after 409: ${sku} (${again.id})`)
        return again
      }
    }
    throw err
  }
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
        parentLocationId: found.parentLocationId ?? found.parent_location_id ?? null,
      } as Location)
    : null
}

async function ensureLocation(
  config: SeedConfig,
  log: ReturnType<typeof makeLogger>,
  input: { code: string; name: string; type: Location['type']; parentLocationId?: string | null },
) {
  const existing = await findLocationByCode(config, input.code)
  if (existing) {
    log.info(`Location exists: ${input.code} (${existing.id})`)
    return existing
  }

  try {
    const created = await apiRequest<Location>(config, 'POST', '/locations', {
      body: { ...input },
    })
    log.info(`Location created: ${input.code} (${created.id})`)
    return created
  } catch (err) {
    const e = toApiError(err)
    if (e.status === 409) {
      const again = await findLocationByCode(config, input.code)
      if (again) {
        log.info(`Location reused after 409: ${input.code} (${again.id})`)
        return again
      }
    }
    throw err
  }
}

async function ensureVendor(config: SeedConfig, log: ReturnType<typeof makeLogger>, code: string, name: string) {
  const res = await apiRequest<{ data?: any[] } | any[]>(config, 'GET', '/vendors')
  const rows = Array.isArray(res) ? res : res.data ?? []
  const found = rows.find((r) => (r?.code ?? '').toLowerCase() === code.toLowerCase())
  if (found) {
    log.info(`Vendor exists: ${code} (${found.id})`)
    return { id: found.id, code: found.code, name: found.name } as Vendor
  }

  try {
    const created = await apiRequest<Vendor>(config, 'POST', '/vendors', {
      body: { code, name, email: 'seed@example.test' },
    })
    log.info(`Vendor created: ${code} (${created.id})`)
    return created
  } catch (err) {
    const e = toApiError(err)
    if (e.status === 409) {
      const res2 = await apiRequest<{ data?: any[] } | any[]>(config, 'GET', '/vendors')
      const rows2 = Array.isArray(res2) ? res2 : res2.data ?? []
      const found2 = rows2.find((r) => (r?.code ?? '').toLowerCase() === code.toLowerCase())
      if (found2) {
        log.info(`Vendor reused after 409: ${code} (${found2.id})`)
        return { id: found2.id, code: found2.code, name: found2.name } as Vendor
      }
    }
    throw err
  }
}

async function getPurchaseOrderDetail(config: SeedConfig, poId: string): Promise<any> {
  return apiRequest<any>(config, 'GET', `/purchase-orders/${poId}`)
}

async function ensurePurchaseOrder(
  config: SeedConfig,
  log: ReturnType<typeof makeLogger>,
  poNumber: string,
  vendorId: string,
  lines: { itemId: string; uom: string; quantityOrdered: number; lineNumber?: number }[],
) {
  // No search support; scan list pages for exact po_number match.
  let offset = 0
  const limit = 100
  for (let i = 0; i < 10; i++) {
    const res = await apiRequest<{ data?: any[]; paging?: Paging } | any[]>(config, 'GET', '/purchase-orders', {
      params: { limit, offset },
    })
    const rows = Array.isArray(res) ? res : res.data ?? []
    const found = rows.find((r) => (r?.poNumber ?? r?.po_number) === poNumber)
    if (found) {
      const full = await getPurchaseOrderDetail(config, found.id)
      log.info(`Purchase order exists: ${poNumber} (${found.id})`)
      return full
    }
    if (rows.length < limit) break
    offset += limit
  }

  try {
    const created = await apiRequest<any>(config, 'POST', '/purchase-orders', {
      body: {
        poNumber,
        vendorId,
        status: 'draft',
        orderDate: new Date().toISOString().slice(0, 10),
        lines,
        notes: `Seeded by ${config.prefix}`,
      },
    })
    log.info(`Purchase order created: ${poNumber} (${created.id})`)
    return created
  } catch (err) {
    const e = toApiError(err)
    if (e.status === 409) {
      // Retry find + load
      const res = await apiRequest<{ data?: any[] } | any[]>(config, 'GET', '/purchase-orders', {
        params: { limit: 100, offset: 0 },
      })
      const rows = Array.isArray(res) ? res : res.data ?? []
      const found = rows.find((r) => (r?.poNumber ?? r?.po_number) === poNumber)
      if (found) {
        const full = await getPurchaseOrderDetail(config, found.id)
        log.info(`Purchase order reused after 409: ${poNumber} (${found.id})`)
        return full
      }
    }
    throw err
  }
}

async function fetchReceipt(config: SeedConfig, receiptId: string): Promise<Receipt | null> {
  try {
    const receipt = await apiRequest<any>(config, 'GET', `/purchase-order-receipts/${receiptId}`)
    return receipt as Receipt
  } catch (err) {
    const e = toApiError(err)
    if (e.status === 404) return null
    throw err
  }
}

async function createReceipt(config: SeedConfig, log: ReturnType<typeof makeLogger>, po: any, warehouseId: string) {
  const receipt = await apiRequest<any>(config, 'POST', '/purchase-order-receipts', {
    body: {
      purchaseOrderId: po.id,
      receivedAt: new Date().toISOString(),
      receivedToLocationId: warehouseId,
      externalRef: `${config.prefix}-RCPT-01`,
      notes: `Seeded by ${config.prefix}`,
      lines: (po.lines ?? []).map((l: any) => ({
        purchaseOrderLineId: l.id,
        uom: l.uom,
        quantityReceived: Number(l.quantityOrdered ?? l.quantity_ordered ?? 0),
      })),
    },
  })
  log.info(`Receipt created: ${receipt.id}`)
  return receipt as Receipt
}

async function fetchPutaway(config: SeedConfig, putawayId: string): Promise<any | null> {
  try {
    return await apiRequest<any>(config, 'GET', `/putaways/${putawayId}`)
  } catch (err) {
    const e = toApiError(err)
    if (e.status === 404) return null
    throw err
  }
}

async function createPutaway(
  config: SeedConfig,
  log: ReturnType<typeof makeLogger>,
  receipt: any,
  binA: string,
  binB: string,
) {
  const receiptLines = receipt.lines ?? []
  if (receiptLines.length < 2) {
    throw new Error('Receipt has fewer than 2 lines; cannot create split putaway.')
  }
  const lineA = receiptLines[0]
  const lineB = receiptLines[1]
  const payload = {
    sourceType: 'purchase_order_receipt',
    purchaseOrderReceiptId: receipt.id,
    notes: `Seeded by ${config.prefix}`,
    lines: [
      {
        purchaseOrderReceiptLineId: lineA.id,
        toLocationId: binA,
        uom: lineA.uom,
        quantity: Number(lineA.quantityReceived ?? lineA.quantity_received ?? 0),
        lineNumber: 1,
      },
      {
        purchaseOrderReceiptLineId: lineB.id,
        toLocationId: binB,
        uom: lineB.uom,
        quantity: Number(lineB.quantityReceived ?? lineB.quantity_received ?? 0),
        lineNumber: 2,
      },
    ],
  }
  const putaway = await apiRequest<any>(config, 'POST', '/putaways', { body: payload })
  log.info(`Putaway created: ${putaway.id}`)
  return putaway as Putaway
}

async function postPutawayIfNeeded(config: SeedConfig, log: ReturnType<typeof makeLogger>, putaway: any) {
  if (putaway.status === 'completed') {
    log.info(`Putaway already posted: ${putaway.id} (movement ${putaway.inventoryMovementId ?? 'n/a'})`)
    return putaway
  }
  const posted = await apiRequest<any>(config, 'POST', `/putaways/${putaway.id}/post`)
  log.info(`Putaway posted: ${putaway.id} (movement ${posted.inventoryMovementId ?? 'n/a'})`)
  return posted
}

async function getMovement(config: SeedConfig, movementId: string): Promise<any> {
  return apiRequest<any>(config, 'GET', `/inventory-movements/${movementId}`)
}

async function listMovements(config: SeedConfig, params: Record<string, string | number | boolean | undefined>) {
  return apiRequest<any>(config, 'GET', `/inventory-movements`, { params })
}

async function getMovementLines(config: SeedConfig, movementId: string): Promise<any[]> {
  const res = await apiRequest<any>(config, 'GET', `/inventory-movements/${movementId}/lines`)
  if (Array.isArray(res)) return res
  if (Array.isArray(res?.data)) return res.data
  return []
}

async function findMovementByExternalRef(config: SeedConfig, externalRef: string) {
  const res = await listMovements(config, { external_ref: externalRef, limit: 5, offset: 0 })
  const rows = Array.isArray(res) ? res : res.data ?? []
  const found = rows.find((r) => {
    const ref = r?.externalRef ?? r?.external_ref ?? ''
    return typeof ref === 'string' && ref.toLowerCase() === externalRef.toLowerCase()
  })
  return found ?? null
}

async function recoverPutawayIdFromLedger(
  config: SeedConfig,
  log: ReturnType<typeof makeLogger>,
  expected: { itemIds: string[]; binIds: string[] },
): Promise<{ putawayId: string; movementId: string } | null> {
  const res = await listMovements(config, { external_ref: 'putaway:', limit: 200, offset: 0 })
  const candidates = Array.isArray(res) ? res : res.data ?? []
  for (const movement of candidates) {
    const ext = movement.externalRef ?? movement.external_ref ?? ''
    if (typeof ext !== 'string' || !ext.startsWith('putaway:')) continue
    const lines = await getMovementLines(config, movement.id)
    const itemIdsInMove = new Set(lines.map((l: MovementLine) => l.itemId ?? l.item_id).filter(Boolean))
    const binIdsInMove = new Set(lines.map((l: MovementLine) => l.locationId ?? l.location_id).filter(Boolean))

    const hasAllItems = expected.itemIds.every((id) => itemIdsInMove.has(id))
    const hasAllBins = expected.binIds.every((id) => binIdsInMove.has(id))
    if (!hasAllItems || !hasAllBins) continue

    const putawayId = ext.slice('putaway:'.length)
    if (putawayId) {
      log.warn(`Recovered putaway from ledger external_ref=${ext}`)
      return { putawayId, movementId: movement.id }
    }
  }
  return null
}

async function verifyPutawayMovement(
  config: SeedConfig,
  log: ReturnType<typeof makeLogger>,
  putawayId: string,
  movementId: string,
) {
  const header = await getMovement(config, movementId)
  if ((header.status ?? '').toLowerCase() !== 'posted') {
    throw new Error(`Expected movement ${movementId} to be posted; got status=${header.status}`)
  }

  const listRes = await listMovements(config, { external_ref: `putaway:${putawayId}`, limit: 5, offset: 0 })
  const rows = Array.isArray(listRes) ? listRes : listRes.data ?? []
  if (rows.length === 0) {
    throw new Error(`Expected to find movement by external_ref putaway:${putawayId} but list returned 0 rows`)
  }

  log.info(`Verified posted movement: ${movementId} (external_ref putaway:${putawayId})`)
}

async function endpointExists(config: SeedConfig, path: string): Promise<boolean> {
  try {
    await apiRequest<any>(config, 'GET', path)
    return true
  } catch (err) {
    const e = toApiError(err)
    if (e.status === 404) return false
    // If request reached server but failed for other reasons, treat as "exists"
    return true
  }
}

async function runManufacturingOptional(
  config: SeedConfig,
  log: ReturnType<typeof makeLogger>,
  seeded: { fg: Item; c1: Item; c2: Item; binA: Location; binB: Location },
) {
  const canWorkOrders = await endpointExists(config, '/work-orders?limit=1&offset=0')
  const canBomsList = await endpointExists(config, `/items/${seeded.fg.id}/boms`)
  const canEffectiveBom = await endpointExists(config, `/items/${seeded.fg.id}/bom`)
  if (!canWorkOrders || !canBomsList || !canEffectiveBom) {
    log.info('Manufacturing seed skipped (endpoints missing).')
    return
  }

  const bomCode = `${config.prefix}-BOM-FG-01`
  const woDescription = `Seeded ${config.prefix} WO 01`

  // Find existing BOM for FG
  let bomId: string | null = null
  let bomVersionId: string | null = null
  const bomsSummary = await apiRequest<any>(config, 'GET', `/items/${seeded.fg.id}/boms`)
  const boms = bomsSummary?.boms ?? []
  const existingBom = boms.find((b: any) => b?.bomCode === bomCode || b?.bom_code === bomCode)
  if (existingBom) {
    bomId = existingBom.id
    bomVersionId = existingBom.versions?.[0]?.id ?? null
    log.info(`BOM exists: ${bomCode} (${bomId})`)
  } else {
    try {
      const createdBom = await apiRequest<any>(config, 'POST', '/boms', {
        body: {
          bomCode,
          outputItemId: seeded.fg.id,
          defaultUom: 'ea',
          notes: `Seeded by ${config.prefix}`,
          version: {
            yieldQuantity: 1,
            yieldUom: 'ea',
            components: [
              { lineNumber: 1, componentItemId: seeded.c1.id, uom: 'ea', quantityPer: 1 },
              { lineNumber: 2, componentItemId: seeded.c2.id, uom: 'ea', quantityPer: 1 },
            ],
          },
        },
      })
      bomId = createdBom.id
      bomVersionId = createdBom.versions?.[0]?.id ?? createdBom.version?.id ?? null
      log.info(`BOM created: ${bomCode} (${bomId})`)
    } catch (err) {
      const e = toApiError(err)
      if (e.status === 404) {
        log.info('Manufacturing seed skipped (endpoints missing).')
        return
      }
      throw err
    }
  }

  if (bomVersionId) {
    try {
      await apiRequest<any>(config, 'POST', `/boms/${bomVersionId}/activate`, {
        body: { effectiveFrom: new Date().toISOString() },
      })
      log.info(`BOM version activated: ${bomVersionId}`)
    } catch (err) {
      log.warn(`BOM activation failed (continuing): ${(err as Error).message}`)
    }
  } else {
    log.warn('BOM version id missing; skipping activation.')
  }

  // Find existing WO
  let workOrder: any | null = null
  const woList = await apiRequest<any>(config, 'GET', '/work-orders', { params: { limit: 50, offset: 0 } })
  const woRows = woList?.data ?? []
  workOrder = woRows.find((w: any) => w?.description === woDescription) ?? null

  if (!workOrder) {
    const created = await apiRequest<any>(config, 'POST', '/work-orders', {
      body: {
        bomId,
        outputItemId: seeded.fg.id,
        outputUom: 'ea',
        quantityPlanned: 5,
        description: woDescription,
      },
    })
    workOrder = created
    log.info(`Work order created: ${workOrder.number} (${workOrder.id})`)
  } else {
    log.info(`Work order exists: ${workOrder.number} (${workOrder.id})`)
  }

  // If already has posted execution totals, skip adding issues/completions.
  const exec = await apiRequest<any>(config, 'GET', `/work-orders/${workOrder.id}/execution`)
  const alreadyIssued = Array.isArray(exec?.issuedTotals) && exec.issuedTotals.length > 0
  const alreadyCompleted = Array.isArray(exec?.completedTotals) && exec.completedTotals.length > 0
  if (alreadyIssued && alreadyCompleted) {
    log.info('Work order already has posted execution; skipping issue/completion.')
    return
  }

  // Issue (draft + post)
  const issue = await apiRequest<any>(config, 'POST', `/work-orders/${workOrder.id}/issues`, {
    body: {
      occurredAt: new Date().toISOString(),
      notes: `Seeded by ${config.prefix}`,
      lines: [
        { componentItemId: seeded.c1.id, fromLocationId: seeded.binA.id, uom: 'ea', quantityIssued: 1 },
        { componentItemId: seeded.c2.id, fromLocationId: seeded.binB.id, uom: 'ea', quantityIssued: 1 },
      ],
    },
  })
  await apiRequest<any>(config, 'POST', `/work-orders/${workOrder.id}/issues/${issue.id}/post`)
  log.info(`Work order issue posted: ${issue.id}`)

  // Completion (draft + post)
  const completion = await apiRequest<any>(config, 'POST', `/work-orders/${workOrder.id}/completions`, {
    body: {
      occurredAt: new Date().toISOString(),
      notes: `Seeded by ${config.prefix}`,
      lines: [{ outputItemId: seeded.fg.id, toLocationId: seeded.binA.id, uom: 'ea', quantityCompleted: 1 }],
    },
  })
  await apiRequest<any>(config, 'POST', `/work-orders/${workOrder.id}/completions/${completion.id}/post`)
  log.info(`Work order completion posted: ${completion.id}`)
}

async function main() {
  const config = loadConfig()
  const log = makeLogger(config.logLevel)
  const state = await loadState()
  const key = stateKey(config)
  state.byKey[key] ||= {}

  log.info(`Starting dev seed against ${config.baseUrl} (prefix=${config.prefix})`)

  // 1) Ensure locations
  const wh = await ensureLocation(config, log, {
    code: `${config.prefix}-WH-01`,
    name: `${config.prefix} Warehouse`,
    type: 'warehouse',
    parentLocationId: null,
  })
  const binA = await ensureLocation(config, log, {
    code: `${config.prefix}-BIN-A`,
    name: `${config.prefix} Bin A`,
    type: 'bin',
    parentLocationId: wh.id,
  })
  const binB = await ensureLocation(config, log, {
    code: `${config.prefix}-BIN-B`,
    name: `${config.prefix} Bin B`,
    type: 'bin',
    parentLocationId: wh.id,
  })

  // 2) Ensure items
  const fg = await ensureItem(config, log, `${config.prefix}-FG-001`, `${config.prefix} Finished Good`)
  const c1 = await ensureItem(config, log, `${config.prefix}-C1-001`, `${config.prefix} Component 1`)
  const c2 = await ensureItem(config, log, `${config.prefix}-C2-001`, `${config.prefix} Component 2`)

  // 3) Ensure vendor
  const vendor = await ensureVendor(config, log, `${config.prefix}-VEND-01`, `${config.prefix} Vendor`)

  // 4) Ensure PO with 2 lines (C1, C2)
  const po = await ensurePurchaseOrder(config, log, `${config.prefix}-PO-01`, vendor.id, [
    { lineNumber: 1, itemId: c1.id, uom: 'ea', quantityOrdered: 5 },
    { lineNumber: 2, itemId: c2.id, uom: 'ea', quantityOrdered: 7 },
  ])
  if (!Array.isArray(po.lines) || po.lines.length < 2) {
    throw new Error('Purchase order does not include lines; cannot create receipt.')
  }

  // 5) Ensure receipt (stateful)
  let receipt: Receipt | null = null
  const priorReceiptId = state.byKey[key].receiptId
  if (priorReceiptId) {
    receipt = await fetchReceipt(config, priorReceiptId)
    if (receipt) log.info(`Receipt reused: ${receipt.id}`)
  }
  if (!receipt) {
    receipt = await createReceipt(config, log, po, wh.id)
    state.byKey[key].receiptId = receipt.id
    await saveState(state)
  }

  // 6) Ensure putaway (stateful, with recovery fallback)
  let putaway: any | null = null
  const priorPutawayId = state.byKey[key].putawayId
  if (priorPutawayId) {
    putaway = await fetchPutaway(config, priorPutawayId)
    if (putaway) log.info(`Putaway reused: ${putaway.id} (status=${putaway.status})`)
  }

  if (!putaway) {
    try {
      putaway = await createPutaway(config, log, receipt, binA.id, binB.id)
      state.byKey[key].putawayId = putaway.id
      await saveState(state)
    } catch (err) {
      const e = toApiError(err)
      // If quantities are already fully put away (e.g., state file removed), try to recover by scanning ledger.
      if (e.status === 409 || e.status === 400) {
        const recovered = await recoverPutawayIdFromLedger(config, log, {
          itemIds: [c1.id, c2.id],
          binIds: [binA.id, binB.id],
        })
        if (recovered) {
          state.byKey[key].putawayId = recovered.putawayId
          state.byKey[key].putawayMovementId = recovered.movementId
          await saveState(state)
          putaway = await fetchPutaway(config, recovered.putawayId)
        }
      }
      if (!putaway) throw err
    }
  }

  // 7) Post putaway
  let postedPutaway = await postPutawayIfNeeded(config, log, putaway)
  if (!postedPutaway.inventoryMovementId) {
    const reloaded = await fetchPutaway(config, postedPutaway.id)
    if (reloaded?.inventoryMovementId) {
      postedPutaway = reloaded
    } else {
      const movement = await findMovementByExternalRef(config, `putaway:${postedPutaway.id}`)
      if (movement) {
        postedPutaway.inventoryMovementId = movement.id
      }
    }
  }
  const movementId = postedPutaway.inventoryMovementId ?? state.byKey[key].putawayMovementId
  if (!movementId) {
    throw new Error('Putaway posted but inventoryMovementId is missing; cannot verify ledger.')
  }
  state.byKey[key].putawayMovementId = movementId
  await saveState(state)

  // 8) Verify ledger movement exists and is posted
  await verifyPutawayMovement(config, log, postedPutaway.id, movementId)

  // Optional manufacturing (guarded, non-fatal if missing endpoints)
  try {
    await runManufacturingOptional(config, log, { fg, c1, c2, binA, binB })
  } catch (err) {
    log.warn(`Manufacturing seed failed (continuing): ${(err as Error).message}`)
  }

  log.info('Seed complete.')
  log.info(
    `Summary: WH=${wh.id} BIN-A=${binA.id} BIN-B=${binB.id} FG=${fg.id} C1=${c1.id} C2=${c2.id} VENDOR=${vendor.id} PO=${po.id} RECEIPT=${receipt.id} PUTAWAY=${postedPutaway.id} MOVEMENT=${movementId}`,
  )
  log.info(`Next: open UI and search for prefix "${config.prefix}" (items/locations/vendors/PO).`)
}

main().catch((err) => {
  const e = toApiError(err)
  // eslint-disable-next-line no-console
  console.error(`[dev-seed] ERROR ${e.message}`, e.details ? { details: e.details } : undefined)
  process.exit(1)
})

import type { KpiRun } from '@api/types'

export type DashboardMode = 'actionable' | 'all'

export type ParsedRunMeta = {
  warehouseId?: string
  runtimeMs?: number
}

export function buildDashboardModeStorageKey(tenantId?: string, userId?: string) {
  return `dashboard:mode:${tenantId ?? 'tenant'}:${userId ?? 'user'}`
}

export function readDashboardModeFromStorage(modeStorageKey: string): DashboardMode {
  if (typeof window === 'undefined') return 'actionable'
  const scoped = window.localStorage.getItem(modeStorageKey)
  if (scoped === 'all' || scoped === 'actionable') return scoped
  const legacy = window.localStorage.getItem('dashboard:mode')
  if (legacy === 'all' || legacy === 'actionable') return legacy
  return 'actionable'
}

export function buildDashboardIdempotencyKey(input: {
  tenantId?: string
  warehouseId?: string
  windowDays: number
  now?: Date
}) {
  const dayBucket = (input.now ?? new Date()).toISOString().slice(0, 10)
  return `dashboard:${input.tenantId ?? 'tenant'}:${input.warehouseId ?? 'default'}:window:${input.windowDays}:day:${dayBucket}`
}

export function parseRunMeta(note?: string | null): ParsedRunMeta | null {
  if (!note) return null
  try {
    const parsed = JSON.parse(note) as { fingerprint?: string; runtimeMs?: number; warehouseId?: string }
    const fingerprint = parsed.fingerprint ?? ''
    const warehouseIdFromFingerprint =
      typeof fingerprint === 'string' && fingerprint.includes('|') ? fingerprint.split('|')[2] : undefined
    return {
      warehouseId: parsed.warehouseId ?? warehouseIdFromFingerprint,
      runtimeMs: typeof parsed.runtimeMs === 'number' ? parsed.runtimeMs : undefined,
    }
  } catch {
    return null
  }
}

const SUCCESS_RUN_STATUSES = new Set(['published', 'computed', 'archived', 'completed', 'succeeded', 'success'])

export function isSuccessfulKpiRun(status?: string | null) {
  if (!status) return false
  return SUCCESS_RUN_STATUSES.has(status.toLowerCase())
}

function runTimestamp(run: KpiRun) {
  return new Date(run.as_of ?? run.finished_at ?? run.started_at ?? '').getTime()
}

export function selectLastSuccessfulRun(runs: KpiRun[]) {
  const successful = runs.filter((run) => isSuccessfulKpiRun(run.status))
  if (successful.length === 0) return null
  const sorted = [...successful].sort((left, right) => runTimestamp(right) - runTimestamp(left))
  return sorted[0] ?? null
}

export function resolveWarehouseScopeLabel(input: {
  warehouseId?: string | null
  warehouseLookup: Map<string, { code?: string; name?: string }>
}) {
  const warehouseId = input.warehouseId ?? undefined
  if (!warehouseId) {
    return {
      label: 'All active warehouses',
      rawId: null as string | null,
    }
  }
  const warehouse = input.warehouseLookup.get(warehouseId)
  if (!warehouse) {
    return {
      label: 'Warehouse scope not resolved',
      rawId: warehouseId,
    }
  }
  if (warehouse.code && warehouse.name) {
    return { label: `${warehouse.code} — ${warehouse.name}`, rawId: warehouseId }
  }
  if (warehouse.code) {
    return { label: warehouse.code, rawId: warehouseId }
  }
  if (warehouse.name) {
    return { label: warehouse.name, rawId: warehouseId }
  }
  return { label: 'Warehouse scope not resolved', rawId: warehouseId }
}

export function medianRuntimeSeconds(runtimeMsValues: number[]) {
  if (runtimeMsValues.length === 0) return null
  const sorted = [...runtimeMsValues].sort((left, right) => left - right)
  const midpoint = Math.floor(sorted.length / 2)
  const medianMs =
    sorted.length % 2 === 0 ? (sorted[midpoint - 1] + sorted[midpoint]) / 2 : sorted[midpoint]
  return Math.max(1, Math.round(medianMs / 1000))
}

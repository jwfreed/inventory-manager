import { apiGet } from '../http'
import type { ApiError, ApiNotAvailable, KpiRun, KpiSnapshot } from '../types'

export type KpiListSuccess<T> = {
  type: 'success'
  endpoint: string
  attempted: string[]
  data: T[]
}

export type ListKpiSnapshotsParams = {
  limit?: number
  page?: number
  pageSize?: number
  kpiName?: string
  from?: string
  to?: string
}

export type ListKpiRunsParams = {
  limit?: number
}

const SNAPSHOT_ENDPOINT_CANDIDATES = ['/kpis/snapshots', '/kpi-snapshots', '/metrics/kpis', '/kpis']
const RUN_ENDPOINT_CANDIDATES = ['/kpis/runs', '/kpi-runs']

let snapshotProbe:
  | { endpoint: string; attempted: string[] }
  | { notAvailable: true; attempted: string[] }
  | null = null

let runProbe:
  | { endpoint: string; attempted: string[] }
  | { notAvailable: true; attempted: string[] }
  | null = null

function normalizeSnapshot(row: any): KpiSnapshot {
  const rawValue = row?.value ?? row?.kpi_value ?? row?.metric_value ?? row?.metricValue
  let value: number | string | null = rawValue ?? null
  if (typeof value === 'string') {
    const parsed = Number(value)
    value = Number.isNaN(parsed) ? value : parsed
  }

  const computedAt =
    row?.computed_at ??
    row?.computedAt ??
    row?.snapshot_at ??
    row?.snapshotAt ??
    row?.timestamp ??
    row?.created_at ??
    row?.createdAt ??
    ''

  return {
    id: row?.id,
    kpi_name: row?.kpi_name ?? row?.kpiName ?? row?.name ?? 'unknown',
    value,
    unit: row?.unit ?? row?.units ?? row?.value_unit ?? row?.valueUnit ?? null,
    computed_at: computedAt || '',
    dimensions: row?.dimensions ?? row?.attrs ?? row?.meta ?? null,
    kpi_run_id: row?.kpi_run_id ?? row?.kpiRunId ?? null,
  }
}

function normalizeRun(row: any): KpiRun {
  return {
    id: row?.id,
    status: row?.status ?? row?.state ?? 'unknown',
    started_at: row?.started_at ?? row?.startedAt ?? row?.created_at ?? row?.createdAt ?? null,
    finished_at: row?.finished_at ?? row?.finishedAt ?? row?.completed_at ?? row?.completedAt ?? null,
    window_start: row?.window_start ?? row?.windowStart ?? null,
    window_end: row?.window_end ?? row?.windowEnd ?? null,
    as_of: row?.as_of ?? row?.asOf ?? null,
    notes: row?.notes ?? null,
  }
}

function extractList<T>(payload: any, mapper: (row: any) => T): T[] {
  if (!payload) return []
  if (Array.isArray(payload)) return payload.map(mapper)
  if (Array.isArray(payload?.data)) return payload.data.map(mapper)
  if (Array.isArray(payload?.snapshots)) return payload.snapshots.map(mapper)
  if (Array.isArray(payload?.results)) return payload.results.map(mapper)
  return []
}

function buildSnapshotQuery(params: ListKpiSnapshotsParams) {
  const query: Record<string, string | number> = {}
  if (params.limit) query.limit = params.limit
  if (params.page) query.page = params.page
  if (params.pageSize) query.page_size = params.pageSize
  if (params.kpiName) query.kpi_name = params.kpiName
  if (params.from) query.from = params.from
  if (params.to) query.to = params.to
  return query
}

export async function listKpiSnapshots(
  params: ListKpiSnapshotsParams = {},
): Promise<KpiListSuccess<KpiSnapshot> | ApiNotAvailable> {
  if (snapshotProbe && 'notAvailable' in snapshotProbe) {
    return { type: 'ApiNotAvailable', attemptedEndpoints: snapshotProbe.attempted }
  }

  const attempted: string[] = []
  const candidates = snapshotProbe?.endpoint ? [snapshotProbe.endpoint] : SNAPSHOT_ENDPOINT_CANDIDATES

  for (const endpoint of candidates) {
    attempted.push(endpoint)
    try {
      const response = await apiGet<any>(endpoint, { params: buildSnapshotQuery(params) })
      const data = extractList(response, normalizeSnapshot)
      snapshotProbe = { endpoint, attempted }
      return { type: 'success', endpoint, attempted, data }
    } catch (err) {
      const apiErr = err as ApiError
      if (apiErr?.status === 404) {
        continue
      }
      throw err
    }
  }

  snapshotProbe = { notAvailable: true, attempted }
  return { type: 'ApiNotAvailable', attemptedEndpoints: attempted }
}

export async function listKpiRuns(
  params: ListKpiRunsParams = {},
): Promise<KpiListSuccess<KpiRun> | ApiNotAvailable> {
  if (runProbe && 'notAvailable' in runProbe) {
    return { type: 'ApiNotAvailable', attemptedEndpoints: runProbe.attempted }
  }

  const attempted: string[] = []
  const candidates = runProbe?.endpoint ? [runProbe.endpoint] : RUN_ENDPOINT_CANDIDATES
  for (const endpoint of candidates) {
    attempted.push(endpoint)
    try {
      const response = await apiGet<any>(endpoint, { params })
      const data = extractList(response, normalizeRun)
      runProbe = { endpoint, attempted }
      return { type: 'success', endpoint, attempted, data }
    } catch (err) {
      const apiErr = err as ApiError
      if (apiErr?.status === 404) {
        continue
      }
      throw err
    }
  }

  runProbe = { notAvailable: true, attempted }
  return { type: 'ApiNotAvailable', attemptedEndpoints: attempted }
}

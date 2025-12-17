import { apiGet } from '../http'
import type { ApiError, ApiNotAvailable, FulfillmentFillRate, KpiRun, KpiSnapshot } from '../types'

export type KpiListSuccess<T> = {
  type: 'success'
  endpoint: string
  attempted: string[]
  data: T[]
}

export type ListKpiSnapshotsParams = {
  limit?: number
  offset?: number
  kpiName?: string
  from?: string
  to?: string
}

export type ListKpiRunsParams = {
  limit?: number
  offset?: number
}

// KPI storage endpoints are available on the backend.
const KPI_SNAPSHOT_ENDPOINT = '/kpis/snapshots'
const KPI_RUN_ENDPOINT = '/kpis/runs'

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
  if (params.offset !== undefined) query.offset = params.offset
  if (params.kpiName) query.kpi_name = params.kpiName
  if (params.from) query.from = params.from
  if (params.to) query.to = params.to
  return query
}

export async function listKpiSnapshots(
  params: ListKpiSnapshotsParams = {},
): Promise<KpiListSuccess<KpiSnapshot> | ApiNotAvailable> {
  if (!KPI_SNAPSHOT_ENDPOINT) {
    return { type: 'ApiNotAvailable', attemptedEndpoints: [] }
  }

  try {
    const response = await apiGet<any>(KPI_SNAPSHOT_ENDPOINT, { params: buildSnapshotQuery(params) })
    const data = extractList(response, normalizeSnapshot)
    return { type: 'success', endpoint: KPI_SNAPSHOT_ENDPOINT, attempted: [KPI_SNAPSHOT_ENDPOINT], data }
  } catch (err) {
    const apiErr = err as ApiError
    if (apiErr?.status === 404) {
      return { type: 'ApiNotAvailable', attemptedEndpoints: [KPI_SNAPSHOT_ENDPOINT] }
    }
    throw err
  }
}

export async function listKpiRuns(
  params: ListKpiRunsParams = {},
): Promise<KpiListSuccess<KpiRun> | ApiNotAvailable> {
  if (!KPI_RUN_ENDPOINT) {
    return { type: 'ApiNotAvailable', attemptedEndpoints: [] }
  }

  try {
    const queryParams: Record<string, string | number> = {}
    if (params.limit) queryParams.limit = params.limit
    if (params.offset !== undefined) queryParams.offset = params.offset

    const response = await apiGet<any>(KPI_RUN_ENDPOINT, { params: queryParams })
    const data = extractList(response, normalizeRun)
    return { type: 'success', endpoint: KPI_RUN_ENDPOINT, attempted: [KPI_RUN_ENDPOINT], data }
  } catch (err) {
    const apiErr = err as ApiError
    if (apiErr?.status === 404) {
      return { type: 'ApiNotAvailable', attemptedEndpoints: [KPI_RUN_ENDPOINT] }
    }
    throw err
  }
}

export async function getFulfillmentFillRate(params: { from?: string; to?: string } = {}): Promise<FulfillmentFillRate> {
  const query: Record<string, string> = {}
  if (params.from) query.from = params.from
  if (params.to) query.to = params.to
  return apiGet<FulfillmentFillRate>('/kpis/fulfillment-fill-rate', { params: query })
}

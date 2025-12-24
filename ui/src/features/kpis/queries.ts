import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import type { ApiError, FulfillmentFillRate } from '../../api/types'
import { listKpiRuns, listKpiSnapshots, getFulfillmentFillRate } from './api/kpis'
import { listReplenishmentRecommendations } from './api/planning'

type KpiSnapshotsResult = Awaited<ReturnType<typeof listKpiSnapshots>>

type KpiRunsResult = Awaited<ReturnType<typeof listKpiRuns>>

type ReplenishmentResult = Awaited<ReturnType<typeof listReplenishmentRecommendations>>

export const kpisQueryKeys = {
  snapshots: (params: Parameters<typeof listKpiSnapshots>[0] = {}) =>
    ['kpis', 'snapshots', params] as const,
  runs: (params: Parameters<typeof listKpiRuns>[0] = {}) => ['kpis', 'runs', params] as const,
  fulfillmentFillRate: (params: { from?: string; to?: string } = {}) =>
    ['kpis', 'fill-rate', params] as const,
  replenishmentRecommendations: (params: { limit?: number; offset?: number } = {}) =>
    ['planning', 'replenishment', params] as const,
}

type KpiSnapshotsOptions = Omit<
  UseQueryOptions<KpiSnapshotsResult, ApiError>,
  'queryKey' | 'queryFn'
>

type KpiRunsOptions = Omit<UseQueryOptions<KpiRunsResult, ApiError>, 'queryKey' | 'queryFn'>

type FulfillmentFillRateOptions = Omit<
  UseQueryOptions<FulfillmentFillRate, ApiError>,
  'queryKey' | 'queryFn'
>

type ReplenishmentOptions = Omit<
  UseQueryOptions<ReplenishmentResult, ApiError>,
  'queryKey' | 'queryFn'
>

export function useKpiSnapshots(
  params: Parameters<typeof listKpiSnapshots>[0] = {},
  options: KpiSnapshotsOptions = {},
) {
  return useQuery({
    queryKey: kpisQueryKeys.snapshots(params),
    queryFn: () => listKpiSnapshots(params),
    retry: 1,
    ...options,
  })
}

export function useKpiRuns(
  params: Parameters<typeof listKpiRuns>[0] = {},
  options: KpiRunsOptions = {},
) {
  return useQuery({
    queryKey: kpisQueryKeys.runs(params),
    queryFn: () => listKpiRuns(params),
    retry: 1,
    ...options,
  })
}

export function useFulfillmentFillRate(
  params: { from?: string; to?: string } = {},
  options: FulfillmentFillRateOptions = {},
) {
  return useQuery({
    queryKey: kpisQueryKeys.fulfillmentFillRate(params),
    queryFn: () => getFulfillmentFillRate(params),
    retry: 1,
    ...options,
  })
}

export function useReplenishmentRecommendations(
  params: { limit?: number; offset?: number } = {},
  options: ReplenishmentOptions = {},
) {
  return useQuery({
    queryKey: kpisQueryKeys.replenishmentRecommendations(params),
    queryFn: () => listReplenishmentRecommendations(params),
    retry: 1,
    ...options,
  })
}

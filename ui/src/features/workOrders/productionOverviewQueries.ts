import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import type { ApiError } from '../../api/types'
import {
  getProductionOverview,
  getProductionVolumeTrend,
  getTopBottomSKUs,
  getWIPStatusSummary,
  getMaterialsConsumed,
  type ProductionOverviewFilters,
  type ProductionOverviewData,
  type ProductionVolumeTrend,
  type TopBottomSKU,
  type WIPStatus,
  type MaterialConsumed,
} from './api/productionOverview'

export const productionOverviewQueryKeys = {
  all: ['production-overview'] as const,
  overview: (filters: ProductionOverviewFilters) =>
    [...productionOverviewQueryKeys.all, 'overview', filters] as const,
  volumeTrend: (filters: ProductionOverviewFilters) =>
    [...productionOverviewQueryKeys.all, 'volume-trend', filters] as const,
  topBottomSKUs: (filters: ProductionOverviewFilters) =>
    [...productionOverviewQueryKeys.all, 'top-bottom-skus', filters] as const,
  wipStatus: (filters: ProductionOverviewFilters) =>
    [...productionOverviewQueryKeys.all, 'wip-status', filters] as const,
  materialsConsumed: (filters: ProductionOverviewFilters) =>
    [...productionOverviewQueryKeys.all, 'materials-consumed', filters] as const,
}

type ProductionOverviewOptions = Omit<
  UseQueryOptions<ProductionOverviewData, ApiError>,
  'queryKey' | 'queryFn'
>

type VolumeTrendOptions = Omit<
  UseQueryOptions<ProductionVolumeTrend[], ApiError>,
  'queryKey' | 'queryFn'
>

type TopBottomSKUsOptions = Omit<UseQueryOptions<TopBottomSKU[], ApiError>, 'queryKey' | 'queryFn'>

type WIPStatusOptions = Omit<UseQueryOptions<WIPStatus[], ApiError>, 'queryKey' | 'queryFn'>

type MaterialsConsumedOptions = Omit<
  UseQueryOptions<MaterialConsumed[], ApiError>,
  'queryKey' | 'queryFn'
>

export function useProductionOverview(
  filters: ProductionOverviewFilters = {},
  options: ProductionOverviewOptions = {}
) {
  return useQuery({
    queryKey: productionOverviewQueryKeys.overview(filters),
    queryFn: () => getProductionOverview(filters),
    retry: 1,
    ...options,
  })
}

export function useProductionVolumeTrend(
  filters: ProductionOverviewFilters = {},
  options: VolumeTrendOptions = {}
) {
  return useQuery({
    queryKey: productionOverviewQueryKeys.volumeTrend(filters),
    queryFn: () => getProductionVolumeTrend(filters),
    retry: 1,
    ...options,
  })
}

export function useTopBottomSKUs(
  filters: ProductionOverviewFilters = {},
  options: TopBottomSKUsOptions = {}
) {
  return useQuery({
    queryKey: productionOverviewQueryKeys.topBottomSKUs(filters),
    queryFn: () => getTopBottomSKUs(filters),
    retry: 1,
    ...options,
  })
}

export function useWIPStatusSummary(
  filters: ProductionOverviewFilters = {},
  options: WIPStatusOptions = {}
) {
  return useQuery({
    queryKey: productionOverviewQueryKeys.wipStatus(filters),
    queryFn: () => getWIPStatusSummary(filters),
    retry: 1,
    ...options,
  })
}

export function useMaterialsConsumed(
  filters: ProductionOverviewFilters = {},
  options: MaterialsConsumedOptions = {}
) {
  return useQuery({
    queryKey: productionOverviewQueryKeys.materialsConsumed(filters),
    queryFn: () => getMaterialsConsumed(filters),
    retry: 1,
    ...options,
  })
}

import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import type {
  ApiError,
  InventoryCount,
  InventorySnapshotRow,
  InventorySnapshotSummaryDetailed,
  MovementLotAllocation,
} from '../../api/types'
import {
  listInventorySnapshotSummaryDetailed,
  listInventorySnapshotSummary,
  type InventorySnapshotSummaryParams,
} from './api/inventorySnapshot'
import { listLots, listMovementLotAllocations, type ListLotsParams } from './api/lots'
import {
  getInventoryCount as getInventoryCountApi,
  listInventoryCounts as listInventoryCountsApi,
  type InventoryCountsListParams,
} from './api/counts'

export const inventoryQueryKeys = {
  all: ['inventory'] as const,
  snapshotSummary: (params: InventorySnapshotSummaryParams = {}) =>
    [...inventoryQueryKeys.all, 'snapshot-summary', params] as const,
  snapshotSummaryDetailed: (params: InventorySnapshotSummaryParams = {}) =>
    [...inventoryQueryKeys.all, 'snapshot-summary-detailed', params] as const,
  countsList: (params: Partial<InventoryCountsListParams> = {}) =>
    [...inventoryQueryKeys.all, 'counts-list', params] as const,
  countsDetail: (id: string) => [...inventoryQueryKeys.all, 'counts-detail', id] as const,
}

export const lotsQueryKeys = {
  all: ['lots'] as const,
  list: (params: ListLotsParams = {}) => [...lotsQueryKeys.all, 'list', params] as const,
  movementAllocations: (movementLineId: string) =>
    [...lotsQueryKeys.all, 'movement-allocations', movementLineId] as const,
  movementAllocationsSummary: (movementId: string) =>
    [...lotsQueryKeys.all, 'movement-allocations-summary', movementId] as const,
}

type InventorySummaryOptions = Omit<
  UseQueryOptions<InventorySnapshotRow[], ApiError>,
  'queryKey' | 'queryFn'
>

type InventorySummaryDetailedOptions = Omit<
  UseQueryOptions<InventorySnapshotSummaryDetailed, ApiError>,
  'queryKey' | 'queryFn'
>

type LotsListOptions = Omit<
  UseQueryOptions<Awaited<ReturnType<typeof listLots>>, ApiError>,
  'queryKey' | 'queryFn'
>

type LotAllocationsOptions = Omit<
  UseQueryOptions<MovementLotAllocation[], ApiError>,
  'queryKey' | 'queryFn'
>

type InventoryCountsListOptions = Omit<
  UseQueryOptions<Awaited<ReturnType<typeof listInventoryCountsApi>>, ApiError>,
  'queryKey' | 'queryFn'
>

type InventoryCountDetailOptions = Omit<
  UseQueryOptions<InventoryCount, ApiError>,
  'queryKey' | 'queryFn'
>

export function useInventorySnapshotSummary(
  params: InventorySnapshotSummaryParams = {},
  options: InventorySummaryOptions = {},
) {
  return useQuery({
    queryKey: inventoryQueryKeys.snapshotSummary(params),
    queryFn: () => listInventorySnapshotSummary(params),
    retry: 1,
    ...options,
  })
}

export function useInventorySnapshotSummaryDetailed(
  params: InventorySnapshotSummaryParams = {},
  options: InventorySummaryDetailedOptions = {},
) {
  return useQuery({
    queryKey: inventoryQueryKeys.snapshotSummaryDetailed(params),
    queryFn: () => listInventorySnapshotSummaryDetailed(params),
    retry: 1,
    ...options,
  })
}

export function useLotsList(params: ListLotsParams = {}, options: LotsListOptions = {}) {
  return useQuery({
    queryKey: lotsQueryKeys.list(params),
    queryFn: () => listLots(params),
    retry: 1,
    ...options,
  })
}

export function useMovementLotAllocations(
  movementLineId?: string,
  options: LotAllocationsOptions = {},
) {
  return useQuery({
    queryKey: lotsQueryKeys.movementAllocations(movementLineId ?? ''),
    queryFn: () => listMovementLotAllocations(movementLineId as string),
    enabled: Boolean(movementLineId),
    retry: 1,
    ...options,
  })
}

export function useInventoryCountsList(
  params?: InventoryCountsListParams,
  options: InventoryCountsListOptions = {},
) {
  return useQuery({
    queryKey: inventoryQueryKeys.countsList(params),
    queryFn: () => listInventoryCountsApi(params as InventoryCountsListParams),
    enabled: Boolean(params?.warehouseId),
    retry: 1,
    ...options,
  })
}

export function useInventoryCount(id?: string, options: InventoryCountDetailOptions = {}) {
  return useQuery({
    queryKey: inventoryQueryKeys.countsDetail(id ?? ''),
    queryFn: () => getInventoryCountApi(id as string),
    enabled: Boolean(id),
    retry: 1,
    ...options,
  })
}

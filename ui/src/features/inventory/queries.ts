import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import type { ApiError, InventorySnapshotRow, MovementLotAllocation } from '../../api/types'
import {
  listInventorySnapshotSummary,
  type InventorySnapshotSummaryParams,
} from './api/inventorySnapshot'
import { listLots, listMovementLotAllocations, type ListLotsParams } from './api/lots'

export const inventoryQueryKeys = {
  all: ['inventory'] as const,
  snapshotSummary: (params: InventorySnapshotSummaryParams = {}) =>
    [...inventoryQueryKeys.all, 'snapshot-summary', params] as const,
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

type LotsListOptions = Omit<
  UseQueryOptions<Awaited<ReturnType<typeof listLots>>, ApiError>,
  'queryKey' | 'queryFn'
>

type LotAllocationsOptions = Omit<
  UseQueryOptions<MovementLotAllocation[], ApiError>,
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

import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import type { ApiError, InventoryAdjustment, InventoryAdjustmentListResponse } from '../../api/types'
import {
  getInventoryAdjustment,
  listInventoryAdjustments,
  type AdjustmentListParams,
} from './api/adjustments'

export const adjustmentsQueryKeys = {
  all: ['inventory-adjustments'] as const,
  list: (params: AdjustmentListParams = {}) =>
    [...adjustmentsQueryKeys.all, 'list', params] as const,
  detail: (id: string) => [...adjustmentsQueryKeys.all, 'detail', id] as const,
}

type AdjustmentsListOptions = Omit<
  UseQueryOptions<InventoryAdjustmentListResponse, ApiError>,
  'queryKey' | 'queryFn'
>

type AdjustmentOptions = Omit<
  UseQueryOptions<InventoryAdjustment, ApiError>,
  'queryKey' | 'queryFn'
>

export function useInventoryAdjustmentsList(
  params: AdjustmentListParams = {},
  options: AdjustmentsListOptions = {},
) {
  return useQuery({
    queryKey: adjustmentsQueryKeys.list(params),
    queryFn: () => listInventoryAdjustments(params),
    retry: 1,
    ...options,
  })
}

export function useInventoryAdjustment(id?: string, options: AdjustmentOptions = {}) {
  return useQuery({
    queryKey: adjustmentsQueryKeys.detail(id ?? ''),
    queryFn: () => getInventoryAdjustment(id as string),
    enabled: Boolean(id),
    retry: 1,
    ...options,
  })
}

import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import type { ApiError, Item, ItemInventoryRow } from '../../api/types'
import {
  getItem,
  getItemInventorySummary,
  getItemMetrics,
  getItemsMetrics,
  listItems,
  type ItemMetrics,
  type ListItemsParams,
} from './api/items'

export const itemsQueryKeys = {
  all: ['items'] as const,
  list: (params: ListItemsParams = {}) => [...itemsQueryKeys.all, 'list', params] as const,
  detail: (id: string) => [...itemsQueryKeys.all, 'detail', id] as const,
  inventorySummary: (id: string) => [...itemsQueryKeys.all, 'inventory-summary', id] as const,
  metrics: (id: string, windowDays?: number) => [...itemsQueryKeys.all, 'metrics', id, windowDays] as const,
  metricsList: (itemIds: string[], windowDays?: number) =>
    [...itemsQueryKeys.all, 'metrics-list', itemIds, windowDays] as const,
}

type ItemsListOptions = Omit<
  UseQueryOptions<{ data: Item[]; paging?: { limit: number; offset: number; total?: number } }, ApiError>,
  'queryKey' | 'queryFn'
>

type ItemOptions = Omit<UseQueryOptions<Item, ApiError>, 'queryKey' | 'queryFn'>

type ItemInventoryOptions = Omit<
  UseQueryOptions<ItemInventoryRow[], ApiError>,
  'queryKey' | 'queryFn'
>

type ItemMetricsOptions = Omit<UseQueryOptions<ItemMetrics, ApiError>, 'queryKey' | 'queryFn'>
type ItemsMetricsOptions = Omit<UseQueryOptions<ItemMetrics[], ApiError>, 'queryKey' | 'queryFn'>

export function useItemsList(params: ListItemsParams = {}, options: ItemsListOptions = {}) {
  return useQuery({
    queryKey: itemsQueryKeys.list(params),
    queryFn: () => listItems(params),
    staleTime: 5 * 60 * 1000, // 5 minutes - master data changes infrequently
    retry: 1,
    ...options,
  })
}

export function useItem(id?: string, options: ItemOptions = {}) {
  return useQuery({
    queryKey: itemsQueryKeys.detail(id ?? ''),
    queryFn: () => getItem(id as string),
    enabled: Boolean(id),
    staleTime: 5 * 60 * 1000, // 5 minutes - master data changes infrequently
    retry: 1,
    ...options,
  })
}

export function useItemInventorySummary(id?: string, options: ItemInventoryOptions = {}) {
  return useQuery({
    queryKey: itemsQueryKeys.inventorySummary(id ?? ''),
    queryFn: () => getItemInventorySummary(id as string),
    enabled: Boolean(id),
    retry: 1,
    ...options,
  })
}

export function useItemMetrics(
  id?: string,
  windowDays: number = 90,
  options: ItemMetricsOptions = {}
) {
  return useQuery({
    queryKey: itemsQueryKeys.metrics(id ?? '', windowDays),
    queryFn: () => getItemMetrics(id as string, windowDays),
    enabled: Boolean(id),
    retry: 1,
    ...options,
  })
}

export function useItemsMetrics(
  itemIds: string[],
  windowDays: number = 90,
  options: ItemsMetricsOptions = {}
) {
  return useQuery({
    queryKey: itemsQueryKeys.metricsList(itemIds, windowDays),
    queryFn: () => getItemsMetrics(itemIds, windowDays),
    retry: 1,
    ...options,
    enabled: itemIds.length > 0 && (options.enabled ?? true),
  })
}

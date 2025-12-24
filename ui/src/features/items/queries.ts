import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import type { ApiError, Item, ItemInventoryRow } from '../../api/types'
import { getItem, getItemInventorySummary, listItems, type ListItemsParams } from './api/items'

export const itemsQueryKeys = {
  all: ['items'] as const,
  list: (params: ListItemsParams = {}) => [...itemsQueryKeys.all, 'list', params] as const,
  detail: (id: string) => [...itemsQueryKeys.all, 'detail', id] as const,
  inventorySummary: (id: string) => [...itemsQueryKeys.all, 'inventory-summary', id] as const,
}

type ItemsListOptions = Omit<
  UseQueryOptions<{ data: Item[] }, ApiError>,
  'queryKey' | 'queryFn'
>

type ItemOptions = Omit<UseQueryOptions<Item, ApiError>, 'queryKey' | 'queryFn'>

type ItemInventoryOptions = Omit<
  UseQueryOptions<ItemInventoryRow[], ApiError>,
  'queryKey' | 'queryFn'
>

export function useItemsList(params: ListItemsParams = {}, options: ItemsListOptions = {}) {
  return useQuery({
    queryKey: itemsQueryKeys.list(params),
    queryFn: () => listItems(params),
    retry: 1,
    ...options,
  })
}

export function useItem(id?: string, options: ItemOptions = {}) {
  return useQuery({
    queryKey: itemsQueryKeys.detail(id ?? ''),
    queryFn: () => getItem(id as string),
    enabled: Boolean(id),
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

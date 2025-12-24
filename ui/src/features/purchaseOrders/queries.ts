import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import type { ApiError, PurchaseOrder } from '../../api/types'
import { getPurchaseOrder, listPurchaseOrders } from './api/purchaseOrders'

export const purchaseOrdersQueryKeys = {
  all: ['purchase-orders'] as const,
  list: (params: { limit?: number; offset?: number } = {}) =>
    [...purchaseOrdersQueryKeys.all, 'list', params] as const,
  detail: (id: string) => [...purchaseOrdersQueryKeys.all, 'detail', id] as const,
}

type PurchaseOrdersListOptions = Omit<
  UseQueryOptions<Awaited<ReturnType<typeof listPurchaseOrders>>, ApiError>,
  'queryKey' | 'queryFn'
>

type PurchaseOrderOptions = Omit<UseQueryOptions<PurchaseOrder, ApiError>, 'queryKey' | 'queryFn'>

export function usePurchaseOrdersList(
  params: { limit?: number; offset?: number } = {},
  options: PurchaseOrdersListOptions = {},
) {
  return useQuery({
    queryKey: purchaseOrdersQueryKeys.list(params),
    queryFn: () => listPurchaseOrders(params),
    retry: 1,
    ...options,
  })
}

export function usePurchaseOrder(id?: string, options: PurchaseOrderOptions = {}) {
  return useQuery({
    queryKey: purchaseOrdersQueryKeys.detail(id ?? ''),
    queryFn: () => getPurchaseOrder(id as string),
    enabled: Boolean(id),
    retry: 1,
    ...options,
  })
}

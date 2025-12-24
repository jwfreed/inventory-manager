import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import type { ApiError, PurchaseOrderReceipt, Putaway, QcEvent } from '../../api/types'
import { getReceipt, listReceipts } from './api/receipts'
import { getPutaway } from './api/putaways'
import { listQcEventsForLine } from './api/qc'

export const receivingQueryKeys = {
  receipts: {
    all: ['receipts'] as const,
    list: (params: { limit?: number; offset?: number } = {}) =>
      [...receivingQueryKeys.receipts.all, 'list', params] as const,
    detail: (id: string) => [...receivingQueryKeys.receipts.all, 'detail', id] as const,
  },
  qcEvents: {
    all: ['qc-events'] as const,
    forLine: (lineId: string) => [...receivingQueryKeys.qcEvents.all, 'line', lineId] as const,
  },
  putaways: {
    all: ['putaways'] as const,
    detail: (id: string) => [...receivingQueryKeys.putaways.all, 'detail', id] as const,
  },
}

type ReceiptsListOptions = Omit<
  UseQueryOptions<Awaited<ReturnType<typeof listReceipts>>, ApiError>,
  'queryKey' | 'queryFn'
>

type ReceiptOptions = Omit<
  UseQueryOptions<PurchaseOrderReceipt, ApiError>,
  'queryKey' | 'queryFn'
>

type QcEventsOptions = Omit<UseQueryOptions<{ data: QcEvent[] }, ApiError>, 'queryKey' | 'queryFn'>

type PutawayOptions = Omit<UseQueryOptions<Putaway, ApiError>, 'queryKey' | 'queryFn'>

export function useReceiptsList(
  params: { limit?: number; offset?: number } = {},
  options: ReceiptsListOptions = {},
) {
  return useQuery({
    queryKey: receivingQueryKeys.receipts.list(params),
    queryFn: () => listReceipts(params),
    retry: 1,
    ...options,
  })
}

export function useReceipt(id?: string, options: ReceiptOptions = {}) {
  return useQuery({
    queryKey: receivingQueryKeys.receipts.detail(id ?? ''),
    queryFn: () => getReceipt(id as string),
    enabled: Boolean(id),
    retry: 1,
    ...options,
  })
}

export function useQcEventsForLine(lineId?: string, options: QcEventsOptions = {}) {
  return useQuery({
    queryKey: receivingQueryKeys.qcEvents.forLine(lineId ?? ''),
    queryFn: () => listQcEventsForLine(lineId as string),
    enabled: Boolean(lineId),
    retry: 1,
    ...options,
  })
}

export function usePutaway(id?: string, options: PutawayOptions = {}) {
  return useQuery({
    queryKey: receivingQueryKeys.putaways.detail(id ?? ''),
    queryFn: () => getPutaway(id as string),
    enabled: Boolean(id),
    retry: 1,
    ...options,
  })
}

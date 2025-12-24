import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import type { ApiError, Reservation, ReturnDoc, SalesOrder, Shipment } from '../../api/types'
import {
  getSalesOrder,
  listSalesOrders,
  type SalesOrderListParams,
} from './api/salesOrders'
import { getShipment, listShipments, type ShipmentListParams } from './api/shipments'
import { getReturn, listReturns, type ReturnListParams } from './api/returns'
import { getReservation, listReservations, type ReservationListParams } from './api/reservations'

export const orderToCashQueryKeys = {
  salesOrders: {
    all: ['sales-orders'] as const,
    list: (params: SalesOrderListParams = {}) =>
      [...orderToCashQueryKeys.salesOrders.all, 'list', params] as const,
    detail: (id: string) => [...orderToCashQueryKeys.salesOrders.all, 'detail', id] as const,
  },
  shipments: {
    all: ['shipments'] as const,
    list: (params: ShipmentListParams = {}) =>
      [...orderToCashQueryKeys.shipments.all, 'list', params] as const,
    detail: (id: string) => [...orderToCashQueryKeys.shipments.all, 'detail', id] as const,
  },
  returns: {
    all: ['returns'] as const,
    list: (params: ReturnListParams = {}) =>
      [...orderToCashQueryKeys.returns.all, 'list', params] as const,
    detail: (id: string) => [...orderToCashQueryKeys.returns.all, 'detail', id] as const,
  },
  reservations: {
    all: ['reservations'] as const,
    list: (params: ReservationListParams = {}) =>
      [...orderToCashQueryKeys.reservations.all, 'list', params] as const,
    detail: (id: string) => [...orderToCashQueryKeys.reservations.all, 'detail', id] as const,
  },
}

type SalesOrdersListOptions = Omit<
  UseQueryOptions<Awaited<ReturnType<typeof listSalesOrders>>, ApiError>,
  'queryKey' | 'queryFn'
>

type SalesOrderOptions = Omit<UseQueryOptions<SalesOrder, ApiError>, 'queryKey' | 'queryFn'>

type ShipmentsListOptions = Omit<
  UseQueryOptions<Awaited<ReturnType<typeof listShipments>>, ApiError>,
  'queryKey' | 'queryFn'
>

type ShipmentOptions = Omit<UseQueryOptions<Shipment, ApiError>, 'queryKey' | 'queryFn'>

type ReturnsListOptions = Omit<
  UseQueryOptions<Awaited<ReturnType<typeof listReturns>>, ApiError>,
  'queryKey' | 'queryFn'
>

type ReturnOptions = Omit<UseQueryOptions<ReturnDoc, ApiError>, 'queryKey' | 'queryFn'>

type ReservationsListOptions = Omit<
  UseQueryOptions<Awaited<ReturnType<typeof listReservations>>, ApiError>,
  'queryKey' | 'queryFn'
>

type ReservationOptions = Omit<UseQueryOptions<Reservation, ApiError>, 'queryKey' | 'queryFn'>

export function useSalesOrdersList(
  params: SalesOrderListParams = {},
  options: SalesOrdersListOptions = {},
) {
  return useQuery({
    queryKey: orderToCashQueryKeys.salesOrders.list(params),
    queryFn: () => listSalesOrders(params),
    retry: 1,
    ...options,
  })
}

export function useSalesOrder(id?: string, options: SalesOrderOptions = {}) {
  return useQuery({
    queryKey: orderToCashQueryKeys.salesOrders.detail(id ?? ''),
    queryFn: () => getSalesOrder(id as string),
    enabled: Boolean(id),
    retry: 1,
    ...options,
  })
}

export function useShipmentsList(
  params: ShipmentListParams = {},
  options: ShipmentsListOptions = {},
) {
  return useQuery({
    queryKey: orderToCashQueryKeys.shipments.list(params),
    queryFn: () => listShipments(params),
    retry: 1,
    ...options,
  })
}

export function useShipment(id?: string, options: ShipmentOptions = {}) {
  return useQuery({
    queryKey: orderToCashQueryKeys.shipments.detail(id ?? ''),
    queryFn: () => getShipment(id as string),
    enabled: Boolean(id),
    retry: 1,
    ...options,
  })
}

export function useReturnsList(
  params: ReturnListParams = {},
  options: ReturnsListOptions = {},
) {
  return useQuery({
    queryKey: orderToCashQueryKeys.returns.list(params),
    queryFn: () => listReturns(params),
    retry: 1,
    ...options,
  })
}

export function useReturn(id?: string, options: ReturnOptions = {}) {
  return useQuery({
    queryKey: orderToCashQueryKeys.returns.detail(id ?? ''),
    queryFn: () => getReturn(id as string),
    enabled: Boolean(id),
    retry: 1,
    ...options,
  })
}

export function useReservationsList(
  params: ReservationListParams = {},
  options: ReservationsListOptions = {},
) {
  return useQuery({
    queryKey: orderToCashQueryKeys.reservations.list(params),
    queryFn: () => listReservations(params),
    retry: 1,
    ...options,
  })
}

export function useReservation(id?: string, options: ReservationOptions = {}) {
  return useQuery({
    queryKey: orderToCashQueryKeys.reservations.detail(id ?? ''),
    queryFn: () => getReservation(id as string),
    enabled: Boolean(id),
    retry: 1,
    ...options,
  })
}

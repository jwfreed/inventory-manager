import { apiGet } from '../../../api/http'
import type { Reservation } from '../../../api/types'
import { ORDER_TO_CASH_ENDPOINTS } from './config'
import { resolveWarehouseId } from '../../../api/warehouseContext'

type ListResponse = { data: Reservation[]; paging?: { limit: number; offset: number } }

export type ReservationListParams = {
  warehouseId?: string
  limit?: number
  offset?: number
}

export async function listReservations(params: ReservationListParams = {}): Promise<ListResponse> {
  const warehouseId = await resolveWarehouseId({ warehouseId: params.warehouseId })
  const query: Record<string, number | string> = { warehouseId }
  if (params.limit) query.limit = params.limit
  if (params.offset !== undefined) query.offset = params.offset
  const res = await apiGet<
    Reservation[] | { data?: Reservation[]; paging?: { limit: number; offset: number } }
  >(ORDER_TO_CASH_ENDPOINTS.reservations, { params: query })
  if (Array.isArray(res)) {
    return { data: res }
  }
  return { data: res.data ?? [], paging: res.paging }
}

export async function getReservation(id: string, warehouseId?: string): Promise<Reservation> {
  const resolvedWarehouseId = await resolveWarehouseId({ warehouseId })
  return await apiGet<Reservation>(`${ORDER_TO_CASH_ENDPOINTS.reservations}/${id}`, {
    params: { warehouseId: resolvedWarehouseId }
  })
}

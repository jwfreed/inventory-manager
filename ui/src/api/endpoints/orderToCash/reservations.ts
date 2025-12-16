import { apiGet } from '../../http'
import type { Reservation } from '../../types'
import { ORDER_TO_CASH_ENDPOINTS } from './config'

type ListResponse = { data: Reservation[]; paging?: { limit: number; offset: number } }

export async function listReservations(): Promise<ListResponse> {
  const res = await apiGet<Reservation[] | { data?: Reservation[]; paging?: { limit: number; offset: number } }>(
    ORDER_TO_CASH_ENDPOINTS.reservations,
  )
  if (Array.isArray(res)) {
    return { data: res }
  }
  return { data: res.data ?? [], paging: res.paging }
}

export async function getReservation(id: string): Promise<Reservation> {
  return await apiGet<Reservation>(`${ORDER_TO_CASH_ENDPOINTS.reservations}/${id}`)
}

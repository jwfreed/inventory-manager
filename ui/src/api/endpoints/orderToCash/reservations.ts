import { apiGet } from '../../http'
import type { ApiError, Reservation } from '../../types'
import { ORDER_TO_CASH_ENDPOINTS } from './config'

type ListResponse = { data: Reservation[]; notImplemented?: boolean }

export async function listReservations(): Promise<ListResponse> {
  if (!ORDER_TO_CASH_ENDPOINTS.reservations) {
    return { data: [], notImplemented: true }
  }

  try {
    const res = await apiGet<Reservation[] | { data?: Reservation[] }>(
      ORDER_TO_CASH_ENDPOINTS.reservations,
    )
    if (Array.isArray(res)) return { data: res }
    return { data: res.data ?? [] }
  } catch (error) {
    const err = error as ApiError
    if (err.status === 404) return { data: [], notImplemented: true }
    throw err
  }
}

export async function getReservation(
  id: string,
): Promise<Reservation & { notImplemented?: boolean }> {
  if (!ORDER_TO_CASH_ENDPOINTS.reservations) {
    return { id, notImplemented: true }
  }

  try {
    return await apiGet<Reservation>(`${ORDER_TO_CASH_ENDPOINTS.reservations}/${id}`)
  } catch (error) {
    const err = error as ApiError
    if (err.status === 404) {
      return { id, notImplemented: true }
    }
    throw err
  }
}

import { apiGet } from '../../http'
import type { ApiError, Reservation } from '../../types'

type ListResponse = { data: Reservation[]; notImplemented?: boolean }

export async function listReservations(): Promise<ListResponse> {
  try {
    const res = await apiGet<Reservation[] | { data?: Reservation[] }>('/reservations')
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
  try {
    return await apiGet<Reservation>(`/reservations/${id}`)
  } catch (error) {
    const err = error as ApiError
    if (err.status === 404) {
      return { id, notImplemented: true }
    }
    throw err
  }
}

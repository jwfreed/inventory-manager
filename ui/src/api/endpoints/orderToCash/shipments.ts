import { apiGet } from '../../http'
import type { ApiError, Shipment } from '../../types'

type ListResponse = { data: Shipment[]; notImplemented?: boolean }

export async function listShipments(): Promise<ListResponse> {
  try {
    const res = await apiGet<Shipment[] | { data?: Shipment[] }>('/shipments')
    if (Array.isArray(res)) return { data: res }
    return { data: res.data ?? [] }
  } catch (error) {
    const err = error as ApiError
    if (err.status === 404) return { data: [], notImplemented: true }
    throw err
  }
}

export async function getShipment(id: string): Promise<Shipment & { notImplemented?: boolean }> {
  try {
    return await apiGet<Shipment>(`/shipments/${id}`)
  } catch (error) {
    const err = error as ApiError
    if (err.status === 404) {
      return { id, notImplemented: true }
    }
    throw err
  }
}

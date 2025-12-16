import { apiGet } from '../../http'
import type { ApiError, Shipment } from '../../types'
import { ORDER_TO_CASH_ENDPOINTS } from './config'

type ListResponse = { data: Shipment[]; notImplemented?: boolean }

export async function listShipments(): Promise<ListResponse> {
  if (!ORDER_TO_CASH_ENDPOINTS.shipments) {
    return { data: [], notImplemented: true }
  }

  try {
    const res = await apiGet<Shipment[] | { data?: Shipment[] }>(
      ORDER_TO_CASH_ENDPOINTS.shipments,
    )
    if (Array.isArray(res)) return { data: res }
    return { data: res.data ?? [] }
  } catch (error) {
    const err = error as ApiError
    if (err.status === 404) return { data: [], notImplemented: true }
    throw err
  }
}

export async function getShipment(id: string): Promise<Shipment & { notImplemented?: boolean }> {
  if (!ORDER_TO_CASH_ENDPOINTS.shipments) {
    return { id, notImplemented: true }
  }

  try {
    return await apiGet<Shipment>(`${ORDER_TO_CASH_ENDPOINTS.shipments}/${id}`)
  } catch (error) {
    const err = error as ApiError
    if (err.status === 404) {
      return { id, notImplemented: true }
    }
    throw err
  }
}

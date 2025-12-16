import { apiGet } from '../../http'
import type { ApiError, SalesOrder } from '../../types'
import { ORDER_TO_CASH_ENDPOINTS } from './config'

type ListResponse = { data: SalesOrder[]; notImplemented?: boolean }

export async function listSalesOrders(): Promise<ListResponse> {
  if (!ORDER_TO_CASH_ENDPOINTS.salesOrders) {
    return { data: [], notImplemented: true }
  }

  try {
    const res = await apiGet<SalesOrder[] | { data?: SalesOrder[] }>(
      ORDER_TO_CASH_ENDPOINTS.salesOrders,
    )
    if (Array.isArray(res)) return { data: res }
    return { data: res.data ?? [] }
  } catch (error) {
    const err = error as ApiError
    if (err.status === 404) return { data: [], notImplemented: true }
    throw err
  }
}

export async function getSalesOrder(id: string): Promise<SalesOrder & { notImplemented?: boolean }> {
  if (!ORDER_TO_CASH_ENDPOINTS.salesOrders) {
    return { id, soNumber: id, notImplemented: true }
  }

  try {
    return await apiGet<SalesOrder>(`${ORDER_TO_CASH_ENDPOINTS.salesOrders}/${id}`)
  } catch (error) {
    const err = error as ApiError
    if (err.status === 404) {
      return { id, soNumber: id, notImplemented: true }
    }
    throw err
  }
}

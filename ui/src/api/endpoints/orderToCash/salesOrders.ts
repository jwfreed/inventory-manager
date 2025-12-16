import { apiGet } from '../../http'
import type { ApiError, SalesOrder } from '../../types'

type ListResponse = { data: SalesOrder[]; notImplemented?: boolean }

export async function listSalesOrders(): Promise<ListResponse> {
  try {
    const res = await apiGet<SalesOrder[] | { data?: SalesOrder[] }>('/sales-orders')
    if (Array.isArray(res)) return { data: res }
    return { data: res.data ?? [] }
  } catch (error) {
    const err = error as ApiError
    if (err.status === 404) return { data: [], notImplemented: true }
    throw err
  }
}

export async function getSalesOrder(id: string): Promise<SalesOrder & { notImplemented?: boolean }> {
  try {
    return await apiGet<SalesOrder>(`/sales-orders/${id}`)
  } catch (error) {
    const err = error as ApiError
    if (err.status === 404) {
      return { id, soNumber: id, notImplemented: true }
    }
    throw err
  }
}

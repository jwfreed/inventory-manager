import { apiGet } from '../http'
import type { PurchaseOrder } from '../types'

export type PurchaseOrderListResponse = {
  data: PurchaseOrder[]
  paging?: { limit: number; offset: number }
}

export async function listPurchaseOrders(params: { limit?: number; offset?: number } = {}): Promise<PurchaseOrderListResponse> {
  return apiGet<PurchaseOrderListResponse>('/purchase-orders', { params })
}

export async function getPurchaseOrder(id: string): Promise<PurchaseOrder> {
  return apiGet<PurchaseOrder>(`/purchase-orders/${id}`)
}

import { apiGet } from '../http'
import { apiPost } from '../http'
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

export type PurchaseOrderCreateInput = {
  poNumber?: string
  vendorId: string
  status?: 'draft' | 'submitted'
  orderDate?: string
  expectedDate?: string
  shipToLocationId?: string
  vendorReference?: string
  notes?: string
  lines: {
    lineNumber?: number
    itemId: string
    uom: string
    quantityOrdered: number
    notes?: string
  }[]
}

export async function createPurchaseOrder(payload: PurchaseOrderCreateInput): Promise<PurchaseOrder> {
  return apiPost<PurchaseOrder>('/purchase-orders', payload)
}

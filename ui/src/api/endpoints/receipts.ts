import { apiGet, apiPost } from '../http'
import type { PurchaseOrderReceipt } from '../types'

export type ReceiptCreatePayload = {
  purchaseOrderId: string
  receivedAt: string
  receivedToLocationId?: string
  externalRef?: string
  notes?: string
  lines: {
    purchaseOrderLineId: string
    uom: string
    quantityReceived: number
  }[]
}

export async function createReceipt(payload: ReceiptCreatePayload): Promise<PurchaseOrderReceipt> {
  return apiPost<PurchaseOrderReceipt>('/purchase-order-receipts', payload)
}

export async function getReceipt(id: string): Promise<PurchaseOrderReceipt> {
  return apiGet<PurchaseOrderReceipt>(`/purchase-order-receipts/${id}`)
}

export async function listReceipts(params: { limit?: number; offset?: number } = {}): Promise<{ data: PurchaseOrderReceipt[] }> {
  return apiGet<{ data: PurchaseOrderReceipt[] }>('/purchase-order-receipts', { params })
}

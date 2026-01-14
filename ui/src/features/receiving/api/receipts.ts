import { apiGet, apiPost } from '../../../api/http'
import type { PurchaseOrderReceipt } from '../../../api/types'

export type ReceiptCreatePayload = {
  purchaseOrderId: string
  receivedAt: string
  receivedToLocationId?: string
  externalRef?: string
  notes?: string
  idempotencyKey?: string
  lines: {
    purchaseOrderLineId: string
    uom: string
    quantityReceived: number
    unitCost?: number
    discrepancyReason?: 'short' | 'over' | 'damaged' | 'substituted'
    discrepancyNotes?: string
    lotCode?: string
    serialNumbers?: string[]
    overReceiptApproved?: boolean
  }[]
}

export async function createReceipt(payload: ReceiptCreatePayload): Promise<PurchaseOrderReceipt> {
  return apiPost<PurchaseOrderReceipt>('/purchase-order-receipts', payload)
}

export async function getReceipt(id: string): Promise<PurchaseOrderReceipt> {
  return apiGet<PurchaseOrderReceipt>(`/purchase-order-receipts/${id}`)
}

export async function listReceipts(
  params: {
    limit?: number
    offset?: number
    status?: string
    vendorId?: string
    from?: string
    to?: string
    search?: string
    includeLines?: boolean
  } = {},
): Promise<{ data: PurchaseOrderReceipt[] }> {
  return apiGet<{ data: PurchaseOrderReceipt[] }>('/purchase-order-receipts', { params })
}

export async function voidReceiptApi(id: string): Promise<void> {
  await apiPost<void>(`/purchase-order-receipts/${id}/void`, {})
}

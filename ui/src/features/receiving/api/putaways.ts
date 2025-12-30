import { apiGet, apiPost } from '../../../api/http'
import type { Putaway } from '../../../api/types'

export type PutawayCreatePayload = {
  sourceType: 'purchase_order_receipt' | 'qc' | 'manual'
  purchaseOrderReceiptId?: string
  notes?: string
  lines: {
    purchaseOrderReceiptLineId: string
    toLocationId: string
    uom: string
    quantity: number
    lineNumber?: number
    fromLocationId?: string
    notes?: string
  }[]
}

export async function createPutaway(payload: PutawayCreatePayload): Promise<Putaway> {
  return apiPost<Putaway>('/putaways', payload)
}

export async function postPutaway(
  id: string,
  payload?: { overrideNegative?: boolean; overrideReason?: string | null },
): Promise<Putaway> {
  return apiPost<Putaway>(`/putaways/${id}/post`, payload)
}

export async function getPutaway(id: string): Promise<Putaway> {
  return apiGet<Putaway>(`/putaways/${id}`)
}

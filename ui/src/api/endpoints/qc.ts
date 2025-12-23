import { apiGet, apiPost } from '../http'
import type { QcEvent } from '../types'

export type QcEventCreatePayload = {
  purchaseOrderReceiptLineId: string
  eventType: 'hold' | 'accept' | 'reject'
  quantity: number
  uom: string
  reasonCode?: string
  notes?: string
  actorType: 'user' | 'system'
  actorId?: string
}

export async function createQcEvent(payload: QcEventCreatePayload): Promise<QcEvent> {
  return apiPost<QcEvent>('/qc-events', payload)
}

export async function listQcEventsForLine(
  lineId: string,
): Promise<{ data: QcEvent[] }> {
  return apiGet<{ data: QcEvent[] }>(
    `/purchase-order-receipt-lines/${lineId}/qc-events`,
  )
}

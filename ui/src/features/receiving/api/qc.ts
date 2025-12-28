import { apiGet, apiPost } from '../../../api/http'
import type { QcEvent } from '../../../api/types'

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

export async function getQcEvent(id: string): Promise<QcEvent> {
  return apiGet<QcEvent>(`/qc-events/${id}`)
}

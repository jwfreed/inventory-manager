import { apiGet, apiPost } from '../../../api/http'
import type { QcEvent } from '../../../api/types'
import { buildIdempotencyHeaders, createIdempotencyKey } from '../../../lib/idempotency'

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

export type CreateQcEventOptions = {
  idempotencyKey?: string
}

export type HoldDispositionPayload = {
  purchaseOrderReceiptLineId: string
  dispositionType: 'release' | 'rework' | 'discard'
  quantity: number
  uom: string
  reasonCode?: string
  notes?: string
  actorType: 'user' | 'system'
  actorId?: string
}

export type HoldDispositionResult = {
  eventId: string
  receiptLineId: string
  dispositionType: 'release' | 'rework' | 'discard'
  quantity: number
  uom: string
  movementId: string
  sourceLocationId: string
  destinationLocationId: string
  sourceWarehouseId: string
  destinationWarehouseId: string
  replayed: boolean
}

export function createNewQcEventIdempotencyKey(payload: QcEventCreatePayload) {
  return createIdempotencyKey(`qc-event:${payload.eventType}:${payload.purchaseOrderReceiptLineId}`)
}

export async function createQcEvent(
  payload: QcEventCreatePayload,
  options?: CreateQcEventOptions,
): Promise<QcEvent> {
  const idempotencyKey = options?.idempotencyKey ?? createNewQcEventIdempotencyKey(payload)
  return apiPost<QcEvent>('/qc-events', payload, {
    headers: buildIdempotencyHeaders(idempotencyKey),
  })
}

export async function resolveHoldDisposition(payload: HoldDispositionPayload): Promise<HoldDispositionResult> {
  return apiPost<HoldDispositionResult>('/qc/hold-dispositions', payload, {
    headers: buildIdempotencyHeaders(createIdempotencyKey('hold-disposition')),
  })
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

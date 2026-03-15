import { apiGet, apiPost } from '../../../api/http'
import type { ReturnReceipt, ReturnReceiptLine } from '../../../api/types'
import { ORDER_TO_CASH_ENDPOINTS } from './config'

type ListResponse = { data: ReturnReceipt[]; paging?: { limit: number; offset: number } }

export type ReturnReceiptListParams = {
  limit?: number
  offset?: number
}

export type ReturnReceiptPayload = {
  returnAuthorizationId: string
  status?: 'draft' | 'posted' | 'canceled'
  receivedAt: string
  receivedToLocationId: string
  inventoryMovementId?: string | null
  externalRef?: string
  notes?: string
  lines?: Array<{
    returnAuthorizationLineId?: string
    itemId: string
    uom: string
    quantityReceived: number
    notes?: string
  }>
}

export type ReturnReceiptLinePayload = {
  returnAuthorizationLineId?: string
  itemId: string
  uom: string
  quantityReceived: number
  notes?: string
}

type ReturnReceiptApiRow = Partial<ReturnReceipt> & {
  return_authorization_id?: string
  received_at?: string
  received_to_location_id?: string
  inventory_movement_id?: string | null
  external_ref?: string | null
  created_at?: string
}

type ReturnReceiptLineApiRow = Partial<ReturnReceiptLine> & {
  return_receipt_id?: string
  return_authorization_line_id?: string | null
  item_id?: string
  quantity_received?: number
  created_at?: string
}

function mapReturnReceiptLine(row: ReturnReceiptLineApiRow): ReturnReceiptLine {
  return {
    id: row.id,
    returnReceiptId: row.returnReceiptId ?? row.return_receipt_id,
    returnAuthorizationLineId: row.returnAuthorizationLineId ?? row.return_authorization_line_id ?? null,
    itemId: row.itemId ?? row.item_id,
    uom: row.uom,
    quantityReceived: row.quantityReceived ?? row.quantity_received,
    notes: row.notes ?? null,
    createdAt: row.createdAt ?? row.created_at,
  }
}

function mapReturnReceipt(row: ReturnReceiptApiRow): ReturnReceipt {
  return {
    id: row.id,
    returnAuthorizationId: row.returnAuthorizationId ?? row.return_authorization_id,
    status: row.status,
    receivedAt: row.receivedAt ?? row.received_at,
    receivedToLocationId: row.receivedToLocationId ?? row.received_to_location_id,
    inventoryMovementId: row.inventoryMovementId ?? row.inventory_movement_id ?? null,
    externalRef: row.externalRef ?? row.external_ref ?? null,
    notes: row.notes ?? null,
    createdAt: row.createdAt ?? row.created_at,
    lines: (row.lines ?? []).map((line) => mapReturnReceiptLine(line as ReturnReceiptLineApiRow)),
  }
}

export async function listReturnReceipts(params: ReturnReceiptListParams = {}): Promise<ListResponse> {
  const query: Record<string, number> = {}
  if (params.limit) query.limit = params.limit
  if (params.offset !== undefined) query.offset = params.offset
  const response = await apiGet<
    ReturnReceiptApiRow[] | { data?: ReturnReceiptApiRow[]; paging?: { limit: number; offset: number } }
  >(ORDER_TO_CASH_ENDPOINTS.returnReceipts, { params: query })
  if (Array.isArray(response)) {
    return { data: response.map(mapReturnReceipt) }
  }
  return {
    data: (response.data ?? []).map(mapReturnReceipt),
    paging: response.paging,
  }
}

export async function getReturnReceipt(id: string): Promise<ReturnReceipt> {
  const receipt = await apiGet<ReturnReceiptApiRow>(`${ORDER_TO_CASH_ENDPOINTS.returnReceipts}/${id}`)
  return mapReturnReceipt(receipt)
}

export async function createReturnReceipt(payload: ReturnReceiptPayload): Promise<ReturnReceipt> {
  const receipt = await apiPost<ReturnReceiptApiRow>(ORDER_TO_CASH_ENDPOINTS.returnReceipts, payload)
  return mapReturnReceipt(receipt)
}

export async function addReturnReceiptLine(
  returnReceiptId: string,
  payload: ReturnReceiptLinePayload,
): Promise<ReturnReceiptLine> {
  const line = await apiPost<ReturnReceiptLineApiRow>(
    `${ORDER_TO_CASH_ENDPOINTS.returnReceipts}/${returnReceiptId}/lines`,
    payload,
  )
  return mapReturnReceiptLine(line)
}

import { apiGet, apiPost } from '../../../api/http'
import type { ReturnDisposition, ReturnDispositionLine } from '../../../api/types'
import { ORDER_TO_CASH_ENDPOINTS } from './config'

type ListResponse = { data: ReturnDisposition[]; paging?: { limit: number; offset: number } }

export type ReturnDispositionListParams = {
  limit?: number
  offset?: number
}

export type ReturnDispositionPayload = {
  returnReceiptId: string
  status?: 'draft' | 'posted' | 'canceled'
  occurredAt: string
  dispositionType: 'restock' | 'scrap' | 'quarantine_hold'
  fromLocationId: string
  toLocationId?: string | null
  inventoryMovementId?: string | null
  notes?: string
  lines?: Array<{
    lineNumber?: number
    itemId: string
    uom: string
    quantity: number
    notes?: string
  }>
}

export type ReturnDispositionLinePayload = {
  lineNumber?: number
  itemId: string
  uom: string
  quantity: number
  notes?: string
}

type ReturnDispositionApiRow = Partial<ReturnDisposition> & {
  return_receipt_id?: string
  occurred_at?: string
  disposition_type?: string
  from_location_id?: string
  to_location_id?: string | null
  inventory_movement_id?: string | null
  created_at?: string
}

type ReturnDispositionLineApiRow = Partial<ReturnDispositionLine> & {
  return_disposition_id?: string
  item_id?: string
  created_at?: string
}

function mapReturnDispositionLine(row: ReturnDispositionLineApiRow): ReturnDispositionLine {
  return {
    id: row.id,
    returnDispositionId: row.returnDispositionId ?? row.return_disposition_id,
    lineNumber: row.lineNumber ?? null,
    itemId: row.itemId ?? row.item_id,
    uom: row.uom,
    quantity: row.quantity,
    notes: row.notes ?? null,
    createdAt: row.createdAt ?? row.created_at,
  }
}

function mapReturnDisposition(row: ReturnDispositionApiRow): ReturnDisposition {
  return {
    id: row.id,
    returnReceiptId: row.returnReceiptId ?? row.return_receipt_id,
    status: row.status,
    occurredAt: row.occurredAt ?? row.occurred_at,
    dispositionType: row.dispositionType ?? row.disposition_type,
    fromLocationId: row.fromLocationId ?? row.from_location_id,
    toLocationId: row.toLocationId ?? row.to_location_id ?? null,
    inventoryMovementId: row.inventoryMovementId ?? row.inventory_movement_id ?? null,
    notes: row.notes ?? null,
    createdAt: row.createdAt ?? row.created_at,
    lines: (row.lines ?? []).map((line) => mapReturnDispositionLine(line as ReturnDispositionLineApiRow)),
  }
}

export async function listReturnDispositions(
  params: ReturnDispositionListParams = {},
): Promise<ListResponse> {
  const query: Record<string, number> = {}
  if (params.limit) query.limit = params.limit
  if (params.offset !== undefined) query.offset = params.offset
  const response = await apiGet<
    ReturnDispositionApiRow[] | { data?: ReturnDispositionApiRow[]; paging?: { limit: number; offset: number } }
  >(ORDER_TO_CASH_ENDPOINTS.returnDispositions, { params: query })
  if (Array.isArray(response)) {
    return { data: response.map(mapReturnDisposition) }
  }
  return {
    data: (response.data ?? []).map(mapReturnDisposition),
    paging: response.paging,
  }
}

export async function getReturnDisposition(id: string): Promise<ReturnDisposition> {
  const disposition = await apiGet<ReturnDispositionApiRow>(
    `${ORDER_TO_CASH_ENDPOINTS.returnDispositions}/${id}`,
  )
  return mapReturnDisposition(disposition)
}

export async function createReturnDisposition(
  payload: ReturnDispositionPayload,
): Promise<ReturnDisposition> {
  const disposition = await apiPost<ReturnDispositionApiRow>(
    ORDER_TO_CASH_ENDPOINTS.returnDispositions,
    payload,
  )
  return mapReturnDisposition(disposition)
}

export async function addReturnDispositionLine(
  returnDispositionId: string,
  payload: ReturnDispositionLinePayload,
): Promise<ReturnDispositionLine> {
  const line = await apiPost<ReturnDispositionLineApiRow>(
    `${ORDER_TO_CASH_ENDPOINTS.returnDispositions}/${returnDispositionId}/lines`,
    payload,
  )
  return mapReturnDispositionLine(line)
}

import { apiGet } from '../../../api/http'
import type { Movement, MovementLine, MovementListResponse } from '../../../api/types'

export type MovementListParams = {
  movementType?: string
  status?: string
  externalRef?: string
  occurredFrom?: string
  occurredTo?: string
  itemId?: string
  locationId?: string
  limit?: number
  offset?: number
}

type MovementApiRow = Partial<Movement> & {
  movement_type?: string
  type?: string
  occurred_at?: string
  posted_at?: string | null
  external_ref?: string | null
  metadata?: Record<string, unknown> | null
  created_at?: string
  updated_at?: string
}

type MovementLineApiRow = Partial<MovementLine> & {
  movement_id?: string
  item_id?: string
  item_sku?: string
  item_name?: string
  location_id?: string
  location_code?: string
  location_name?: string
  quantity_delta?: number | string
  reason_code?: string | null
  line_notes?: string | null
  sku?: string
  name?: string
}

function toCamelMovement(row: MovementApiRow): Movement {
  if (!row) throw new Error('Missing movement payload')
  return {
    id: row.id as string,
    movementType: row.movementType ?? row.movement_type ?? row.type ?? '',
    status: row.status ?? '',
    occurredAt: row.occurredAt ?? row.occurred_at ?? '',
    postedAt: row.postedAt ?? row.posted_at ?? null,
    externalRef: row.externalRef ?? row.external_ref ?? null,
    notes: row.notes ?? null,
    metadata: row.metadata ?? null,
    createdAt: row.createdAt ?? row.created_at,
    updatedAt: row.updatedAt ?? row.updated_at,
  }
}

function toCamelLine(row: MovementLineApiRow): MovementLine {
  if (!row) throw new Error('Missing movement line payload')
  return {
    id: row.id as string,
    movementId: row.movementId ?? row.movement_id ?? '',
    itemId: row.itemId ?? row.item_id ?? '',
    itemSku: row.itemSku ?? row.item_sku ?? row.sku,
    itemName: row.itemName ?? row.item_name ?? row.name,
    locationId: row.locationId ?? row.location_id ?? '',
    locationCode: row.locationCode ?? row.location_code,
    locationName: row.locationName ?? row.location_name,
    uom: row.uom ?? '',
    quantityDelta: Number(row.quantityDelta ?? row.quantity_delta ?? 0),
    reasonCode: row.reasonCode ?? row.reason_code,
    lineNotes: row.lineNotes ?? row.line_notes ?? row.notes ?? null,
  }
}

export async function listMovements(params: MovementListParams = {}): Promise<MovementListResponse> {
  const queryParams: Record<string, string | number> = {}
  if (params.movementType) queryParams.movement_type = params.movementType
  if (params.status) queryParams.status = params.status
  if (params.externalRef) queryParams.external_ref = params.externalRef
  if (params.occurredFrom) queryParams.occurred_from = params.occurredFrom
  if (params.occurredTo) queryParams.occurred_to = params.occurredTo
  if (params.itemId) queryParams.item_id = params.itemId
  if (params.locationId) queryParams.location_id = params.locationId
  if (params.limit) queryParams.limit = params.limit
  if (params.offset !== undefined) queryParams.offset = params.offset

  const response = await apiGet<unknown>('/inventory-movements', {
    params: queryParams,
  })

  // If backend returns array directly
  if (Array.isArray(response)) {
    return { data: response.map(toCamelMovement) }
  }

  return {
    data: Array.isArray(response.data) ? response.data.map(toCamelMovement) : [],
    paging: response.paging,
  }
}

export async function getMovement(movementId: string): Promise<Movement> {
  const movement = await apiGet<MovementApiRow>(`/inventory-movements/${movementId}`)
  return toCamelMovement(movement)
}

export async function getMovementLines(movementId: string): Promise<MovementLine[]> {
  const lines = await apiGet<unknown>(`/inventory-movements/${movementId}/lines`)
  if (Array.isArray(lines)) {
    return lines.map(toCamelLine)
  }
  if (Array.isArray(lines?.data)) {
    return lines.data.map(toCamelLine)
  }
  return []
}

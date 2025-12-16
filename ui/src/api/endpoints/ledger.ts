import { apiGet } from '../http'
import type { Movement, MovementLine, MovementListResponse } from '../types'

export type MovementListParams = {
  movementType?: string
  status?: string
  externalRef?: string
  occurredFrom?: string
  occurredTo?: string
  page?: number
  pageSize?: number
}

function toCamelMovement(row: any): Movement {
  if (!row) throw new Error('Missing movement payload')
  return {
    id: row.id,
    movementType: row.movementType ?? row.movement_type ?? row.type ?? row.movementType,
    status: row.status,
    occurredAt: row.occurredAt ?? row.occurred_at,
    postedAt: row.postedAt ?? row.posted_at,
    externalRef: row.externalRef ?? row.external_ref,
    notes: row.notes,
    createdAt: row.createdAt ?? row.created_at,
    updatedAt: row.updatedAt ?? row.updated_at,
  }
}

function toCamelLine(row: any): MovementLine {
  if (!row) throw new Error('Missing movement line payload')
  return {
    id: row.id,
    movementId: row.movementId ?? row.movement_id,
    itemId: row.itemId ?? row.item_id,
    itemSku: row.itemSku ?? row.item_sku ?? row.sku,
    itemName: row.itemName ?? row.item_name ?? row.name,
    locationId: row.locationId ?? row.location_id,
    locationCode: row.locationCode ?? row.location_code,
    locationName: row.locationName ?? row.location_name,
    uom: row.uom,
    quantityDelta: Number(row.quantityDelta ?? row.quantity_delta ?? 0),
    reasonCode: row.reasonCode ?? row.reason_code,
    notes: row.notes ?? row.line_notes ?? null,
  }
}

export async function listMovements(params: MovementListParams = {}): Promise<MovementListResponse> {
  const queryParams: Record<string, string | number> = {}
  if (params.movementType) queryParams.movement_type = params.movementType
  if (params.status) queryParams.status = params.status
  if (params.externalRef) queryParams.external_ref = params.externalRef
  if (params.occurredFrom) queryParams.occurred_from = params.occurredFrom
  if (params.occurredTo) queryParams.occurred_to = params.occurredTo
  if (params.page) queryParams.page = params.page
  if (params.pageSize) queryParams.page_size = params.pageSize

  const response = await apiGet<any>('/inventory-movements', {
    params: queryParams,
  })

  // If backend returns array directly
  if (Array.isArray(response)) {
    return { data: response.map(toCamelMovement) }
  }

  return {
    data: Array.isArray(response.data) ? response.data.map(toCamelMovement) : [],
    total: response.total,
    page: response.page,
    pageSize: response.pageSize ?? response.page_size,
  }
}

export async function getMovement(movementId: string): Promise<Movement> {
  const movement = await apiGet<any>(`/inventory-movements/${movementId}`)
  return toCamelMovement(movement)
}

export async function getMovementLines(movementId: string): Promise<MovementLine[]> {
  const lines = await apiGet<any>(`/inventory-movements/${movementId}/lines`)
  if (Array.isArray(lines)) {
    return lines.map(toCamelLine)
  }
  if (Array.isArray(lines?.data)) {
    return lines.data.map(toCamelLine)
  }
  return []
}

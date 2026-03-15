import { apiGet, apiPost } from '../../../api/http'
import type { Reservation } from '../../../api/types'
import { ORDER_TO_CASH_ENDPOINTS } from './config'
import { resolveWarehouseId } from '../../../api/warehouseContext'
import { buildIdempotencyHeaders, createIdempotencyKey } from '../../../lib/idempotency'

type ListResponse = { data: Reservation[]; paging?: { limit: number; offset: number } }

export type ReservationListParams = {
  warehouseId?: string
  limit?: number
  offset?: number
}

export type ReservationCancelPayload = {
  warehouseId?: string
  reason?: string
}

export type ReservationFulfillPayload = {
  warehouseId?: string
  quantity: number
}

type ReservationApiRow = Partial<Reservation> & {
  demand_type?: string
  demand_id?: string
  item_id?: string
  location_id?: string
  warehouse_id?: string
  quantity_reserved?: number
  quantity_fulfilled?: number | null
  reserved_at?: string
  allocated_at?: string | null
  canceled_at?: string | null
  fulfilled_at?: string | null
  expired_at?: string | null
  expires_at?: string | null
  cancel_reason?: string | null
  release_reason_code?: string | null
  created_at?: string
  updated_at?: string
}

function mapReservation(row: ReservationApiRow): Reservation {
  return {
    id: row.id,
    status: row.status,
    state: row.state ?? row.status,
    demandType: row.demandType ?? row.demand_type,
    demandId: row.demandId ?? row.demand_id,
    itemId: row.itemId ?? row.item_id,
    locationId: row.locationId ?? row.location_id,
    warehouseId: row.warehouseId ?? row.warehouse_id,
    uom: row.uom,
    quantityReserved: row.quantityReserved ?? row.quantity_reserved,
    quantityFulfilled: row.quantityFulfilled ?? row.quantity_fulfilled ?? null,
    reservedAt: row.reservedAt ?? row.reserved_at,
    allocatedAt: row.allocatedAt ?? row.allocated_at ?? null,
    canceledAt: row.canceledAt ?? row.canceled_at ?? null,
    fulfilledAt: row.fulfilledAt ?? row.fulfilled_at ?? null,
    expiredAt: row.expiredAt ?? row.expired_at ?? null,
    expiresAt: row.expiresAt ?? row.expires_at ?? null,
    cancelReason: row.cancelReason ?? row.cancel_reason ?? null,
    releaseReasonCode: row.releaseReasonCode ?? row.release_reason_code ?? null,
    notes: row.notes ?? null,
    createdAt: row.createdAt ?? row.created_at,
    updatedAt: row.updatedAt ?? row.updated_at,
  }
}

export async function listReservations(params: ReservationListParams = {}): Promise<ListResponse> {
  const warehouseId = await resolveWarehouseId({ warehouseId: params.warehouseId })
  const query: Record<string, number | string> = { warehouseId }
  if (params.limit) query.limit = params.limit
  if (params.offset !== undefined) query.offset = params.offset
  const res = await apiGet<
    ReservationApiRow[] | { data?: ReservationApiRow[]; paging?: { limit: number; offset: number } }
  >(ORDER_TO_CASH_ENDPOINTS.reservations, { params: query })
  if (Array.isArray(res)) {
    return { data: res.map(mapReservation) }
  }
  return { data: (res.data ?? []).map(mapReservation), paging: res.paging }
}

export async function getReservation(id: string, warehouseId?: string): Promise<Reservation> {
  const resolvedWarehouseId = await resolveWarehouseId({ warehouseId })
  const reservation = await apiGet<ReservationApiRow>(`${ORDER_TO_CASH_ENDPOINTS.reservations}/${id}`, {
    params: { warehouseId: resolvedWarehouseId }
  })
  return mapReservation(reservation)
}

export async function allocateReservation(id: string, warehouseId?: string): Promise<Reservation> {
  const resolvedWarehouseId = await resolveWarehouseId({ warehouseId })
  const response = await apiPost<ReservationApiRow>(
    `${ORDER_TO_CASH_ENDPOINTS.reservations}/${id}/allocate`,
    { warehouseId: resolvedWarehouseId },
    {
      headers: buildIdempotencyHeaders(createIdempotencyKey('reservation-allocate')),
    },
  )
  return mapReservation(response)
}

export async function cancelReservation(
  id: string,
  payload: ReservationCancelPayload = {},
): Promise<Reservation> {
  const resolvedWarehouseId = await resolveWarehouseId({ warehouseId: payload.warehouseId })
  const response = await apiPost<ReservationApiRow>(
    `${ORDER_TO_CASH_ENDPOINTS.reservations}/${id}/cancel`,
    {
      warehouseId: resolvedWarehouseId,
      reason: payload.reason?.trim() ? payload.reason.trim() : undefined,
    },
    {
      headers: buildIdempotencyHeaders(createIdempotencyKey('reservation-cancel')),
    },
  )
  return mapReservation(response)
}

export async function fulfillReservation(
  id: string,
  payload: ReservationFulfillPayload,
): Promise<Reservation> {
  const resolvedWarehouseId = await resolveWarehouseId({ warehouseId: payload.warehouseId })
  const response = await apiPost<ReservationApiRow>(
    `${ORDER_TO_CASH_ENDPOINTS.reservations}/${id}/fulfill`,
    {
      warehouseId: resolvedWarehouseId,
      quantity: payload.quantity,
    },
    {
      headers: buildIdempotencyHeaders(createIdempotencyKey('reservation-fulfill')),
    },
  )
  return mapReservation(response)
}

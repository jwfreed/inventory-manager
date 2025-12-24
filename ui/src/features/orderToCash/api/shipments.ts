import { apiGet } from '../../../api/http'
import type { Shipment } from '../../../api/types'
import { ORDER_TO_CASH_ENDPOINTS } from './config'

type ListResponse = { data: Shipment[]; paging?: { limit: number; offset: number } }

export type ShipmentListParams = {
  limit?: number
  offset?: number
}

type ShipmentApiRow = Partial<Shipment> & {
  sales_order_id?: string
  shipped_at?: string
  ship_from_location_id?: string
  inventory_movement_id?: string
  external_ref?: string
  created_at?: string
}

function mapShipment(row: ShipmentApiRow): Shipment {
  return {
    id: row.id,
    salesOrderId: row.salesOrderId ?? row.sales_order_id,
    shippedAt: row.shippedAt ?? row.shipped_at,
    shipFromLocationId: row.shipFromLocationId ?? row.ship_from_location_id ?? undefined,
    inventoryMovementId: row.inventoryMovementId ?? row.inventory_movement_id ?? undefined,
    externalRef: row.externalRef ?? row.external_ref ?? undefined,
    notes: row.notes ?? undefined,
    createdAt: row.createdAt ?? row.created_at ?? undefined,
  }
}

export async function listShipments(params: ShipmentListParams = {}): Promise<ListResponse> {
  const query: Record<string, number> = {}
  if (params.limit) query.limit = params.limit
  if (params.offset !== undefined) query.offset = params.offset
  const res = await apiGet<
    ShipmentApiRow[] | { data?: ShipmentApiRow[]; paging?: { limit: number; offset: number } }
  >(ORDER_TO_CASH_ENDPOINTS.shipments, { params: query })
  if (Array.isArray(res)) {
    return { data: res.map(mapShipment) }
  }
  return {
    data: (res.data ?? []).map(mapShipment),
    paging: res.paging,
  }
}

export async function getShipment(id: string): Promise<Shipment> {
  return await apiGet<Shipment>(`${ORDER_TO_CASH_ENDPOINTS.shipments}/${id}`)
}

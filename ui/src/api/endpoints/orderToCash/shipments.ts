import { apiGet } from '../../http'
import type { Shipment } from '../../types'
import { ORDER_TO_CASH_ENDPOINTS } from './config'

type ListResponse = { data: Shipment[]; paging?: { limit: number; offset: number } }

function mapShipment(row: any): Shipment {
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

export async function listShipments(): Promise<ListResponse> {
  const res = await apiGet<Shipment[] | { data?: any[]; paging?: { limit: number; offset: number } }>(
    ORDER_TO_CASH_ENDPOINTS.shipments,
  )
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

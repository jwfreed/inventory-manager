import { apiGet } from '../../http'
import type { SalesOrder } from '../../types'
import { ORDER_TO_CASH_ENDPOINTS } from './config'

export type SalesOrderListParams = {
  limit?: number
  offset?: number
  status?: string
  customerId?: string
}

export type SalesOrderListResponse = {
  data: SalesOrder[]
  paging?: { limit: number; offset: number }
}

function mapSalesOrderSummary(row: any): SalesOrder {
  return {
    id: row.id,
    soNumber: row.soNumber ?? row.so_number,
    customerId: row.customerId ?? row.customer_id,
    status: row.status,
    orderDate: row.orderDate ?? row.order_date ?? undefined,
    requestedShipDate: row.requestedShipDate ?? row.requested_ship_date ?? undefined,
    shipFromLocationId: row.shipFromLocationId ?? row.ship_from_location_id ?? undefined,
    customerReference: row.customerReference ?? row.customer_reference ?? undefined,
    notes: row.notes ?? undefined,
    createdAt: row.createdAt ?? row.created_at ?? undefined,
    updatedAt: row.updatedAt ?? row.updated_at ?? undefined,
  }
}

export async function listSalesOrders(
  params: SalesOrderListParams = {},
): Promise<SalesOrderListResponse> {
  const response = await apiGet<SalesOrder[] | { data: any[]; paging?: { limit: number; offset: number } }>(
    ORDER_TO_CASH_ENDPOINTS.salesOrders,
    { params },
  )

  if (Array.isArray(response)) {
    return { data: response.map(mapSalesOrderSummary) }
  }

  return {
    data: (response.data ?? []).map(mapSalesOrderSummary),
    paging: response.paging,
  }
}

export async function getSalesOrder(id: string): Promise<SalesOrder> {
  return await apiGet<SalesOrder>(`${ORDER_TO_CASH_ENDPOINTS.salesOrders}/${id}`)
}

import { apiGet, apiPost } from '../../http'
import type { SalesOrder, SalesOrderLine } from '../../types'
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

type SalesOrderApiRow = Partial<SalesOrder> & {
  so_number?: string
  customer_id?: string
  order_date?: string
  requested_ship_date?: string
  ship_from_location_id?: string
  customer_reference?: string
  created_at?: string
  updated_at?: string
}

function mapSalesOrderSummary(row: SalesOrderApiRow): SalesOrder {
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
  const response = await apiGet<SalesOrderApiRow[] | { data: SalesOrderApiRow[]; paging?: { limit: number; offset: number } }>(
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

export type SalesOrderPayload = {
  soNumber: string
  customerId: string
  status?: SalesOrder['status']
  orderDate?: string
  requestedShipDate?: string
  shipFromLocationId?: string
  customerReference?: string
  notes?: string
  lines: {
    lineNumber?: number
    itemId: string
    uom: string
    quantityOrdered: number
    notes?: string
  }[]
}

export async function createSalesOrder(payload: SalesOrderPayload): Promise<SalesOrder> {
  const order = await apiPost<SalesOrder>(ORDER_TO_CASH_ENDPOINTS.salesOrders, payload)
  return {
    ...order,
    lines: (order.lines ?? []).map((line: SalesOrderLine) => ({
      ...line,
      lineNumber: line.lineNumber ?? line.line_number,
      itemId: line.itemId ?? line.item_id,
      uom: line.uom ?? line.uom,
      quantityOrdered: line.quantityOrdered ?? line.quantity_ordered,
    })),
  }
}

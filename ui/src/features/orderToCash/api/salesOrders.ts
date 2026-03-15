import { apiGet, apiPost } from '../../../api/http'
import type { SalesOrder, SalesOrderLine } from '../../../api/types'
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
  warehouse_id?: string | null
  order_date?: string
  requested_ship_date?: string
  ship_from_location_id?: string
  customer_reference?: string
  created_at?: string
  updated_at?: string
}

type SalesOrderLineApiRow = Partial<SalesOrderLine> & {
  sales_order_id?: string
  line_number?: number
  item_id?: string
  quantity_ordered?: number
  derived_backorder_qty?: number
  unit_price?: number | null
  currency_code?: string | null
  exchange_rate_to_base?: number | null
  line_amount?: number | null
  base_amount?: number | null
  created_at?: string
}

function mapSalesOrderLine(line: SalesOrderLineApiRow): SalesOrderLine {
  return {
    id: line.id,
    salesOrderId: line.salesOrderId ?? line.sales_order_id,
    lineNumber: line.lineNumber ?? line.line_number,
    itemId: line.itemId ?? line.item_id,
    uom: line.uom,
    quantityOrdered: line.quantityOrdered ?? line.quantity_ordered,
    derivedBackorderQty: line.derivedBackorderQty ?? line.derived_backorder_qty,
    unitPrice: line.unitPrice ?? line.unit_price ?? null,
    currencyCode: line.currencyCode ?? line.currency_code ?? null,
    exchangeRateToBase: line.exchangeRateToBase ?? line.exchange_rate_to_base ?? null,
    lineAmount: line.lineAmount ?? line.line_amount ?? null,
    baseAmount: line.baseAmount ?? line.base_amount ?? null,
    notes: line.notes ?? null,
    createdAt: line.createdAt ?? line.created_at,
  }
}

function mapSalesOrderSummary(row: SalesOrderApiRow): SalesOrder {
  return {
    id: row.id,
    soNumber: row.soNumber ?? row.so_number,
    customerId: row.customerId ?? row.customer_id,
    warehouseId: row.warehouseId ?? row.warehouse_id ?? null,
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

function mapSalesOrderDetail(row: SalesOrderApiRow): SalesOrder {
  return {
    ...mapSalesOrderSummary(row),
    lines: (row.lines ?? []).map((line) => mapSalesOrderLine(line as SalesOrderLineApiRow)),
    shipments: row.shipments,
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
  const order = await apiGet<SalesOrderApiRow>(`${ORDER_TO_CASH_ENDPOINTS.salesOrders}/${id}`)
  return mapSalesOrderDetail(order)
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
  const order = await apiPost<SalesOrderApiRow>(ORDER_TO_CASH_ENDPOINTS.salesOrders, payload)
  return mapSalesOrderDetail(order)
}

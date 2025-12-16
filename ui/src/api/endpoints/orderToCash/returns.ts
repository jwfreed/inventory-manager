import { apiGet } from '../../http'
import type { ReturnDoc } from '../../types'
import { ORDER_TO_CASH_ENDPOINTS } from './config'

type ListResponse = { data: ReturnDoc[]; paging?: { limit: number; offset: number } }

function mapReturn(row: any): ReturnDoc {
  return {
    id: row.id,
    rmaNumber: row.rmaNumber ?? row.rma_number,
    customerId: row.customerId ?? row.customer_id,
    salesOrderId: row.salesOrderId ?? row.sales_order_id ?? undefined,
    status: row.status,
    severity: row.severity ?? undefined,
    authorizedAt: row.authorizedAt ?? row.authorized_at ?? undefined,
    notes: row.notes ?? undefined,
    createdAt: row.createdAt ?? row.created_at ?? undefined,
    updatedAt: row.updatedAt ?? row.updated_at ?? undefined,
  }
}

export async function listReturns(): Promise<ListResponse> {
  const res = await apiGet<ReturnDoc[] | { data?: any[]; paging?: { limit: number; offset: number } }>(
    ORDER_TO_CASH_ENDPOINTS.returns,
  )
  if (Array.isArray(res)) {
    return { data: res.map(mapReturn) }
  }
  return {
    data: (res.data ?? []).map(mapReturn),
    paging: res.paging,
  }
}

export async function getReturn(id: string): Promise<ReturnDoc> {
  return await apiGet<ReturnDoc>(`${ORDER_TO_CASH_ENDPOINTS.returns}/${id}`)
}

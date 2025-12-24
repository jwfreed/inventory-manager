import { apiGet } from '../../../api/http'
import type { ReturnDoc } from '../../../api/types'
import { ORDER_TO_CASH_ENDPOINTS } from './config'

type ListResponse = { data: ReturnDoc[]; paging?: { limit: number; offset: number } }

export type ReturnListParams = {
  limit?: number
  offset?: number
}

type ReturnApiRow = Partial<ReturnDoc> & {
  rma_number?: string
  customer_id?: string
  sales_order_id?: string
  authorized_at?: string
  created_at?: string
  updated_at?: string
}

function mapReturn(row: ReturnApiRow): ReturnDoc {
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

export async function listReturns(params: ReturnListParams = {}): Promise<ListResponse> {
  const query: Record<string, number> = {}
  if (params.limit) query.limit = params.limit
  if (params.offset !== undefined) query.offset = params.offset
  const res = await apiGet<
    ReturnApiRow[] | { data?: ReturnApiRow[]; paging?: { limit: number; offset: number } }
  >(ORDER_TO_CASH_ENDPOINTS.returns, { params: query })
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

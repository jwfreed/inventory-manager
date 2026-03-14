import { apiGet, apiPatch, apiPost } from '../../../api/http'
import type { InventoryCount } from '../../../api/types'
import { buildIdempotencyHeaders, createIdempotencyKey } from '../../../lib/idempotency'

export type InventoryCountsListParams = {
  warehouseId: string
  status?: string
  limit?: number
  offset?: number
}

export type InventoryCountLineInput = {
  lineNumber?: number
  itemId: string
  locationId: string
  uom: string
  countedQuantity: number
  unitCostForPositiveAdjustment?: number
  reasonCode?: string
  notes?: string
}

export type InventoryCountCreatePayload = {
  countedAt: string
  warehouseId: string
  locationId?: string
  notes?: string
  lines: InventoryCountLineInput[]
}

export type InventoryCountUpdatePayload = {
  countedAt?: string
  notes?: string
  lines?: InventoryCountLineInput[]
}

export async function listInventoryCounts(
  params: InventoryCountsListParams,
): Promise<{ data: InventoryCount[]; paging?: { limit: number; offset: number } }> {
  return apiGet('/inventory-counts', {
    params: {
      warehouseId: params.warehouseId,
      status: params.status,
      limit: params.limit,
      offset: params.offset,
    },
  })
}

export async function getInventoryCount(id: string): Promise<InventoryCount> {
  return apiGet<InventoryCount>(`/inventory-counts/${id}`)
}

export async function createInventoryCount(payload: InventoryCountCreatePayload): Promise<InventoryCount> {
  return apiPost<InventoryCount>('/inventory-counts', payload)
}

export async function updateInventoryCount(
  id: string,
  payload: InventoryCountUpdatePayload,
): Promise<InventoryCount> {
  return apiPatch<InventoryCount>(`/inventory-counts/${id}`, payload)
}

export async function postInventoryCount(
  id: string,
  payload: { warehouseId: string },
): Promise<InventoryCount> {
  const idempotencyKey = createIdempotencyKey(`inventory-count-post:${id}`)
  return apiPost<InventoryCount>(
    `/inventory-counts/${id}/post`,
    payload,
    {
      headers: buildIdempotencyHeaders(idempotencyKey),
    },
  )
}

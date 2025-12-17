import { apiGet, apiPost } from '../http'
import type { Lot, MovementLotAllocation } from '../types'

export type ListLotsParams = {
  itemId?: string
  lotCode?: string
  status?: string
  limit?: number
  offset?: number
}

export type ListLotsResponse = {
  data: Lot[]
  paging?: { limit: number; offset: number }
}

export async function listLots(params: ListLotsParams = {}): Promise<ListLotsResponse> {
  const apiParams: Record<string, string | number> = {}
  if (params.itemId) apiParams.item_id = params.itemId
  if (params.lotCode) apiParams.lot_code = params.lotCode
  if (params.status) apiParams.status = params.status
  if (params.limit) apiParams.limit = params.limit
  if (params.offset !== undefined) apiParams.offset = params.offset
  return apiGet<ListLotsResponse>('/lots', { params: apiParams })
}

export async function createLot(payload: Omit<Lot, 'id' | 'createdAt' | 'updatedAt'>): Promise<Lot> {
  return apiPost<Lot>('/lots', payload)
}

export async function getLot(id: string): Promise<Lot> {
  return apiGet<Lot>(`/lots/${id}`)
}

export async function addMovementLotAllocations(
  movementLineId: string,
  allocations: { lotId: string; uom: string; quantityDelta: number }[],
): Promise<MovementLotAllocation[]> {
  const res = await apiPost<{ data: MovementLotAllocation[] }>(
    `/inventory-movement-lines/${movementLineId}/lots`,
    { allocations },
  )
  return res.data ?? []
}

export async function listMovementLotAllocations(
  movementLineId: string,
): Promise<MovementLotAllocation[]> {
  const res = await apiGet<{ data: MovementLotAllocation[] }>(
    `/inventory-movement-lines/${movementLineId}/lots`,
  )
  return res.data ?? []
}

import { apiGet } from '../../../api/http'
import type { InventorySnapshotRow } from '../../../api/types'
import { resolveWarehouseId } from '../../../api/warehouseContext'

export type InventorySnapshotParams = {
  warehouseId?: string
  itemId: string
  locationId: string
  uom?: string
}

export type InventorySnapshotSummaryParams = {
  warehouseId?: string
  itemId?: string
  locationId?: string
  limit?: number
  offset?: number
}

export async function getInventorySnapshot(params: InventorySnapshotParams): Promise<InventorySnapshotRow[]> {
  const warehouseId = await resolveWarehouseId({
    warehouseId: params.warehouseId,
    locationId: params.locationId
  })
  const response = await apiGet<InventorySnapshotRow[] | { data?: InventorySnapshotRow[] }>('/inventory-snapshot', {
    params: {
      warehouseId,
      itemId: params.itemId,
      locationId: params.locationId,
      ...(params.uom ? { uom: params.uom } : {}),
    },
  })

  if (Array.isArray(response)) return response
  return response.data ?? []
}

export async function listInventorySnapshotSummary(
  params: InventorySnapshotSummaryParams = {},
): Promise<InventorySnapshotRow[]> {
  const warehouseId = await resolveWarehouseId({
    warehouseId: params.warehouseId,
    locationId: params.locationId
  })
  const response = await apiGet<{ data?: InventorySnapshotRow[] }>('/inventory-snapshot/summary', {
    params: {
      warehouseId,
      ...(params.itemId ? { itemId: params.itemId } : {}),
      ...(params.locationId ? { locationId: params.locationId } : {}),
      ...(params.limit ? { limit: params.limit } : {}),
      ...(params.offset ? { offset: params.offset } : {}),
    },
  })
  return response.data ?? []
}

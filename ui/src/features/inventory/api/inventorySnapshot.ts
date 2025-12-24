import { apiGet } from '../../../api/http'
import type { InventorySnapshotRow } from '../../../api/types'

export type InventorySnapshotParams = {
  itemId: string
  locationId: string
  uom?: string
}

export type InventorySnapshotSummaryParams = {
  itemId?: string
  locationId?: string
  limit?: number
  offset?: number
}

export async function getInventorySnapshot(params: InventorySnapshotParams): Promise<InventorySnapshotRow[]> {
  const response = await apiGet<InventorySnapshotRow[] | { data?: InventorySnapshotRow[] }>('/inventory-snapshot', {
    params: {
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
  const response = await apiGet<{ data?: InventorySnapshotRow[] }>('/inventory-snapshot/summary', {
    params: {
      ...(params.itemId ? { itemId: params.itemId } : {}),
      ...(params.locationId ? { locationId: params.locationId } : {}),
      ...(params.limit ? { limit: params.limit } : {}),
      ...(params.offset ? { offset: params.offset } : {}),
    },
  })
  return response.data ?? []
}

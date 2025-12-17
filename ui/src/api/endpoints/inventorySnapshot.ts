import { apiGet } from '../http'
import type { InventorySnapshotRow } from '../types'

export type InventorySnapshotParams = {
  itemId: string
  locationId: string
  uom?: string
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

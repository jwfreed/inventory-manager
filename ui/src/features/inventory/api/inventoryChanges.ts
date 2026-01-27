import { apiGet } from '../../../api/http'
import type { InventoryChangesResponse } from '../../../api/types'

export type InventoryChangesParams = {
  since?: string
  limit?: number
}

export async function getInventoryChanges(
  params: InventoryChangesParams = {},
): Promise<InventoryChangesResponse> {
  return apiGet<InventoryChangesResponse>('/inventory/changes', {
    params: {
      ...(params.since ? { since: params.since } : {}),
      ...(params.limit ? { limit: params.limit } : {}),
    },
  })
}

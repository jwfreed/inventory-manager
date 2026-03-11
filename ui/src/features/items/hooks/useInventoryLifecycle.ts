import { useMemo } from 'react'
import type { InventorySummary } from '../itemDetail.models'
import { buildInventoryLifecycle } from '../itemDetail.logic'

export function useInventoryLifecycle(inventory: InventorySummary) {
  return useMemo(() => buildInventoryLifecycle(inventory), [inventory])
}

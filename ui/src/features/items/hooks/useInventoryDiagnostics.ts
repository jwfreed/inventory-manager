import { useMemo } from 'react'
import type { Item, InventorySnapshotRow } from '../../../api/types'
import { inventoryDiagnostics } from '../inventoryDiagnostics'
import type { InventorySummary, UnitConversionState } from '../itemDetail.models'

type Params = {
  item?: Item | null
  inventory: InventorySummary
  stockRows: InventorySnapshotRow[]
  conversions: UnitConversionState
}

export function useInventoryDiagnostics({ item, inventory, stockRows, conversions }: Params) {
  return useMemo(
    () => inventoryDiagnostics({ item, inventory, stockRows, conversions }),
    [conversions, inventory, item, stockRows],
  )
}

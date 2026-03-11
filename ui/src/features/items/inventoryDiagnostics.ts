import type { Item, InventorySnapshotRow } from '../../api/types'
import type { InventorySummary, UnitConversionState } from './itemDetail.models'

export type Diagnostic = {
  severity: 'warning' | 'error'
  message: string
  code: string
}

type InventoryDiagnosticsInput = {
  item?: Item | null
  inventory: InventorySummary
  stockRows: InventorySnapshotRow[]
  conversions: UnitConversionState
}

export function inventoryDiagnostics({
  item,
  inventory,
  stockRows,
  conversions,
}: InventoryDiagnosticsInput): Diagnostic[] {
  const diagnostics: Diagnostic[] = []

  if (inventory.available > inventory.onHand) {
    diagnostics.push({
      severity: 'error',
      code: 'AVAILABLE_GT_ON_HAND',
      message: 'Available exceeds on-hand.',
    })
  }

  if (inventory.reserved < 0) {
    diagnostics.push({
      severity: 'error',
      code: 'NEGATIVE_RESERVED',
      message: 'Reserved quantity is negative.',
    })
  }

  if (!item?.canonicalUom && !item?.defaultUom) {
    diagnostics.push({
      severity: 'error',
      code: 'CANONICAL_UOM_MISSING',
      message: 'Canonical UOM is missing.',
    })
  }

  if (conversions.missingUnits.length > 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'INVALID_UOM_CONVERSION',
      message: `Invalid UOM conversion for ${conversions.missingUnits.join(', ')}.`,
    })
  }

  if (stockRows.some((row) => !row.locationId)) {
    diagnostics.push({
      severity: 'warning',
      code: 'INVENTORY_WITHOUT_LOCATION',
      message: 'Inventory row exists without a location.',
    })
  }

  return diagnostics
}

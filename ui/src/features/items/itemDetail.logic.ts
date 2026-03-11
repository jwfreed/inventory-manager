import { formatNumber } from '@shared/formatters'
import type { Item, InventorySnapshotRow, UomConversion } from '../../api/types'
import type {
  DerivedUnitConversion,
  HealthAction,
  InventoryLifecycleStage,
  InventorySummary,
  ItemConfiguration,
  ItemHealthResult,
} from './itemDetail.models'
import { ItemHealthStatus } from './itemDetail.models'

export function normalizeUomCode(value?: string | null) {
  return value?.trim().toLowerCase() ?? ''
}

export function checkSystemConversions(item?: Pick<Item, 'uomDimension' | 'canonicalUom' | 'stockingUom'> | null) {
  return Boolean(item?.uomDimension && item?.canonicalUom && item?.stockingUom)
}

export function buildManualConversionEntries(
  conversions: UomConversion[],
  canonicalUom: string | null,
): DerivedUnitConversion[] {
  const canonicalKey = normalizeUomCode(canonicalUom)
  const rows: DerivedUnitConversion[] = []

  conversions.forEach((conversion) => {
    const fromKey = normalizeUomCode(conversion.fromUom)
    const toKey = normalizeUomCode(conversion.toUom)
    const touchesCanonical = canonicalKey && (fromKey === canonicalKey || toKey === canonicalKey)
    if (!touchesCanonical || !conversion.factor || conversion.factor <= 0) return

    const factor =
      fromKey === canonicalKey ? 1 / conversion.factor : conversion.factor
    const fromUom = fromKey === canonicalKey ? conversion.toUom : conversion.fromUom
    const toUom = canonicalUom ?? conversion.toUom

    rows.push({
      key: `manual:${fromUom}:${toUom}`,
      fromUom,
      toUom,
      factor,
      inverseFactor: 1 / factor,
      source: 'manual',
    })
  })

  return rows.sort((left, right) => left.fromUom.localeCompare(right.fromUom))
}

export function summarizeInventoryRows(
  rows: InventorySnapshotRow[],
  factorByUom: Map<string, number>,
  canonicalUom: string | null,
): InventorySummary {
  const base: InventorySummary = {
    rows: [],
    canonicalUom,
    onHand: 0,
    reserved: 0,
    available: 0,
    inTransit: 0,
    backordered: 0,
    inventoryPosition: 0,
    hasNegativeOnHand: false,
  }

  if (!canonicalUom) {
    return {
      ...base,
      rows,
      hasNegativeOnHand: rows.some((row) => row.onHand < 0),
    }
  }

  return rows.reduce<InventorySummary>((acc, row) => {
    const factor = factorByUom.get(normalizeUomCode(row.uom))
    if (!factor) {
      return {
        ...acc,
        rows: [...acc.rows, row],
        hasNegativeOnHand: acc.hasNegativeOnHand || row.onHand < 0,
      }
    }

    return {
      rows: [...acc.rows, row],
      canonicalUom,
      onHand: acc.onHand + row.onHand * factor,
      reserved: acc.reserved + row.reserved * factor,
      available: acc.available + row.available * factor,
      inTransit: acc.inTransit + row.inTransit * factor,
      backordered: acc.backordered + row.backordered * factor,
      inventoryPosition: acc.inventoryPosition + row.inventoryPosition * factor,
      hasNegativeOnHand: acc.hasNegativeOnHand || row.onHand < 0,
    }
  }, base)
}

export function buildInventoryLifecycle(inventory: InventorySummary): InventoryLifecycleStage[] {
  return [
    {
      key: 'ON_HAND',
      label: 'On hand',
      quantity: inventory.onHand,
      description: 'Total physical quantity recorded for this item.',
      tone: inventory.hasNegativeOnHand ? 'danger' : 'neutral',
    },
    {
      key: 'RESERVED',
      label: 'Reserved',
      quantity: inventory.reserved,
      description: 'Allocated to demand and not freely available.',
      tone: inventory.reserved > inventory.onHand ? 'warning' : 'neutral',
    },
    {
      key: 'AVAILABLE',
      label: 'Available',
      quantity: inventory.available,
      description: 'On-hand minus reservations in usable locations.',
      tone: inventory.available <= 0 ? 'warning' : 'neutral',
    },
    {
      key: 'IN_TRANSIT',
      label: 'In transit',
      quantity: inventory.inTransit,
      description: 'Expected stock already moving through the network.',
      tone: 'neutral',
    },
    {
      key: 'BACKORDERED',
      label: 'Backordered',
      quantity: inventory.backordered,
      description: 'Demand that cannot be fulfilled from current supply.',
      tone: inventory.backordered > 0 ? 'warning' : 'neutral',
    },
  ]
}

export function evaluateItemHealth(
  item: Item,
  inventory: InventorySummary,
  configuration: ItemConfiguration,
): ItemHealthResult {
  const reasons: string[] = []
  const actions: HealthAction[] = []

  const pushAction = (action: HealthAction) => {
    if (!actions.some((entry) => entry.id === action.id)) {
      actions.push(action)
    }
  }

  if (configuration.missingConversionUnits.length > 0) {
    reasons.push(
      `Missing UOM normalization for ${configuration.missingConversionUnits.join(', ')}.`,
    )
    pushAction({ id: 'fix_conversions', label: 'Fix conversions' })
  }

  if (inventory.available <= 0) {
    reasons.push('No usable inventory is available.')
    pushAction({ id: 'adjust_stock', label: 'Adjust stock' })
  }

  if (inventory.hasNegativeOnHand) {
    reasons.push('Negative on-hand detected in the movement ledger.')
    pushAction({ id: 'view_movements', label: 'View movements' })
  }

  if (configuration.requiresBom && !configuration.hasActiveBom) {
    reasons.push('No active BOM is configured for this manufacturable item.')
    pushAction({ id: 'create_bom', label: 'Create BOM' })
  }

  if (configuration.requiresRouting && !configuration.hasRouting) {
    reasons.push('No routing is configured for this manufacturable item.')
    pushAction({ id: 'create_routing', label: 'Create routing' })
  }

  if (reasons.length === 0) {
    return {
      status: ItemHealthStatus.READY,
      reasons: ['Item is ready for operational use.'],
      actions: [],
    }
  }

  if (configuration.missingConversionUnits.length > 0) {
    return { status: ItemHealthStatus.INVALID_CONVERSIONS, reasons, actions }
  }
  if (configuration.requiresBom && !configuration.hasActiveBom) {
    return { status: ItemHealthStatus.BOM_MISSING, reasons, actions }
  }
  if (configuration.requiresRouting && !configuration.hasRouting) {
    return { status: ItemHealthStatus.ROUTING_MISSING, reasons, actions }
  }
  if (inventory.available <= 0) {
    return { status: ItemHealthStatus.NO_STOCK, reasons, actions }
  }

  return { status: ItemHealthStatus.CONFIGURATION_REQUIRED, reasons, actions }
}

export function buildHealthTitle(health: ItemHealthResult) {
  switch (health.status) {
    case ItemHealthStatus.READY:
      return 'Item ready for use'
    case ItemHealthStatus.INVALID_CONVERSIONS:
      return 'Item blocked by invalid conversions'
    case ItemHealthStatus.BOM_MISSING:
      return 'Item blocked by missing BOM'
    case ItemHealthStatus.ROUTING_MISSING:
      return 'Item blocked by missing routing'
    case ItemHealthStatus.NO_STOCK:
      return 'Item has no usable stock'
    case ItemHealthStatus.CONFIGURATION_REQUIRED:
    default:
      return 'Item requires configuration'
  }
}

export function buildReadinessMetric(inventory: InventorySummary, hasActiveBom: boolean) {
  if (inventory.available > 0 && hasActiveBom) return 'Ready'
  if (inventory.available > 0) return 'Stock ready'
  return 'Attention needed'
}

export function formatConversionEquation(conversion: DerivedUnitConversion) {
  return `1 ${conversion.fromUom} = ${formatNumber(conversion.factor)} ${conversion.toUom}`
}

import type { Item, InventorySnapshotRow } from '../../api/types'

export enum ItemHealthStatus {
  READY = 'READY',
  CONFIGURATION_REQUIRED = 'CONFIGURATION_REQUIRED',
  NO_STOCK = 'NO_STOCK',
  INVALID_CONVERSIONS = 'INVALID_CONVERSIONS',
  BOM_MISSING = 'BOM_MISSING',
  ROUTING_MISSING = 'ROUTING_MISSING',
}

export type HealthActionId =
  | 'fix_conversions'
  | 'adjust_stock'
  | 'create_bom'
  | 'create_routing'
  | 'view_movements'
  | 'edit_item'

export type HealthAction = {
  id: HealthActionId
  label: string
}

export type ItemHealthResult = {
  status: ItemHealthStatus
  reasons: string[]
  actions: HealthAction[]
}

export type ItemConfiguration = {
  hasActiveBom: boolean
  requiresBom: boolean
  hasRouting: boolean
  requiresRouting: boolean
  conversionMode: 'derived' | 'manual'
  systemConversionDetected: boolean
  missingConversionUnits: string[]
}

export type InventorySummary = {
  rows: InventorySnapshotRow[]
  canonicalUom: string | null
  onHand: number
  reserved: number
  available: number
  inTransit: number
  backordered: number
  inventoryPosition: number
  hasNegativeOnHand: boolean
}

export type DerivedUnitConversion = {
  key: string
  fromUom: string
  toUom: string
  factor: number
  inverseFactor: number
  source: 'system' | 'manual'
}

export type UnitConversionState = {
  systemDetected: boolean
  canonicalUom: string | null
  conversions: DerivedUnitConversion[]
  factorByUom: Map<string, number>
  mode: 'derived' | 'manual'
  missingUnits: string[]
}

export type InventoryLifecycleStageKey =
  | 'ON_HAND'
  | 'RESERVED'
  | 'AVAILABLE'
  | 'IN_TRANSIT'
  | 'BACKORDERED'

export type InventoryLifecycleStage = {
  key: InventoryLifecycleStageKey
  label: string
  quantity: number
  description: string
  tone: 'neutral' | 'warning' | 'danger'
}

export type MetricTileModel = {
  label: string
  value: string | number
  subtext?: string
  status?: 'neutral' | 'warning' | 'danger'
}

export type ItemHeaderModel = {
  title: string
  subtitle: string
  badges: string[]
}

export type ItemDetailContextRailModel = {
  identity: Array<{ label: string; value: string }>
  configurationHealth: Array<{ label: string; value: string; tone: 'success' | 'warning' }>
  supportingMetadata: Array<{ label: string; value: string }>
}

export type ItemDetailViewModel = {
  item: Item
  inventory: InventorySummary
  configuration: ItemConfiguration
  health: ItemHealthResult
  lifecycle: InventoryLifecycleStage[]
  metrics: MetricTileModel[]
}

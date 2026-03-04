export type InventorySnapshotRow = {
  itemId: string
  locationId: string
  uom: string
  onHand: number
  reserved: number
  available: number
  held: number
  rejected: number
  nonUsable: number
  onOrder: number
  inTransit: number
  backordered: number
  inventoryPosition: number
}

export type InventoryUomInconsistencyReason = 'STOCKING_UOM_UNSET' | 'NON_CONVERTIBLE_UOM'

export type UomNormalizationStatus =
  | 'OK'
  | 'INCONSISTENT'
  | 'UNKNOWN_UOM'
  | 'DIMENSION_MISMATCH'
  | 'LEGACY_FALLBACK_USED'

export type UomDiagnosticSeverity = 'info' | 'watch' | 'action' | 'critical'

export type UomResolutionTrace = {
  status: UomNormalizationStatus
  severity: UomDiagnosticSeverity
  canAggregate: boolean
  source: 'registry' | 'alias' | 'item_override' | 'legacy_conversion'
  inputUomCode: string
  resolvedFromUom?: string
  resolvedToUom?: string
  itemId?: string
  mappingKey?: string
  detailCode?: string
  detail?: string
}

export type InventoryUomInconsistency = {
  itemId: string
  locationId: string
  stockingUom: string | null
  observedUoms: string[]
  reason?: InventoryUomInconsistencyReason | 'UNKNOWN_UOM' | 'DIMENSION_MISMATCH' | 'LEGACY_FALLBACK_USED'
  status: UomNormalizationStatus
  severity: UomDiagnosticSeverity
  canAggregate: boolean
  traces: UomResolutionTrace[]
}

export type InventorySnapshotSummaryDiagnostics = {
  uomNormalizationDiagnostics: InventoryUomInconsistency[]
  // Deprecated compatibility alias from backend.
  uomInconsistencies: InventoryUomInconsistency[]
}

export type InventorySnapshotSummaryDetailed = {
  data: InventorySnapshotRow[]
  diagnostics: InventorySnapshotSummaryDiagnostics
}

export type InventoryChangeScope = {
  itemId?: string
  locationId?: string
}

export type InventoryChangeEvent = {
  seq: string
  type: string
  scope: InventoryChangeScope
  occurredAt: string
}

export type InventoryChangesResponse = {
  events: InventoryChangeEvent[]
  nextSeq: string
  resetRequired?: boolean
}

export type DashboardSignalSeverity = 'info' | 'watch' | 'action' | 'critical'

export type DashboardExceptionType =
  | 'availability_breach'
  | 'negative_on_hand'
  | 'allocation_integrity'
  | 'reorder_risk'
  | 'inbound_aging'
  | 'work_order_risk'
  | 'cycle_count_hygiene'
  | 'uom_inconsistent'

export type InventoryMonitoringCoverage = {
  hasInventoryRows: boolean
  hasReplenishmentPolicies: boolean
  hasDemandSignal: boolean
  hasCycleCountProgram: boolean
  hasShipmentsInWindow: boolean
  inventoryMonitoringConfigured: boolean
  replenishmentMonitoringConfigured: boolean
  cycleCountMonitoringConfigured: boolean
  reliabilityMeasurable: boolean
}

export type InventorySignalAction = {
  label: string
  href: string
}

export type ResolutionQueueRow = {
  id: string
  type: DashboardExceptionType
  severity: DashboardSignalSeverity
  itemLabel: string
  itemId?: string
  locationLabel: string
  locationId?: string
  warehouseId?: string
  uom?: string
  impactScore: number
  occurredAt: string
  recommendedAction: string
  primaryLink: string
}

export type DashboardSignal = {
  key: string
  label: string
  type: DashboardExceptionType | 'fulfillment_reliability'
  severity: DashboardSignalSeverity
  value: string
  helper: string
  count: number
  drilldownTo: string
  formula: string
  sources: string[]
  queryHint: string
}

export type InventorySignalMetric = {
  key: string
  label: string
  severity: DashboardSignalSeverity
  value: string
  count?: number
  helper: string
  formula: string
  queryHint: string
  drilldownTo: string
  sources: string[]
  investigativeAction?: InventorySignalAction
  correctiveAction?: InventorySignalAction
}

export type InventorySignalRow = {
  id: string
  label: string
  secondaryLabel?: string
  value: string
  severity: DashboardSignalSeverity
  drilldownTo: string
}

export type DashboardSignalSectionKey =
  | 'inventoryIntegrity'
  | 'inventoryRisk'
  | 'inventoryCoverage'
  | 'flowReliability'
  | 'supplyReliability'
  | 'excessInventory'
  | 'performanceMetrics'
  | 'systemHealth'
  | 'demandVolatility'
  | 'forecastAccuracy'

export type DashboardSignalSection = {
  key: DashboardSignalSectionKey
  title: string
  description: string
  metrics: InventorySignalMetric[]
  rows: InventorySignalRow[]
}

export type InventorySignalCoverageRow = {
  signal: string
  implemented: boolean
  dataSource: string[]
  accuracy: 'measured' | 'derived' | 'proxy'
  dashboardIntegration: 'live_api' | 'dashboard_section' | 'exception_queue'
}

export type DashboardOverview = {
  asOf: string
  asOfLabel: string
  warehouseScope: {
    ids: string[]
    label: string
  }
  warehouses: Array<{
    id: string
    code: string | null
    name: string | null
  }>
  coverage: InventoryMonitoringCoverage
  exceptions: ResolutionQueueRow[]
  signals: DashboardSignal[]
  uomNormalizationDiagnostics: unknown[]
  uomDiagnosticGroupBuckets: {
    actionGroups: number
    watchGroups: number
    totalGroups: number
  }
  sections: Record<DashboardSignalSectionKey, DashboardSignalSection>
  coverageMatrix: InventorySignalCoverageRow[]
}

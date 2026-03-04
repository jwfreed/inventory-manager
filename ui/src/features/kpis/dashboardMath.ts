import type {
  FulfillmentFillRate,
  InventorySnapshotRow,
  Item,
  Location,
  PurchaseOrder,
  ReplenishmentPolicy,
  ReplenishmentRecommendation,
  WorkOrder,
} from '@api/types'
import type { ItemMetrics } from '@features/items/api/items'
import { compareSeverity, type Severity } from '@shared/ui'

export type InventoryState = {
  onHandQty: number
  allocatedQty: number
  qualityHoldQty: number
  damagedHoldQty: number
  availableQty: number
  onOrderQty: number
  inTransitQty: number
  wipQty: number
  backorderQty: number
}

export type DashboardExceptionType =
  | 'availability_breach'
  | 'negative_on_hand'
  | 'allocation_integrity'
  | 'reorder_risk'
  | 'inbound_aging'
  | 'work_order_risk'
  | 'cycle_count_hygiene'

export type ResolutionQueueRow = {
  id: string
  type: DashboardExceptionType
  severity: Severity
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
  severity: Severity
  value: string
  helper: string
  count: number
  drilldownTo: string
  formula: string
  sources: string[]
  queryHint: string
}

export type MonitoringCoverage = {
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

export type AttentionState = 'all_clear' | 'not_configured' | 'exceptions_present'

export type BuildDashboardExceptionsInput = {
  inventoryRows: InventorySnapshotRow[]
  recommendations: ReplenishmentRecommendation[]
  policyScopeSet: Set<string>
  purchaseOrders: PurchaseOrder[]
  workOrders: WorkOrder[]
  itemLookup: Map<string, Item>
  locationLookup: Map<string, Location>
  itemMetricsLookup: Map<string, ItemMetrics>
  asOf: string
}

type CoverageInput = {
  inventoryRows: InventorySnapshotRow[]
  policies: ReplenishmentPolicy[]
  items: Item[]
  itemMetrics: ItemMetrics[]
  fillRate: FulfillmentFillRate | null
}

function toFiniteNumber(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0
  }
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function roundQuantity(value: number) {
  return Math.round(value * 1000) / 1000
}

function daysSince(value?: string | null): number {
  if (!value) return Number.POSITIVE_INFINITY
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return Number.POSITIVE_INFINITY
  return Math.floor((Date.now() - date.getTime()) / (24 * 60 * 60 * 1000))
}

export function parseTime(value?: string | null) {
  if (!value) return 0
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : 0
}

function itemLabel(itemId: string | undefined, lookup: Map<string, Item>, fallback: string) {
  if (!itemId) return fallback
  const item = lookup.get(itemId)
  if (!item) return fallback
  return item.name ? `${item.sku} - ${item.name}` : item.sku
}

function locationLabel(locationId: string | undefined, lookup: Map<string, Location>, fallback: string) {
  if (!locationId) return fallback
  const location = lookup.get(locationId)
  if (!location) return fallback
  return location.name ? `${location.code} - ${location.name}` : location.code
}

// Warehouse resolution precedence:
// 1) explicit parent warehouseId on the location row
// 2) if the row itself is a warehouse-type location, use its own id
// 3) unresolved -> null
export function resolveWarehouseId(locationId: string | undefined, lookup: Map<string, Location>) {
  if (!locationId) return null
  const location = lookup.get(locationId)
  if (!location) return null
  if (location.warehouseId) return location.warehouseId
  if (location.type === 'warehouse') return location.id
  return null
}

export function withQuery(
  basePath: string,
  params: Record<string, string | null | undefined>,
) {
  const search = new URLSearchParams()
  Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([key, value]) => {
      search.set(key, String(value))
    })
  const query = search.toString()
  return query ? `${basePath}?${query}` : basePath
}

function availabilityScopeKey(row: ResolutionQueueRow) {
  if (row.type !== 'availability_breach') return null
  if (!row.itemId || !row.locationId) return null
  const uom = row.uom?.trim()
  if (!uom) return null
  return `${row.itemId}:${row.locationId}:${uom}:${row.severity}`
}

export function dedupeResolutionQueue(rows: ResolutionQueueRow[]) {
  const byId = new Map<string, ResolutionQueueRow>()
  rows.forEach((row) => {
    const existing = byId.get(row.id)
    if (!existing) {
      byId.set(row.id, row)
      return
    }
    if (row.impactScore > existing.impactScore) {
      byId.set(row.id, row)
      return
    }
    if (row.impactScore === existing.impactScore && parseTime(row.occurredAt) > parseTime(existing.occurredAt)) {
      byId.set(row.id, row)
    }
  })

  const byAvailabilityScope = new Map<string, ResolutionQueueRow>()
  Array.from(byId.values()).forEach((row) => {
    const scopeKey = availabilityScopeKey(row)
    if (!scopeKey) {
      byAvailabilityScope.set(row.id, row)
      return
    }
    const existing = byAvailabilityScope.get(scopeKey)
    if (!existing) {
      byAvailabilityScope.set(scopeKey, row)
      return
    }
    if (row.impactScore > existing.impactScore) {
      byAvailabilityScope.set(scopeKey, row)
      return
    }
    if (row.impactScore === existing.impactScore && parseTime(row.occurredAt) > parseTime(existing.occurredAt)) {
      byAvailabilityScope.set(scopeKey, row)
    }
  })

  return Array.from(byAvailabilityScope.values())
}

export function computeAvailableQty(input: {
  onHandQty: number
  allocatedQty: number
  qualityHoldQty: number
  damagedHoldQty: number
}) {
  return roundQuantity(
    toFiniteNumber(input.onHandQty) -
      toFiniteNumber(input.allocatedQty) -
      toFiniteNumber(input.qualityHoldQty) -
      toFiniteNumber(input.damagedHoldQty),
  )
}

export function deriveInventoryState(row: InventorySnapshotRow): InventoryState {
  const onHandQty = toFiniteNumber(row.onHand)
  const allocatedQty = toFiniteNumber(row.reserved)
  const qualityHoldQty = toFiniteNumber(row.held)
  const damagedHoldQty = toFiniteNumber(row.rejected)
  const availableQty = computeAvailableQty({
    onHandQty,
    allocatedQty,
    qualityHoldQty,
    damagedHoldQty,
  })
  return {
    onHandQty,
    allocatedQty,
    qualityHoldQty,
    damagedHoldQty,
    availableQty,
    onOrderQty: toFiniteNumber(row.onOrder),
    inTransitQty: toFiniteNumber(row.inTransit),
    wipQty: 0,
    backorderQty: toFiniteNumber(row.backordered),
  }
}

export function deriveCoverageState(input: CoverageInput): MonitoringCoverage {
  const hasInventoryRows = input.inventoryRows.length > 0
  const hasReplenishmentPolicies = input.policies.some((policy) => policy.status !== 'inactive')
  const hasDemandSignal = input.inventoryRows.some(
    (row) => toFiniteNumber(row.reserved) > 0 || toFiniteNumber(row.backordered) > 0,
  )
  const abcItemIds = input.items.filter((item) => item.abcClass === 'A').map((item) => item.id)
  const metricsIds = new Set(input.itemMetrics.map((metric) => metric.itemId))
  const hasCycleCountProgram = abcItemIds.some((itemId) => metricsIds.has(itemId))
  const hasShipmentsInWindow = (input.fillRate?.requestedQty ?? 0) > 0

  return {
    hasInventoryRows,
    hasReplenishmentPolicies,
    hasDemandSignal,
    hasCycleCountProgram,
    hasShipmentsInWindow,
    inventoryMonitoringConfigured: hasInventoryRows,
    replenishmentMonitoringConfigured: hasInventoryRows && hasReplenishmentPolicies,
    cycleCountMonitoringConfigured: hasCycleCountProgram,
    reliabilityMeasurable: hasShipmentsInWindow,
  }
}

export function deriveAttentionState(input: {
  coverage: MonitoringCoverage
  exceptionCount: number
}): AttentionState {
  if (input.exceptionCount > 0) return 'exceptions_present'
  if (!input.coverage.inventoryMonitoringConfigured) return 'not_configured'
  return 'all_clear'
}

export function buildDashboardExceptions(input: BuildDashboardExceptionsInput): ResolutionQueueRow[] {
  const rows: ResolutionQueueRow[] = []

  input.inventoryRows.forEach((row) => {
    const state = deriveInventoryState(row)
    const key = `${row.itemId}:${row.locationId}`
    const activeDemand = state.allocatedQty > 0 || state.backorderQty > 0
    const hasPolicy = input.policyScopeSet.has(key)
    const readableItem = itemLabel(row.itemId, input.itemLookup, row.itemId)
    const readableLocation = locationLabel(row.locationId, input.locationLookup, row.locationId)
    const warehouseId = resolveWarehouseId(row.locationId, input.locationLookup) ?? undefined

    if (state.availableQty <= 0 && (activeDemand || hasPolicy)) {
      rows.push({
        id: `availability:${key}:${row.uom}`,
        type: 'availability_breach',
        severity: 'critical',
        itemLabel: readableItem,
        itemId: row.itemId,
        locationLabel: readableLocation,
        locationId: row.locationId,
        warehouseId,
        uom: row.uom,
        impactScore: Math.max(Math.abs(state.availableQty), state.backorderQty, state.allocatedQty),
        occurredAt: input.asOf,
        recommendedAction: 'Investigate allocation, expedite inbound, or deallocate lower-priority demand.',
        primaryLink: withQuery(`/items/${row.itemId}`, {
          locationId: row.locationId,
          warehouseId,
          type: 'availability_breach',
        }),
      })
    }

    if (state.onHandQty < 0) {
      rows.push({
        id: `negative-onhand:${key}:${row.uom}`,
        type: 'negative_on_hand',
        severity: 'critical',
        itemLabel: readableItem,
        itemId: row.itemId,
        locationLabel: readableLocation,
        locationId: row.locationId,
        warehouseId,
        uom: row.uom,
        impactScore: Math.abs(state.onHandQty),
        occurredAt: input.asOf,
        recommendedAction: 'Investigate ledger sequence and post corrective movement.',
        primaryLink: withQuery('/movements', {
          itemId: row.itemId,
          locationId: row.locationId,
          warehouseId,
          type: 'negative_on_hand',
        }),
      })
    }

    if (
      state.allocatedQty > state.onHandQty ||
      (state.availableQty < 0 && state.qualityHoldQty <= 0 && state.damagedHoldQty <= 0)
    ) {
      rows.push({
        id: `allocation-integrity:${key}:${row.uom}`,
        type: 'allocation_integrity',
        severity: 'critical',
        itemLabel: readableItem,
        itemId: row.itemId,
        locationLabel: readableLocation,
        locationId: row.locationId,
        warehouseId,
        uom: row.uom,
        impactScore: Math.max(state.allocatedQty - state.onHandQty, Math.abs(state.availableQty)),
        occurredAt: input.asOf,
        recommendedAction:
          'Investigate reservations/allocations; deallocate lower-priority demand or correct ledger postings.',
        primaryLink: withQuery('/reservations', {
          itemId: row.itemId,
          locationId: row.locationId,
          warehouseId,
          type: 'allocation_integrity',
        }),
      })
    }
  })

  input.recommendations
    .filter((rec) => rec.recommendation.reorderNeeded)
    .forEach((rec) => {
      const threshold =
        rec.policyType === 'q_rop'
          ? toFiniteNumber(rec.inputs.reorderPointQty)
          : toFiniteNumber(rec.inputs.orderUpToLevelQty)
      const gap = Math.max(0, threshold - toFiniteNumber(rec.inventory.inventoryPosition))
      const severity: Severity = gap > Math.max(10, threshold * 0.25) ? 'action' : 'watch'
      const warehouseId = resolveWarehouseId(rec.locationId, input.locationLookup) ?? undefined
      rows.push({
        id: `reorder:${rec.policyId}`,
        type: 'reorder_risk',
        severity,
        itemLabel: itemLabel(rec.itemId, input.itemLookup, rec.itemId),
        itemId: rec.itemId,
        locationLabel: locationLabel(rec.locationId, input.locationLookup, rec.locationId),
        locationId: rec.locationId,
        warehouseId,
        uom: rec.uom,
        impactScore: Math.max(gap, toFiniteNumber(rec.recommendation.recommendedOrderQty)),
        occurredAt: input.asOf,
        recommendedAction: 'Create or expedite a PO for the recommended quantity.',
        primaryLink: withQuery('/purchase-orders/new', {
          itemId: rec.itemId,
          locationId: rec.locationId,
          warehouseId,
          qty: String(rec.recommendation.recommendedOrderQty),
          uom: rec.uom,
          type: 'reorder_risk',
        }),
      })
    })

  input.purchaseOrders.forEach((po) => {
    const status = String(po.status ?? '').toLowerCase()
    const submittedAge = daysSince(po.createdAt ?? po.orderDate ?? null)
    const overdueAge = po.expectedDate ? daysSince(po.expectedDate) : 0
    const warehouseId = resolveWarehouseId(po.shipToLocationId, input.locationLookup) ?? undefined
    const occurredSubmittedAt = po.createdAt ?? po.orderDate ?? input.asOf
    const occurredOverdueAt = po.expectedDate ?? po.createdAt ?? po.orderDate ?? input.asOf

    if (status === 'submitted' && submittedAge > 1) {
      rows.push({
        id: `inbound-submitted:${po.id}`,
        type: 'inbound_aging',
        severity: submittedAge > 3 ? 'action' : 'watch',
        itemLabel: po.poNumber,
        itemId: undefined,
        locationLabel: locationLabel(po.shipToLocationId, input.locationLookup, 'Not set'),
        locationId: po.shipToLocationId,
        warehouseId,
        impactScore: submittedAge,
        occurredAt: occurredSubmittedAt,
        recommendedAction: 'Approve or reject PO to unblock inbound execution.',
        primaryLink: withQuery(`/purchase-orders/${po.id}`, {
          locationId: po.shipToLocationId,
          warehouseId,
          type: 'inbound_aging',
        }),
      })
    }
    if ((status === 'approved' || status === 'partially_received') && overdueAge > 0) {
      rows.push({
        id: `inbound-overdue:${po.id}`,
        type: 'inbound_aging',
        severity: overdueAge > 5 ? 'action' : 'watch',
        itemLabel: po.poNumber,
        itemId: undefined,
        locationLabel: locationLabel(po.shipToLocationId, input.locationLookup, 'Not set'),
        locationId: po.shipToLocationId,
        warehouseId,
        impactScore: overdueAge,
        occurredAt: occurredOverdueAt,
        recommendedAction: 'Expedite supplier confirmation and adjust expected receipt date.',
        primaryLink: withQuery(`/purchase-orders/${po.id}`, {
          locationId: po.shipToLocationId,
          warehouseId,
          type: 'inbound_aging',
        }),
      })
    }
  })

  input.workOrders
    .filter((workOrder) => {
      const status = (workOrder.status ?? '').toLowerCase()
      return status !== 'completed' && status !== 'closed' && status !== 'voided'
    })
    .forEach((workOrder) => {
      const planned = toFiniteNumber(workOrder.quantityPlanned)
      const completed = toFiniteNumber(workOrder.quantityCompleted)
      const remaining = Math.max(0, planned - completed)
      if (remaining <= 0) return
      const dueAge = workOrder.scheduledDueAt ? daysSince(workOrder.scheduledDueAt) : 0
      const locationId = workOrder.defaultProduceLocationId ?? undefined
      const warehouseId = resolveWarehouseId(locationId, input.locationLookup) ?? undefined
      rows.push({
        id: `work-order-risk:${workOrder.id}`,
        type: 'work_order_risk',
        severity: dueAge > 0 ? 'action' : 'watch',
        itemLabel: itemLabel(workOrder.outputItemId, input.itemLookup, workOrder.number),
        itemId: workOrder.outputItemId,
        locationLabel: locationLabel(locationId, input.locationLookup, 'Production'),
        locationId,
        warehouseId,
        impactScore: remaining,
        occurredAt: workOrder.scheduledDueAt ?? input.asOf,
        recommendedAction: 'Review component availability and prioritize issue/production steps.',
        primaryLink: withQuery(`/work-orders/${workOrder.id}`, {
          warehouseId,
          locationId,
          type: 'work_order_risk',
        }),
      })
    })

  input.itemLookup.forEach((item) => {
    if (item.abcClass !== 'A') return
    const metrics = input.itemMetricsLookup.get(item.id)
    const countAgeDays = daysSince(metrics?.lastCountAt ?? null)
    const variancePct = Math.abs(toFiniteNumber(metrics?.lastCountVariancePct))
    const stale = !Number.isFinite(countAgeDays) || countAgeDays > 30
    const highVariance = variancePct > 0.05
    if (!stale && !highVariance) return
    const locationId = item.defaultLocationId ?? undefined
    const warehouseId = resolveWarehouseId(locationId, input.locationLookup) ?? undefined

    rows.push({
      id: `cycle:${item.id}`,
      type: 'cycle_count_hygiene',
      severity: stale || variancePct > 0.1 ? 'action' : 'watch',
      itemLabel: item.name ? `${item.sku} - ${item.name}` : item.sku,
      itemId: item.id,
      locationLabel: locationLabel(locationId, input.locationLookup, 'Multiple'),
      locationId,
      warehouseId,
      impactScore: Math.max(Number.isFinite(countAgeDays) ? countAgeDays : 45, variancePct * 100),
      occurredAt: metrics?.lastCountAt ?? input.asOf,
      recommendedAction: 'Schedule cycle count and investigate variance root cause.',
      primaryLink: withQuery(`/items/${item.id}`, {
        warehouseId,
        locationId,
        type: 'cycle_count_hygiene',
      }),
    })
  })

  return sortResolutionQueue(dedupeResolutionQueue(rows))
}

export function sortResolutionQueue(rows: ResolutionQueueRow[]) {
  return [...rows].sort((left, right) => {
    const severityRank = compareSeverity(left.severity, right.severity)
    if (severityRank !== 0) return severityRank
    if (right.impactScore !== left.impactScore) return right.impactScore - left.impactScore
    return parseTime(right.occurredAt) - parseTime(left.occurredAt)
  })
}

export function filterResolutionQueue(rows: ResolutionQueueRow[], type?: DashboardExceptionType | 'all') {
  if (!type || type === 'all') return rows
  return rows.filter((row) => row.type === type)
}

export function buildDashboardSignals(input: {
  exceptions: ResolutionQueueRow[]
  fillRate: FulfillmentFillRate | null
  asOfLabel: string
}): DashboardSignal[] {
  const countByType = new Map<DashboardExceptionType, number>()
  const maxSeverityByType = new Map<DashboardExceptionType, Severity>()
  input.exceptions.forEach((exception) => {
    countByType.set(exception.type, (countByType.get(exception.type) ?? 0) + 1)
    const previous = maxSeverityByType.get(exception.type)
    if (!previous || compareSeverity(exception.severity, previous) < 0) {
      maxSeverityByType.set(exception.type, exception.severity)
    }
  })

  const withCount = (
    key: DashboardExceptionType,
    label: string,
    helper: string,
    formula: string,
    queryHint: string,
  ): DashboardSignal => {
    const count = countByType.get(key) ?? 0
    return {
      key,
      type: key,
      label,
      severity: maxSeverityByType.get(key) ?? 'info',
      value: String(count),
      helper,
      count,
      drilldownTo: `/dashboard/resolution-queue?type=${key}`,
      formula,
      queryHint,
      sources: [
        '/inventory-snapshot/summary',
        '/replenishment/policies',
        '/replenishment/recommendations',
        '/purchase-orders',
        '/work-orders',
      ],
    }
  }

  const fillMeasured = Boolean(input.fillRate && input.fillRate.fillRate !== null)
  const fillRateValue = fillMeasured
    ? `${Math.round((input.fillRate?.fillRate ?? 0) * 1000) / 10}%`
    : 'Not measurable yet'
  const unfilledRate = fillMeasured ? Math.max(0, 1 - (input.fillRate?.fillRate ?? 0)) : null
  const reliabilitySeverity: Severity = !fillMeasured
    ? 'info'
    : (input.fillRate?.fillRate ?? 0) < 0.85
      ? 'action'
      : (input.fillRate?.fillRate ?? 0) < 0.95
        ? 'watch'
        : 'info'

  const signals: DashboardSignal[] = [
    withCount(
      'availability_breach',
      'Availability breaches',
      'Available qty <= 0 with active demand or configured policy scope.',
      'AvailableQty = OnHandQty - AllocatedQty - QualityHoldQty - DamagedHoldQty.',
      'Derived from /inventory-snapshot/summary and policy scope coverage.',
    ),
    withCount(
      'negative_on_hand',
      'Negative on-hand',
      'Physical stock cannot be negative.',
      'Negative on-hand when OnHandQty < 0 at any location.',
      'Derived from /inventory-snapshot/summary.',
    ),
    withCount(
      'allocation_integrity',
      'Allocation integrity',
      'Allocated exceeds on-hand or negative available without holds.',
      'Critical when AllocatedQty > OnHandQty OR AvailableQty < 0 with zero holds.',
      'Derived from /inventory-snapshot/summary.',
    ),
    withCount(
      'reorder_risk',
      'Reorder risks',
      'Below reorder thresholds or projected short.',
      'Reorder risk when policy recommendation requires replenishment.',
      'Derived from /replenishment/recommendations.',
    ),
    withCount(
      'inbound_aging',
      'Inbound aging',
      'Aging submitted/overdue purchase orders.',
      'Submitted age and approved overdue days by PO status.',
      'Derived from /purchase-orders.',
    ),
    withCount(
      'work_order_risk',
      'Open WO at risk',
      'WIP with remaining quantity and due-date risk.',
      'Risk when remaining quantity > 0, weighted by due date and remaining qty.',
      'Derived from /work-orders.',
    ),
    withCount(
      'cycle_count_hygiene',
      'Cycle count hygiene',
      'A-items stale counts or large variance.',
      'A-item count policy breach by age and variance thresholds.',
      'Derived from /items and /items/metrics.',
    ),
    {
      key: 'fulfillment_reliability',
      type: 'fulfillment_reliability',
      label: 'Fulfillment reliability',
      severity: reliabilitySeverity,
      value: fillRateValue,
      count: fillMeasured ? 1 : 0,
      helper: fillMeasured
        ? `Unfilled rate ≈ ${(Math.round((unfilledRate ?? 0) * 1000) / 10).toFixed(1)}% (proxy). True backorder rate requires backordered qty data.`
        : 'Not measurable: no shipped/requested quantity in selected window.',
      drilldownTo: '/shipments',
      formula: fillMeasured
        ? 'FillRate = shippedQty / requestedQty. Unfilled rate (proxy) = 1 - FillRate.'
        : 'Not measurable when requestedQty = 0.',
      queryHint: 'Measured using /kpis/fulfillment-fill-rate.',
      sources: ['/kpis/fulfillment-fill-rate'],
    },
  ]

  return signals.map((signal) => ({ ...signal, helper: `${signal.helper} As of ${input.asOfLabel}.` }))
}

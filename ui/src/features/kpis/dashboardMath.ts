import type {
  FulfillmentFillRate,
  InventorySnapshotRow,
  Item,
  Location,
  PurchaseOrder,
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

export type BuildDashboardExceptionsInput = {
  inventoryRows: InventorySnapshotRow[]
  recommendations: ReplenishmentRecommendation[]
  purchaseOrders: PurchaseOrder[]
  workOrders: WorkOrder[]
  itemLookup: Map<string, Item>
  locationLookup: Map<string, Location>
  itemMetricsLookup: Map<string, ItemMetrics>
  asOf: string
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

function businessDaysAgo(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

function daysSince(value?: string | null): number {
  if (!value) return Number.POSITIVE_INFINITY
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return Number.POSITIVE_INFINITY
  return Math.floor((Date.now() - date.getTime()) / (24 * 60 * 60 * 1000))
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

export function buildDashboardExceptions(input: BuildDashboardExceptionsInput): ResolutionQueueRow[] {
  const rows: ResolutionQueueRow[] = []
  const policyByItemLocation = new Set(
    input.recommendations.map((rec) => `${rec.itemId}:${rec.locationId}`),
  )

  input.inventoryRows.forEach((row) => {
    const state = deriveInventoryState(row)
    const key = `${row.itemId}:${row.locationId}`
    const activeDemand = state.allocatedQty > 0 || state.backorderQty > 0
    const hasPolicy = policyByItemLocation.has(key)
    const readableItem = itemLabel(row.itemId, input.itemLookup, row.itemId)
    const readableLocation = locationLabel(row.locationId, input.locationLookup, row.locationId)

    if (state.availableQty <= 0 && (activeDemand || hasPolicy)) {
      rows.push({
        id: `availability:${key}:${row.uom}`,
        type: 'availability_breach',
        severity: 'critical',
        itemLabel: readableItem,
        itemId: row.itemId,
        locationLabel: readableLocation,
        locationId: row.locationId,
        impactScore: Math.max(Math.abs(state.availableQty), state.backorderQty, state.allocatedQty),
        occurredAt: input.asOf,
        recommendedAction: 'Investigate allocation, expedite inbound, or deallocate lower-priority demand.',
        primaryLink: `/items/${row.itemId}?locationId=${encodeURIComponent(row.locationId)}`,
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
        impactScore: Math.abs(state.onHandQty),
        occurredAt: input.asOf,
        recommendedAction: 'Investigate ledger sequence and post corrective movement.',
        primaryLink: `/movements?itemId=${encodeURIComponent(row.itemId)}&locationId=${encodeURIComponent(row.locationId)}`,
      })
    }
  })

  input.recommendations
    .filter((rec) => rec.recommendation.reorderNeeded)
    .forEach((rec) => {
      const threshold = rec.policyType === 'q_rop'
        ? toFiniteNumber(rec.inputs.reorderPointQty)
        : toFiniteNumber(rec.inputs.orderUpToLevelQty)
      const gap = Math.max(0, threshold - toFiniteNumber(rec.inventory.inventoryPosition))
      const severity: Severity = gap > Math.max(10, threshold * 0.25) ? 'action' : 'watch'
      rows.push({
        id: `reorder:${rec.policyId}`,
        type: 'reorder_risk',
        severity,
        itemLabel: itemLabel(rec.itemId, input.itemLookup, rec.itemId),
        itemId: rec.itemId,
        locationLabel: locationLabel(rec.locationId, input.locationLookup, rec.locationId),
        locationId: rec.locationId,
        impactScore: Math.max(gap, toFiniteNumber(rec.recommendation.recommendedOrderQty)),
        occurredAt: input.asOf,
        recommendedAction: 'Create or expedite a PO for the recommended quantity.',
        primaryLink: `/purchase-orders/new?itemId=${encodeURIComponent(rec.itemId)}&locationId=${encodeURIComponent(
          rec.locationId,
        )}&qty=${encodeURIComponent(String(rec.recommendation.recommendedOrderQty))}&uom=${encodeURIComponent(rec.uom)}`,
      })
    })

  input.purchaseOrders.forEach((po) => {
    const submittedAge = daysSince(po.createdAt ?? po.orderDate ?? null)
    const overdueAge = po.expectedDate ? daysSince(po.expectedDate) : 0
    if (po.status === 'submitted' && submittedAge > 1) {
      rows.push({
        id: `inbound-submitted:${po.id}`,
        type: 'inbound_aging',
        severity: submittedAge > 3 ? 'action' : 'watch',
        itemLabel: po.poNumber,
        itemId: undefined,
        locationLabel: locationLabel(po.shipToLocationId, input.locationLookup, 'Not set'),
        locationId: po.shipToLocationId,
        impactScore: submittedAge,
        occurredAt: businessDaysAgo(submittedAge),
        recommendedAction: 'Approve or reject PO to unblock inbound execution.',
        primaryLink: `/purchase-orders/${po.id}`,
      })
    }
    if ((po.status === 'approved' || po.status === 'partially_received') && overdueAge > 0) {
      rows.push({
        id: `inbound-overdue:${po.id}`,
        type: 'inbound_aging',
        severity: overdueAge > 5 ? 'action' : 'watch',
        itemLabel: po.poNumber,
        itemId: undefined,
        locationLabel: locationLabel(po.shipToLocationId, input.locationLookup, 'Not set'),
        locationId: po.shipToLocationId,
        impactScore: overdueAge,
        occurredAt: businessDaysAgo(overdueAge),
        recommendedAction: 'Expedite supplier confirmation and adjust expected receipt date.',
        primaryLink: `/purchase-orders/${po.id}`,
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
      rows.push({
        id: `work-order-risk:${workOrder.id}`,
        type: 'work_order_risk',
        severity: dueAge > 0 ? 'action' : 'watch',
        itemLabel: itemLabel(workOrder.outputItemId, input.itemLookup, workOrder.number),
        itemId: workOrder.outputItemId,
        locationLabel: locationLabel(
          workOrder.defaultProduceLocationId ?? undefined,
          input.locationLookup,
          'Production',
        ),
        locationId: workOrder.defaultProduceLocationId ?? undefined,
        impactScore: remaining,
        occurredAt: workOrder.scheduledDueAt ?? input.asOf,
        recommendedAction: 'Review component availability and prioritize issue/production steps.',
        primaryLink: `/work-orders/${workOrder.id}`,
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

    rows.push({
      id: `cycle:${item.id}`,
      type: 'cycle_count_hygiene',
      severity: stale || variancePct > 0.1 ? 'action' : 'watch',
      itemLabel: item.name ? `${item.sku} - ${item.name}` : item.sku,
      itemId: item.id,
      locationLabel: locationLabel(item.defaultLocationId ?? undefined, input.locationLookup, 'Multiple'),
      locationId: item.defaultLocationId ?? undefined,
      impactScore: Math.max(Number.isFinite(countAgeDays) ? countAgeDays : 45, variancePct * 100),
      occurredAt: metrics?.lastCountAt ?? input.asOf,
      recommendedAction: 'Schedule cycle count and investigate variance root cause.',
      primaryLink: `/items/${item.id}`,
    })
  })

  return sortResolutionQueue(rows)
}

export function sortResolutionQueue(rows: ResolutionQueueRow[]) {
  return [...rows].sort((left, right) => {
    const severityRank = compareSeverity(left.severity, right.severity)
    if (severityRank !== 0) return severityRank
    if (right.impactScore !== left.impactScore) return right.impactScore - left.impactScore
    return new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime()
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
    drilldownTo: string,
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
      drilldownTo,
      formula,
      queryHint,
      sources: ['/inventory-snapshot/summary', '/replenishment/recommendations', '/purchase-orders', '/work-orders'],
    }
  }

  const fillMeasured = input.fillRate && input.fillRate.fillRate !== null
  const fillRateValue = fillMeasured
    ? `${Math.round((input.fillRate?.fillRate ?? 0) * 1000) / 10}%`
    : 'Not measurable yet'
  const backorderRate = fillMeasured ? Math.max(0, 1 - (input.fillRate?.fillRate ?? 0)) : null
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
      'Available qty <= 0 with active demand or policy.',
      '/dashboard/resolution-queue?type=availability_breach',
      'AvailableQty = OnHandQty - AllocatedQty - QualityHoldQty - DamagedHoldQty.',
      'Derived from /inventory-snapshot/summary.',
    ),
    withCount(
      'negative_on_hand',
      'Negative on-hand',
      'Physical stock cannot be negative.',
      '/dashboard/resolution-queue?type=negative_on_hand',
      'Negative on-hand when OnHandQty < 0 at any location.',
      'Derived from /inventory-snapshot/summary.',
    ),
    withCount(
      'reorder_risk',
      'Reorder risks',
      'Below reorder thresholds or projected short.',
      '/dashboard/resolution-queue?type=reorder_risk',
      'Reorder risk when policy recommendation requires replenishment.',
      'Derived from /replenishment/recommendations.',
    ),
    withCount(
      'inbound_aging',
      'Inbound aging',
      'Aging submitted/overdue purchase orders.',
      '/dashboard/resolution-queue?type=inbound_aging',
      'Submitted age and approved overdue days by PO status.',
      'Derived from /purchase-orders.',
    ),
    withCount(
      'work_order_risk',
      'Open WO at risk',
      'WIP with remaining quantity and due-date risk.',
      '/dashboard/resolution-queue?type=work_order_risk',
      'Risk when remaining quantity > 0, weighted by due date and remaining qty.',
      'Derived from /work-orders.',
    ),
    withCount(
      'cycle_count_hygiene',
      'Cycle count hygiene',
      'A-items stale counts or large variance.',
      '/dashboard/resolution-queue?type=cycle_count_hygiene',
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
        ? `Backorder rate ${(Math.round((backorderRate ?? 0) * 1000) / 10).toFixed(1)}%`
        : 'No shipments in the selected window.',
      drilldownTo: '/shipments',
      formula: fillMeasured
        ? 'FillRate = shippedQty / requestedQty. BackorderRate = 1 - FillRate.'
        : 'Not measurable when requestedQty = 0.',
      queryHint: 'Measured using /kpis/fulfillment-fill-rate.',
      sources: ['/kpis/fulfillment-fill-rate'],
    },
  ]

  return signals.map((signal) => ({ ...signal, helper: `${signal.helper} As of ${input.asOfLabel}.` }))
}

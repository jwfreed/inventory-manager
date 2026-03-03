import { describe, expect, it } from 'vitest'
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
import {
  buildDashboardExceptions,
  buildDashboardSignals,
  computeAvailableQty,
  deriveInventoryState,
  sortResolutionQueue,
  type ResolutionQueueRow,
} from '@features/kpis/dashboardMath'

function asLookup<T extends { id: string }>(rows: T[]) {
  return new Map(rows.map((row) => [row.id, row]))
}

describe('dashboardMath', () => {
  it('computes available quantity with allocated greater than on-hand', () => {
    const available = computeAvailableQty({
      onHandQty: 10,
      allocatedQty: 15,
      qualityHoldQty: 0,
      damagedHoldQty: 0,
    })
    expect(available).toBe(-5)
  })

  it('derives inventory state with holds and partial receipts on-order', () => {
    const row: InventorySnapshotRow = {
      itemId: 'item-1',
      locationId: 'loc-1',
      uom: 'ea',
      onHand: 25,
      reserved: 8,
      held: 3,
      rejected: 2,
      nonUsable: 5,
      available: 12,
      onOrder: 40,
      inTransit: 6,
      backordered: 4,
      inventoryPosition: 61,
    }
    const state = deriveInventoryState(row)
    expect(state.availableQty).toBe(12)
    expect(state.onOrderQty).toBe(40)
    expect(state.inTransitQty).toBe(6)
    expect(state.backorderQty).toBe(4)
  })

  it('flags negative on-hand and availability breaches as critical', () => {
    const inventoryRows: InventorySnapshotRow[] = [
      {
        itemId: 'item-a',
        locationId: 'loc-a',
        uom: 'ea',
        onHand: -2,
        reserved: 1,
        held: 0,
        rejected: 0,
        nonUsable: 0,
        available: -3,
        onOrder: 0,
        inTransit: 0,
        backordered: 3,
        inventoryPosition: -2,
      },
    ]
    const recommendations: ReplenishmentRecommendation[] = [
      {
        policyId: 'pol-1',
        itemId: 'item-a',
        locationId: 'loc-a',
        uom: 'ea',
        policyType: 'q_rop',
        inputs: {
          leadTimeDays: 5,
          reorderPointQty: 10,
          orderUpToLevelQty: null,
          orderQuantityQty: 20,
          minOrderQty: null,
          maxOrderQty: null,
        },
        inventory: inventoryRows[0],
        recommendation: {
          reorderNeeded: true,
          recommendedOrderQty: 20,
          recommendedOrderDate: null,
        },
        assumptions: [],
      },
    ]
    const items = asLookup<Item>([
      {
        id: 'item-a',
        sku: 'A-100',
        name: 'Alpha',
        type: 'finished',
        lifecycleStatus: 'Active',
      },
    ])
    const locations = asLookup<Location>([
      {
        id: 'loc-a',
        code: 'FG',
        name: 'Finished Goods',
        type: 'storage',
        active: true,
      },
    ])
    const exceptions = buildDashboardExceptions({
      inventoryRows,
      recommendations,
      purchaseOrders: [],
      workOrders: [],
      itemLookup: items,
      locationLookup: locations,
      itemMetricsLookup: new Map<string, ItemMetrics>(),
      asOf: '2026-03-03T10:00:00.000Z',
    })

    expect(exceptions.some((row) => row.type === 'negative_on_hand' && row.severity === 'critical')).toBe(true)
    expect(exceptions.some((row) => row.type === 'availability_breach' && row.severity === 'critical')).toBe(true)
  })

  it('sorts resolution queue by severity then impact then recency', () => {
    const rows: ResolutionQueueRow[] = [
      {
        id: 'watch-old',
        type: 'reorder_risk',
        severity: 'watch',
        itemLabel: 'A',
        locationLabel: 'L',
        impactScore: 2,
        occurredAt: '2026-03-01T00:00:00.000Z',
        recommendedAction: 'x',
        primaryLink: '/x',
      },
      {
        id: 'critical-low',
        type: 'negative_on_hand',
        severity: 'critical',
        itemLabel: 'B',
        locationLabel: 'L',
        impactScore: 1,
        occurredAt: '2026-03-01T00:00:00.000Z',
        recommendedAction: 'x',
        primaryLink: '/x',
      },
      {
        id: 'critical-high',
        type: 'negative_on_hand',
        severity: 'critical',
        itemLabel: 'C',
        locationLabel: 'L',
        impactScore: 10,
        occurredAt: '2026-03-02T00:00:00.000Z',
        recommendedAction: 'x',
        primaryLink: '/x',
      },
    ]
    const sorted = sortResolutionQueue(rows)
    expect(sorted.map((row) => row.id)).toEqual(['critical-high', 'critical-low', 'watch-old'])
  })

  it('builds fulfillment reliability signal with not measurable fallback', () => {
    const signals = buildDashboardSignals({
      exceptions: [],
      fillRate: {
        metricName: 'Fulfillment Fill Rate (measured)',
        shippedQty: 0,
        requestedQty: 0,
        fillRate: null,
        window: { from: null, to: null },
        assumptions: ['No shipped order lines in the window; fill rate not measurable.'],
      } satisfies FulfillmentFillRate,
      asOfLabel: 'Mar 3, 2026 10:00',
    })
    const reliability = signals.find((signal) => signal.type === 'fulfillment_reliability')
    expect(reliability?.value).toBe('Not measurable yet')
    expect(reliability?.severity).toBe('info')
  })

  it('creates cycle count hygiene exceptions for stale A items', () => {
    const items = asLookup<Item>([
      {
        id: 'item-a',
        sku: 'A-100',
        name: 'Alpha',
        type: 'finished',
        lifecycleStatus: 'Active',
        abcClass: 'A',
      },
    ])
    const metrics = new Map<string, ItemMetrics>([
      [
        'item-a',
        {
          itemId: 'item-a',
          windowDays: 90,
          orderedQty: 100,
          shippedQty: 90,
          fillRate: 0.9,
          stockoutRate: 0.1,
          totalOutflowQty: 10,
          avgOnHandQty: 5,
          turns: 2,
          doiDays: 45,
          lastCountAt: '2020-01-01T00:00:00.000Z',
          lastCountVarianceQty: 5,
          lastCountVariancePct: 0.02,
        },
      ],
    ])
    const exceptions = buildDashboardExceptions({
      inventoryRows: [],
      recommendations: [],
      purchaseOrders: [] as PurchaseOrder[],
      workOrders: [] as WorkOrder[],
      itemLookup: items,
      locationLookup: new Map<string, Location>(),
      itemMetricsLookup: metrics,
      asOf: '2026-03-03T10:00:00.000Z',
    })

    expect(exceptions.some((row) => row.type === 'cycle_count_hygiene')).toBe(true)
  })
})

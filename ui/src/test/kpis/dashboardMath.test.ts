import { describe, expect, it } from 'vitest'
import type {
  FulfillmentFillRate,
  InventorySnapshotRow,
  Item,
  Location,
  PurchaseOrder,
} from '@api/types'
import type { ItemMetrics } from '@features/items/api/items'
import {
  buildDashboardExceptions,
  buildDashboardSignals,
  computeAvailableQty,
  dedupeResolutionQueue,
  deriveAttentionState,
  deriveCoverageState,
  deriveInventoryState,
  parseTime,
  resolveWarehouseId,
  sortResolutionQueue,
  withQuery,
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

  it('triggers availability breach when policy scope exists even without recommendation rows', () => {
    const inventoryRows: InventorySnapshotRow[] = [
      {
        itemId: 'item-a',
        locationId: 'loc-a',
        uom: 'ea',
        onHand: 0,
        reserved: 0,
        held: 0,
        rejected: 0,
        nonUsable: 0,
        available: 0,
        onOrder: 0,
        inTransit: 0,
        backordered: 0,
        inventoryPosition: 0,
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
      recommendations: [],
      policyScopeSet: new Set(['item-a:loc-a']),
      purchaseOrders: [],
      workOrders: [],
      itemLookup: items,
      locationLookup: locations,
      itemMetricsLookup: new Map<string, ItemMetrics>(),
      asOf: '2026-03-03T10:00:00.000Z',
    })

    expect(exceptions.some((row) => row.type === 'availability_breach' && row.severity === 'critical')).toBe(true)
  })

  it('creates allocation_integrity exception when allocated exceeds on-hand', () => {
    const inventoryRows: InventorySnapshotRow[] = [
      {
        itemId: 'item-a',
        locationId: 'loc-a',
        uom: 'ea',
        onHand: 5,
        reserved: 9,
        held: 0,
        rejected: 0,
        nonUsable: 0,
        available: -4,
        onOrder: 0,
        inTransit: 0,
        backordered: 2,
        inventoryPosition: 5,
      },
    ]
    const exceptions = buildDashboardExceptions({
      inventoryRows,
      recommendations: [],
      policyScopeSet: new Set(),
      purchaseOrders: [],
      workOrders: [],
      itemLookup: asLookup<Item>([
        {
          id: 'item-a',
          sku: 'A-100',
          name: 'Alpha',
          type: 'finished',
          lifecycleStatus: 'Active',
        },
      ]),
      locationLookup: asLookup<Location>([
        {
          id: 'loc-a',
          code: 'FG',
          name: 'Finished Goods',
          type: 'storage',
          active: true,
        },
      ]),
      itemMetricsLookup: new Map<string, ItemMetrics>(),
      asOf: '2026-03-03T10:00:00.000Z',
    })

    expect(exceptions.some((row) => row.type === 'allocation_integrity' && row.severity === 'critical')).toBe(true)
  })

  it('evaluates negative on-hand even when replenishment policies are missing', () => {
    const exceptions = buildDashboardExceptions({
      inventoryRows: [
        {
          itemId: 'item-a',
          locationId: 'loc-a',
          uom: 'ea',
          onHand: -1,
          reserved: 0,
          held: 0,
          rejected: 0,
          nonUsable: 0,
          available: -1,
          onOrder: 0,
          inTransit: 0,
          backordered: 0,
          inventoryPosition: -1,
        },
      ],
      recommendations: [],
      policyScopeSet: new Set(),
      purchaseOrders: [],
      workOrders: [],
      itemLookup: asLookup<Item>([
        {
          id: 'item-a',
          sku: 'A-100',
          name: 'Alpha',
          type: 'finished',
          lifecycleStatus: 'Active',
        },
      ]),
      locationLookup: asLookup<Location>([
        {
          id: 'loc-a',
          code: 'FG',
          name: 'Finished Goods',
          type: 'storage',
          active: true,
        },
      ]),
      itemMetricsLookup: new Map<string, ItemMetrics>(),
      asOf: '2026-03-03T10:00:00.000Z',
    })

    expect(exceptions.some((row) => row.type === 'negative_on_hand')).toBe(true)
  })

  it('uses real PO timestamps for inbound aging occurredAt', () => {
    const pos: PurchaseOrder[] = [
      {
        id: 'po-submitted',
        poNumber: 'PO-100',
        status: 'submitted',
        vendorId: 'vendor-1',
        shipToLocationId: 'loc-a',
        orderDate: '2026-02-20',
        createdAt: '2026-02-20T08:00:00.000Z',
      },
      {
        id: 'po-overdue',
        poNumber: 'PO-200',
        status: 'approved',
        vendorId: 'vendor-1',
        shipToLocationId: 'loc-a',
        orderDate: '2026-02-10',
        createdAt: '2026-02-10T08:00:00.000Z',
        expectedDate: '2026-02-22T00:00:00.000Z',
      },
    ]

    const exceptions = buildDashboardExceptions({
      inventoryRows: [],
      recommendations: [],
      policyScopeSet: new Set(),
      purchaseOrders: pos,
      workOrders: [],
      itemLookup: new Map<string, Item>(),
      locationLookup: asLookup<Location>([
        { id: 'loc-a', code: 'FG', name: 'Finished Goods', type: 'storage', active: true },
      ]),
      itemMetricsLookup: new Map<string, ItemMetrics>(),
      asOf: '2026-03-03T10:00:00.000Z',
    })

    const submitted = exceptions.find((row) => row.id === 'inbound-submitted:po-submitted')
    const overdue = exceptions.find((row) => row.id === 'inbound-overdue:po-overdue')

    expect(submitted?.occurredAt).toBe('2026-02-20T08:00:00.000Z')
    expect(overdue?.occurredAt).toBe('2026-02-22T00:00:00.000Z')
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

  it('returns all_clear when inventory monitoring is configured even if shipments are absent', () => {
    const coverage = deriveCoverageState({
      inventoryRows: [
        {
          itemId: 'item-1',
          locationId: 'loc-1',
          uom: 'ea',
          onHand: 10,
          reserved: 0,
          held: 0,
          rejected: 0,
          nonUsable: 0,
          available: 10,
          onOrder: 0,
          inTransit: 0,
          backordered: 0,
          inventoryPosition: 10,
        },
      ],
      policies: [],
      items: [],
      itemMetrics: [],
      fillRate: {
        metricName: 'Fulfillment Fill Rate (measured)',
        shippedQty: 0,
        requestedQty: 0,
        fillRate: null,
        window: { from: null, to: null },
        assumptions: [],
      },
    })
    expect(coverage.reliabilityMeasurable).toBe(false)
    expect(deriveAttentionState({ coverage, exceptionCount: 0 })).toBe('all_clear')
  })

  it('returns not_configured when inventory snapshot is missing', () => {
    const coverage = deriveCoverageState({
      inventoryRows: [],
      policies: [],
      items: [],
      itemMetrics: [],
      fillRate: null,
    })
    expect(coverage.inventoryMonitoringConfigured).toBe(false)
    expect(deriveAttentionState({ coverage, exceptionCount: 0 })).toBe('not_configured')
  })

  it('tracks replenishment monitoring separately from inventory monitoring', () => {
    const coverage = deriveCoverageState({
      inventoryRows: [
        {
          itemId: 'item-1',
          locationId: 'loc-1',
          uom: 'ea',
          onHand: 10,
          reserved: 0,
          held: 0,
          rejected: 0,
          nonUsable: 0,
          available: 10,
          onOrder: 0,
          inTransit: 0,
          backordered: 0,
          inventoryPosition: 10,
        },
      ],
      policies: [],
      items: [],
      itemMetrics: [],
      fillRate: null,
    })
    expect(coverage.inventoryMonitoringConfigured).toBe(true)
    expect(coverage.replenishmentMonitoringConfigured).toBe(false)
  })

  it('builds stable query params and omits empty values', () => {
    const url = withQuery('/items', {
      warehouseId: 'wh-1',
      itemId: 'item-1',
      empty: '',
      ignored: undefined,
      nullable: null,
    })
    expect(url).toBe('/items?itemId=item-1&warehouseId=wh-1')
  })

  it('parses timestamps safely and returns 0 for invalid values', () => {
    expect(parseTime('invalid-date')).toBe(0)
    expect(parseTime(undefined)).toBe(0)
    expect(parseTime('2026-03-03T10:00:00.000Z')).toBeGreaterThan(0)
  })

  it('resolves warehouse id from parent link or warehouse row fallback', () => {
    const lookup = asLookup<Location>([
      {
        id: 'loc-1',
        code: 'BIN-1',
        name: 'Bin 1',
        type: 'storage',
        warehouseId: 'wh-parent',
        active: true,
      },
      {
        id: 'wh-1',
        code: 'WH1',
        name: 'Main',
        type: 'warehouse',
        active: true,
      },
    ])
    expect(resolveWarehouseId(undefined, lookup)).toBeNull()
    expect(resolveWarehouseId('loc-1', lookup)).toBe('wh-parent')
    expect(resolveWarehouseId('wh-1', lookup)).toBe('wh-1')
  })

  it('dedupes by id and consolidates duplicate availability rows only', () => {
    const rows: ResolutionQueueRow[] = [
      {
        id: 'dup',
        type: 'negative_on_hand',
        severity: 'critical',
        itemLabel: 'A',
        itemId: 'item-a',
        locationLabel: 'L1',
        locationId: 'loc-1',
        impactScore: 1,
        occurredAt: '2026-03-01T00:00:00.000Z',
        recommendedAction: 'x',
        primaryLink: '/x',
      },
      {
        id: 'dup',
        type: 'negative_on_hand',
        severity: 'critical',
        itemLabel: 'A',
        itemId: 'item-a',
        locationLabel: 'L1',
        locationId: 'loc-1',
        impactScore: 5,
        occurredAt: '2026-03-02T00:00:00.000Z',
        recommendedAction: 'x',
        primaryLink: '/x',
      },
      {
        id: 'availability-custom-a',
        type: 'availability_breach',
        severity: 'critical',
        itemLabel: 'A',
        itemId: 'item-a',
        locationLabel: 'L1',
        locationId: 'loc-1',
        uom: 'ea',
        impactScore: 2,
        occurredAt: '2026-03-01T00:00:00.000Z',
        recommendedAction: 'x',
        primaryLink: '/items/item-a?type=availability_breach',
      },
      {
        id: 'availability-custom-b',
        type: 'availability_breach',
        severity: 'critical',
        itemLabel: 'A',
        itemId: 'item-a',
        locationLabel: 'L1',
        locationId: 'loc-1',
        uom: 'ea',
        impactScore: 10,
        occurredAt: '2026-03-03T00:00:00.000Z',
        recommendedAction: 'x',
        primaryLink: '/items/item-a?type=availability_breach&second=1',
      },
      {
        id: 'reorder:item-a',
        type: 'reorder_risk',
        severity: 'watch',
        itemLabel: 'A',
        itemId: 'item-a',
        locationLabel: 'L1',
        locationId: 'loc-1',
        impactScore: 3,
        occurredAt: '2026-03-03T00:00:00.000Z',
        recommendedAction: 'x',
        primaryLink: '/purchase-orders/new',
      },
    ]

    const deduped = dedupeResolutionQueue(rows)
    expect(deduped.filter((row) => row.id === 'dup')).toHaveLength(1)
    expect(
      deduped.filter((row) => row.type === 'availability_breach' && row.itemId === 'item-a' && row.locationId === 'loc-1'),
    ).toHaveLength(1)
    expect(
      deduped.find((row) => row.type === 'availability_breach' && row.itemId === 'item-a' && row.locationId === 'loc-1')
        ?.impactScore,
    ).toBe(10)
    expect(deduped.some((row) => row.type === 'reorder_risk')).toBe(true)
  })

  it('does not dedupe availability breaches across different uom', () => {
    const rows: ResolutionQueueRow[] = [
      {
        id: 'availability-a',
        type: 'availability_breach',
        severity: 'critical',
        itemLabel: 'A',
        itemId: 'item-a',
        locationLabel: 'L1',
        locationId: 'loc-1',
        uom: 'ea',
        impactScore: 6,
        occurredAt: '2026-03-01T00:00:00.000Z',
        recommendedAction: 'x',
        primaryLink: '/items/item-a?type=availability_breach',
      },
      {
        id: 'availability-b',
        type: 'availability_breach',
        severity: 'critical',
        itemLabel: 'A',
        itemId: 'item-a',
        locationLabel: 'L1',
        locationId: 'loc-1',
        uom: 'case',
        impactScore: 8,
        occurredAt: '2026-03-02T00:00:00.000Z',
        recommendedAction: 'x',
        primaryLink: '/items/item-a?type=availability_breach',
      },
    ]

    const deduped = dedupeResolutionQueue(rows)
    expect(deduped.filter((row) => row.type === 'availability_breach')).toHaveLength(2)
  })

  it('does not consolidate availability breaches when uom is blank', () => {
    const rows: ResolutionQueueRow[] = [
      {
        id: 'availability-blank-a',
        type: 'availability_breach',
        severity: 'critical',
        itemLabel: 'A',
        itemId: 'item-a',
        locationLabel: 'L1',
        locationId: 'loc-1',
        uom: '   ',
        impactScore: 6,
        occurredAt: '2026-03-01T00:00:00.000Z',
        recommendedAction: 'x',
        primaryLink: '/items/item-a?type=availability_breach',
      },
      {
        id: 'availability-blank-b',
        type: 'availability_breach',
        severity: 'critical',
        itemLabel: 'A',
        itemId: 'item-a',
        locationLabel: 'L1',
        locationId: 'loc-1',
        uom: '',
        impactScore: 8,
        occurredAt: '2026-03-02T00:00:00.000Z',
        recommendedAction: 'x',
        primaryLink: '/items/item-a?type=availability_breach',
      },
    ]

    const deduped = dedupeResolutionQueue(rows)
    expect(deduped.filter((row) => row.type === 'availability_breach')).toHaveLength(2)
  })

  it('consolidates availability breaches when uom differs only by surrounding whitespace', () => {
    const rows: ResolutionQueueRow[] = [
      {
        id: 'availability-trim-a',
        type: 'availability_breach',
        severity: 'critical',
        itemLabel: 'A',
        itemId: 'item-a',
        locationLabel: 'L1',
        locationId: 'loc-1',
        uom: 'ea',
        impactScore: 3,
        occurredAt: '2026-03-01T00:00:00.000Z',
        recommendedAction: 'x',
        primaryLink: '/items/item-a?type=availability_breach',
      },
      {
        id: 'availability-trim-b',
        type: 'availability_breach',
        severity: 'critical',
        itemLabel: 'A',
        itemId: 'item-a',
        locationLabel: 'L1',
        locationId: 'loc-1',
        uom: '  ea  ',
        impactScore: 9,
        occurredAt: '2026-03-02T00:00:00.000Z',
        recommendedAction: 'x',
        primaryLink: '/items/item-a?type=availability_breach',
      },
    ]

    const deduped = dedupeResolutionQueue(rows)
    expect(deduped.filter((row) => row.type === 'availability_breach')).toHaveLength(1)
    expect(deduped[0]?.id).toBe('availability-trim-b')
  })

  it('describes unfilled rate as proxy and never states backorder rate equals 1-fill rate', () => {
    const signals = buildDashboardSignals({
      exceptions: [],
      fillRate: {
        metricName: 'Fulfillment Fill Rate (measured)',
        shippedQty: 90,
        requestedQty: 100,
        fillRate: 0.9,
        window: { from: null, to: null },
        assumptions: [],
      } satisfies FulfillmentFillRate,
      asOfLabel: 'Mar 3, 2026 10:00',
    })
    const reliability = signals.find((signal) => signal.type === 'fulfillment_reliability')
    expect(reliability?.helper).toContain('Unfilled rate')
    expect(reliability?.formula).toContain('Unfilled rate (proxy) = 1 - FillRate.')
    expect(reliability?.helper).not.toContain('Backorder rate = 1 - fill rate')
    expect(reliability?.formula).not.toContain('Backorder rate = 1 - fill rate')
  })
})

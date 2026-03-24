import { describe, expect, it, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import DashboardPage from '@features/kpis/pages/DashboardPage'
import { renderWithQueryClient } from '../testUtils'

const { runDashboardKpisMock, useDashboardSignalsMock, useKpiRunsMock, mockKpiQueryKeys } = vi.hoisted(() => ({
  runDashboardKpisMock: vi.fn(),
  useDashboardSignalsMock: vi.fn(),
  useKpiRunsMock: vi.fn(),
  mockKpiQueryKeys: {
    runsPrefix: () => ['kpis', 'runs'] as const,
    snapshotsPrefix: () => ['kpis', 'snapshots'] as const,
    fulfillmentFillRatePrefix: () => ['kpis', 'fill-rate'] as const,
    replenishmentRecommendationsPrefix: () => ['planning', 'replenishment'] as const,
    replenishmentPoliciesPrefix: () => ['planning', 'replenishment-policies'] as const,
  },
}))

vi.mock('@shared/auth', () => ({
  useAuth: () => ({
    user: { id: 'user-1' },
    tenant: { id: 'tenant-1', name: 'Tenant One', slug: 'tenant-one' },
  }),
}))

vi.mock('../../features/kpis/api/kpis', () => ({
  runDashboardKpis: (...args: unknown[]) => runDashboardKpisMock(...args),
}))

vi.mock('../../features/kpis/useDashboardSignals', () => ({
  useDashboardSignals: () => useDashboardSignalsMock(),
}))

vi.mock('../../features/kpis/queries', () => ({
  useKpiRuns: (...args: unknown[]) => useKpiRunsMock(...args),
  kpisQueryKeys: mockKpiQueryKeys,
}))

function baseSignalsResponse(overrides: Record<string, unknown> = {}) {
  return {
    loading: false,
    error: undefined,
    data: {
      asOfIso: '2026-03-03T10:00:00.000Z',
      asOfLabel: 'Mar 3, 2026 10:00',
      itemLookup: new Map(),
      locationLookup: new Map(),
      warehouseLookup: new Map([['warehouse-1', { code: 'WH1', name: 'Main Warehouse' }]]),
      exceptions: [
        {
          id: 'ex-1',
          type: 'reorder_risk',
          severity: 'watch',
          itemLabel: 'A-100 - Alpha',
          itemId: 'item-1',
          locationLabel: 'FG - Finished Goods',
          locationId: 'loc-1',
          warehouseId: 'warehouse-1',
          impactScore: 3,
          occurredAt: '2026-03-03T09:00:00.000Z',
          recommendedAction: 'Create PO',
          primaryLink: '/purchase-orders/new?itemId=item-1',
        },
      ],
      signals: [
        {
          key: 'reorder_risk',
          label: 'Reorder risks',
          type: 'reorder_risk',
          severity: 'watch',
          value: '1',
          helper: 'One reorder risk',
          count: 1,
          drilldownTo: '/dashboard/resolution-queue?type=reorder_risk',
          formula: 'x',
          sources: [],
          queryHint: 'x',
        },
        {
          key: 'fulfillment_reliability',
          label: 'Fulfillment reliability',
          type: 'fulfillment_reliability',
          severity: 'info',
          value: '99.0%',
          helper: 'stable',
          count: 1,
          drilldownTo: '/shipments',
          formula: 'x',
          sources: [],
          queryHint: 'x',
        },
      ],
      coverage: {
        hasInventoryRows: true,
        hasReplenishmentPolicies: true,
        hasDemandSignal: true,
        hasCycleCountProgram: true,
        hasShipmentsInWindow: true,
        inventoryMonitoringConfigured: true,
        replenishmentMonitoringConfigured: true,
        cycleCountMonitoringConfigured: true,
        reliabilityMeasurable: true,
      },
      uomDiagnosticGroupBuckets: {
        actionGroups: 0,
        watchGroups: 0,
        totalGroups: 0,
      },
      ...overrides,
    },
  }
}

beforeEach(() => {
  runDashboardKpisMock.mockReset()
  runDashboardKpisMock.mockResolvedValue({
    runId: 'run-2',
    reused: false,
    computedAt: '2026-03-03T11:00:00.000Z',
    asOf: '2026-03-03T11:00:00.000Z',
    warehouseId: 'warehouse-1',
    runtimeMs: 1000,
    runtimeEstimateSeconds: 2,
    snapshotsWritten: 8,
  })

  useDashboardSignalsMock.mockReset()
  useDashboardSignalsMock.mockReturnValue(baseSignalsResponse())

  useKpiRunsMock.mockReset()
  useKpiRunsMock.mockReturnValue({
    data: {
      type: 'success',
      data: [
        {
          id: 'run-1',
          status: 'published',
          as_of: '2026-03-03T09:00:00.000Z',
          notes: JSON.stringify({
            source: 'dashboard_compute',
            warehouseId: 'warehouse-1',
            fingerprint: 'dashboard-v2|tenant-1|warehouse-1|window:90|scope:auto',
          }),
        },
      ],
    },
    refetch: vi.fn(),
  })
})

describe('DashboardPage', () => {
  it('shows human-readable warehouse scope label when warehouse id is present', () => {
    renderWithQueryClient(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    )

    expect(screen.getByText('Warehouse scope: WH1 — Main Warehouse')).toBeInTheDocument()
    expect(screen.getByText('FG - Finished Goods — WH1')).toBeInTheDocument()
  })

  it('shows all-clear banner plus replenishment warning when replenishment monitoring is not configured', () => {
    useDashboardSignalsMock.mockReturnValue(
      baseSignalsResponse({
        exceptions: [],
        signals: [
          {
            key: 'fulfillment_reliability',
            label: 'Fulfillment reliability',
            type: 'fulfillment_reliability',
            severity: 'info',
            value: 'Not measurable yet',
            helper: 'x',
            count: 0,
            drilldownTo: '/shipments',
            formula: 'x',
            sources: [],
            queryHint: 'x',
          },
        ],
        coverage: {
          hasInventoryRows: true,
          hasReplenishmentPolicies: false,
          hasDemandSignal: true,
          hasCycleCountProgram: true,
          hasShipmentsInWindow: false,
          inventoryMonitoringConfigured: true,
          replenishmentMonitoringConfigured: false,
          cycleCountMonitoringConfigured: true,
          reliabilityMeasurable: false,
        },
      }),
    )

    renderWithQueryClient(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    )

    expect(screen.getAllByText('All clear').length).toBeGreaterThan(0)
    expect(screen.getByText('Replenishment monitoring not configured')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Configure replenishment policies' })).toHaveAttribute('href', '/replenishment-policies?source=dashboard')
  })

  it('uses replenishment policy route for replenishment monitoring CTAs', () => {
    useDashboardSignalsMock.mockReturnValue(
      baseSignalsResponse({
        exceptions: [],
        signals: [
          {
            key: 'fulfillment_reliability',
            label: 'Fulfillment reliability',
            type: 'fulfillment_reliability',
            severity: 'info',
            value: 'Not measurable yet',
            helper: 'x',
            count: 0,
            drilldownTo: '/shipments',
            formula: 'x',
            sources: [],
            queryHint: 'x',
          },
        ],
        coverage: {
          hasInventoryRows: false,
          hasReplenishmentPolicies: false,
          hasDemandSignal: false,
          hasCycleCountProgram: false,
          hasShipmentsInWindow: false,
          inventoryMonitoringConfigured: false,
          replenishmentMonitoringConfigured: false,
          cycleCountMonitoringConfigured: false,
          reliabilityMeasurable: false,
        },
      }),
    )

    renderWithQueryClient(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    )

    expect(screen.getByRole('link', { name: 'Configure replenishment policies' })).toHaveAttribute('href', '/replenishment-policies?source=dashboard')
    expect(screen.getByRole('link', { name: 'Set ABC / cycle count policy' })).toHaveAttribute('href', '/items')
    expect(screen.getByRole('link', { name: 'Select warehouse scope' })).toHaveAttribute('href', '/items')
  })

  it('keeps watch-level UOM diagnostics visible but non-blocking', () => {
    useDashboardSignalsMock.mockReturnValue(
      baseSignalsResponse({
        exceptions: [
          {
            id: 'uom-watch-1',
            type: 'uom_inconsistent',
            severity: 'watch',
            itemLabel: 'A-100 - Alpha',
            itemId: 'item-1',
            locationLabel: 'FG - Finished Goods',
            locationId: 'loc-1',
            warehouseId: 'warehouse-1',
            impactScore: 2,
            occurredAt: '2026-03-03T09:00:00.000Z',
            recommendedAction: 'Review legacy conversion fallback.',
            primaryLink: '/items/item-1?type=uom_inconsistent',
          },
        ],
        signals: [
          {
            key: 'uom_inconsistent',
            label: 'UOM inconsistent',
            type: 'uom_inconsistent',
            severity: 'watch',
            value: '1',
            helper: 'watch-only uom diagnostic',
            count: 1,
            drilldownTo: '/dashboard/resolution-queue?type=uom_inconsistent',
            formula: 'x',
            sources: [],
            queryHint: 'x',
          },
          {
            key: 'fulfillment_reliability',
            label: 'Fulfillment reliability',
            type: 'fulfillment_reliability',
            severity: 'info',
            value: '99.0%',
            helper: 'stable',
            count: 1,
            drilldownTo: '/shipments',
            formula: 'x',
            sources: [],
            queryHint: 'x',
          },
        ],
        uomDiagnosticGroupBuckets: {
          actionGroups: 0,
          watchGroups: 1,
          totalGroups: 1,
        },
      }),
    )

    renderWithQueryClient(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    )

    expect(screen.getAllByText('All clear').length).toBeGreaterThan(0)
    expect(screen.getByText('A-100 - Alpha')).toBeInTheDocument()
  })

  it('treats action-level UOM diagnostics as blocking attention', () => {
    useDashboardSignalsMock.mockReturnValue(
      baseSignalsResponse({
        exceptions: [
          {
            id: 'uom-action-1',
            type: 'uom_inconsistent',
            severity: 'action',
            itemLabel: 'A-100 - Alpha',
            itemId: 'item-1',
            locationLabel: 'FG - Finished Goods',
            locationId: 'loc-1',
            warehouseId: 'warehouse-1',
            impactScore: 3,
            occurredAt: '2026-03-03T09:00:00.000Z',
            recommendedAction: 'Set stock UOM and conversion policy.',
            primaryLink: '/items/item-1?type=uom_inconsistent',
          },
        ],
        signals: [
          {
            key: 'uom_inconsistent',
            label: 'UOM inconsistent',
            type: 'uom_inconsistent',
            severity: 'action',
            value: '1',
            helper: 'blocking uom diagnostic',
            count: 1,
            drilldownTo: '/dashboard/resolution-queue?type=uom_inconsistent',
            formula: 'x',
            sources: [],
            queryHint: 'x',
          },
          {
            key: 'fulfillment_reliability',
            label: 'Fulfillment reliability',
            type: 'fulfillment_reliability',
            severity: 'info',
            value: '99.0%',
            helper: 'stable',
            count: 1,
            drilldownTo: '/shipments',
            formula: 'x',
            sources: [],
            queryHint: 'x',
          },
        ],
        uomDiagnosticGroupBuckets: {
          actionGroups: 1,
          watchGroups: 0,
          totalGroups: 1,
        },
      }),
    )

    renderWithQueryClient(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    )

    expect(screen.getByRole('link', { name: 'Resolve all' })).toBeInTheDocument()
  })

  it('invalidates dependent query-key prefixes after KPI run success', async () => {
    const rendered = renderWithQueryClient(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    )
    const invalidateSpy = vi.spyOn(rendered.queryClient, 'invalidateQueries')

    fireEvent.click(screen.getByRole('button', { name: 'Run KPI calculations' }))

    await waitFor(() => {
      expect(runDashboardKpisMock).toHaveBeenCalled()
    })

    const calledWith = (queryKey: readonly unknown[]) =>
      invalidateSpy.mock.calls.some(
        ([arg]) => JSON.stringify((arg as { queryKey?: readonly unknown[] }).queryKey) === JSON.stringify(queryKey),
      )

    await waitFor(() => {
      expect(calledWith(mockKpiQueryKeys.runsPrefix())).toBe(true)
      expect(calledWith(mockKpiQueryKeys.snapshotsPrefix())).toBe(true)
      expect(calledWith(mockKpiQueryKeys.fulfillmentFillRatePrefix())).toBe(true)
      expect(calledWith(mockKpiQueryKeys.replenishmentRecommendationsPrefix())).toBe(true)
      expect(calledWith(mockKpiQueryKeys.replenishmentPoliciesPrefix())).toBe(true)
    })
  })
})

import { describe, expect, it } from 'vitest'
import type { KpiRun } from '@api/types'
import {
  buildDashboardIdempotencyKey,
  buildDashboardModeStorageKey,
  readDashboardModeFromStorage,
  resolveWarehouseScopeLabel,
  selectLastSuccessfulRun,
} from '@features/kpis/dashboardPageUtils'

describe('dashboardPageUtils', () => {
  it('builds idempotency key with tenant, warehouse, and window scope', () => {
    const key = buildDashboardIdempotencyKey({
      tenantId: 'tenant-1',
      warehouseId: 'warehouse-1',
      windowDays: 90,
      now: new Date('2026-03-03T10:00:00.000Z'),
    })
    expect(key).toBe('dashboard:tenant-1:warehouse-1:window:90:day:2026-03-03')
  })

  it('selects last successful run and ignores failed or in-progress runs', () => {
    const runs: KpiRun[] = [
      {
        id: 'run-failed',
        status: 'failed',
        as_of: '2026-03-03T12:00:00.000Z',
      },
      {
        id: 'run-pending',
        status: 'running',
        as_of: '2026-03-03T11:00:00.000Z',
      },
      {
        id: 'run-success-old',
        status: 'published',
        as_of: '2026-03-02T11:00:00.000Z',
      },
      {
        id: 'run-success-new',
        status: 'computed',
        as_of: '2026-03-03T09:00:00.000Z',
      },
    ]
    expect(selectLastSuccessfulRun(runs)?.id).toBe('run-success-new')
  })

  it('initial mode resolves from per-user storage key first', () => {
    const perUserKey = buildDashboardModeStorageKey('tenant-1', 'user-1')
    window.localStorage.setItem('dashboard:mode', 'all')
    window.localStorage.setItem(perUserKey, 'actionable')
    expect(readDashboardModeFromStorage(perUserKey)).toBe('actionable')
  })

  it('formats warehouse scope with human-readable code and name', () => {
    const lookup = new Map<string, { code?: string; name?: string }>([
      ['warehouse-1', { code: 'WH1', name: 'Main Warehouse' }],
    ])
    const display = resolveWarehouseScopeLabel({
      warehouseId: 'warehouse-1',
      warehouseLookup: lookup,
    })
    expect(display.label).toBe('WH1 — Main Warehouse')
    expect(display.rawId).toBe('warehouse-1')
  })
})

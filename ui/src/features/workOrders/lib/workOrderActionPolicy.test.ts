import { describe, expect, it } from 'vitest'
import {
  canCancelWorkOrder,
  canCloseWorkOrder,
  canQuickCancelWorkOrder,
  getExecutionLockedReason,
  getWorkOrderActionPolicy,
  isExecutionLockedWorkOrder,
} from './workOrderActionPolicy'

describe('workOrderActionPolicy', () => {
  it('enforces the cancel matrix across every work order status', () => {
    const expectations = [
      { status: 'draft', canCancel: true, locked: false },
      { status: 'ready', canCancel: true, locked: false },
      { status: 'in_progress', canCancel: false, locked: false },
      { status: 'partially_completed', canCancel: false, locked: false },
      { status: 'completed', canCancel: false, locked: true },
      { status: 'closed', canCancel: false, locked: true },
      { status: 'canceled', canCancel: false, locked: true },
    ] as const

    expectations.forEach(({ status, canCancel, locked }) => {
      expect(canCancelWorkOrder(status)).toBe(canCancel)
      expect(canQuickCancelWorkOrder(status)).toBe(canCancel)
      expect(isExecutionLockedWorkOrder(status)).toBe(locked)
    })
  })

  it('locks execution for terminal work orders only', () => {
    expect(isExecutionLockedWorkOrder('completed')).toBe(true)
    expect(isExecutionLockedWorkOrder('closed')).toBe(true)
    expect(isExecutionLockedWorkOrder('canceled')).toBe(true)
    expect(isExecutionLockedWorkOrder('ready')).toBe(false)
    expect(getExecutionLockedReason('completed')).toContain('Execution is locked')
  })

  it('allows close only for completed work orders', () => {
    expect(canCloseWorkOrder('completed')).toBe(true)
    expect(canCloseWorkOrder('ready')).toBe(false)
  })

  it('blocks recent void when scrap was posted or the work order is terminal', () => {
    expect(
      getWorkOrderActionPolicy(
        { status: 'ready' },
        {
          workOrderExecutionId: 'exec-1',
          productionReportId: 'exec-1',
          scrapPosted: false,
        },
      ).canVoidRecentReport,
    ).toBe(true)

    expect(
      getWorkOrderActionPolicy(
        { status: 'ready' },
        {
          workOrderExecutionId: 'exec-1',
          productionReportId: 'exec-1',
          scrapPosted: true,
        },
      ).canVoidRecentReport,
    ).toBe(false)

    expect(
      getWorkOrderActionPolicy(
        { status: 'completed' },
        {
          workOrderExecutionId: 'exec-1',
          productionReportId: 'exec-1',
          scrapPosted: false,
        },
      ).canVoidRecentReport,
    ).toBe(false)
  })

  it('blocks recent void when the recent report context is incomplete', () => {
    expect(
      getWorkOrderActionPolicy(
        { status: 'ready' },
        {
          workOrderExecutionId: '',
          productionReportId: 'report-1',
          scrapPosted: false,
        },
      ).canVoidRecentReport,
    ).toBe(false)
  })
})

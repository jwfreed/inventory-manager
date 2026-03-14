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
  it('allows cancel and quick cancel for draft and ready only', () => {
    expect(canCancelWorkOrder('draft')).toBe(true)
    expect(canQuickCancelWorkOrder('draft')).toBe(true)
    expect(canCancelWorkOrder('ready')).toBe(true)
    expect(canQuickCancelWorkOrder('ready')).toBe(true)
    expect(canCancelWorkOrder('in_progress')).toBe(false)
    expect(canCancelWorkOrder('partially_completed')).toBe(false)
    expect(canCancelWorkOrder('completed')).toBe(false)
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
})

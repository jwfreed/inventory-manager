import { describe, expect, it } from 'vitest'
import type { Movement } from '@api/types'
import {
  getWorkOrderOperationalHistoryItems,
  isWorkOrderOperationalMovementFor,
} from './workOrderOperationalHistory'

function makeMovement(overrides: Partial<Movement> = {}): Movement {
  return {
    id: overrides.id ?? 'movement-1',
    movementType: overrides.movementType ?? 'issue',
    status: overrides.status ?? 'posted',
    occurredAt: overrides.occurredAt ?? '2026-03-14T09:00:00.000Z',
    postedAt: overrides.postedAt ?? '2026-03-14T09:01:00.000Z',
    externalRef: overrides.externalRef ?? 'work_order_batch_issue:exec-1:wo-1',
    notes: overrides.notes ?? null,
    metadata: overrides.metadata ?? { workOrderId: 'wo-1' },
    ...overrides,
  }
}

describe('workOrderOperationalHistory', () => {
  it('matches known work-order movement families using embedded work order ids', () => {
    expect(
      isWorkOrderOperationalMovementFor(
        makeMovement({ externalRef: 'work_order_batch_completion:exec-1:wo-1' }),
        'wo-1',
      ),
    ).toBe(true)

    expect(
      isWorkOrderOperationalMovementFor(
        makeMovement({ externalRef: 'inventory_adjustment:adj-1', metadata: {} }),
        'wo-1',
      ),
    ).toBe(false)
  })

  it('sorts operational history by occurredAt, then postedAt, then id', () => {
    const items = getWorkOrderOperationalHistoryItems(
      [
        makeMovement({
          id: 'movement-b',
          occurredAt: '',
          postedAt: '2026-03-14T12:00:00.000Z',
          externalRef: 'work_order_batch_completion:exec-1:wo-1',
        }),
        makeMovement({
          id: 'movement-c',
          occurredAt: '',
          postedAt: '',
          externalRef: 'work_order_batch_void_output:exec-1:wo-1',
        }),
        makeMovement({
          id: 'movement-a',
          occurredAt: '2026-03-14T13:00:00.000Z',
          externalRef: 'work_order_batch_issue:exec-1:wo-1',
        }),
      ],
      'wo-1',
    )

    expect(items.map((item) => item.id)).toEqual(['movement-a', 'movement-b', 'movement-c'])
  })
})

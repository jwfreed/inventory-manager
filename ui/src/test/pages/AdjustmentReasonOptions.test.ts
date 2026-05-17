import { describe, expect, it } from 'vitest'
import { adjustmentReasonOptions } from '@features/adjustments/types'

describe('adjustment reason options', () => {
  it('keeps transfer out of stock discrepancy reasons', () => {
    expect(adjustmentReasonOptions.map((option) => option.value)).toEqual([
      'shrinkage',
      'damage',
      'found',
      'correction',
      'other',
    ])
    expect(adjustmentReasonOptions.some((option) => /transfer/i.test(option.label))).toBe(false)
  })
})

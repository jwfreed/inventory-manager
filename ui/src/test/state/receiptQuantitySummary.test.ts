import { describe, expect, it } from 'vitest'
import type { ReceiptLineSummary } from '../../features/receiving/types'
import {
  formatReceiptQuantitySummary,
  normalizeReceiptQuantity,
} from '../../features/receiving/utils'

const summary = (lines: Array<{ uom: string; expectedQty: unknown; receivedQty: unknown }>): ReceiptLineSummary =>
  ({
    lines: lines.map((line, idx) => ({
      purchaseOrderLineId: `line-${idx + 1}`,
      lineNumber: idx + 1,
      itemLabel: `Item ${idx + 1}`,
      uom: line.uom,
      expectedQty: line.expectedQty,
      receivedQty: line.receivedQty,
      discrepancyReason: '',
      discrepancyNotes: '',
      delta: normalizeReceiptQuantity(line.receivedQty) - normalizeReceiptQuantity(line.expectedQty),
      remaining: Math.max(0, normalizeReceiptQuantity(line.expectedQty) - normalizeReceiptQuantity(line.receivedQty)),
    })),
    receivedLines: [],
    discrepancyLines: [],
    missingReasons: [],
    invalidLines: [],
    missingLotSerial: [],
    overApprovalMissing: [],
    remainingLines: [],
    totalExpected: lines.reduce((sum, line) => sum + normalizeReceiptQuantity(line.expectedQty), 0),
    totalReceived: lines.reduce((sum, line) => sum + normalizeReceiptQuantity(line.receivedQty), 0),
  }) as ReceiptLineSummary

describe('receipt quantity summary formatting', () => {
  it('groups expected and received quantities by UOM without concatenating numeric strings', () => {
    const text = formatReceiptQuantitySummary(
      summary([
        { uom: 'g', expectedQty: '30000.00000', receivedQty: '30000.00000' },
        { uom: 'g', expectedQty: '20000.00000', receivedQty: '20000.00000' },
        { uom: 'g', expectedQty: '15000.00000', receivedQty: '15000.00000' },
        { uom: 'g', expectedQty: '9500.00000', receivedQty: '9500.00000' },
        { uom: 'g', expectedQty: '1500.00000', receivedQty: '1500.00000' },
        { uom: 'each', expectedQty: '1000.00000', receivedQty: '1000.00000' },
      ]),
    )

    expect(text).toBe('76,000 g + 1,000 each ready to post')
    expect(text).not.toContain('030000.0000020000')
    expect(text).not.toContain('.00000')
  })

  it('preserves meaningful fractional quantities', () => {
    expect(
      formatReceiptQuantitySummary(
        summary([
          { uom: 'kg', expectedQty: '12.75', receivedQty: '6.5' },
        ]),
      ),
    ).toBe('6.5 of 12.75 kg received')
  })

  it('formats mixed UOM partial receipts separately', () => {
    expect(
      formatReceiptQuantitySummary(
        summary([
          { uom: 'g', expectedQty: 76000, receivedQty: 40000 },
          { uom: 'each', expectedQty: 1000, receivedQty: 500 },
        ]),
      ),
    ).toBe('40,000 of 76,000 g received · 500 of 1,000 each received')
  })
})

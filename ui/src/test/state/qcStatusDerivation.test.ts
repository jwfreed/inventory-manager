/**
 * Unit tests for getQcStatus — all six decision branches.
 *
 * These tests guard against regression in QC status label and badge variant
 * derivation. Any change that collapses distinct operational states into one
 * visual representation will fail here.
 */
import { describe, expect, it } from 'vitest'
import { getQcStatus } from '../../features/receiving/utils'
import type { PurchaseOrderReceiptLine } from '@api/types'

// Build a minimal receipt line with a qcSummary
function makeLine(
  breakdown: { accept: number; hold: number; reject: number; disposed?: number },
  remainingUninspected: number,
): PurchaseOrderReceiptLine {
  return {
    id: 'line-test',
    purchaseOrderLineId: 'pol-test',
    itemId: 'item-test',
    itemSku: 'SKU-TEST',
    itemName: 'Test Item',
    quantityReceived: breakdown.accept + breakdown.hold + breakdown.reject + remainingUninspected,
    expectedQuantity: breakdown.accept + breakdown.hold + breakdown.reject + remainingUninspected,
    uom: 'kg',
    qcSummary: {
      breakdown,
      remainingUninspectedQuantity: remainingUninspected,
    },
  } as unknown as PurchaseOrderReceiptLine
}

// Line with no qcSummary at all
function makeLineNoSummary(): PurchaseOrderReceiptLine {
  return {
    id: 'line-no-qc',
    purchaseOrderLineId: 'pol-no-qc',
    itemId: 'item-test',
    itemSku: 'SKU-TEST',
    itemName: 'Test Item',
    quantityReceived: 100,
    expectedQuantity: 100,
    uom: 'kg',
    qcSummary: null,
  } as unknown as PurchaseOrderReceiptLine
}

describe('getQcStatus', () => {
  it('returns QC not started (neutral) when no QC events have been recorded', () => {
    // No qcSummary at all
    const status = getQcStatus(makeLineNoSummary())
    expect(status.label).toBe('QC not started')
    expect(status.variant).toBe('neutral')
  })

  it('returns QC not started (neutral) when breakdown totals are zero', () => {
    const status = getQcStatus(makeLine({ accept: 0, hold: 0, reject: 0 }, 100))
    expect(status.label).toBe('QC not started')
    expect(status.variant).toBe('neutral')
  })

  it('returns QC in progress (warning) when uninspected quantity remains', () => {
    const status = getQcStatus(makeLine({ accept: 50, hold: 0, reject: 0 }, 50))
    expect(status.label).toBe('QC in progress')
    expect(status.variant).toBe('warning')
  })

  it('returns Hold unresolved (warning) when all inspected but hold is non-zero', () => {
    const status = getQcStatus(makeLine({ accept: 60, hold: 40, reject: 0 }, 0))
    expect(status.label).toBe('Hold unresolved')
    expect(status.variant).toBe('warning')
  })

  it('returns Accepted (success) when all units accepted and no holds or rejects', () => {
    const status = getQcStatus(makeLine({ accept: 100, hold: 0, reject: 0 }, 0))
    expect(status.label).toBe('Accepted')
    expect(status.variant).toBe('success')
    // Must NOT say "QC complete" — that language does not distinguish accepted from rejected
    expect(status.label).not.toBe('QC complete')
  })

  it('returns Fully rejected (danger) when all units rejected and none accepted', () => {
    const status = getQcStatus(makeLine({ accept: 0, hold: 0, reject: 100 }, 0))
    expect(status.label).toBe('Fully rejected')
    expect(status.variant).toBe('danger')
    // Must NOT return success — rejected stock must not appear green
    expect(status.variant).not.toBe('success')
    expect(status.label).not.toMatch(/complete|accepted/i)
  })

  it('returns Accepted with rejects (warning) when some accepted and some rejected', () => {
    const status = getQcStatus(makeLine({ accept: 60, hold: 0, reject: 40 }, 0))
    expect(status.label).toBe('Accepted with rejects')
    expect(status.variant).toBe('warning')
    // Must not be success — partial rejection is not a clean pass
    expect(status.variant).not.toBe('success')
    expect(status.label).not.toBe('Accepted')
  })

  it('returns Fully rejected (danger) even when disposed quantity is set', () => {
    // disposed is an optional field, should not affect the accept/reject outcome
    const status = getQcStatus(makeLine({ accept: 0, hold: 0, reject: 100, disposed: 10 }, 0))
    expect(status.label).toBe('Fully rejected')
    expect(status.variant).toBe('danger')
  })

  // Invariant: success variant must only occur when accept > 0 and reject === 0
  it('never returns success variant when any units were rejected', () => {
    const rejectScenarios = [
      makeLine({ accept: 0, hold: 0, reject: 100 }, 0),  // fully rejected
      makeLine({ accept: 50, hold: 0, reject: 50 }, 0),  // mixed
      makeLine({ accept: 1, hold: 0, reject: 99 }, 0),   // mostly rejected
    ]
    for (const line of rejectScenarios) {
      const status = getQcStatus(line)
      expect(status.variant, `expected non-success for ${JSON.stringify(line.qcSummary?.breakdown)}`).not.toBe('success')
    }
  })
})

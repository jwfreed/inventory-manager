import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QcBatchQueue } from '../../features/receiving/components/QcBatchQueue'

const buildReceipt = (id: string, remainingUninspectedQuantity: number) => ({
  id,
  purchaseOrderId: `po-${id}`,
  purchaseOrderNumber: `PO-${id}`,
  receivedAt: '2026-05-11T00:00:00Z',
  lines: [
    {
      id: `line-${id}`,
      quantityReceived: 30000,
      uom: 'g',
      qcSummary: {
        totalQcQuantity: 30000 - remainingUninspectedQuantity,
        remainingUninspectedQuantity,
      },
    },
  ],
})

const hasText = (expected: string) => (_content: string, node: Element | null) =>
  node?.textContent?.replace(/\s+/g, ' ').trim() === expected

describe('QcBatchQueue copy', () => {
  it('uses singular grammar for one receipt needing attention', () => {
    render(
      <QcBatchQueue
        receipts={[buildReceipt('one', 30000) as any]}
        onSelectReceipt={vi.fn()}
      />,
    )

    expect(screen.getByText(hasText('1 receipt needs attention'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Load next receipt' })).toBeInTheDocument()
  })

  it('uses plural grammar for multiple receipts needing attention', () => {
    render(
      <QcBatchQueue
        receipts={[
          buildReceipt('one', 30000) as any,
          buildReceipt('two', 15000) as any,
        ]}
        onSelectReceipt={vi.fn()}
      />,
    )

    expect(screen.getByText(hasText('2 receipts need attention'))).toBeInTheDocument()
  })
})

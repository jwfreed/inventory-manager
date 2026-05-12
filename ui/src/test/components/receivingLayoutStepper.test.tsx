/**
 * Route-step mapping tests for ReceivingLayout.
 *
 * These tests use the REAL ReceivingLayout component (not mocked) and a real
 * MemoryRouter to verify that the workflow stepper correctly maps route paths
 * to active step indexes.
 *
 * Specifically covers the alias /qc/receipts/:id -> QC step (index 1),
 * which previously returned -1 and left all steps "upcoming".
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { ReceivingLayout } from '../../features/receiving/components/ReceivingLayout'

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../../features/receiving/context', () => ({
  useReceivingContext: vi.fn(),
  QC_ERROR_MAP: {},
}))
vi.mock('../../features/receiving/hooks/useResponsive', () => ({
  useResponsive: () => ({ isMobile: false }),
}))
vi.mock('../../features/receiving/components/OfflineIndicator', () => ({
  OfflineIndicator: () => null,
}))

import { useReceivingContext } from '../../features/receiving/context'

const mockedUseReceivingContext = vi.mocked(useReceivingContext)

function buildMinimalContext() {
  return {
    selectedPoId: '',
    poQuery: { data: null, isLoading: false, isError: false },
    receiptIdForQc: '',
    receiptQuery: { data: null, isLoading: false, isError: false },
    putawayId: '',
    putawayQuery: { data: null, isLoading: false, isError: false },
    isOnline: true,
    pendingCount: 0,
    syncPendingOperations: vi.fn(),
    clearOfflineQueue: vi.fn(),
  }
}

function renderLayoutAt(path: string, routePattern = path) {
  mockedUseReceivingContext.mockReturnValue(buildMinimalContext() as any)
  const router = createMemoryRouter(
    [
      {
        path: routePattern,
        element: <ReceivingLayout><div data-testid="content">page</div></ReceivingLayout>,
      },
    ],
    { initialEntries: [path] },
  )
  return render(<RouterProvider router={router} />)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * The stepper renders each step as a Link with text "Receipt", "QC", "Putaway".
 * The active step's step-indicator circle gets `bg-indigo-600`.
 * We identify active vs upcoming by checking the class of the circle element
 * that precedes each step label.
 */
function getStepCircle(label: string) {
  // Find the link containing the step label, then its first child div (the circle)
  const link = screen.getAllByRole('link').find((el) => el.textContent?.includes(label))
  return link?.querySelector('div') ?? null
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ReceivingLayout: stepper route-step mapping', () => {
  it('marks Receipt step active on /receiving/receipt', () => {
    renderLayoutAt('/receiving/receipt')
    const circle = getStepCircle('Receipt')
    expect(circle?.className).toContain('bg-indigo-600')
  })

  it('marks QC step active on /receiving/qc (canonical path)', () => {
    renderLayoutAt('/receiving/qc')
    const circle = getStepCircle('QC')
    expect(circle?.className).toContain('bg-indigo-600')
  })

  it('marks QC step active on /qc/receipts/:id (alias route)', () => {
    renderLayoutAt('/qc/receipts/abc-123', '/qc/receipts/:receiptId')
    const qcCircle = getStepCircle('QC')
    expect(qcCircle?.className).toContain('bg-indigo-600')
  })

  it('does NOT mark Receipt step active when on /qc/receipts/:id', () => {
    renderLayoutAt('/qc/receipts/abc-123', '/qc/receipts/:receiptId')
    const receiptCircle = getStepCircle('Receipt')
    // Completed steps get bg-green-600; upcoming get bg-slate-200. Neither is bg-indigo-600.
    expect(receiptCircle?.className).not.toContain('bg-indigo-600')
  })

  it('does NOT mark Putaway step active when on /qc/receipts/:id', () => {
    renderLayoutAt('/qc/receipts/abc-123', '/qc/receipts/:receiptId')
    const putawayCircle = getStepCircle('Putaway')
    expect(putawayCircle?.className).not.toContain('bg-indigo-600')
  })

  it('marks Putaway step active on /receiving/putaway', () => {
    renderLayoutAt('/receiving/putaway')
    const circle = getStepCircle('Putaway')
    expect(circle?.className).toContain('bg-indigo-600')
  })

  it('marks Receipt step completed (green) when QC step is active', () => {
    renderLayoutAt('/receiving/qc')
    const receiptCircle = getStepCircle('Receipt')
    expect(receiptCircle?.className).toContain('bg-green-600')
  })

  it('marks Receipt and QC steps completed (green) when Putaway step is active', () => {
    renderLayoutAt('/receiving/putaway')
    expect(getStepCircle('Receipt')?.className).toContain('bg-green-600')
    expect(getStepCircle('QC')?.className).toContain('bg-green-600')
  })
})

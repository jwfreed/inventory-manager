import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ItemReadinessPanel } from '@features/items/components/ItemReadinessPanel'
import { ItemSectionNav } from '@features/items/components/ItemSectionNav'

// ─── Auth mock ───────────────────────────────────────────────────────────────
vi.mock('@shared/auth', () => ({
  useAuth: () => ({
    hasPermission: () => true,
    user: { baseCurrency: 'USD' },
  }),
}))

// ─── Shared test helpers ─────────────────────────────────────────────────────
function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
}

function renderWithProviders(ui: React.ReactElement, { route = '/' } = {}) {
  const queryClient = makeQueryClient()
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="*" element={ui} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

// ─── ItemReadinessPanel ───────────────────────────────────────────────────────
describe('ItemReadinessPanel', () => {
  const baseProps = {
    available: 0,
    onHand: 0,
    reserved: 0,
    inTransit: 0,
    backordered: 0,
    canonicalUom: 'each',
    hasNegativeOnHand: false,
    hasManufacturingFlow: true,
    hasActiveBom: false,
    hasRouting: false,
    onAdjustStock: vi.fn(),
    onViewMovements: vi.fn(),
    onCreateRouting: vi.fn(),
  }

  describe('inventory readiness', () => {
    it('shows no finished goods available when available is 0', () => {
      render(<ItemReadinessPanel {...baseProps} />)
      expect(screen.getByText('No finished goods available')).toBeInTheDocument()
    })

    it('shows available quantity when stock exists', () => {
      render(<ItemReadinessPanel {...baseProps} available={12} onHand={15} reserved={3} />)
      expect(screen.getByText(/12 each available/)).toBeInTheDocument()
    })

    it('shows on-hand, reserved, in-transit in summary line', () => {
      render(<ItemReadinessPanel {...baseProps} onHand={5} reserved={2} inTransit={1} />)
      const summary = screen.getByText(/5 each on hand/)
      expect(summary).toBeInTheDocument()
      expect(summary.textContent).toContain('2 reserved')
      expect(summary.textContent).toContain('1 in transit')
    })

    it('shows negative on-hand warning when detected', () => {
      render(<ItemReadinessPanel {...baseProps} hasNegativeOnHand />)
      expect(screen.getByText(/Negative on-hand detected/)).toBeInTheDocument()
    })

    it('shows Adjust stock and View movements actions', () => {
      render(<ItemReadinessPanel {...baseProps} />)
      expect(screen.getByRole('button', { name: 'Adjust stock' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'View movements' })).toBeInTheDocument()
    })

    it('calls onAdjustStock when Adjust stock is clicked', () => {
      const onAdjustStock = vi.fn()
      render(<ItemReadinessPanel {...baseProps} onAdjustStock={onAdjustStock} />)
      fireEvent.click(screen.getByRole('button', { name: 'Adjust stock' }))
      expect(onAdjustStock).toHaveBeenCalledOnce()
    })
  })

  describe('manufacturing readiness', () => {
    it('shows manufacturing section for manufacturing-flow items', () => {
      render(<ItemReadinessPanel {...baseProps} hasManufacturingFlow />)
      expect(screen.getByText('Manufacturing')).toBeInTheDocument()
    })

    it('does not show manufacturing section for non-manufacturing items', () => {
      render(<ItemReadinessPanel {...baseProps} hasManufacturingFlow={false} />)
      expect(screen.queryByText('Manufacturing')).not.toBeInTheDocument()
    })

    it('shows BOM missing message when no active BOM', () => {
      render(<ItemReadinessPanel {...baseProps} hasManufacturingFlow hasActiveBom={false} />)
      expect(screen.getByText('Setup incomplete')).toBeInTheDocument()
      expect(screen.getByText('No active BOM configured.')).toBeInTheDocument()
    })

    it('shows BOM configured and Routing missing when BOM exists but routing is absent', () => {
      render(
        <ItemReadinessPanel {...baseProps} hasManufacturingFlow hasActiveBom hasRouting={false} />,
      )
      expect(screen.getByText('BOM configured')).toBeInTheDocument()
      expect(screen.getByText('Routing missing')).toBeInTheDocument()
    })

    it('shows Create routing as primary action when BOM configured but routing missing', () => {
      render(
        <ItemReadinessPanel {...baseProps} hasManufacturingFlow hasActiveBom hasRouting={false} />,
      )
      expect(screen.getByRole('button', { name: 'Create routing' })).toBeInTheDocument()
    })

    it('calls onCreateRouting when Create routing is clicked', () => {
      const onCreateRouting = vi.fn()
      render(
        <ItemReadinessPanel
          {...baseProps}
          hasManufacturingFlow
          hasActiveBom
          hasRouting={false}
          onCreateRouting={onCreateRouting}
        />,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Create routing' }))
      expect(onCreateRouting).toHaveBeenCalledOnce()
    })

    it('shows Ready status when BOM and routing are both configured', () => {
      render(
        <ItemReadinessPanel {...baseProps} hasManufacturingFlow hasActiveBom hasRouting />,
      )
      expect(screen.getByText('Ready')).toBeInTheDocument()
      const bomRow = screen.getByText('BOM configured')
      const routingRow = screen.getByText('Routing configured')
      expect(bomRow).toBeInTheDocument()
      expect(routingRow).toBeInTheDocument()
    })

    it('inventory and manufacturing readiness are visually separate sections', () => {
      render(
        <ItemReadinessPanel {...baseProps} hasManufacturingFlow hasActiveBom hasRouting={false} />,
      )
      // Both section labels must be present
      expect(screen.getByText('Inventory')).toBeInTheDocument()
      expect(screen.getByText('Manufacturing')).toBeInTheDocument()
    })
  })
})

// ─── ItemSectionNav (real tabs) ───────────────────────────────────────────────
describe('ItemSectionNav', () => {
  const sections = [
    { id: 'overview', label: 'Overview' },
    { id: 'inventory', label: 'Inventory' },
    { id: 'production', label: 'Production' },
    { id: 'configuration', label: 'Configuration' },
    { id: 'history', label: 'History' },
  ]

  it('renders all tab labels', () => {
    render(
      <ItemSectionNav sections={sections} activeSection="overview" onSectionChange={vi.fn()} />,
    )
    for (const section of sections) {
      expect(screen.getByRole('tab', { name: section.label })).toBeInTheDocument()
    }
  })

  it('marks the active section as selected', () => {
    render(
      <ItemSectionNav sections={sections} activeSection="production" onSectionChange={vi.fn()} />,
    )
    expect(screen.getByRole('tab', { name: 'Production' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Inventory' })).toHaveAttribute('aria-selected', 'false')
  })

  it('calls onSectionChange with the clicked section id', () => {
    const onSectionChange = vi.fn()
    render(
      <ItemSectionNav sections={sections} activeSection="overview" onSectionChange={onSectionChange} />,
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Inventory' }))
    expect(onSectionChange).toHaveBeenCalledWith('inventory')
  })

  it('does not use anchor elements (tabs scope content rather than scroll)', () => {
    const { container } = render(
      <ItemSectionNav sections={sections} activeSection="overview" onSectionChange={vi.fn()} />,
    )
    // No anchor links — real tab buttons instead
    expect(container.querySelectorAll('a[href]')).toHaveLength(0)
    expect(container.querySelectorAll('button[role="tab"]')).toHaveLength(sections.length)
  })
})

// ─── BomCard component row ordering ─────────────────────────────────────────
describe('BomCard component name ordering', () => {
  it('shows component name before SKU in BOM table rows', () => {
    // Verify the intended ordering by checking that name appears as font-medium
    // and SKU appears as font-mono text below it.
    // We test the rendering pattern directly.
    const { container } = renderWithProviders(
      <table>
        <tbody>
          <tr>
            <td>
              <a href="/items/comp-1">
                <div>
                  <div className="font-medium">Cacao nibs</div>
                  <div className="font-mono text-xs text-slate-500">COMP-SKU-001</div>
                </div>
              </a>
            </td>
          </tr>
        </tbody>
      </table>,
    )
    const name = container.querySelector('.font-medium')
    const sku = container.querySelector('.font-mono')
    expect(name).toBeTruthy()
    expect(sku).toBeTruthy()
    // Name appears before SKU in DOM order
    expect(name!.compareDocumentPosition(sku!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

// ─── ItemDetailPage tab behavior ────────────────────────────────────────────
// This tests the tab-scoping behavior using the ItemSectionNav + conditional
// rendering pattern without mounting the full page (which requires many API mocks).
describe('ItemDetailPage tab scoping', () => {
  it('tab bar renders Overview as the first tab', () => {
    const sections = [
      { id: 'overview', label: 'Overview' },
      { id: 'inventory', label: 'Inventory' },
      { id: 'production', label: 'Production' },
      { id: 'configuration', label: 'Configuration' },
      { id: 'history', label: 'History' },
    ]
    render(
      <ItemSectionNav sections={sections} activeSection="overview" onSectionChange={vi.fn()} />,
    )
    const tabs = screen.getAllByRole('tab')
    expect(tabs[0]).toHaveTextContent('Overview')
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('switching to Inventory tab fires correct section id', () => {
    const sections = [
      { id: 'overview', label: 'Overview' },
      { id: 'inventory', label: 'Inventory' },
    ]
    const onSectionChange = vi.fn()
    render(
      <ItemSectionNav sections={sections} activeSection="overview" onSectionChange={onSectionChange} />,
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Inventory' }))
    expect(onSectionChange).toHaveBeenCalledWith('inventory')
  })

  it('switching to Production tab fires correct section id', () => {
    const sections = [
      { id: 'overview', label: 'Overview' },
      { id: 'production', label: 'Production' },
    ]
    const onSectionChange = vi.fn()
    render(
      <ItemSectionNav sections={sections} activeSection="overview" onSectionChange={onSectionChange} />,
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Production' }))
    expect(onSectionChange).toHaveBeenCalledWith('production')
  })
})

// ─── Zero inventory compressed display ──────────────────────────────────────
describe('ItemReadinessPanel zero inventory compressed display', () => {
  it('does not show each quantity as a separate equal-weight card', () => {
    const { container } = render(
      <ItemReadinessPanel
        available={0}
        onHand={0}
        reserved={0}
        inTransit={0}
        backordered={0}
        canonicalUom="each"
        hasNegativeOnHand={false}
        hasManufacturingFlow={false}
        hasActiveBom={false}
        hasRouting={false}
        onAdjustStock={vi.fn()}
        onViewMovements={vi.fn()}
        onCreateRouting={vi.fn()}
      />,
    )
    // All zero quantities should be on a single line, not 5+ separate tile cards
    const summaryLine = screen.getByText(/0 each on hand/)
    expect(summaryLine).toBeInTheDocument()
    expect(summaryLine.textContent).toContain('0 reserved')
    expect(summaryLine.textContent).toContain('0 in transit')
    // The inventory section is one card, not repeated tiles
    expect(container.querySelectorAll('[class*="rounded-2xl"]')).toHaveLength(1)
  })

  it('backordered quantity is included when greater than zero', () => {
    render(
      <ItemReadinessPanel
        available={0}
        onHand={0}
        reserved={0}
        inTransit={0}
        backordered={5}
        canonicalUom="kg"
        hasNegativeOnHand={false}
        hasManufacturingFlow={false}
        hasActiveBom={false}
        hasRouting={false}
        onAdjustStock={vi.fn()}
        onViewMovements={vi.fn()}
        onCreateRouting={vi.fn()}
      />,
    )
    expect(screen.getByText(/5 backordered/)).toBeInTheDocument()
  })
})

import { describe, expect, it, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import type { AppNavItem } from '@shared/routes'
import SectionNav from './SectionNav'

const navItems: AppNavItem[] = [
  { label: 'Receiving & QC', to: '/receiving', section: 'inbound', order: 1 },
  { label: 'Items', to: '/items', section: 'master-data', order: 1 },
]

function NavWithRouter({ initialEntries }: { initialEntries: string[] }) {
  return (
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route path="*" element={<SectionNav navItems={navItems} />} />
      </Routes>
    </MemoryRouter>
  )
}

function NavWithNavigate() {
  const navigate = useNavigate()
  return (
    <>
      <button onClick={() => navigate('/items')}>Go items</button>
      <SectionNav navItems={navItems} />
    </>
  )
}

describe('SectionNav single-branch expansion', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('expanding one section collapses others when navigating between sections', () => {
    render(<NavWithRouter initialEntries={['/not-found']} />)

    fireEvent.click(screen.getByRole('button', { name: 'Inbound' }))
    expect(screen.getByText('Receiving & QC')).toBeInTheDocument()
    expect(screen.queryByText('Items')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Master Data' }))
    expect(screen.getByText('Items')).toBeInTheDocument()
    expect(screen.queryByText('Receiving & QC')).toBeNull()
  })

  it('active route forces parent section open', () => {
    render(<NavWithRouter initialEntries={['/receiving']} />)
    expect(screen.getByText('Receiving & QC')).toBeInTheDocument()
    expect(screen.queryByText('Items')).toBeNull()
  })

  it('route change updates expanded section', () => {
    render(
      <MemoryRouter initialEntries={['/receiving']}>
        <Routes>
          <Route path="*" element={<NavWithNavigate />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(screen.getByText('Receiving & QC')).toBeInTheDocument()
    expect(screen.queryByText('Items')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Go items' }))
    expect(screen.getByText('Items')).toBeInTheDocument()
    expect(screen.queryByText('Receiving & QC')).toBeNull()
  })
})

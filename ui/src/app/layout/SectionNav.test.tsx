import { describe, expect, it, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import type { AppNavItem } from '@shared/routes'
import SectionNav from './SectionNav'
import { AuthContext, type AuthContextValue } from '../../lib/authContext'

const navItems: AppNavItem[] = [
  { label: 'Receiving & QC', to: '/receiving', section: 'inbound', order: 1, permission: 'purchasing:read' },
  { label: 'Items', to: '/items', section: 'master-data', order: 1, permission: 'masterdata:read' },
  { label: 'Accounts Payable', to: '/ap', section: 'master-data', order: 2, permission: 'finance:read' },
  { label: 'Data Import', to: '/admin/imports', section: 'admin', order: 1, permission: 'admin:imports' },
]

function authValue(permissions: string[]): AuthContextValue {
  return {
    status: 'authenticated',
    accessToken: 'token',
    user: { id: 'user-1', email: 'user@example.com' },
    tenant: { id: 'tenant-1', name: 'Tenant', slug: 'tenant' },
    role: permissions.includes('admin:imports') ? 'admin' : 'operator',
    permissions,
    logoutReason: null,
    login: async () => undefined,
    bootstrap: async () => undefined,
    logout: async () => undefined,
    refresh: async () => undefined,
    hasPermission: (permission) => permissions.includes(permission),
    hasAnyPermission: (required) => required.some((permission) => permissions.includes(permission)),
    hasAllPermissions: (required) => required.every((permission) => permissions.includes(permission)),
  }
}

function NavWithRouter({
  initialEntries,
  permissions = ['purchasing:read', 'masterdata:read'],
}: {
  initialEntries: string[]
  permissions?: string[]
}) {
  return (
    <AuthContext.Provider value={authValue(permissions)}>
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route path="*" element={<SectionNav navItems={navItems} />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>
  )
}

function NavWithNavigate({ permissions }: { permissions: string[] }) {
  const navigate = useNavigate()
  return (
    <AuthContext.Provider value={authValue(permissions)}>
      <button onClick={() => navigate('/items')}>Go items</button>
      <SectionNav navItems={navItems} />
    </AuthContext.Provider>
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
        <Route path="*" element={<NavWithNavigate permissions={['purchasing:read', 'masterdata:read']} />} />
      </Routes>
    </MemoryRouter>,
  )

    expect(screen.getByText('Receiving & QC')).toBeInTheDocument()
    expect(screen.queryByText('Items')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Go items' }))
    expect(screen.getByText('Items')).toBeInTheDocument()
    expect(screen.queryByText('Receiving & QC')).toBeNull()
  })

  it('hides navigation entries when permissions are missing', () => {
    render(<NavWithRouter initialEntries={['/not-found']} permissions={['purchasing:read']} />)

    fireEvent.click(screen.getByRole('button', { name: 'Inbound' }))
    expect(screen.getByText('Receiving & QC')).toBeInTheDocument()
    expect(screen.queryByText('Items')).toBeNull()
    expect(screen.queryByText('Accounts Payable')).toBeNull()
    expect(screen.queryByText('Data Import')).toBeNull()
  })

  it('shows all protected navigation entries when the session has every permission', () => {
    render(
      <NavWithRouter
        initialEntries={['/not-found']}
        permissions={['purchasing:read', 'masterdata:read', 'finance:read', 'admin:imports']}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Master Data' }))
    expect(screen.getByText('Items')).toBeInTheDocument()
    expect(screen.getByText('Accounts Payable')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Admin' }))
    expect(screen.getByText('Data Import')).toBeInTheDocument()
  })
})

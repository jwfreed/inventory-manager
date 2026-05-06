import { Outlet, useLocation } from 'react-router-dom'
import { useEffect, useMemo, useRef } from 'react'
import { Badge, Breadcrumbs, Button, CommandPaletteProvider } from '@shared/ui'
import { useAuth } from '@shared/auth'
import { use403Handler } from '../../lib/use403Handler'
import { navItems } from '../routeData'
import SectionNav from './SectionNav'
import OnboardingNudge from '@features/onboarding/components/OnboardingNudge'

function AppShell() {
  const { user, tenant, logout } = useAuth()
  use403Handler()
  const location = useLocation()
  const contentScrollRef = useRef<HTMLElement | null>(null)
  const envLabel = useMemo(() => {
    const mode = import.meta.env.MODE ?? 'development'
    return mode.toUpperCase()
  }, [])

  const userLabel = user?.fullName || user?.email
  const tenantLabel = tenant?.name || tenant?.slug
  const tenantInitials = tenantLabel
    ? tenantLabel.split(' ').slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('')
    : '?'

  const logoMd = tenant?.logoUrl ? (
    <img
      src={tenant.logoUrl}
      alt={tenantLabel ? `${tenantLabel} logo` : 'Tenant logo'}
      className="h-10 w-10 flex-shrink-0 rounded-full object-contain"
      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
    />
  ) : (
    <div
      className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold text-slate-600"
      aria-label={tenantLabel ? `${tenantLabel} logo` : 'Tenant logo'}
    >
      {tenantInitials}
    </div>
  )

  const logoSm = tenant?.logoUrl ? (
    <img
      src={tenant.logoUrl}
      alt={tenantLabel ? `${tenantLabel} logo` : 'Tenant logo'}
      className="h-9 w-9 flex-shrink-0 rounded-full object-contain"
      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
    />
  ) : (
    <div
      className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600"
      aria-label={tenantLabel ? `${tenantLabel} logo` : 'Tenant logo'}
    >
      {tenantInitials}
    </div>
  )

  useEffect(() => {
    contentScrollRef.current?.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior })
  }, [location.pathname])

  return (
    <CommandPaletteProvider>
      <div className="h-screen overflow-hidden bg-slate-25 text-slate-900">
        <aside className="fixed inset-y-0 left-0 hidden w-64 overflow-y-auto border-r border-slate-200 bg-white lg:flex lg:flex-col">
          <div className="flex items-center gap-3 px-5 py-6">
            {logoMd}
            <div>
              <div className="text-sm font-semibold text-slate-900">Inventory Manager</div>
              {tenantLabel && <p className="text-xs text-slate-500">{tenantLabel}</p>}
            </div>
          </div>
          <SectionNav navItems={navItems} />
        </aside>
        <div className="flex h-full min-w-0 flex-col lg:pl-64">
          <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
            {/* Mobile branding — hidden on desktop where sidebar shows it */}
            <div className="flex items-center gap-2.5 lg:hidden">
              {logoSm}
              <div>
                <div className="text-sm font-semibold text-slate-900">Inventory Manager</div>
                {tenantLabel && <div className="text-xs text-slate-400">{tenantLabel}</div>}
              </div>
            </div>
            {/* Desktop spacer so right cluster stays right */}
            <div className="hidden lg:block" />
            {/* User cluster */}
            <div className="flex items-center gap-3">
              {(userLabel || tenantLabel) && (
                <div className="text-right">
                  {userLabel && <div className="text-xs font-medium text-slate-700 leading-tight">{userLabel}</div>}
                  {tenantLabel && <div className="text-xs text-slate-400 leading-tight">{tenantLabel}</div>}
                </div>
              )}
              <Badge variant="info" className="uppercase">
                {envLabel}
              </Badge>
              <div className="h-4 w-px bg-slate-200" />
              <Button variant="secondary" size="sm" onClick={() => void logout()}>
                Sign out
              </Button>
            </div>
          </header>
          <main ref={contentScrollRef} className="flex-1 overflow-y-auto bg-slate-25">
            <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-6">
              <Breadcrumbs />
              <OnboardingNudge />
              <Outlet />
            </div>
          </main>
        </div>
      </div>
    </CommandPaletteProvider>
  )
}

export default AppShell

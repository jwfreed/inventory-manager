import { Outlet } from 'react-router-dom'
import { useMemo } from 'react'
import Breadcrumbs from '../../components/Breadcrumbs'
import { NavLink } from '../../components/NavLink'
import { Badge } from '../../components/Badge'

const navItems = [
  { to: '/home', label: 'Home' },
  { to: '/ledger', label: 'Ledger (coming soon)', disabled: true },
  { to: '/work-orders', label: 'Work Orders (coming soon)', disabled: true },
  { to: '/items', label: 'Items (coming soon)', disabled: true },
  { to: '/locations', label: 'Locations (coming soon)', disabled: true },
]

function AppShell() {
  const envLabel = useMemo(() => {
    const mode = import.meta.env.MODE ?? 'development'
    return mode.toUpperCase()
  }, [])

  return (
    <div className="flex min-h-screen bg-slate-25 text-slate-900">
      <aside className="w-64 border-r border-slate-200 bg-white">
        <div className="px-5 py-6">
          <div className="text-lg font-semibold text-slate-900">Inventory UI</div>
          <p className="mt-1 text-sm text-slate-500">Inventory & manufacturing ops</p>
        </div>
        <nav className="mt-2 space-y-1 px-3">
          {navItems.map((item) => (
            <NavLink key={item.to} to={item.to} disabled={item.disabled}>
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Inventory Manager</h1>
            <p className="text-sm text-slate-500">UI foundation (Phase A)</p>
          </div>
          <Badge variant="info" className="uppercase">
            {envLabel}
          </Badge>
        </header>
        <main className="flex-1 bg-slate-25">
          <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-6">
            <Breadcrumbs />
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}

export default AppShell

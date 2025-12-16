import { Link, useLocation } from 'react-router-dom'
import { cn } from '../lib/utils'

type Props = {
  to: string
  children: React.ReactNode
  disabled?: boolean
}

export function NavLink({ to, children, disabled }: Props) {
  const location = useLocation()
  const isActive = location.pathname === to

  if (disabled) {
    return (
      <div className="rounded-lg px-3 py-2 text-sm text-slate-400 transition">
        {children}
      </div>
    )
  }

  return (
    <Link
      to={to}
      className={cn(
        'block rounded-lg px-3 py-2 text-sm font-medium transition',
        isActive
          ? 'bg-brand-50 text-brand-700'
          : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900',
      )}
    >
      {children}
    </Link>
  )
}

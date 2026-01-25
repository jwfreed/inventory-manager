import { Link, useMatches } from 'react-router-dom'
import type { AppRouteHandle } from '../shared/routes'
import { usePageChrome } from '../app/layout/usePageChrome'

export default function Breadcrumbs() {
  const matches = useMatches()
  const { showBreadcrumbs } = usePageChrome()
  const crumbs = matches
    .map((match) => {
      const handle = match.handle as AppRouteHandle | undefined
      const breadcrumb = handle?.breadcrumb
      if (!breadcrumb) return null
      const label = typeof breadcrumb === 'function' ? breadcrumb(match.params) : breadcrumb
      if (!label) return null
      return { label, path: match.pathname }
    })
    .filter((crumb): crumb is { label: string; path: string } => Boolean(crumb))

  if (!showBreadcrumbs || crumbs.length === 0) return null

  return (
    <nav aria-label="Breadcrumb" className="text-sm text-slate-500">
      <ol className="flex items-center gap-2">
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1
          return (
            <li key={crumb.path} className="flex items-center gap-2">
              {isLast ? (
                <span className="font-medium text-slate-700">{crumb.label}</span>
              ) : (
                <Link to={crumb.path} className="hover:text-brand-700">
                  {crumb.label}
                </Link>
              )}
              {!isLast && <span className="text-slate-300">/</span>}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

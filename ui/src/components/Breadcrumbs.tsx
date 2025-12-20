import { Link, useLocation } from 'react-router-dom'

function formatLabel(segment: string) {
  if (!segment) return 'Home'
  return segment
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function buildPath(segments: string[], index: number) {
  return `/${segments.slice(0, index + 1).join('/')}`
}

export default function Breadcrumbs() {
  const location = useLocation()
  const segments = location.pathname.split('/').filter(Boolean)

  const crumbs = segments.length ? segments : ['home']

  return (
    <nav aria-label="Breadcrumb" className="text-sm text-slate-500">
      <ol className="flex items-center gap-2">
        {crumbs.map((segment, index) => {
          const isLast = index === crumbs.length - 1
          const path = buildPath(crumbs, index)
          return (
            <li key={path} className="flex items-center gap-2">
              {isLast ? (
                <span className="font-medium text-slate-700">{formatLabel(segment)}</span>
              ) : (
                <Link to={path} className="hover:text-brand-700">
                  {formatLabel(segment)}
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

import { Link } from 'react-router-dom'
import { Card } from '../components/Card'
import { cn } from '../lib/utils'

export default function NotFoundPage() {
  return (
    <div className="mx-auto max-w-xl">
      <Card title="Page not found" description="The page you requested does not exist.">
        <div className="flex items-center justify-between">
          <div className="text-sm text-slate-600">
            Check the URL or head back to the foundation Home page.
          </div>
          <Link
            to="/home"
            className={cn(
              'inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm transition',
              'hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400',
            )}
          >
            Go home
          </Link>
        </div>
      </Card>
    </div>
  )
}

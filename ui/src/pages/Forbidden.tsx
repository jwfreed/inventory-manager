import { Link } from 'react-router-dom'
import { Card } from '../components/Card'
import { cn } from '../lib/utils'

export default function ForbiddenPage() {
  return (
    <div className="mx-auto max-w-xl">
      <Card title="Access denied" description="You don't have permission to view this page.">
        <div className="flex items-center justify-between">
          <div className="text-sm text-slate-600">
            Contact your administrator if you believe this is an error.
          </div>
          <Link
            to="/dashboard"
            className={cn(
              'inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm transition',
              'hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400',
            )}
          >
            Go to dashboard
          </Link>
        </div>
      </Card>
    </div>
  )
}

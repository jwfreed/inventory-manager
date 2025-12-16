import { useEffect } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getReturn } from '../../../api/endpoints/orderToCash/returns'
import type { ApiError } from '../../../api/types'
import { Alert } from '../../../components/Alert'
import { Badge } from '../../../components/Badge'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { EmptyState } from '../../../components/EmptyState'
import { ErrorState } from '../../../components/ErrorState'
import { LoadingSpinner } from '../../../components/Loading'

export default function ReturnDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const query = useQuery({
    queryKey: ['return', id],
    queryFn: () => getReturn(id as string),
    enabled: !!id,
    retry: 1,
  })

  useEffect(() => {
    if (query.data?.notImplemented) return
    const err = query.error as unknown as ApiError | undefined
    if (query.isError && err?.status === 404) {
      navigate('/not-found', { replace: true })
    }
  }, [query.isError, query.error, query.data, navigate])

  const copyId = async () => {
    if (!id) return
    try {
      await navigator.clipboard.writeText(id)
    } catch {
      // ignore
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">Order to Cash</p>
          <h2 className="text-2xl font-semibold text-slate-900">Return detail</h2>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => navigate('/returns')}>
            Back to list
          </Button>
          <Button variant="secondary" size="sm" onClick={copyId}>
            Copy ID
          </Button>
        </div>
      </div>

      {query.isLoading && <LoadingSpinner label="Loading return..." />}
      {query.data?.notImplemented && (
        <EmptyState
          title="API not available yet"
          description="Phase 4 Order-to-Cash is DB-first in this repo; runtime endpoints are not implemented yet."
        />
      )}
      {query.isError && !query.data?.notImplemented && query.error && (
        <ErrorState error={query.error as unknown as ApiError} onRetry={() => void query.refetch()} />
      )}

      {query.data && !query.data.notImplemented && (
        <Card>
          <div className="grid gap-3 text-sm text-slate-800 md:grid-cols-2">
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500">Status</div>
              <Badge variant="neutral">{query.data.status || '—'}</Badge>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500">Type</div>
              <div>{query.data.type || '—'}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500">Movement</div>
              {query.data.inventoryMovementId ? (
                <Link
                  to={`/ledger/movements/${query.data.inventoryMovementId}`}
                  className="text-brand-700 hover:underline"
                >
                  {query.data.inventoryMovementId}
                </Link>
              ) : (
                '—'
              )}
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500">Notes</div>
              <div>{query.data.notes || '—'}</div>
            </div>
          </div>
          <Alert
            className="mt-3"
            variant="info"
            title="Return document"
            message="This return document may be linked to an inventory movement when posted."
          />
        </Card>
      )}
    </div>
  )
}

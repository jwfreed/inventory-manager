import { useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getReservation } from '../../../api/endpoints/orderToCash/reservations'
import type { ApiError } from '../../../api/types'
import { Alert } from '../../../components/Alert'
import { Badge } from '../../../components/Badge'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { EmptyState } from '../../../components/EmptyState'
import { ErrorState } from '../../../components/ErrorState'
import { LoadingSpinner } from '../../../components/Loading'

export default function ReservationDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const query = useQuery({
    queryKey: ['reservation', id],
    queryFn: () => getReservation(id as string),
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
          <h2 className="text-2xl font-semibold text-slate-900">Reservation detail</h2>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => navigate('/reservations')}>
            Back to list
          </Button>
          <Button variant="secondary" size="sm" onClick={copyId}>
            Copy ID
          </Button>
        </div>
      </div>

      {query.isLoading && <LoadingSpinner label="Loading reservation..." />}
      {query.data?.notImplemented && (
        <EmptyState
          title="API not available yet"
          description="Expected endpoint: GET /reservations/:id (Phase 4 runtime may be DB-only)."
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
              <div className="text-xs uppercase tracking-wide text-slate-500">Demand</div>
              <div>
                {query.data.demandType || '—'} {query.data.demandId || ''}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500">Item</div>
              <div>{query.data.itemId || '—'}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500">Location</div>
              <div>{query.data.locationId || '—'}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500">Reserved</div>
              <div>
                {query.data.quantityReserved ?? '—'} {query.data.uom || ''}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500">Fulfilled</div>
              <div>
                {query.data.quantityFulfilled ?? '—'} {query.data.uom || ''}
              </div>
            </div>
          </div>
          <Alert
            className="mt-3"
            variant="info"
            title="Reservation ≠ inventory movement"
            message="Reservations do not change on-hand; they represent demand allocation."
          />
        </Card>
      )}
    </div>
  )
}

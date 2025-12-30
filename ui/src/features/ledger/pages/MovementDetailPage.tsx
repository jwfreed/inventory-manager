import { useEffect, useMemo } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { ApiError } from '../../../api/types'
import { useMovement, useMovementLines } from '../queries'
import { Alert } from '../../../components/Alert'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { EmptyState } from '../../../components/EmptyState'
import { ErrorState } from '../../../components/ErrorState'
import { LoadingSpinner } from '../../../components/Loading'
import { Section } from '../../../components/Section'
import { Badge } from '../../../components/Badge'
import { formatDate, formatNumber } from '@shared/formatters'
import { MovementStatusBadge } from '../components/MovementStatusBadge'
import { MovementLinesTable } from '../components/MovementLinesTable'

export default function MovementDetailPage() {
  const { movementId } = useParams<{ movementId: string }>()
  const navigate = useNavigate()

  const movementQuery = useMovement(movementId, {
    retry: (failureCount, error: ApiError) => error?.status !== 404 && failureCount < 1,
  })

  const linesQuery = useMovementLines(movementId)

  useEffect(() => {
    if (movementQuery.isError && movementQuery.error?.status === 404) {
      navigate('/not-found', { replace: true })
    }
  }, [movementQuery.isError, movementQuery.error, navigate])

  const totals = useMemo(() => {
    const map = new Map<string, { itemId: string; uom: string; quantity: number }>()
    if (linesQuery.data) {
      for (const line of linesQuery.data) {
        const key = `${line.itemId}-${line.uom}`
        const current = map.get(key) ?? { itemId: line.itemId, uom: line.uom, quantity: 0 }
        current.quantity += line.quantityDelta || 0
        map.set(key, current)
      }
    }
    return Array.from(map.values())
  }, [linesQuery.data])

  const copyId = async () => {
    if (!movementId) return
    try {
      await navigator.clipboard.writeText(movementId)
    } catch {
      // ignore clipboard errors
    }
  }

  const sourceLink = useMemo(() => {
    const ref = movementQuery.data?.externalRef
    if (!ref) return null
    const workOrderLink = (label: string) => {
      const parts = ref.split(':')
      const id = parts[1]
      const workOrderId = parts[2]
      return workOrderId
        ? { label: `${label} ${id.slice(0, 8)}…`, to: `/work-orders/${workOrderId}` }
        : null
    }
    const disassemblyLink = () => {
      const parts = ref.split(':')
      const workOrderId = parts[2] ?? parts[1]
      if (!workOrderId) return null
      return {
        label: `Disassembly WO ${workOrderId.slice(0, 8)}…`,
        to: `/work-orders/${workOrderId}`,
      }
    }
    if (ref.startsWith('putaway:')) {
      const id = ref.split(':')[1]
      return { label: `Putaway ${id.slice(0, 8)}…`, to: `/receiving?putawayId=${id}` }
    }
    if (ref.startsWith('qc_accept:')) {
      const id = ref.split(':')[1]
      return { label: `QC event ${id.slice(0, 8)}…`, to: `/qc-events/${id}` }
    }
    if (ref.startsWith('inventory_adjustment:')) {
      const id = ref.split(':')[1]
      return { label: `Adjustment ${id.slice(0, 8)}…`, to: `/inventory-adjustments/${id}` }
    }
    if (ref.startsWith('work_order_issue:')) {
      return workOrderLink('Work order issue')
    }
    if (ref.startsWith('work_order_completion:')) {
      return workOrderLink('Work order completion')
    }
    if (ref.startsWith('work_order_disassembly_issue:')) {
      return disassemblyLink()
    }
    if (ref.startsWith('work_order_disassembly_completion:')) {
      return disassemblyLink()
    }
    if (ref.startsWith('work_order_batch_issue:')) {
      return workOrderLink('Batch issue')
    }
    if (ref.startsWith('work_order_batch_completion:')) {
      return workOrderLink('Batch completion')
    }
    return null
  }, [movementQuery.data?.externalRef])

  const negativeOverride = useMemo(() => {
    const metadata = movementQuery.data?.metadata as
      | { negative_override?: boolean; override_reason?: string; override_actor_id?: string }
      | null
    if (!metadata?.negative_override) return null
    return {
      reason: metadata.override_reason,
      actorId: metadata.override_actor_id,
    }
  }, [movementQuery.data?.metadata])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">Ledger</p>
          <h2 className="text-2xl font-semibold text-slate-900">Movement detail</h2>
          <p className="text-sm text-slate-600">Review header info and line deltas.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => navigate('/movements')}>
            Back to list
          </Button>
          <Button variant="secondary" size="sm" onClick={copyId}>
            Copy ID
          </Button>
        </div>
      </div>

      <Section title="Header">
        <Card>
          {movementQuery.isLoading && <LoadingSpinner label="Loading movement..." />}
          {movementQuery.isError && movementQuery.error && (
            <ErrorState
              error={movementQuery.error}
              onRetry={() => {
                void movementQuery.refetch()
              }}
            />
          )}
          {movementQuery.data && (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <Badge variant="info">{movementQuery.data.movementType}</Badge>
                  <MovementStatusBadge status={movementQuery.data.status} />
                  {negativeOverride && <Badge variant="danger">Negative override</Badge>}
                </div>
                <div className="text-sm text-slate-700">
                  <span className="font-semibold">Occurred:</span>{' '}
                  {formatDate(movementQuery.data.occurredAt)}
                </div>
                <div className="text-sm text-slate-700">
                  <span className="font-semibold">Posted:</span>{' '}
                  {movementQuery.data.postedAt ? formatDate(movementQuery.data.postedAt) : '—'}
                </div>
                <div className="text-sm text-slate-700">
                  <span className="font-semibold">External ref:</span>{' '}
                  {movementQuery.data.externalRef || '—'}
                </div>
                {negativeOverride && (
                  <div className="text-sm text-slate-700">
                    <span className="font-semibold">Override reason:</span>{' '}
                    {negativeOverride.reason || '—'}
                  </div>
                )}
              </div>
              <div className="space-y-2">
                <div className="text-sm text-slate-700">
                  <span className="font-semibold">Movement ID:</span> {movementId}
                </div>
                <div className="text-sm text-slate-700">
                  <span className="font-semibold">Notes:</span>{' '}
                  {movementQuery.data.notes || '—'}
                </div>
                <div className="text-sm text-slate-700">
                  <span className="font-semibold">Source:</span>{' '}
                  {sourceLink ? (
                    <Link className="text-brand-700 underline" to={sourceLink.to}>
                      {sourceLink.label}
                    </Link>
                  ) : (
                    movementQuery.data.externalRef || '—'
                  )}
                </div>
                {negativeOverride && (
                  <div className="text-sm text-slate-700">
                    <span className="font-semibold">Override actor:</span>{' '}
                    {negativeOverride.actorId || '—'}
                  </div>
                )}
              </div>
            </div>
          )}
        </Card>
      </Section>

      <Section title="Lines">
        {linesQuery.isLoading && <LoadingSpinner label="Loading lines..." />}
        {linesQuery.isError && linesQuery.error && (
          <ErrorState
            error={linesQuery.error}
            onRetry={() => {
              void linesQuery.refetch()
            }}
          />
        )}
        {!linesQuery.isLoading && !linesQuery.isError && linesQuery.data && (
          <MovementLinesTable lines={linesQuery.data} />
        )}
        {!linesQuery.isLoading && !linesQuery.isError && linesQuery.data?.length === 0 && (
          <EmptyState
            title="No lines found"
            description="This movement has no lines. Verify backend data."
          />
        )}
      </Section>

      <Section title="Totals by item (delta)">
        {totals.length === 0 ? (
          <Alert
            variant="info"
            title="No totals available"
            message="Totals are calculated from movement lines; none are present."
          />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {totals.map((total) => {
              const sign = total.quantity > 0 ? '+' : total.quantity < 0 ? '−' : ''
              const color =
                total.quantity > 0 ? 'text-green-700' : total.quantity < 0 ? 'text-red-600' : ''
              return (
                <Card key={`${total.itemId}-${total.uom}`}>
                  <div className="text-xs uppercase tracking-wide text-slate-500">
                    Item {total.itemId}
                  </div>
                  <div className="mt-1 text-sm text-slate-600">UOM: {total.uom}</div>
                  <div className={`mt-2 text-lg font-semibold ${color}`}>
                    {sign}
                    {formatNumber(Math.abs(total.quantity))} {total.uom}
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </Section>
    </div>
  )
}

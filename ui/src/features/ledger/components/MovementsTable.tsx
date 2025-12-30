import { Link, useNavigate } from 'react-router-dom'
import { formatDate } from '@shared/formatters'
import { cn } from '../../../lib/utils'
import type { Movement } from '../../../api/types'
import { MovementStatusBadge } from './MovementStatusBadge'
import { Badge } from '../../../components/Badge'

type Props = {
  movements: Movement[]
  page?: number
  pageCount?: number
  onPageChange?: (page: number) => void
}

export function MovementsTable({ movements, page, pageCount, onPageChange }: Props) {
  const navigate = useNavigate()

  const getSourceLink = (externalRef?: string | null) => {
    if (!externalRef) return null
    if (externalRef.startsWith('putaway:')) {
      const id = externalRef.split(':')[1]
      return { label: `Putaway ${id.slice(0, 8)}…`, type: 'Putaway', to: `/receiving?putawayId=${id}` }
    }
    if (externalRef.startsWith('qc_accept:')) {
      const id = externalRef.split(':')[1]
      return { label: `QC accept ${id.slice(0, 8)}…`, type: 'QC accept', to: `/qc-events/${id}` }
    }
    if (externalRef.startsWith('inventory_adjustment:')) {
      const id = externalRef.split(':')[1]
      return { label: `Adjustment ${id.slice(0, 8)}…`, type: 'Adjustment', to: `/inventory-adjustments/${id}` }
    }
    if (externalRef.startsWith('work_order_issue:')) {
      const id = externalRef.split(':')[1]
      return { label: `Work order issue ${id.slice(0, 8)}…`, type: 'Work order issue' }
    }
    if (externalRef.startsWith('work_order_completion:')) {
      const id = externalRef.split(':')[1]
      return { label: `Work order completion ${id.slice(0, 8)}…`, type: 'Work order completion' }
    }
    if (externalRef.startsWith('work_order_batch_issue:')) {
      const id = externalRef.split(':')[1]
      return { label: `Batch issue ${id.slice(0, 8)}…`, type: 'Work order issue' }
    }
    if (externalRef.startsWith('work_order_batch_completion:')) {
      const id = externalRef.split(':')[1]
      return { label: `Batch completion ${id.slice(0, 8)}…`, type: 'Work order completion' }
    }
    return { label: externalRef, type: 'External ref' }
  }

  const isLatePosted = (movement: Movement) => {
    if (!movement.postedAt || !movement.occurredAt) return false
    const postedAt = new Date(movement.postedAt).getTime()
    const occurredAt = new Date(movement.occurredAt).getTime()
    if (Number.isNaN(postedAt) || Number.isNaN(occurredAt)) return false
    const oneDayMs = 24 * 60 * 60 * 1000
    return postedAt - occurredAt > oneDayMs
  }
  // TODO: flag large adjustments when list endpoint includes total absolute delta.
  const isAdjustment = (movement: Movement) =>
    movement.movementType?.toLowerCase() === 'adjustment'

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <table className="min-w-full divide-y divide-slate-200">
        <thead className="bg-slate-50">
          <tr>
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              Occurred at
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              Movement type
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              Status
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              Source
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              Posted at
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200 bg-white">
          {movements.length === 0 ? (
            <tr>
              <td colSpan={5} className="px-4 py-6 text-sm text-slate-500">
                No movements found.
              </td>
            </tr>
          ) : (
            movements.map((movement) => (
              <tr
                key={movement.id}
                tabIndex={0}
                role="button"
                className={cn(
                  'cursor-pointer transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                  (movement.status?.toLowerCase() === 'draft' || isLatePosted(movement)) &&
                    'bg-amber-50/40',
                )}
                onClick={() => navigate(`/movements/${movement.id}`)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    navigate(`/movements/${movement.id}`)
                  }
                }}
              >
                <td className="px-4 py-3 text-sm text-slate-800">
                  <div className="font-medium text-slate-900">{formatDate(movement.occurredAt)}</div>
                  {movement.postedAt && (
                    <div className="text-xs text-slate-500">Posted {formatDate(movement.postedAt)}</div>
                  )}
                </td>
                <td className="px-4 py-3 text-sm capitalize text-slate-800">
                  <div className="font-medium">{movement.movementType}</div>
                  {movement.notes && (
                    <div className="text-xs text-slate-500">{movement.notes}</div>
                  )}
                </td>
                <td className="px-4 py-3 text-sm text-slate-800">
                  <div className="flex flex-wrap items-center gap-2">
                    <MovementStatusBadge status={movement.status} />
                    {isLatePosted(movement) && (
                      <Badge variant="warning">Late posted</Badge>
                    )}
                    {isAdjustment(movement) && (
                      <Badge variant="info">Adjustment</Badge>
                    )}
                  </div>
                  {movement.status?.toLowerCase() === 'draft' && (
                    <div className="mt-1 text-xs text-slate-500">Draft movements do not affect stock.</div>
                  )}
                </td>
                <td className="px-4 py-3 text-sm text-slate-700">
                  {(() => {
                    const source = getSourceLink(movement.externalRef)
                    if (!movement.externalRef) {
                      return <span className="text-xs text-slate-500">System-generated</span>
                    }
                    if (!source) return movement.externalRef
                    return (
                      <div className="flex flex-col">
                        <div className="flex items-center gap-2">
                          <Badge variant="neutral">{source.type}</Badge>
                          {source.to ? (
                            <Link
                              className="text-brand-700 underline"
                              to={source.to}
                              onClick={(event) => event.stopPropagation()}
                            >
                              {source.label}
                            </Link>
                          ) : (
                            <span className="text-sm text-slate-700">{source.label}</span>
                          )}
                        </div>
                        <span className="text-xs text-slate-500">{movement.externalRef}</span>
                      </div>
                    )
                  })()}
                </td>
                <td className="px-4 py-3 text-sm text-slate-800">
                  {movement.postedAt ? (
                    <span className="text-xs text-slate-500">{formatDate(movement.postedAt)}</span>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      {page && pageCount ? (
        <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-sm">
          <span className="text-slate-500">
            Page {page} of {pageCount}
          </span>
          <div className="flex items-center gap-2">
            <button
              className={cn(
                'rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-800 shadow-sm transition',
                page <= 1 && 'cursor-not-allowed opacity-50',
              )}
              disabled={page <= 1}
              onClick={() => onPageChange?.(page - 1)}
            >
              Previous
            </button>
            <button
              className={cn(
                'rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-800 shadow-sm transition',
                page >= pageCount && 'cursor-not-allowed opacity-50',
              )}
              disabled={page >= pageCount}
              onClick={() => onPageChange?.(page + 1)}
            >
              Next
            </button>
          </div>
        </div>
      ) : (
        <div className="border-t border-slate-200 px-4 py-3 text-sm text-slate-500">
          Pagination not available (backend does not expose totals).
        </div>
      )}
      <div className="border-t border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-500">
        Movements are immutable and append-only.
      </div>
    </div>
  )
}

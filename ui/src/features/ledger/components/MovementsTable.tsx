import { Link, useNavigate } from 'react-router-dom'
import { formatDate } from '@shared/formatters'
import { cn } from '../../../lib/utils'
import type { Movement } from '../../../api/types'
import { MovementStatusBadge } from './MovementStatusBadge'
import { Badge } from '../../../components/Badge'
import { Button, DataTable, StatusCell } from '@shared/ui'

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
    const workOrderLink = (prefix: string, type: string) => {
      const parts = externalRef.split(':')
      const issueId = parts[1]
      const workOrderId = parts[2]
      return {
        label: `${type} ${issueId?.slice(0, 8)}…`,
        type,
        to: workOrderId ? `/work-orders/${workOrderId}` : undefined,
      }
    }
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
      return workOrderLink('work_order_issue', 'Work order issue')
    }
    if (externalRef.startsWith('work_order_completion:')) {
      return workOrderLink('work_order_completion', 'Work order completion')
    }
    if (externalRef.startsWith('work_order_disassembly_issue:') || externalRef.startsWith('work_order_disassembly_completion:')) {
      const parts = externalRef.split(':')
      const workOrderId = parts[2] ?? parts[1]
      return {
        label: `WO ${workOrderId?.slice(0, 8)}…`,
        type: 'Disassembly',
        to: workOrderId ? `/work-orders/${workOrderId}` : undefined,
      }
    }
    if (externalRef.startsWith('work_order_batch_issue:')) {
      return workOrderLink('work_order_batch_issue', 'Batch issue')
    }
    if (externalRef.startsWith('work_order_batch_completion:')) {
      return workOrderLink('work_order_batch_completion', 'Batch completion')
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
  const hasNegativeOverride = (movement: Movement) =>
    Boolean((movement.metadata as { negative_override?: boolean } | null)?.negative_override)

  return (
    <div className="space-y-0 rounded-xl border border-slate-200 bg-white">
      <DataTable
        key={page ?? 'movements'}
        className="rounded-none border-0"
        stickyHeader
        keyboardNavigation
        rows={movements}
        rowKey={(movement) => movement.id}
        onRowClick={(movement) => navigate(`/movements/${movement.id}`)}
        onRowOpen={(movement) => navigate(`/movements/${movement.id}`)}
        shortcutActions={[
          {
            key: 'm',
            run: (movement) => navigate(`/movements/${movement.id}`),
          },
        ]}
        getRowState={(movement) =>
          hasNegativeOverride(movement) ? 'danger' : movement.status?.toLowerCase() === 'draft' || isLatePosted(movement) ? 'warning' : 'default'
        }
        rowActions={(movement) => (
          <Button variant="secondary" size="sm" onClick={() => navigate(`/movements/${movement.id}`)}>
            View
          </Button>
        )}
        columns={[
          {
            id: 'occurredAt',
            header: 'Occurred at',
            priority: 'primary',
            cell: (movement) => (
              <div>
                <div className="font-medium text-slate-900">{formatDate(movement.occurredAt)}</div>
                {movement.postedAt ? <div className="text-xs text-slate-500">Posted {formatDate(movement.postedAt)}</div> : null}
              </div>
            ),
          },
          {
            id: 'movementType',
            header: 'Movement type',
            cell: (movement) => (
              <div>
                <div className="font-medium capitalize text-slate-900">{movement.movementType}</div>
                {movement.notes ? <div className="text-xs text-slate-500">{movement.notes}</div> : null}
              </div>
            ),
          },
          {
            id: 'status',
            header: 'Status',
            priority: 'anomaly',
            cell: (movement) => {
              if (hasNegativeOverride(movement)) {
                return <StatusCell label="Anomaly" tone="danger" meta="Negative override recorded" />
              }
              if (isLatePosted(movement)) {
                return <StatusCell label="Late posted" tone="warning" meta={movement.status?.toLowerCase() === 'draft' ? 'Draft does not affect stock' : undefined} />
              }
              return <MovementStatusBadge status={movement.status} meta={movement.status?.toLowerCase() === 'draft' ? 'Draft does not affect stock' : undefined} />
            },
          },
          {
            id: 'source',
            header: 'Source',
            cell: (movement) => {
              const source = getSourceLink(movement.externalRef)
              if (!movement.externalRef) return <span className="text-xs text-slate-500">System-generated</span>
              if (!source) return movement.externalRef
              return (
                <div className="flex flex-col">
                  <div className="flex items-center gap-2">
                    <Badge variant="neutral">{source.type}</Badge>
                    {source.to ? (
                      <Link className="text-brand-700 underline" to={source.to} onClick={(event) => event.stopPropagation()}>
                        {source.label}
                      </Link>
                    ) : (
                      <span className="text-sm text-slate-700">{source.label}</span>
                    )}
                  </div>
                  <span className="text-xs text-slate-500">{movement.externalRef}</span>
                </div>
              )
            },
          },
          {
            id: 'postedAt',
            header: 'Posted at',
            cell: (movement) => movement.postedAt ? <span className="text-xs text-slate-500">{formatDate(movement.postedAt)}</span> : '—',
          },
        ]}
      />
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

import { useNavigate } from 'react-router-dom'
import { formatDate } from '../../../lib/formatters'
import { cn } from '../../../lib/utils'
import type { Movement } from '../../../api/types'
import { MovementStatusBadge } from './MovementStatusBadge'

type Props = {
  movements: Movement[]
  page?: number
  pageCount?: number
  onPageChange?: (page: number) => void
}

export function MovementsTable({ movements, page, pageCount, onPageChange }: Props) {
  const navigate = useNavigate()

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
              External ref
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
                className="cursor-pointer transition hover:bg-slate-50"
                onClick={() => navigate(`/movements/${movement.id}`)}
              >
                <td className="px-4 py-3 text-sm text-slate-800">
                  {formatDate(movement.occurredAt)}
                </td>
                <td className="px-4 py-3 text-sm capitalize text-slate-800">
                  {movement.movementType}
                </td>
                <td className="px-4 py-3 text-sm text-slate-800">
                  <MovementStatusBadge status={movement.status} />
                </td>
                <td className="px-4 py-3 text-sm text-slate-700">
                  {movement.externalRef || '—'}
                </td>
                <td className="px-4 py-3 text-sm text-slate-800">
                  {movement.postedAt ? formatDate(movement.postedAt) : '—'}
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
    </div>
  )
}

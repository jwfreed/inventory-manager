import { Link } from 'react-router-dom'
import type { PurchaseOrder } from '@api/types'
import { Button, Card, DataTable } from '@shared/ui'

const staleDraftReferenceTime = Date.now()

type Group = {
  key: 'draft' | 'submitted' | 'approved' | 'closed' | 'canceled'
  title: string
  description: string
}

type Props = {
  group: Group
  rows: PurchaseOrder[]
  showReceiveAction: boolean
  showEmptyState: boolean
  onRepeat: (poId: string) => void
  repeatPendingId: string | null
  onClearFilters?: () => void
}

export function PurchaseOrdersGroupTable({
  group,
  rows,
  showReceiveAction,
  showEmptyState,
  onRepeat,
  repeatPendingId,
  onClearFilters,
}: Props) {
  if (!showEmptyState && rows.length === 0) return null

  return (
    <Card className="p-0">
      <div className="border-b border-slate-200 px-4 py-3">
        <div className="text-sm font-semibold text-slate-800">{group.title}</div>
        <p className="text-xs text-slate-500">{group.description}</p>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-4 text-sm text-slate-600">
          <div>No {group.title.toLowerCase()}.</div>
          {onClearFilters && (
            <button
              type="button"
              className="mt-2 text-xs font-semibold uppercase text-brand-700"
              onClick={onClearFilters}
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <DataTable
          className="rounded-none rounded-b-lg border-t-0"
          rows={rows}
          rowKey={(row) => row.id}
          rowClassName={(row) => {
            const status = (row.status ?? '').toLowerCase()
            if (showReceiveAction && status !== 'approved' && status !== 'partially_received') {
              return 'opacity-60'
            }
            return undefined
          }}
          columns={[
            {
              id: 'poNumber',
              header: 'PO #',
              cell: (po) => {
                const status = (po.status ?? '').toLowerCase()
                const isDraft = status === 'draft'
                const createdAt = po.createdAt ? new Date(po.createdAt).getTime() : null
                const isStaleDraft =
                  isDraft && createdAt && !Number.isNaN(createdAt)
                    ? Math.floor((staleDraftReferenceTime - createdAt) / (1000 * 60 * 60 * 24)) >= 7
                    : false

                return (
                  <div>
                    <Link to={`/purchase-orders/${po.id}`} className="text-brand-700 underline">
                      {po.poNumber}
                    </Link>
                    {isStaleDraft && (
                      <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
                        Stale
                      </span>
                    )}
                  </div>
                )
              },
            },
            {
              id: 'vendor',
              header: 'Vendor',
              cell: (po) => (
                <span>
                  {po.vendorCode ?? po.vendorId}
                  {po.vendorName ? ` — ${po.vendorName}` : ''}
                </span>
              ),
            },
            {
              id: 'expected',
              header: 'Expected',
              cell: (po) => po.expectedDate ?? '—',
            },
            {
              id: 'shipTo',
              header: 'Ship to',
              cell: (po) => po.shipToLocationCode ?? po.shipToLocationId ?? '—',
            },
            {
              id: 'nextStep',
              header: 'Next step',
              cell: (po) => {
                const status = (po.status ?? '').toLowerCase()
                const isDraft = status === 'draft'
                const isSubmitted = status === 'submitted'
                const isApproved = status === 'approved'
                const isPartiallyReceived = status === 'partially_received'
                const isCanceled = status === 'canceled'
                return isDraft
                  ? 'Complete draft'
                  : isSubmitted
                  ? 'Await approval'
                  : isApproved || isPartiallyReceived
                  ? isPartiallyReceived
                    ? 'Receive remaining'
                    : 'Receive items'
                  : isCanceled
                  ? 'Canceled'
                  : 'Closed'
              },
            },
            {
              id: 'actions',
              header: 'Actions',
              align: 'right',
              cell: (po) => {
                const status = (po.status ?? '').toLowerCase()
                const canReceive = status === 'approved' || status === 'partially_received'
                const isRepeating = repeatPendingId === po.id
                return (
                  <div className="flex justify-end gap-2">
                    {showReceiveAction && canReceive && (
                      <Link to={`/receiving?poId=${po.id}`}>
                        <Button variant="secondary" size="sm">
                          Receive
                        </Button>
                      </Link>
                    )}
                    <Link to={`/purchase-orders/${po.id}`}>
                      <Button variant="secondary" size="sm">
                        View
                      </Button>
                    </Link>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => onRepeat(po.id)}
                      disabled={isRepeating}
                    >
                      {isRepeating ? (
                        <span className="inline-flex items-center gap-2">
                          <span className="h-3 w-3 animate-spin rounded-full border border-slate-300 border-t-slate-600" />
                          Repeating…
                        </span>
                      ) : (
                        'Repeat'
                      )}
                    </Button>
                  </div>
                )
              },
              cellClassName: 'text-right',
              headerClassName: 'text-right',
            },
          ]}
        />
      )}
    </Card>
  )
}

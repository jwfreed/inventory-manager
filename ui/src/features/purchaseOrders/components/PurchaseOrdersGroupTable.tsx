import { Link } from 'react-router-dom'
import type { PurchaseOrder } from '../../../api/types'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { DataTable } from '../../../shared'

const staleDraftReferenceTime = Date.now()

type Group = {
  key: 'draft' | 'submitted' | 'approved' | 'closed'
  title: string
  description: string
}

type Props = {
  group: Group
  rows: PurchaseOrder[]
  showReceiveAction: boolean
  showEmptyState: boolean
  onRepeat: (poId: string) => void
  repeatPending: boolean
}

export function PurchaseOrdersGroupTable({
  group,
  rows,
  showReceiveAction,
  showEmptyState,
  onRepeat,
  repeatPending,
}: Props) {
  if (!showEmptyState && rows.length === 0) return null

  return (
    <Card className="p-0">
      <div className="border-b border-slate-200 px-4 py-3">
        <div className="text-sm font-semibold text-slate-800">{group.title}</div>
        <p className="text-xs text-slate-500">{group.description}</p>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-4 text-sm text-slate-600">No {group.title.toLowerCase()}.</div>
      ) : (
        <DataTable
          className="rounded-none rounded-b-lg border-t-0"
          rows={rows}
          rowKey={(row) => row.id}
          columns={[
            {
              id: 'poNumber',
              header: 'PO #',
              cell: (po) => {
                const status = (po.status ?? '').toLowerCase()
                const isDraft = status === 'draft'
                const isApproved = status === 'approved' || status === 'partially_received'
                const createdAt = po.createdAt ? new Date(po.createdAt).getTime() : null
                const isStaleDraft =
                  isDraft && createdAt && !Number.isNaN(createdAt)
                    ? Math.floor((staleDraftReferenceTime - createdAt) / (1000 * 60 * 60 * 24)) >= 7
                    : false
                const target =
                  showReceiveAction && isApproved ? `/receiving?poId=${po.id}` : `/purchase-orders/${po.id}`

                return (
                  <div>
                    <Link to={target} className="text-brand-700 underline">
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
                return isDraft
                  ? 'Complete draft'
                  : isSubmitted
                  ? 'Await approval'
                  : isApproved || isPartiallyReceived
                  ? isPartiallyReceived
                    ? 'Receive remaining'
                    : 'Receive items'
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
                      disabled={repeatPending}
                    >
                      {repeatPending ? 'Repeating…' : 'Repeat'}
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

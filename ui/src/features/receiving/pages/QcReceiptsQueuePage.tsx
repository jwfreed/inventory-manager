import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { formatDate, formatNumber } from '@shared/formatters'
import { Alert, Badge, Card, DataTable, Input, LoadingSpinner, Section } from '@shared/ui'
import { useReceiptsList } from '../queries'

const STATUS_LABELS: Record<string, string> = {
  pending_qc: 'Pending QC',
  qc_failed: 'QC Failed',
  qc_passed: 'QC Passed',
}

const STATUS_VARIANTS: Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  pending_qc: 'warning',
  qc_failed: 'danger',
  qc_passed: 'info',
}

export default function QcReceiptsQueuePage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const search = searchParams.get('search') ?? ''

  const receiptsQuery = useReceiptsList(
    {
      limit: 200,
      status: 'pending_qc',
      search: search || undefined,
    },
    { staleTime: 30_000 },
  )

  const receipts = receiptsQuery.data?.data ?? []
  const filtered = useMemo(() => receipts, [receipts])

  return (
    <div className="space-y-6">
      <Section title="QC Queue" description="Receipts eligible for QC classification.">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">Search</label>
          <Input
            placeholder="Receipt #, PO #, or reference..."
            value={search}
            onChange={(event) => {
              const next = new URLSearchParams(searchParams)
              if (event.target.value) {
                next.set('search', event.target.value)
              } else {
                next.delete('search')
              }
              setSearchParams(next)
            }}
          />
        </div>

        {receiptsQuery.isLoading && <LoadingSpinner label="Loading receipts..." />}
        {receiptsQuery.isError && (
          <Alert variant="error" title="Failed to load QC queue" message="Try refreshing the page." />
        )}
        {!receiptsQuery.isLoading && filtered.length === 0 && (
          <div className="text-sm text-slate-600 py-6">No receipts are pending QC.</div>
        )}
        {!receiptsQuery.isLoading && filtered.length > 0 && (
          <Card>
            <DataTable
              rows={filtered}
              rowKey={(receipt) => receipt.id}
              columns={[
                {
                  id: 'receipt',
                  header: 'Receipt',
                  cell: (receipt) => (
                    <Link className="text-brand-700 underline font-mono text-xs" to={`/qc/receipts/${receipt.id}`}>
                      {receipt.id.slice(0, 8)}
                    </Link>
                  ),
                },
                {
                  id: 'po',
                  header: 'PO',
                  cell: (receipt) => (
                    <span className="font-mono text-xs" title={receipt.purchaseOrderId}>
                      {receipt.purchaseOrderNumber || receipt.purchaseOrderId.slice(0, 8)}
                    </span>
                  ),
                },
                {
                  id: 'vendor',
                  header: 'Vendor',
                  cell: (receipt) => receipt.vendorName || receipt.vendorCode || '—',
                },
                {
                  id: 'received',
                  header: 'Received',
                  cell: (receipt) => formatDate(receipt.receivedAt),
                },
                {
                  id: 'remaining',
                  header: 'QC Remaining',
                  align: 'right',
                  cell: (receipt) => formatNumber(receipt.qcRemaining ?? 0),
                },
                {
                  id: 'status',
                  header: 'Status',
                  cell: (receipt) => {
                    const status = receipt.workflowStatus || 'pending_qc'
                    return (
                      <Badge variant={STATUS_VARIANTS[status] || 'warning'}>
                        {STATUS_LABELS[status] || 'Pending QC'}
                      </Badge>
                    )
                  },
                },
              ]}
            />
          </Card>
        )}
      </Section>
    </div>
  )
}

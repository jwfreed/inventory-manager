import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type { PurchaseOrderReceipt } from '@api/types'
import { useVendorsList } from '@features/vendors/queries'
import { formatDate, formatNumber } from '@shared/formatters'
import { Alert, Badge, Card, DataTable, Input, LoadingSpinner, Section, Select } from '@shared/ui'
import { useReceiptsList } from '../queries'

const STATUS_OPTIONS = [
  { label: 'All statuses', value: '' },
  { label: 'Draft', value: 'draft' },
  { label: 'Posted', value: 'posted' },
  { label: 'Pending QC', value: 'pending_qc' },
  { label: 'QC Passed', value: 'qc_passed' },
  { label: 'QC Failed', value: 'qc_failed' },
  { label: 'Putaway Pending', value: 'putaway_pending' },
  { label: 'Complete', value: 'complete' },
  { label: 'Voided', value: 'voided' },
]

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  posted: 'Posted',
  pending_qc: 'Pending QC',
  qc_passed: 'QC Passed',
  qc_failed: 'QC Failed',
  putaway_pending: 'Putaway Pending',
  complete: 'Complete',
  voided: 'Voided',
}

const STATUS_VARIANTS: Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  draft: 'neutral',
  posted: 'neutral',
  pending_qc: 'warning',
  qc_passed: 'info',
  qc_failed: 'danger',
  putaway_pending: 'warning',
  complete: 'success',
  voided: 'danger',
}

function resolveWorkflowStatus(receipt: PurchaseOrderReceipt) {
  return receipt.workflowStatus || receipt.status || 'posted'
}

export default function ReceiptsIndexPage() {
  const [searchParams, setSearchParams] = useSearchParams()

  const status = searchParams.get('status') ?? ''
  const vendorId = searchParams.get('vendorId') ?? ''
  const search = searchParams.get('search') ?? ''
  const from = searchParams.get('from') ?? ''
  const to = searchParams.get('to') ?? ''

  const receiptsQuery = useReceiptsList(
    {
      limit: 200,
      status: status || undefined,
      vendorId: vendorId || undefined,
      from: from || undefined,
      to: to || undefined,
      search: search || undefined,
    },
    { staleTime: 30_000 },
  )

  const vendorsQuery = useVendorsList({ limit: 200, active: true })
  const vendors = useMemo(() => vendorsQuery.data?.data ?? [], [vendorsQuery.data])
  const receipts = receiptsQuery.data?.data ?? []

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams)
    if (value) {
      next.set(key, value)
    } else {
      next.delete(key)
    }
    setSearchParams(next)
  }

  return (
    <div className="space-y-6">
      <Section title="Receipts" description="Browse inbound receipts without entering the workflow.">
        <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-4">
          <div className="grid gap-3 md:grid-cols-4">
            <div className="md:col-span-2">
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">Search</label>
              <Input
                placeholder="Receipt #, PO #, or reference..."
                value={search}
                onChange={(event) => setParam('search', event.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">Status</label>
              <Select value={status} onChange={(event) => setParam('status', event.target.value)}>
                {STATUS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">Vendor</label>
              <Select value={vendorId} onChange={(event) => setParam('vendorId', event.target.value)}>
                <option value="">All vendors</option>
                {vendors.map((vendor) => (
                  <option key={vendor.id} value={vendor.id}>
                    {vendor.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-4">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">From</label>
              <Input type="date" value={from} onChange={(event) => setParam('from', event.target.value)} />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">To</label>
              <Input type="date" value={to} onChange={(event) => setParam('to', event.target.value)} />
            </div>
          </div>
        </div>

        {receiptsQuery.isLoading && <LoadingSpinner label="Loading receipts..." />}
        {receiptsQuery.isError && (
          <Alert variant="error" title="Failed to load receipts" message="Try refreshing the page." />
        )}
        {!receiptsQuery.isLoading && receipts.length === 0 && (
          <div className="text-sm text-slate-600 py-6">No receipts match the current filters.</div>
        )}
        {!receiptsQuery.isLoading && receipts.length > 0 && (
          <Card>
            <div className="px-4 py-3 text-sm text-slate-600 border-b border-slate-200">
              Showing {formatNumber(receipts.length)} receipts
            </div>
            <DataTable
              rows={receipts}
              rowKey={(receipt) => receipt.id}
              columns={[
                {
                  id: 'receipt',
                  header: 'Receipt',
                  cell: (receipt) => (
                    <Link className="text-brand-700 underline font-mono text-xs" to={`/receipts/${receipt.id}`}>
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
                  id: 'status',
                  header: 'Status',
                  cell: (receipt) => {
                    const workflow = resolveWorkflowStatus(receipt)
                    return (
                      <Badge variant={STATUS_VARIANTS[workflow] || 'neutral'}>
                        {STATUS_LABELS[workflow] || workflow}
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

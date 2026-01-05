import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getOpenPOAging } from '../api/reports'
import { useVendorsList } from '../../vendors/queries'
import { Button, Card, Section, LoadingSpinner, ErrorState, Badge } from '@shared/ui'
import { formatDate } from '@shared/formatters'
import type { Vendor } from '../../../api/types/vendors'
import type { ApiError } from '../../../api/types/common'

export default function OpenPOAgingPage() {
  const [vendorFilter, setVendorFilter] = useState('')
  const [minDaysOpen, setMinDaysOpen] = useState('')
  const [includeFullyReceived, setIncludeFullyReceived] = useState(false)

  const agingQuery = useQuery({
    queryKey: ['open-po-aging', vendorFilter, minDaysOpen, includeFullyReceived],
    queryFn: () => getOpenPOAging({
      vendorId: vendorFilter || undefined,
      minDaysOpen: minDaysOpen ? parseInt(minDaysOpen) : undefined,
      includeFullyReceived,
      limit: 500,
    }),
    staleTime: 30_000,
  })

  const vendorsQuery = useVendorsList({ active: true, limit: 200 }, { staleTime: 60_000 })

  const exportToCsv = () => {
    if (!agingQuery.data?.data) return
    
    const headers = ['PO#', 'Vendor', 'Status', 'Order Date', 'Promised Date', 'Days Open', 'Days Overdue', 'Total Lines', 'Received Lines', 'Outstanding', 'Fill Rate %']
    const rows = agingQuery.data.data.map(row => [
      row.poNumber,
      row.vendorName,
      row.status,
      row.orderDate,
      row.promisedDate || 'N/A',
      row.daysOpen,
      row.daysOverdue || 'N/A',
      row.totalLines,
      row.receivedLines,
      row.outstandingLines,
      row.fillRate,
    ])
    
    const csv = [headers, ...rows].map(row => row.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `open-po-aging-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const overdueCount = agingQuery.data?.data.filter(po => po.daysOverdue && po.daysOverdue > 0).length || 0
  const avgFillRate = agingQuery.data?.data.length 
    ? Math.round(agingQuery.data.data.reduce((sum, po) => sum + po.fillRate, 0) / agingQuery.data.data.length)
    : 0

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Open PO Aging Report</h1>
        <p className="mt-1 text-sm text-slate-600">
          Track outstanding purchase orders and vendor delivery performance
        </p>
      </div>

      {agingQuery.data && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <div className="p-4">
              <div className="text-xs uppercase tracking-wide text-slate-600 font-medium">Open POs</div>
              <div className="mt-2 text-2xl font-bold text-slate-900">{agingQuery.data.data.length}</div>
            </div>
          </Card>
          <Card>
            <div className="p-4">
              <div className="text-xs uppercase tracking-wide text-slate-600 font-medium">Overdue</div>
              <div className="mt-2 text-2xl font-bold text-rose-600">{overdueCount}</div>
            </div>
          </Card>
          <Card>
            <div className="p-4">
              <div className="text-xs uppercase tracking-wide text-slate-600 font-medium">Avg Fill Rate</div>
              <div className="mt-2 text-2xl font-bold text-emerald-600">{avgFillRate}%</div>
            </div>
          </Card>
          <Card>
            <div className="p-4">
              <div className="text-xs uppercase tracking-wide text-slate-600 font-medium">Outstanding Lines</div>
              <div className="mt-2 text-2xl font-bold text-slate-900">
                {agingQuery.data.data.reduce((sum, po) => sum + po.outstandingLines, 0)}
              </div>
            </div>
          </Card>
        </div>
      )}

      <Card>
        <div className="p-4 space-y-4">
          <h2 className="text-lg font-semibold text-slate-900">Filters</h2>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Vendor</label>
              <select
                value={vendorFilter}
                onChange={(e) => setVendorFilter(e.target.value)}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              >
                <option value="">All Vendors</option>
                {vendorsQuery.data?.data.map((vendor: Vendor) => (
                  <option key={vendor.id} value={vendor.id}>{vendor.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Min Days Open</label>
              <input
                type="number"
                value={minDaysOpen}
                onChange={(e) => setMinDaysOpen(e.target.value)}
                placeholder="0"
                min="0"
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              />
            </div>

            <div className="flex items-end">
              <label className="flex items-center space-x-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeFullyReceived}
                  onChange={(e) => setIncludeFullyReceived(e.target.checked)}
                  className="rounded border-slate-300"
                />
                <span className="text-sm text-slate-700">Include Fully Received</span>
              </label>
            </div>
          </div>
        </div>
      </Card>

      <Section
        title="Purchase Orders"
        action={<Button onClick={exportToCsv} variant="secondary" size="sm">Export CSV</Button>}
      >
        {agingQuery.isLoading && <LoadingSpinner />}
        {agingQuery.isError && <ErrorState error={agingQuery.error as unknown as ApiError} />}
        
        {agingQuery.data && (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-600 uppercase">PO#</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-600 uppercase">Vendor</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-600 uppercase">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-600 uppercase">Order Date</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-600 uppercase">Days Open</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-600 uppercase">Days Overdue</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-600 uppercase">Lines</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-600 uppercase">Fill Rate</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-slate-200">
                {agingQuery.data.data.map((row) => (
                  <tr key={row.purchaseOrderId} className={row.daysOverdue && row.daysOverdue > 0 ? 'bg-rose-50' : ''}>
                    <td className="px-4 py-3 text-sm font-medium text-slate-900">{row.poNumber}</td>
                    <td className="px-4 py-3 text-sm text-slate-900">{row.vendorName}</td>
                    <td className="px-4 py-3 text-sm">
                      <Badge variant={
                        row.status === 'received' ? 'success' :
                        row.status === 'partially_received' ? 'warning' : 'neutral'
                      }>{row.status}</Badge>
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-900">{formatDate(row.orderDate)}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono">{row.daysOpen}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono">
                      {row.daysOverdue ? (
                        <span className="text-rose-600 font-semibold">{row.daysOverdue}</span>
                      ) : '-'}
                    </td>
                    <td className="px-4 py-3 text-sm text-right font-mono">
                      {row.receivedLines}/{row.totalLines}
                    </td>
                    <td className="px-4 py-3 text-sm text-right font-mono">
                      <span className={
                        row.fillRate >= 90 ? 'text-emerald-600' :
                        row.fillRate >= 70 ? 'text-amber-600' : 'text-rose-600'
                      }>
                        {row.fillRate}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {agingQuery.data.data.length === 0 && (
              <div className="text-center py-12 text-slate-500">
                No open purchase orders found
              </div>
            )}
          </div>
        )}
      </Section>
    </div>
  )
}

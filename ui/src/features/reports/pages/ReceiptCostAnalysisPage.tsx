import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getReceiptCostAnalysis } from '../api/reports'
import { useVendorsList } from '../../vendors/queries'
import { Button, Card, Section, LoadingSpinner, ErrorState, Badge, Input } from '@shared/ui'
import { formatDate, formatNumber } from '@shared/formatters'

export default function ReceiptCostAnalysisPage() {
  const [vendorFilter, setVendorFilter] = useState('')
  const [startDate, setStartDate] = useState(() => {
    const date = new Date()
    date.setMonth(date.getMonth() - 1)
    return date.toISOString().slice(0, 10)
  })
  const [endDate, setEndDate] = useState(new Date().toISOString().slice(0, 10))
  const [minVariance, setMinVariance] = useState<number>(5)

  const analysisQuery = useQuery({
    queryKey: ['receipt-cost-analysis', vendorFilter, startDate, endDate, minVariance],
    queryFn: () => getReceiptCostAnalysis({
      vendorId: vendorFilter || undefined,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      minVariancePercent: minVariance || undefined,
      limit: 500,
    }),
    staleTime: 60_000,
  })

  const vendorsQuery = useVendorsList({ active: true, limit: 200 }, { staleTime: 60_000 })

  const exportToCsv = () => {
    if (!analysisQuery.data?.data) return
    
    const headers = ['Receipt Date', 'PO Number', 'Vendor', 'Item', 'Qty', 'Expected Cost', 'Actual Cost', 'Variance $', 'Variance %', 'Extended Variance']
    const rows = analysisQuery.data.data.map(row => [
      row.receiptDate,
      row.poNumber,
      `${row.vendorCode} - ${row.vendorName}`,
      `${row.itemSku} - ${row.itemName}`,
      `${row.quantityReceived} ${row.uom}`,
      row.expectedUnitCost?.toFixed(2) || 'N/A',
      row.actualUnitCost?.toFixed(2) || 'N/A',
      row.variance?.toFixed(2) || 'N/A',
      row.variancePercent?.toFixed(1) || 'N/A',
      row.extendedVariance?.toFixed(2) || 'N/A',
    ])
    
    const csv = [headers, ...rows].map(row => row.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `receipt-cost-analysis-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const totalExtendedVariance = analysisQuery.data?.data.reduce(
    (sum, row) => sum + (row.extendedVariance || 0),
    0
  ) || 0

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Receipt Cost Analysis</h1>
        <p className="mt-1 text-sm text-slate-600">
          Track Purchase Price Variance (PPV) between expected PO costs and actual receipt costs
        </p>
      </div>

      {analysisQuery.data && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <div className="p-4">
              <div className="text-xs uppercase tracking-wide text-slate-600 font-medium">Total Receipts</div>
              <div className="mt-2 text-2xl font-bold text-slate-900">
                {analysisQuery.data.data.length}
              </div>
            </div>
          </Card>
          <Card>
            <div className="p-4">
              <div className="text-xs uppercase tracking-wide text-slate-600 font-medium">Total Extended Variance</div>
              <div className={`mt-2 text-2xl font-bold font-mono ${
                totalExtendedVariance > 0 ? 'text-rose-600' : totalExtendedVariance < 0 ? 'text-emerald-600' : 'text-slate-900'
              }`}>
                ${formatNumber(Math.abs(totalExtendedVariance))}
                {totalExtendedVariance > 0 ? ' over' : totalExtendedVariance < 0 ? ' under' : ''}
              </div>
            </div>
          </Card>
          <Card>
            <div className="p-4">
              <div className="text-xs uppercase tracking-wide text-slate-600 font-medium">Date Range</div>
              <div className="mt-2 text-sm text-slate-900">
                {formatDate(startDate)} → {formatDate(endDate)}
              </div>
            </div>
          </Card>
        </div>
      )}

      <Card>
        <div className="p-4 space-y-4">
          <h2 className="text-lg font-semibold text-slate-900">Filters</h2>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Vendor
              </label>
              <select
                value={vendorFilter}
                onChange={(e) => setVendorFilter(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
              >
                <option value="">All Vendors</option>
                {vendorsQuery.data?.data.map((vendor) => (
                  <option key={vendor.id} value={vendor.id}>
                    {vendor.code} — {vendor.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Start Date
              </label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                End Date
              </label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Min Variance %
              </label>
              <input
                type="number"
                step="1"
                min="0"
                value={minVariance}
                onChange={(e) => setMinVariance(Number(e.target.value))}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm font-mono"
                placeholder="5"
              />
            </div>
          </div>
          <div className="flex justify-end">
            <Button variant="secondary" size="sm" onClick={exportToCsv} disabled={!analysisQuery.data?.data.length}>
              Export to CSV
            </Button>
          </div>
        </div>
      </Card>

      <Section>
        {analysisQuery.isLoading ? (
          <LoadingSpinner />
        ) : analysisQuery.error ? (
          <ErrorState
            error={{ status: 500, message: 'Failed to load receipt cost analysis. Please try again.' }}
            onRetry={() => analysisQuery.refetch()}
          />
        ) : !analysisQuery.data?.data?.length ? (
          <div className="text-center py-12">
            <p className="text-slate-500">No receipt variances found matching filters.</p>
            <p className="text-xs text-slate-600 mt-1">Receipts need both PO unit price and actual cost to appear here.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Receipt Date
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    PO / Vendor
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Item
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Qty Received
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Expected Cost
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Actual Cost
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Variance %
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Ext. Variance
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-slate-200">
                {analysisQuery.data.data.map((row, idx) => {
                  const varianceAbs = Math.abs(row.variancePercent || 0)
                  const isHighVariance = varianceAbs >= 15
                  const isMediumVariance = varianceAbs >= 5 && varianceAbs < 15
                  const varianceTone = isHighVariance ? 'text-rose-600' : isMediumVariance ? 'text-amber-600' : 'text-slate-900'
                  
                  return (
                    <tr key={`${row.receiptId}-${idx}`} className="hover:bg-slate-50">
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-600">
                        {formatDate(row.receiptDate)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm font-medium text-slate-900">{row.poNumber}</div>
                        <div className="text-xs text-slate-600">{row.vendorCode}</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm font-medium text-slate-900">{row.itemSku}</div>
                        <div className="text-xs text-slate-600 max-w-xs truncate">{row.itemName}</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-mono text-slate-900">
                        {formatNumber(row.quantityReceived)} {row.uom}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-mono">
                        {row.expectedUnitCost != null ? (
                          <span className="text-slate-900">${row.expectedUnitCost.toFixed(2)}</span>
                        ) : (
                          <Badge variant="neutral">N/A</Badge>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-mono">
                        {row.actualUnitCost != null ? (
                          <span className="text-slate-900">${row.actualUnitCost.toFixed(2)}</span>
                        ) : (
                          <Badge variant="neutral">N/A</Badge>
                        )}
                      </td>
                      <td className={`px-6 py-4 whitespace-nowrap text-sm text-right font-mono font-semibold ${varianceTone}`}>
                        {row.variancePercent != null ? (
                          <span>
                            {row.variancePercent > 0 ? '+' : ''}{row.variancePercent.toFixed(1)}%
                          </span>
                        ) : '—'}
                      </td>
                      <td className={`px-6 py-4 whitespace-nowrap text-sm text-right font-mono font-semibold ${varianceTone}`}>
                        {row.extendedVariance != null ? `$${row.extendedVariance.toFixed(2)}` : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  )
}

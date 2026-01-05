import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getSalesOrderFillPerformance } from '../api/reports'
import { Button, Card, Section, LoadingSpinner, ErrorState, Badge } from '@shared/ui'
import { formatDate } from '@shared/formatters'
import type { ApiError } from '../../../api/types/common'

export default function SalesOrderFillPage() {
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [includeFullyShipped, setIncludeFullyShipped] = useState(false)
  const [onlyLate, setOnlyLate] = useState(false)

  const fillQuery = useQuery({
    queryKey: ['sales-order-fill', startDate, endDate, includeFullyShipped, onlyLate],
    queryFn: () => getSalesOrderFillPerformance({
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      includeFullyShipped,
      onlyLate,
      limit: 500,
    }),
    staleTime: 30_000,
  })

  const exportToCsv = () => {
    if (!fillQuery.data?.data) return
    
    const headers = ['SO#', 'Customer', 'Status', 'Order Date', 'Requested Date', 'Shipped Date', 'Days to Ship', 'Late?', 'Lines', 'Fill Rate %', 'On-Time?']
    const rows = fillQuery.data.data.map(row => [
      row.soNumber,
      row.customerName || 'N/A',
      row.status,
      row.orderDate,
      row.requestedDate || 'N/A',
      row.shippedDate || 'N/A',
      row.daysToShip || 'N/A',
      row.isLate ? 'Yes' : 'No',
      `${row.shippedLines}/${row.totalLines}`,
      row.fillRate,
      row.onTimeShipment ? 'Yes' : 'No',
    ])
    
    const csv = [headers, ...rows].map(row => row.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `sales-order-fill-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const lateOrders = fillQuery.data?.data.filter(so => so.isLate).length || 0
  const totalOrders = fillQuery.data?.data.length || 0
  const avgFillRate = totalOrders 
    ? Math.round(fillQuery.data!.data.reduce((sum, so) => sum + so.fillRate, 0) / totalOrders)
    : 0
  const onTimeCount = fillQuery.data?.data.filter(so => so.onTimeShipment).length || 0

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Sales Order Fill Performance</h1>
        <p className="mt-1 text-sm text-slate-600">
          Track order fulfillment rates and on-time shipment performance
        </p>
      </div>

      {fillQuery.data && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <div className="p-4">
              <div className="text-xs uppercase tracking-wide text-slate-600 font-medium">Total Orders</div>
              <div className="mt-2 text-2xl font-bold text-slate-900">{totalOrders}</div>
            </div>
          </Card>
          <Card>
            <div className="p-4">
              <div className="text-xs uppercase tracking-wide text-slate-600 font-medium">Late Orders</div>
              <div className="mt-2 text-2xl font-bold text-rose-600">{lateOrders}</div>
            </div>
          </Card>
          <Card>
            <div className="p-4">
              <div className="text-xs uppercase tracking-wide text-slate-600 font-medium">On-Time %</div>
              <div className="mt-2 text-2xl font-bold text-emerald-600">
                {totalOrders > 0 ? Math.round((onTimeCount / totalOrders) * 100) : 0}%
              </div>
            </div>
          </Card>
          <Card>
            <div className="p-4">
              <div className="text-xs uppercase tracking-wide text-slate-600 font-medium">Avg Fill Rate</div>
              <div className="mt-2 text-2xl font-bold text-slate-900">{avgFillRate}%</div>
            </div>
          </Card>
        </div>
      )}

      <Card>
        <div className="p-4 space-y-4">
          <h2 className="text-lg font-semibold text-slate-900">Filters</h2>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Start Date</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">End Date</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              />
            </div>

            <div className="flex items-end">
              <label className="flex items-center space-x-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeFullyShipped}
                  onChange={(e) => setIncludeFullyShipped(e.target.checked)}
                  className="rounded border-slate-300"
                />
                <span className="text-sm text-slate-700">Include Fully Shipped</span>
              </label>
            </div>

            <div className="flex items-end">
              <label className="flex items-center space-x-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={onlyLate}
                  onChange={(e) => setOnlyLate(e.target.checked)}
                  className="rounded border-slate-300"
                />
                <span className="text-sm text-slate-700">Only Late Orders</span>
              </label>
            </div>
          </div>
        </div>
      </Card>

      <Section
        title="Sales Orders"
        action={<Button onClick={exportToCsv} variant="secondary" size="sm">Export CSV</Button>}
      >
        {fillQuery.isLoading && <LoadingSpinner />}
        {fillQuery.isError && <ErrorState error={fillQuery.error as unknown as ApiError} />}
        
        {fillQuery.data && (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-600 uppercase">SO#</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-600 uppercase">Customer</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-600 uppercase">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-600 uppercase">Order Date</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-600 uppercase">Requested</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-600 uppercase">Lines</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-600 uppercase">Fill Rate</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-600 uppercase">On-Time?</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-slate-200">
                {fillQuery.data.data.map((row) => (
                  <tr key={row.salesOrderId} className={row.isLate ? 'bg-rose-50' : ''}>
                    <td className="px-4 py-3 text-sm font-medium text-slate-900">{row.soNumber}</td>
                    <td className="px-4 py-3 text-sm text-slate-900">{row.customerName || '-'}</td>
                    <td className="px-4 py-3 text-sm">
                      <Badge variant={
                        row.status === 'shipped' ? 'success' :
                        row.status === 'partially_shipped' ? 'warning' : 'neutral'
                      }>{row.status}</Badge>
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-900">{formatDate(row.orderDate)}</td>
                    <td className="px-4 py-3 text-sm text-slate-900">
                      {row.requestedDate ? formatDate(row.requestedDate) : '-'}
                    </td>
                    <td className="px-4 py-3 text-sm text-right font-mono">
                      {row.shippedLines}/{row.totalLines}
                    </td>
                    <td className="px-4 py-3 text-sm text-right font-mono">
                      <span className={
                        row.fillRate >= 90 ? 'text-emerald-600' :
                        row.fillRate >= 70 ? 'text-amber-600' : 'text-rose-600'
                      }>
                        {row.fillRate}%
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {row.onTimeShipment ? (
                        <span className="text-emerald-600 font-semibold">✓</span>
                      ) : (
                        <span className="text-rose-600 font-semibold">✗</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {fillQuery.data.data.length === 0 && (
              <div className="text-center py-12 text-slate-500">
                No sales orders found
              </div>
            )}
          </div>
        )}
      </Section>
    </div>
  )
}

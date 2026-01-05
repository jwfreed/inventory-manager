import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getWorkOrderProgress } from '../api/reports'
import { useItemsList } from '../../items/queries'
import { Button, Card, Section, LoadingSpinner, ErrorState, Badge } from '@shared/ui'
import { formatNumber, formatDate } from '@shared/formatters'

export default function WorkOrderProgressPage() {
  const [statusFilter, setStatusFilter] = useState('')
  const [itemFilter, setItemFilter] = useState('')
  const [includeCompleted, setIncludeCompleted] = useState(false)
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')

  const progressQuery = useQuery({
    queryKey: ['work-order-progress', statusFilter, itemFilter, includeCompleted, startDate, endDate],
    queryFn: () => getWorkOrderProgress({
      status: statusFilter || undefined,
      itemId: itemFilter || undefined,
      includeCompleted,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      limit: 500,
    }),
    staleTime: 30_000,
  })

  const itemsQuery = useItemsList({ active: true, limit: 200 }, { staleTime: 60_000 })

  const exportToCsv = () => {
    if (!progressQuery.data?.data) return
    
    const headers = ['WO Number', 'Item SKU', 'Item Name', 'Status', 'Type', 'Planned Qty', 'Completed Qty', '% Complete', 'Due Date', 'Days Until Due', 'Late?']
    const rows = progressQuery.data.data.map(row => [
      row.workOrderNumber,
      row.itemSku,
      row.itemName,
      row.status,
      row.orderType,
      row.quantityPlanned,
      row.quantityCompleted,
      row.percentComplete,
      row.dueDate || 'N/A',
      row.daysUntilDue?.toString() || 'N/A',
      row.isLate ? 'Yes' : 'No',
    ])
    
    const csv = [headers, ...rows].map(row => row.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `work-order-progress-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const lateOrders = progressQuery.data?.data.filter(wo => wo.isLate).length || 0
  const totalOrders = progressQuery.data?.data.length || 0

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Work Order Progress Report</h1>
        <p className="mt-1 text-sm text-slate-600">
          Track work order completion status, late orders, and production progress
        </p>
      </div>

      {progressQuery.data && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
              <div className="text-xs uppercase tracking-wide text-slate-600 font-medium">On-Time Rate</div>
              <div className="mt-2 text-2xl font-bold text-emerald-600">
                {totalOrders > 0 ? Math.round(((totalOrders - lateOrders) / totalOrders) * 100) : 0}%
              </div>
            </div>
          </Card>
        </div>
      )}

      <Card>
        <div className="p-4 space-y-4">
          <div className="flex justify-between items-center">
            <h2 className="text-lg font-semibold text-slate-900">Filters</h2>
            <Button onClick={() => {
              setStatusFilter('')
              setItemFilter('')
              setIncludeCompleted(false)
              setStartDate('')
              setEndDate('')
            }} variant="outline" size="sm">Clear Filters</Button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Status</label>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              >
                <option value="">All Statuses</option>
                <option value="draft">Draft</option>
                <option value="released">Released</option>
                <option value="in_progress">In Progress</option>
                <option value="completed">Completed</option>
                <option value="closed">Closed</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Item</label>
              <select
                value={itemFilter}
                onChange={(e) => setItemFilter(e.target.value)}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              >
                <option value="">All Items</option>
                {itemsQuery.data?.map(item => (
                  <option key={item.id} value={item.id}>{item.sku} - {item.name}</option>
                ))}
              </select>
            </div>

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
                  checked={includeCompleted}
                  onChange={(e) => setIncludeCompleted(e.target.checked)}
                  className="rounded border-slate-300"
                />
                <span className="text-sm text-slate-700">Include Completed</span>
              </label>
            </div>
          </div>
        </div>
      </Card>

      <Section
        title="Work Orders"
        action={
          <Button onClick={exportToCsv} variant="outline" size="sm">
            Export CSV
          </Button>
        }
      >
        {progressQuery.isLoading && <LoadingSpinner />}
        {progressQuery.isError && <ErrorState message="Failed to load work order progress" />}
        
        {progressQuery.data && (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-600 uppercase tracking-wider">WO#</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-600 uppercase tracking-wider">Item</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-600 uppercase tracking-wider">Status</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-600 uppercase tracking-wider">Planned</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-600 uppercase tracking-wider">Completed</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-600 uppercase tracking-wider">% Done</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-600 uppercase tracking-wider">Due Date</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-600 uppercase tracking-wider">Days Left</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-slate-200">
                {progressQuery.data.data.map((row) => (
                  <tr key={row.workOrderId} className={row.isLate ? 'bg-rose-50' : ''}>
                    <td className="px-4 py-3 text-sm font-medium text-slate-900">{row.workOrderNumber}</td>
                    <td className="px-4 py-3 text-sm text-slate-900">
                      <div className="font-medium">{row.itemSku}</div>
                      <div className="text-xs text-slate-500">{row.itemName}</div>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <Badge variant={
                        row.status === 'completed' ? 'success' :
                        row.status === 'in_progress' ? 'info' :
                        row.status === 'released' ? 'warning' : 'neutral'
                      }>{row.status}</Badge>
                    </td>
                    <td className="px-4 py-3 text-sm text-right font-mono">{formatNumber(row.quantityPlanned)}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono">{formatNumber(row.quantityCompleted)}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono">
                      <span className={row.percentComplete >= 100 ? 'text-emerald-600 font-semibold' : ''}>
                        {row.percentComplete}%
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-900">
                      {row.dueDate ? formatDate(row.dueDate) : '-'}
                    </td>
                    <td className="px-4 py-3 text-sm text-right">
                      {row.daysUntilDue !== null ? (
                        <span className={row.isLate ? 'text-rose-600 font-semibold' : 'text-slate-900'}>
                          {row.daysUntilDue}
                        </span>
                      ) : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {progressQuery.data.data.length === 0 && (
              <div className="text-center py-12 text-slate-500">
                No work orders found matching the selected filters
              </div>
            )}
          </div>
        )}
      </Section>
    </div>
  )
}

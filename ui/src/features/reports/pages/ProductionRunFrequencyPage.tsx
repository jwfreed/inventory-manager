import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getProductionRunFrequency } from '../api/reports'
import { useItemsList } from '../../items/queries'
import { Button, Card, Section, LoadingSpinner, ErrorState } from '@shared/ui'
import { formatNumber, formatDate } from '@shared/formatters'

export default function ProductionRunFrequencyPage() {
  const [itemTypeFilter, setItemTypeFilter] = useState('')
  const [itemFilter, setItemFilter] = useState('')
  const [startDate, setStartDate] = useState(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10))
  const [endDate, setEndDate] = useState(new Date().toISOString().slice(0, 10))

  const frequencyQuery = useQuery({
    queryKey: ['production-run-frequency', itemTypeFilter, itemFilter, startDate, endDate],
    queryFn: () => getProductionRunFrequency({
      startDate,
      endDate,
      itemType: itemTypeFilter || undefined,
      itemId: itemFilter || undefined,
      limit: 500,
    }),
    staleTime: 60_000,
    enabled: Boolean(startDate && endDate),
  })

  const itemsQuery = useItemsList({ active: true, limit: 200 }, { staleTime: 60_000 })

  const exportToCsv = () => {
    if (!frequencyQuery.data?.data) return
    
    const headers = ['SKU', 'Item Name', 'Type', 'Total Runs', 'Total Qty Produced', 'Avg Batch Size', 'Last Production', 'Days Since']
    const rows = frequencyQuery.data.data.map(row => [
      row.itemSku,
      row.itemName,
      row.itemType,
      row.totalRuns,
      row.totalQuantityProduced,
      row.avgBatchSize,
      row.lastProductionDate ? formatDate(row.lastProductionDate) : 'Never',
      row.daysSinceLastProduction || 'N/A',
    ])
    
    const csv = [headers, ...rows].map(row => row.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `production-run-frequency-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const totalRuns = frequencyQuery.data?.data.reduce((sum, item) => sum + item.totalRuns, 0) || 0
  const totalProduced = frequencyQuery.data?.data.reduce((sum, item) => sum + item.totalQuantityProduced, 0) || 0

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Production Run Frequency</h1>
        <p className="mt-1 text-sm text-slate-600">
          Analyze production batch sizes and manufacturing frequency by item
        </p>
      </div>

      {frequencyQuery.data && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <div className="p-4">
              <div className="text-xs uppercase tracking-wide text-slate-600 font-medium">Total Runs</div>
              <div className="mt-2 text-2xl font-bold text-slate-900">{totalRuns}</div>
            </div>
          </Card>
          <Card>
            <div className="p-4">
              <div className="text-xs uppercase tracking-wide text-slate-600 font-medium">Total Produced</div>
              <div className="mt-2 text-2xl font-bold text-slate-900">{formatNumber(totalProduced)}</div>
            </div>
          </Card>
          <Card>
            <div className="p-4">
              <div className="text-xs uppercase tracking-wide text-slate-600 font-medium">Unique Items</div>
              <div className="mt-2 text-2xl font-bold text-slate-900">{frequencyQuery.data.data.length}</div>
            </div>
          </Card>
        </div>
      )}

      <Card>
        <div className="p-4 space-y-4">
          <h2 className="text-lg font-semibold text-slate-900">Filters</h2>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Start Date *</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                required
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">End Date *</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                required
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Item Type</label>
              <select
                value={itemTypeFilter}
                onChange={(e) => setItemTypeFilter(e.target.value)}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              >
                <option value="">All Types</option>
                <option value="finished">Finished Goods</option>
                <option value="wip">Work in Progress</option>
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
                  <option key={item.id} value={item.id}>{item.sku}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </Card>

      <Section
        title="Production Frequency"
        action={<Button onClick={exportToCsv} variant="outline" size="sm">Export CSV</Button>}
      >
        {frequencyQuery.isLoading && <LoadingSpinner />}
        {frequencyQuery.isError && <ErrorState message="Failed to load production data" />}
        
        {frequencyQuery.data && (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-600 uppercase">Item</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-600 uppercase">Runs</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-600 uppercase">Total Qty</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-600 uppercase">Avg Batch</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-600 uppercase">Last Production</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-600 uppercase">Days Ago</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-slate-200">
                {frequencyQuery.data.data.map((row) => (
                  <tr key={row.itemId}>
                    <td className="px-4 py-3 text-sm">
                      <div className="font-medium text-slate-900">{row.itemSku}</div>
                      <div className="text-xs text-slate-500">{row.itemName}</div>
                    </td>
                    <td className="px-4 py-3 text-sm text-right font-mono font-semibold">{row.totalRuns}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono">{formatNumber(row.totalQuantityProduced)}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono text-emerald-600">
                      {formatNumber(row.avgBatchSize)}
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-900">
                      {row.lastProductionDate ? formatDate(row.lastProductionDate) : 'Never'}
                    </td>
                    <td className="px-4 py-3 text-sm text-right font-mono">
                      {row.daysSinceLastProduction !== null ? (
                        <span className={
                          row.daysSinceLastProduction > 60 ? 'text-amber-600' :
                          row.daysSinceLastProduction > 90 ? 'text-rose-600' : 'text-slate-900'
                        }>
                          {row.daysSinceLastProduction}
                        </span>
                      ) : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {frequencyQuery.data.data.length === 0 && (
              <div className="text-center py-12 text-slate-500">
                No production data found for selected period
              </div>
            )}
          </div>
        )}
      </Section>
    </div>
  )
}

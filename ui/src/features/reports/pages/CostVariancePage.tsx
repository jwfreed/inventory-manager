import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getCostVariance } from '../api/reports'
import { Button, Card, Section, LoadingSpinner, ErrorState, Badge } from '@shared/ui'
import { formatNumber } from '@shared/formatters'

export default function CostVariancePage() {
  const [itemTypeFilter, setItemTypeFilter] = useState('')
  const [minVariance, setMinVariance] = useState<number>(10)

  const varianceQuery = useQuery({
    queryKey: ['cost-variance', itemTypeFilter, minVariance],
    queryFn: () => getCostVariance({
      itemType: itemTypeFilter || undefined,
      minVariancePercent: minVariance || undefined,
      limit: 500,
    }),
    staleTime: 60_000,
  })

  const exportToCsv = () => {
    if (!varianceQuery.data?.data) return
    
    const headers = ['SKU', 'Item Name', 'Std Cost', 'Avg Cost', 'Variance $', 'Variance %', 'Qty On Hand']
    const rows = varianceQuery.data.data.map(row => [
      row.itemSku,
      row.itemName,
      row.standardCost?.toFixed(2) || 'N/A',
      row.averageCost?.toFixed(2) || 'N/A',
      row.variance?.toFixed(2) || 'N/A',
      row.variancePercent?.toFixed(1) || 'N/A',
      row.quantityOnHand,
    ])
    
    const csv = [headers, ...rows].map(row => row.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `cost-variance-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Cost Variance Report</h1>
        <p className="mt-1 text-sm text-slate-600">
          Compare standard costs to actual average costs to identify pricing discrepancies
        </p>
      </div>

      <Card>
        <div className="p-4 space-y-4">
          <h2 className="text-lg font-semibold text-slate-900">Filters</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Item Type
              </label>
              <select
                value={itemTypeFilter}
                onChange={(e) => setItemTypeFilter(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
              >
                <option value="">All Types</option>
                <option value="raw">Raw Material</option>
                <option value="wip">WIP</option>
                <option value="finished">Finished Good</option>
                <option value="packaging">Packaging</option>
              </select>
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
                placeholder="10"
              />
              <span className="text-xs text-slate-600 mt-1">Show only variances above this %</span>
            </div>
            <div className="flex items-end">
              <Button variant="secondary" size="sm" onClick={exportToCsv} disabled={!varianceQuery.data?.data.length}>
                Export to CSV
              </Button>
            </div>
          </div>
        </div>
      </Card>

      <Section>
        {varianceQuery.isLoading ? (
          <LoadingSpinner />
        ) : varianceQuery.error ? (
          <ErrorState
            error={{ status: 500, message: 'Failed to load variance data. Please try again.' }}
            onRetry={() => varianceQuery.refetch()}
          />
        ) : !varianceQuery.data?.data?.length ? (
          <div className="text-center py-12">
            <p className="text-slate-500">No cost variances found matching filters.</p>
            <p className="text-xs text-slate-600 mt-1">Items need both standard cost and average cost to appear here.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Item
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Standard Cost
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Average Cost
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Variance $
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Variance %
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Qty On Hand
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-slate-200">
                {varianceQuery.data.data.map((row) => {
                  const varianceAbs = Math.abs(row.variancePercent || 0)
                  const isHighVariance = varianceAbs >= 20
                  const isMediumVariance = varianceAbs >= 10 && varianceAbs < 20
                  const varianceTone = isHighVariance ? 'text-rose-600' : isMediumVariance ? 'text-amber-600' : 'text-slate-900'
                  
                  return (
                    <tr key={row.itemId} className="hover:bg-slate-50">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm font-medium text-slate-900">{row.itemSku}</div>
                        <div className="text-xs text-slate-600">{row.itemName}</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-mono">
                        {row.standardCost != null ? (
                          <span className="text-slate-900">${row.standardCost.toFixed(2)}</span>
                        ) : (
                          <Badge variant="neutral">N/A</Badge>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-mono">
                        {row.averageCost != null ? (
                          <span className="text-slate-900">${row.averageCost.toFixed(2)}</span>
                        ) : (
                          <Badge variant="neutral">N/A</Badge>
                        )}
                      </td>
                      <td className={`px-6 py-4 whitespace-nowrap text-sm text-right font-mono font-semibold ${varianceTone}`}>
                        {row.variance != null ? `$${row.variance.toFixed(2)}` : '—'}
                      </td>
                      <td className={`px-6 py-4 whitespace-nowrap text-sm text-right font-mono font-semibold ${varianceTone}`}>
                        {row.variancePercent != null ? (
                          <span>
                            {row.variancePercent > 0 ? '+' : ''}{row.variancePercent.toFixed(1)}%
                          </span>
                        ) : '—'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-slate-600 font-mono">
                        {formatNumber(row.quantityOnHand)}
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

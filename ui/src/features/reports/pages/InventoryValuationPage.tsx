import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getInventoryValuation } from '../api/reports'
import { useLocationsList } from '../../locations/queries'
import { Button, Card, Section, LoadingSpinner, ErrorState, Badge } from '@shared/ui'
import { formatNumber } from '@shared/formatters'

export default function InventoryValuationPage() {
  const [locationFilter, setLocationFilter] = useState('')
  const [itemTypeFilter, setItemTypeFilter] = useState('')
  const [includeZeroQty, setIncludeZeroQty] = useState(false)

  const valuationQuery = useQuery({
    queryKey: ['inventory-valuation', locationFilter, itemTypeFilter, includeZeroQty],
    queryFn: () => getInventoryValuation({
      locationId: locationFilter || undefined,
      itemType: itemTypeFilter || undefined,
      includeZeroQty,
      limit: 500,
    }),
    staleTime: 60_000,
  })

  const locationsQuery = useLocationsList({ active: true, limit: 200 }, { staleTime: 60_000 })

  const exportToCsv = () => {
    if (!valuationQuery.data?.data) return
    
    const headers = ['SKU', 'Item Name', 'Location', 'UOM', 'Qty On Hand', 'Avg Cost', 'Std Cost', 'Extended Value']
    const rows = valuationQuery.data.data.map(row => [
      row.itemSku,
      row.itemName,
      `${row.locationCode} - ${row.locationName}`,
      row.uom,
      row.quantityOnHand,
      row.averageCost?.toFixed(2) || 'N/A',
      row.standardCost?.toFixed(2) || 'N/A',
      row.extendedValue?.toFixed(2) || '0.00',
    ])
    
    const csv = [headers, ...rows].map(row => row.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `inventory-valuation-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Inventory Valuation Report</h1>
        <p className="mt-1 text-sm text-slate-600">
          View total inventory value based on quantity on hand and average cost
        </p>
      </div>

      {valuationQuery.data?.summary && (
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <Card>
            <div className="p-4">
              <div className="text-xs uppercase tracking-wide text-slate-600 font-medium">Total Items</div>
              <div className="mt-2 text-2xl font-bold text-slate-900">
                {valuationQuery.data.summary.totalItems}
              </div>
            </div>
          </Card>
          <Card>
            <div className="p-4">
              <div className="text-xs uppercase tracking-wide text-slate-600 font-medium">Total Units</div>
              <div className="mt-2 text-2xl font-bold text-slate-900">
                {formatNumber(valuationQuery.data.summary.totalQuantity)}
              </div>
            </div>
          </Card>
          <Card>
            <div className="p-4">
              <div className="text-xs uppercase tracking-wide text-slate-600 font-medium">Total Value</div>
              <div className="mt-2 text-2xl font-bold text-emerald-600 font-mono">
                ${formatNumber(valuationQuery.data.summary.totalValue)}
              </div>
            </div>
          </Card>
          <Card>
            <div className="p-4">
              <div className="text-xs uppercase tracking-wide text-slate-600 font-medium">Valued Items</div>
              <div className="mt-2 text-2xl font-bold text-slate-900">
                {valuationQuery.data.summary.totalValuedItems}
              </div>
              <div className="text-xs text-slate-600">With costs set</div>
            </div>
          </Card>
          <Card>
            <div className="p-4">
              <div className="text-xs uppercase tracking-wide text-slate-600 font-medium">Unvalued Items</div>
              <div className="mt-2 text-2xl font-bold text-amber-600">
                {valuationQuery.data.summary.totalUnvaluedItems}
              </div>
              <div className="text-xs text-slate-600">Missing costs</div>
            </div>
          </Card>
        </div>
      )}

      <Card>
        <div className="p-4 space-y-4">
          <h2 className="text-lg font-semibold text-slate-900">Filters</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Location
              </label>
              <select
                value={locationFilter}
                onChange={(e) => setLocationFilter(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
              >
                <option value="">All Locations</option>
                {locationsQuery.data?.data.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.code} — {loc.name}
                  </option>
                ))}
              </select>
            </div>
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
            <div className="flex items-center pt-6">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                  checked={includeZeroQty}
                  onChange={(e) => setIncludeZeroQty(e.target.checked)}
                />
                <span className="text-slate-700">Include zero quantity</span>
              </label>
            </div>
          </div>
          <div className="flex justify-end">
            <Button variant="secondary" size="sm" onClick={exportToCsv} disabled={!valuationQuery.data?.data.length}>
              Export to CSV
            </Button>
          </div>
        </div>
      </Card>

      <Section>
        {valuationQuery.isLoading ? (
          <LoadingSpinner />
        ) : valuationQuery.error ? (
          <ErrorState
            error={{ status: 500, message: 'Failed to load valuation data. Please try again.' }}
            onRetry={() => valuationQuery.refetch()}
          />
        ) : !valuationQuery.data?.data?.length ? (
          <div className="text-center py-12">
            <p className="text-slate-500">No inventory found matching filters.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Item
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Location
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Qty On Hand
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Avg Cost
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Std Cost
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Extended Value
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-slate-200">
                {valuationQuery.data.data.map((row) => (
                  <tr key={`${row.itemId}-${row.locationId}-${row.uom}`} className="hover:bg-slate-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm font-medium text-slate-900">{row.itemSku}</div>
                      <div className="text-xs text-slate-600">{row.itemName}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-600">
                      {row.locationCode}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-slate-900 font-mono">
                      {formatNumber(row.quantityOnHand)} {row.uom}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-mono">
                      {row.averageCost != null ? (
                        <span className="text-slate-900">${row.averageCost.toFixed(2)}</span>
                      ) : (
                        <Badge variant="warning">N/A</Badge>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-slate-600 font-mono">
                      {row.standardCost != null ? `$${row.standardCost.toFixed(2)}` : '—'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-semibold font-mono">
                      {row.extendedValue != null ? (
                        <span className="text-emerald-600">${formatNumber(row.extendedValue)}</span>
                      ) : (
                        <Badge variant="warning">N/A</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  )
}

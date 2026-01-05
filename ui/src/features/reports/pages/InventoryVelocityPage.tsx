import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getInventoryVelocity } from '../api/reports'
import { useLocationsList } from '../../locations/queries'
import { Button, Card, Section, LoadingSpinner, ErrorState } from '@shared/ui'
import { formatNumber } from '@shared/formatters'
import type { Location } from '../../../api/types/locations'
import type { ApiError } from '../../../api/types/common'

const getDefaultStartDate = () => new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
const getDefaultEndDate = () => new Date().toISOString().slice(0, 10)

export default function InventoryVelocityPage() {
  const [locationFilter, setLocationFilter] = useState('')
  const [itemTypeFilter, setItemTypeFilter] = useState('')
  const [startDate, setStartDate] = useState(getDefaultStartDate())
  const [endDate, setEndDate] = useState(getDefaultEndDate())

  const velocityQuery = useQuery({
    queryKey: ['inventory-velocity', locationFilter, itemTypeFilter, startDate, endDate],
    queryFn: () => getInventoryVelocity({
      startDate,
      endDate,
      locationId: locationFilter || undefined,
      itemType: itemTypeFilter || undefined,
      limit: 500,
    }),
    staleTime: 60_000,
    enabled: Boolean(startDate && endDate),
  })

  const locationsQuery = useLocationsList({ active: true, limit: 200 }, { staleTime: 60_000 })

  const exportToCsv = () => {
    if (!velocityQuery.data?.data) return
    
    const headers = ['SKU', 'Item Name', 'Type', 'Total Movements', 'Qty In', 'Qty Out', 'Net Change', 'On Hand', 'Avg Daily Movement', 'Turnover Proxy']
    const rows = velocityQuery.data.data.map(row => [
      row.itemSku,
      row.itemName,
      row.itemType,
      row.totalMovements,
      row.quantityIn,
      row.quantityOut,
      row.netChange,
      row.currentOnHand,
      row.avgDailyMovement,
      row.turnoverProxy || 'N/A',
    ])
    
    const csv = [headers, ...rows].map(row => row.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `inventory-velocity-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Inventory Movement Velocity</h1>
        <p className="mt-1 text-sm text-slate-600">
          Analyze inventory turnover and movement frequency
        </p>
      </div>

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
              <label className="block text-sm font-medium text-slate-700 mb-1">Location</label>
              <select
                value={locationFilter}
                onChange={(e) => setLocationFilter(e.target.value)}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              >
                <option value="">All Locations</option>
                {locationsQuery.data?.data.map((loc: Location) => (
                  <option key={loc.id} value={loc.id}>{loc.code}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Item Type</label>
              <select
                value={itemTypeFilter}
                onChange={(e) => setItemTypeFilter(e.target.value)}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              >
                <option value="">All Types</option>
                <option value="raw">Raw Material</option>
                <option value="wip">Work in Progress</option>
                <option value="finished">Finished Goods</option>
                <option value="packaging">Packaging</option>
              </select>
            </div>
          </div>
        </div>
      </Card>

      <Section
        title="Velocity Analysis"
        action={<Button onClick={exportToCsv} variant="secondary" size="sm">Export CSV</Button>}
      >
        {velocityQuery.isLoading && <LoadingSpinner />}
        {velocityQuery.isError && <ErrorState error={velocityQuery.error as unknown as ApiError} />}
        
        {velocityQuery.data && (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-600 uppercase">Item</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-600 uppercase">Movements</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-600 uppercase">Qty In</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-600 uppercase">Qty Out</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-600 uppercase">On Hand</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-600 uppercase">Avg Daily</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-600 uppercase">Turnover</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-slate-200">
                {velocityQuery.data.data.map((row) => (
                  <tr key={row.itemId}>
                    <td className="px-4 py-3 text-sm">
                      <div className="font-medium text-slate-900">{row.itemSku}</div>
                      <div className="text-xs text-slate-500">{row.itemName}</div>
                    </td>
                    <td className="px-4 py-3 text-sm text-right font-mono">{row.totalMovements}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono text-emerald-600">{formatNumber(row.quantityIn)}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono text-rose-600">{formatNumber(row.quantityOut)}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono">{formatNumber(row.currentOnHand)}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono">{row.avgDailyMovement}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono font-semibold">
                      {row.turnoverProxy ? `${row.turnoverProxy}x` : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {velocityQuery.data.data.length === 0 && (
              <div className="text-center py-12 text-slate-500">
                No movement data found for selected period
              </div>
            )}
          </div>
        )}
      </Section>
    </div>
  )
}

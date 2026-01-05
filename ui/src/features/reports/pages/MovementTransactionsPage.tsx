import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getMovementTransactions } from '../api/reports'
import { useItemsList } from '../../items/queries'
import { useLocationsList } from '../../locations/queries'
import { Button, Card, Section, LoadingSpinner, ErrorState, Badge } from '@shared/ui'
import { formatNumber, formatDate } from '@shared/formatters'
import type { Item } from '../../../api/types/items'
import type { Location } from '../../../api/types/locations'
import type { ApiError } from '../../../api/types/common'

export default function MovementTransactionsPage() {
  const [itemFilter, setItemFilter] = useState('')
  const [locationFilter, setLocationFilter] = useState('')
  const [movementType, setMovementType] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')

  const transactionsQuery = useQuery({
    queryKey: ['movement-transactions', itemFilter, locationFilter, movementType, startDate, endDate],
    queryFn: () => getMovementTransactions({
      itemId: itemFilter || undefined,
      locationId: locationFilter || undefined,
      movementType: movementType || undefined,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      limit: 500,
    }),
    staleTime: 30_000,
  })

  const itemsQuery = useItemsList({ limit: 200 }, { staleTime: 60_000 })
  const locationsQuery = useLocationsList({ limit: 200 }, { staleTime: 60_000 })

  const exportToCsv = () => {
    if (!transactionsQuery.data?.data) return
    
    const headers = ['Date', 'Movement#', 'Type', 'Status', 'Item SKU', 'Location', 'Quantity', 'UOM', 'Unit Cost', 'Extended Value', 'Lot', 'Reference', 'Notes']
    const rows = transactionsQuery.data.data.map(row => [
      formatDate(row.createdAt),
      row.movementNumber,
      row.movementType,
      row.status,
      row.itemSku,
      row.locationCode,
      row.quantity,
      row.uom,
      row.unitCost?.toFixed(2) || 'N/A',
      row.extendedValue?.toFixed(2) || 'N/A',
      row.lotNumber || '',
      row.referenceNumber || '',
      row.notes || '',
    ])
    
    const csv = [headers, ...rows].map(row => row.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `movement-transactions-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const totalValue = transactionsQuery.data?.data.reduce((sum, row) => sum + (row.extendedValue || 0), 0) || 0

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Movement Transaction History</h1>
        <p className="mt-1 text-sm text-slate-600">
          Complete audit trail of all inventory movements
        </p>
      </div>

      {transactionsQuery.data && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <div className="p-4">
              <div className="text-xs uppercase tracking-wide text-slate-600 font-medium">Total Transactions</div>
              <div className="mt-2 text-2xl font-bold text-slate-900">{transactionsQuery.data.data.length}</div>
            </div>
          </Card>
          <Card>
            <div className="p-4">
              <div className="text-xs uppercase tracking-wide text-slate-600 font-medium">Total Value</div>
              <div className="mt-2 text-2xl font-bold text-slate-900 font-mono">${formatNumber(totalValue)}</div>
            </div>
          </Card>
          <Card>
            <div className="p-4">
              <div className="text-xs uppercase tracking-wide text-slate-600 font-medium">Posted</div>
              <div className="mt-2 text-2xl font-bold text-emerald-600">
                {transactionsQuery.data.data.filter(t => t.status === 'posted').length}
              </div>
            </div>
          </Card>
        </div>
      )}

      <Card>
        <div className="p-4 space-y-4">
          <h2 className="text-lg font-semibold text-slate-900">Filters</h2>

          <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Item</label>
              <select
                value={itemFilter}
                onChange={(e) => setItemFilter(e.target.value)}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              >
                <option value="">All Items</option>
                {itemsQuery.data?.data.map((item: Item) => (
                  <option key={item.id} value={item.id}>{item.sku}</option>
                ))}
              </select>
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
              <label className="block text-sm font-medium text-slate-700 mb-1">Movement Type</label>
              <select
                value={movementType}
                onChange={(e) => setMovementType(e.target.value)}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              >
                <option value="">All Types</option>
                <option value="receive">Receive</option>
                <option value="issue">Issue</option>
                <option value="transfer">Transfer</option>
                <option value="adjustment">Adjustment</option>
                <option value="production">Production</option>
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
          </div>
        </div>
      </Card>

      <Section
        title="Transactions"
        action={<Button onClick={exportToCsv} variant="secondary" size="sm">Export CSV</Button>}
      >
        {transactionsQuery.isLoading && <LoadingSpinner />}
        {transactionsQuery.isError && <ErrorState error={transactionsQuery.error as unknown as ApiError} />}
        
        {transactionsQuery.data && (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-600 uppercase">Date</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-600 uppercase">Movement#</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-600 uppercase">Type</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-600 uppercase">Item</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-600 uppercase">Location</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-600 uppercase">Quantity</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-600 uppercase">Value</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-600 uppercase">Reference</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-slate-200">
                {transactionsQuery.data.data.map((row) => (
                  <tr key={row.lineId}>
                    <td className="px-4 py-3 text-sm text-slate-900">{formatDate(row.createdAt)}</td>
                    <td className="px-4 py-3 text-sm font-medium text-slate-900">{row.movementNumber}</td>
                    <td className="px-4 py-3 text-sm">
                      <Badge variant="neutral">{row.movementType}</Badge>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <div className="font-medium">{row.itemSku}</div>
                      <div className="text-xs text-slate-500">{row.itemName}</div>
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-900">{row.locationCode}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono">
                      <span className={row.quantity > 0 ? 'text-emerald-600' : 'text-rose-600'}>
                        {formatNumber(row.quantity)}
                      </span> {row.uom}
                    </td>
                    <td className="px-4 py-3 text-sm text-right font-mono">
                      ${row.extendedValue ? formatNumber(row.extendedValue) : '-'}
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-600">{row.referenceNumber || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {transactionsQuery.data.data.length === 0 && (
              <div className="text-center py-12 text-slate-500">
                No transactions found
              </div>
            )}
          </div>
        )}
      </Section>
    </div>
  )
}

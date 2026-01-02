import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { listLicensePlates } from '@api/reports'
import type { LicensePlate } from '@api/types'
import { LoadingSpinner, ErrorState, Badge, Section, Card, Input } from '@shared/ui'

export function LicensePlatesPage() {
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [searchFilter, setSearchFilter] = useState('')

  const { data, isLoading, error } = useQuery({
    queryKey: ['license-plates', statusFilter, searchFilter],
    queryFn: () => listLicensePlates({ 
      limit: 100,
      status: statusFilter || undefined,
      search: searchFilter || undefined,
    }),
    staleTime: 60_000,
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">License Plates</h1>
        <p className="mt-1 text-sm text-slate-500">
          Track inventory by LPN for advanced warehouse management
        </p>
      </div>

      {/* Filter Card */}
      <Card>
        <div className="p-4 space-y-4">
          <h2 className="text-lg font-semibold text-slate-900">Filters</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Search LPN or Item
              </label>
              <Input
                type="text"
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                placeholder="Search by LPN, item ID..."
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Status
              </label>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
              >
                <option value="">All Statuses</option>
                <option value="active">Active</option>
                <option value="consumed">Consumed</option>
                <option value="shipped">Shipped</option>
                <option value="damaged">Damaged</option>
                <option value="quarantine">Quarantine</option>
                <option value="expired">Expired</option>
              </select>
            </div>
          </div>
        </div>
      </Card>

      <Section>
        {isLoading ? (
          <LoadingSpinner />
        ) : error ? (
          <ErrorState
            error={{ status: 500, message: 'Failed to load license plates. Please try again.' }}
          />
        ) : !data?.data?.length ? (
          <div className="text-center py-12">
            <p className="text-slate-500">No license plates found.</p>
          </div>
        ) : (
          <LpnTable lpns={data.data} />
        )}
      </Section>
    </div>
  )
}

function LpnTable({ lpns }: { lpns: LicensePlate[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200">
        <thead className="bg-slate-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
              LPN
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
              Status
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
              Item
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
              Location
            </th>
            <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider font-mono">
              Quantity
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
              Received
            </th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-slate-200">
          {lpns.map((lpn) => {
            const borderColor = 
              lpn.status === 'active' ? 'border-l-4 border-l-green-500' :
              lpn.status === 'quarantine' ? 'border-l-4 border-l-amber-500' :
              lpn.status === 'damaged' || lpn.status === 'expired' ? 'border-l-4 border-l-red-500' :
              'border-l-4 border-l-slate-200'
            
            return (
              <tr key={lpn.id} className={`hover:bg-slate-50 ${borderColor}`}>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="text-sm font-medium text-slate-900">{lpn.lpn}</div>
                  {lpn.containerType && (
                    <div className="text-xs text-slate-500">{lpn.containerType}</div>
                  )}
              </td>
              <td className="px-6 py-4 whitespace-nowrap">
                <StatusBadge status={lpn.status} />
              </td>
              <td className="px-6 py-4 whitespace-nowrap">
                  <div className="text-sm text-slate-900">{lpn.itemId}</div>
                  {lpn.lotId && <div className="text-xs text-slate-500">Lot: {lpn.lotId}</div>}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-600">
                  {lpn.locationId}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-slate-900 font-mono">
                  {Number(lpn.quantity).toLocaleString()} {lpn.uom}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-600">
                  {lpn.receivedAt
                    ? new Date(lpn.receivedAt).toLocaleDateString()
                    : '-'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function StatusBadge({ status }: { status: LicensePlate['status'] }) {
  const variantMap: Record<string, 'success' | 'warning' | 'danger' | 'neutral' | 'info'> = {
    active: 'success',
    consumed: 'neutral',
    shipped: 'info',
    damaged: 'danger',
    quarantine: 'warning',
    expired: 'danger',
  }

  return <Badge variant={variantMap[status] || 'neutral'}>{status}</Badge>
}

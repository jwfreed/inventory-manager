import { useQuery } from '@tanstack/react-query'
import { listLicensePlates } from '@api/reports'
import type { LicensePlate } from '@api/types'
import { LoadingSpinner, ErrorState, Badge, Section } from '@shared/ui'

export function LicensePlatesPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['license-plates'],
    queryFn: () => listLicensePlates({ limit: 100 }),
    staleTime: 60_000,
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">License Plates</h1>
        <p className="mt-1 text-sm text-gray-500">
          Track inventory by LPN for advanced warehouse management
        </p>
      </div>

      <Section>
        {isLoading ? (
          <LoadingSpinner />
        ) : error ? (
          <ErrorState
            error={{ status: 500, message: 'Failed to load license plates. Please try again.' }}
          />
        ) : !data?.data?.length ? (
          <div className="text-center py-12">
            <p className="text-gray-500">No license plates found.</p>
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
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              LPN
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Status
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Item
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Location
            </th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
              Quantity
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Received
            </th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {lpns.map((lpn) => (
            <tr key={lpn.id} className="hover:bg-gray-50">
              <td className="px-6 py-4 whitespace-nowrap">
                <div className="text-sm font-medium text-gray-900">{lpn.lpn}</div>
                {lpn.containerType && (
                  <div className="text-xs text-gray-500">{lpn.containerType}</div>
                )}
              </td>
              <td className="px-6 py-4 whitespace-nowrap">
                <StatusBadge status={lpn.status} />
              </td>
              <td className="px-6 py-4 whitespace-nowrap">
                <div className="text-sm text-gray-900">{lpn.itemId}</div>
                {lpn.lotId && <div className="text-xs text-gray-500">Lot: {lpn.lotId}</div>}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                {lpn.locationId}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">
                {Number(lpn.quantity).toLocaleString()} {lpn.uom}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                {lpn.receivedAt
                  ? new Date(lpn.receivedAt).toLocaleDateString()
                  : '-'}
              </td>
            </tr>
          ))}
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

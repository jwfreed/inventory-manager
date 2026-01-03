import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getAtp } from '@api/reports'
import type { AtpResult } from '@api/types'
import { Button, Card, LoadingSpinner, EmptyState, ErrorState, Section } from '@shared/ui'
import { useItemsList } from '../../items/queries'
import { useLocationsList } from '../../locations/queries'
import { Link } from 'react-router-dom'

export function AtpQueryPage() {
  const [itemId, setItemId] = useState('')
  const [locationId, setLocationId] = useState('')
  const [hasSearched, setHasSearched] = useState(false)

  // Load items and locations for dropdowns
  const itemsQuery = useItemsList(
    { lifecycleStatus: 'Active', limit: 1000 },
    { staleTime: 60_000 }
  )
  const locationsQuery = useLocationsList(
    { active: true, limit: 1000 },
    { staleTime: 60_000 }
  )

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['atp', itemId, locationId],
    queryFn: () => getAtp({ itemId: itemId || undefined, locationId: locationId || undefined }),
    enabled: hasSearched,
    staleTime: 30_000, // Fresh for 30s - ATP changes frequently
  })

  const handleSearch = () => {
    setHasSearched(true)
    refetch()
  }

  const handleClear = () => {
    setItemId('')
    setLocationId('')
    setHasSearched(false)
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Available to Promise</h1>
        <p className="mt-1 text-sm text-slate-600">
          Query inventory available for new orders (on-hand minus reservations)
        </p>
      </div>

      <Card>
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-slate-900">Search Filters</h2>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Item (optional)
              </label>
              <select
                value={itemId}
                onChange={(e) => setItemId(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
              >
                <option value="">All Items</option>
                {itemsQuery.data?.data.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.sku} - {item.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Location (optional)
              </label>
              <select
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
              >
                <option value="">All Locations</option>
                {locationsQuery.data?.data.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.code} - {location.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex gap-2">
            <Button onClick={handleSearch} disabled={isLoading}>
              {isLoading ? 'Searching...' : 'Search ATP'}
            </Button>
            <Button onClick={handleClear} variant="secondary" disabled={isLoading}>
              Clear
            </Button>
          </div>
        </div>
      </Card>

      {hasSearched && (
        <Section>
          {isLoading ? (
            <LoadingSpinner />
          ) : error ? (
            <ErrorState error={{ status: 500, message: 'Failed to load ATP data. Please try again.' }} />
          ) : !data?.data?.length ? (
            <EmptyState
              title="No ATP data found"
              description="Try adjusting your search filters or check that inventory exists for the specified criteria."
            />
          ) : (
            <AtpResultsTable results={data.data} />
          )}
        </Section>
      )}
    </div>
  )
}

function AtpResultsTable({ results }: { results: AtpResult[] }) {
  return (
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
            <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
              UOM
            </th>
            <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider font-mono">
              On Hand
            </th>
            <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider font-mono">
              Reserved
            </th>
            <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider font-mono">
              <span className="inline-flex items-center">
                Available to Promise
                <span className="ml-1 text-emerald-600">✓</span>
              </span>
            </th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-slate-200">
          {results.map((result, idx) => (
            <tr key={idx} className="hover:bg-slate-50">
              <td className="px-6 py-4 whitespace-nowrap text-sm">
                <Link to={`/items/${result.itemId}`} className="text-blue-600 hover:text-blue-800 hover:underline">
                  <div className="font-medium">{result.itemSku}</div>
                  <div className="text-slate-500 text-xs">{result.itemName}</div>
                </Link>
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm">
                <Link to={`/locations/${result.locationId}`} className="text-blue-600 hover:text-blue-800 hover:underline">
                  <div className="font-medium">{result.locationCode}</div>
                  <div className="text-slate-500 text-xs">{result.locationName}</div>
                </Link>
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-600">
                {result.uom}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-slate-900 font-mono">
                {Number(result.onHand).toLocaleString()}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-amber-600 font-mono">
                {Number(result.reserved).toLocaleString()}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-semibold font-mono">
                <span className={result.availableToPromise > 0 ? 'text-emerald-600' : 'text-slate-400'}>
                  {Number(result.availableToPromise).toLocaleString()}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

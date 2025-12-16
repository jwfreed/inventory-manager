import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getLocation, getLocationInventorySummary } from '../../../api/endpoints/locations'
import type { ApiError } from '../../../api/types'
import { Alert } from '../../../components/Alert'
import { Badge } from '../../../components/Badge'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { EmptyState } from '../../../components/EmptyState'
import { ErrorState } from '../../../components/ErrorState'
import { LoadingSpinner } from '../../../components/Loading'
import { Section } from '../../../components/Section'
import { formatDate, formatNumber } from '../../../lib/formatters'
import { LocationForm } from '../components/LocationForm'

export default function LocationDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [showEdit, setShowEdit] = useState(false)

  const locationQuery = useQuery({
    queryKey: ['location', id],
    queryFn: () => getLocation(id as string),
    enabled: !!id,
    retry: (count, err: ApiError) => err?.status !== 404 && count < 1,
  })

  const inventoryQuery = useQuery({
    queryKey: ['location-inventory', id],
    queryFn: () => getLocationInventorySummary(id as string),
    enabled: !!id,
    retry: 0,
  })

  useEffect(() => {
    if (locationQuery.isError && locationQuery.error?.status === 404) {
      navigate('/not-found', { replace: true })
    }
  }, [locationQuery.isError, locationQuery.error, navigate])

  const copyId = async () => {
    if (!id) return
    try {
      await navigator.clipboard.writeText(id)
    } catch {
      // ignore
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">Master data</p>
          <h2 className="text-2xl font-semibold text-slate-900">Location detail</h2>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => navigate('/locations')}>
            Back to list
          </Button>
          <Button variant="secondary" size="sm" onClick={copyId}>
            Copy ID
          </Button>
        </div>
      </div>

      {locationQuery.isLoading && <LoadingSpinner label="Loading location..." />}
      {locationQuery.isError && locationQuery.error && (
        <ErrorState error={locationQuery.error} onRetry={() => void locationQuery.refetch()} />
      )}

      {locationQuery.data && (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500">Code</div>
              <div className="text-xl font-semibold text-slate-900">{locationQuery.data.code}</div>
              <div className="text-sm text-slate-700">{locationQuery.data.name}</div>
              <div className="mt-2 flex items-center gap-2">
                <Badge variant="neutral">{locationQuery.data.type}</Badge>
                <Badge variant={locationQuery.data.active ? 'success' : 'danger'}>
                  {locationQuery.data.active ? 'Active' : 'Inactive'}
                </Badge>
              </div>
            </div>
            <div className="grid gap-2 text-right text-sm text-slate-700">
              <div>Parent: {locationQuery.data.parentLocationId || '—'}</div>
              <div>Path: {locationQuery.data.path || '—'}</div>
              <div>Depth: {locationQuery.data.depth ?? '—'}</div>
              <div>Created: {locationQuery.data.createdAt ? formatDate(locationQuery.data.createdAt) : '—'}</div>
              <div>Updated: {locationQuery.data.updatedAt ? formatDate(locationQuery.data.updatedAt) : '—'}</div>
            </div>
          </div>
        </Card>
      )}

      {locationQuery.data && (
        <Section title="Edit location">
          <div className="flex justify-end pb-2">
            <Button variant="secondary" size="sm" onClick={() => setShowEdit((v) => !v)}>
              {showEdit ? 'Hide form' : 'Edit location'}
            </Button>
          </div>
          {showEdit && (
            <LocationForm
              initialLocation={locationQuery.data}
              onSuccess={() => {
                setShowEdit(false)
                void locationQuery.refetch()
              }}
            />
          )}
        </Section>
      )}

      <Section title="Inventory snapshot">
        {inventoryQuery.isLoading && <LoadingSpinner label="Loading inventory..." />}
        {inventoryQuery.isError && (
          <Alert
            variant="info"
            title="Inventory summary not available"
            message="Endpoint may be missing. On-hand is derived from the movement ledger."
            action={
              <Button size="sm" variant="secondary" onClick={() => void inventoryQuery.refetch()}>
                Retry
              </Button>
            }
          />
        )}
        {!inventoryQuery.isLoading && !inventoryQuery.isError && inventoryQuery.data?.length === 0 && (
          <EmptyState
            title="Inventory summary not available yet"
            description="On-hand is derived from the movement ledger. No summary endpoint found."
          />
        )}
        {!inventoryQuery.isLoading && !inventoryQuery.isError && inventoryQuery.data && inventoryQuery.data.length > 0 && (
          <div className="overflow-hidden rounded-xl border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Item
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                    UOM
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                    On hand
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 bg-white">
                {inventoryQuery.data.map((row, idx) => (
                  <tr key={idx}>
                    <td className="px-4 py-3 text-sm text-slate-800">
                      {row.itemSku || row.itemName || row.itemId}
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-800">{row.uom}</td>
                    <td className="px-4 py-3 text-right text-sm text-slate-800">
                      {formatNumber(row.onHand)}
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

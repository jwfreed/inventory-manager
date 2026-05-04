import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '@shared/auth'
import { useLocation, useLocationInventorySummary } from '../queries'
import type { ApiError } from '../../../api/types'
import { formatDate, formatNumber } from '@shared/formatters'
import { LocationForm } from '../components/LocationForm'
import { ActiveFiltersSummary, Banner, ContextRail, DataTable, EmptyState, EntityPageLayout, ErrorState, PageHeader, Panel, StatusCell, Button, LoadingSpinner } from '@shared/ui'

export default function LocationDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { hasPermission } = useAuth()
  const [showEdit, setShowEdit] = useState(false)

  const canEditLocation = hasPermission('masterdata:write')

  const handleRequestEditLocation = () => {
    if (!canEditLocation) return
    setShowEdit(true)
  }

  const locationQuery = useLocation(id, {
    retry: (count, err: ApiError) => err?.status !== 404 && count < 1,
  })

  const inventoryQuery = useLocationInventorySummary(id, { retry: 0 })

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
      {locationQuery.isLoading && <LoadingSpinner label="Loading location..." />}
      {locationQuery.isError && locationQuery.error && <ErrorState error={locationQuery.error} onRetry={() => void locationQuery.refetch()} />}

      {locationQuery.data ? (
        <EntityPageLayout
          header={
            <PageHeader
              title={locationQuery.data.name}
              subtitle={`Location ${locationQuery.data.code}`}
              meta={
                <div className="flex flex-wrap items-center gap-2">
                  <StatusCell label={locationQuery.data.active ? 'Ready' : 'Blocked'} tone={locationQuery.data.active ? 'success' : 'danger'} compact />
                  <StatusCell label={locationQuery.data.type} tone="neutral" compact />
                </div>
              }
              action={
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" onClick={() => navigate('/locations')}>Back to list</Button>
                  <Button variant="secondary" size="sm" onClick={() => { if (id) navigate(`/inventory-adjustments/new?locationId=${id}`) }}>Adjust stock</Button>
                  <Button variant="secondary" size="sm" onClick={copyId}>Copy ID</Button>
                </div>
              }
            />
          }
          health={
            inventoryQuery.isError ? (
              <Banner
                severity="watch"
                title="Inventory summary not available"
                description="On-hand is derived from the movement ledger. Retry the location summary or investigate from linked items."
                action={<Button size="sm" variant="secondary" onClick={() => void inventoryQuery.refetch()}>Retry</Button>}
              />
            ) : undefined
          }
          contextRail={
            <ContextRail
              sections={[
                {
                  title: 'Entity identity',
                  description: 'Stable location properties.',
                  items: [
                    { label: 'Code', value: locationQuery.data.code },
                    { label: 'Type', value: locationQuery.data.type },
                    { label: 'Active', value: locationQuery.data.active ? 'Ready' : 'Blocked' },
                  ],
                },
                {
                  title: 'Supporting metadata',
                  description: 'Hierarchy and timestamps.',
                  items: [
                    { label: 'Parent', value: locationQuery.data.parentLocationId || '—' },
                    { label: 'Path', value: locationQuery.data.path || '—' },
                    { label: 'Depth', value: locationQuery.data.depth ?? '—' },
                    { label: 'Created', value: locationQuery.data.createdAt ? formatDate(locationQuery.data.createdAt) : '—' },
                    { label: 'Updated', value: locationQuery.data.updatedAt ? formatDate(locationQuery.data.updatedAt) : '—' },
                  ],
                },
              ]}
            />
          }
        >
          <Panel title="Location details" description="Operational properties for this location.">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-2xl border border-slate-200 bg-slate-50/70 px-4 py-4">
                <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Location path</div>
                <div className="mt-2 text-base font-semibold text-slate-950">{locationQuery.data.path || '—'}</div>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50/70 px-4 py-4">
                <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Hierarchy</div>
                <div className="mt-2 text-base font-semibold text-slate-950">Depth {locationQuery.data.depth ?? '—'}</div>
              </div>
            </div>
          </Panel>

          <Panel
            title="Edit location"
            description="Master data changes should remain isolated from inventory review."
            actions={<Button variant="secondary" size="sm" onClick={showEdit ? () => setShowEdit(false) : handleRequestEditLocation} disabled={!showEdit && !canEditLocation}>{showEdit ? 'Hide form' : 'Edit location'}</Button>}
          >
            {showEdit ? (
              <LocationForm
                initialLocation={locationQuery.data}
                onSuccess={() => {
                  setShowEdit(false)
                  void locationQuery.refetch()
                }}
              />
            ) : (
              <EmptyState
                title="Edit form hidden"
                description="Open the edit form when you need to change location metadata."
                action={<Button variant="secondary" size="sm" onClick={handleRequestEditLocation} disabled={!canEditLocation}>Edit location</Button>}
              />
            )}
          </Panel>

          <Panel
            title="Location inventory"
            description="This view is scoped to one location. The authoritative stock totals live in item inventory."
          >
            <div className="space-y-4">
              <ActiveFiltersSummary filters={[{ key: 'locationId', label: 'Location', value: locationQuery.data.code }]} />
              {inventoryQuery.isLoading ? <LoadingSpinner label="Loading inventory..." /> : null}
              {!inventoryQuery.isLoading && !inventoryQuery.isError && inventoryQuery.data?.length === 0 ? (
                <EmptyState
                  title="No inventory"
                  description="This location has no derived on-hand quantity yet."
                  action={<Button variant="secondary" size="sm" onClick={() => { if (id) navigate(`/inventory-adjustments/new?locationId=${id}`) }}>Adjust stock</Button>}
                />
              ) : null}
              {!inventoryQuery.isLoading && !inventoryQuery.isError && inventoryQuery.data && inventoryQuery.data.length > 0 ? (
                <DataTable
                  rows={inventoryQuery.data}
                  rowKey={(row) => `${row.itemId}-${row.uom}`}
                  columns={[
                    {
                      id: 'item',
                      header: 'Item',
                      priority: 'primary',
                      cell: (row) => (
                        <Link
                          to={`/items/${row.itemId}?locationId=${encodeURIComponent(id ?? '')}`}
                          className="text-brand-700 hover:underline"
                        >
                          {row.itemSku || row.itemName || row.itemId}
                        </Link>
                      ),
                    },
                    { id: 'uom', header: 'UOM', cell: (row) => row.uom },
                    { id: 'onHand', header: 'On hand', align: 'right', cell: (row) => formatNumber(row.onHand) },
                  ]}
                />
              ) : null}
            </div>
          </Panel>
        </EntityPageLayout>
      ) : null}
    </div>
  )
}

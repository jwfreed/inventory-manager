import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getItem } from '../../../api/endpoints/items'
import { listLocations } from '../../../api/endpoints/locations'
import { getInventorySnapshot } from '../../../api/endpoints/inventorySnapshot'
import { listBomsByItem } from '../../../api/endpoints/boms'
import type { ApiError } from '../../../api/types'
import { Alert } from '../../../components/Alert'
import { Badge } from '../../../components/Badge'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { EmptyState } from '../../../components/EmptyState'
import { ErrorState } from '../../../components/ErrorState'
import { LoadingSpinner } from '../../../components/Loading'
import { Section } from '../../../components/Section'
import { formatDate } from '../../../lib/formatters'
import { ItemForm } from '../components/ItemForm'
import { BomForm } from '../../boms/components/BomForm'
import { BomCard } from '../../boms/components/BomCard'
import { InventorySnapshotTable } from '../../inventory/components/InventorySnapshotTable'

const typeLabels: Record<string, string> = {
  raw: 'Raw',
  wip: 'WIP',
  finished: 'Finished',
  packaging: 'Packaging',
}

export default function ItemDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [showEdit, setShowEdit] = useState(false)
  const [showBomForm, setShowBomForm] = useState(false)
  const [selectedLocationId, setSelectedLocationId] = useState('')

  const itemQuery = useQuery({
    queryKey: ['item', id],
    queryFn: () => getItem(id as string),
    enabled: !!id,
    retry: (count, err: ApiError) => err?.status !== 404 && count < 1,
  })

  const locationsQuery = useQuery({
    queryKey: ['locations', 'active'],
    queryFn: () => listLocations({ active: true, limit: 100 }),
    staleTime: 60_000,
  })

  const snapshotQuery = useQuery({
    queryKey: ['inventory-snapshot', id, selectedLocationId],
    queryFn: () => getInventorySnapshot({ itemId: id as string, locationId: selectedLocationId }),
    enabled: !!id && !!selectedLocationId,
    staleTime: 30_000,
  })

  const bomsQuery = useQuery({
    queryKey: ['item-boms', id],
    queryFn: () => listBomsByItem(id as string),
    enabled: !!id,
    retry: 1,
  })

  useEffect(() => {
    if (itemQuery.isError && itemQuery.error?.status === 404) {
      navigate('/not-found', { replace: true })
    }
  }, [itemQuery.isError, itemQuery.error, navigate])

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
          <h2 className="text-2xl font-semibold text-slate-900">Item detail</h2>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => navigate('/items')}>
            Back to list
          </Button>
          <Button variant="secondary" size="sm" onClick={copyId}>
            Copy ID
          </Button>
        </div>
      </div>

      {itemQuery.isLoading && <LoadingSpinner label="Loading item..." />}
      {itemQuery.isError && itemQuery.error && (
        <ErrorState error={itemQuery.error} onRetry={() => void itemQuery.refetch()} />
      )}

      {itemQuery.data && (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500">SKU</div>
              <div className="text-xl font-semibold text-slate-900">{itemQuery.data.sku}</div>
              <div className="text-sm text-slate-700">{itemQuery.data.name}</div>
              {itemQuery.data.description && (
                <div className="mt-2 text-sm text-slate-600">{itemQuery.data.description}</div>
              )}
              <div className="mt-2 flex items-center gap-2">
                <Badge variant={itemQuery.data.active ? 'success' : 'danger'}>
                  {itemQuery.data.active ? 'Active' : 'Inactive'}
                </Badge>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-3 text-sm text-slate-700">
                <div>
                  <div className="text-xs uppercase tracking-wide text-slate-500">Type</div>
                  <div className="font-semibold text-slate-900">
                    {typeLabels[itemQuery.data.type] ?? itemQuery.data.type}
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wide text-slate-500">Default UOM</div>
                  <div className="font-semibold text-slate-900">
                    {itemQuery.data.defaultUom || '—'}
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wide text-slate-500">Default location</div>
                  <div className="font-semibold text-slate-900">
                    {itemQuery.data.defaultLocationCode ||
                      itemQuery.data.defaultLocationName ||
                      '—'}
                  </div>
                </div>
              </div>
            </div>
            <div className="grid gap-2 text-right text-sm text-slate-700">
              <div>Created: {itemQuery.data.createdAt ? formatDate(itemQuery.data.createdAt) : '—'}</div>
              <div>Updated: {itemQuery.data.updatedAt ? formatDate(itemQuery.data.updatedAt) : '—'}</div>
            </div>
          </div>
        </Card>
      )}

      {itemQuery.data && (
        <Section title="Edit item">
          <div className="flex justify-end pb-2">
            <Button variant="secondary" size="sm" onClick={() => setShowEdit((v) => !v)}>
              {showEdit ? 'Hide form' : 'Edit item'}
            </Button>
          </div>
          {showEdit && (
            <ItemForm
              initialItem={itemQuery.data}
              onSuccess={() => {
                setShowEdit(false)
                void itemQuery.refetch()
              }}
            />
          )}
        </Section>
      )}

      <Section
        title="Inventory snapshot"
        description="See what you can ship right now. Available = On hand - Already promised. Inventory position includes incoming."
      >
        <div className="flex flex-col gap-2 pb-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-slate-700">
            Choose a location to see on-hand, reserved, available, incoming, and inventory position.
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs uppercase tracking-wide text-slate-500">Location</label>
            <select
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
              value={selectedLocationId}
              onChange={(e) => setSelectedLocationId(e.target.value)}
            >
              <option value="">Select</option>
              {locationsQuery.data?.data.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.code || loc.name || loc.id}
                </option>
              ))}
            </select>
          </div>
        </div>
        {locationsQuery.isLoading && <LoadingSpinner label="Loading locations..." />}
        {locationsQuery.isError && (
          <Alert
            variant="error"
            title="Locations unavailable"
            message={(locationsQuery.error as ApiError)?.message ?? 'Could not load locations.'}
            action={
              <Button size="sm" variant="secondary" onClick={() => void locationsQuery.refetch()}>
                Retry
              </Button>
            }
          />
        )}
        {!selectedLocationId && !locationsQuery.isLoading && (
          <EmptyState
            title="Pick a location"
            description="Choose where you want to view availability. This helps separate on-hand vs incoming per site."
          />
        )}
        {selectedLocationId && snapshotQuery.isLoading && <LoadingSpinner label="Loading inventory snapshot..." />}
        {selectedLocationId && snapshotQuery.isError && (
          <ErrorState error={snapshotQuery.error as ApiError} onRetry={() => void snapshotQuery.refetch()} />
        )}
        {selectedLocationId && !snapshotQuery.isLoading && !snapshotQuery.isError && (
          <>
            {snapshotQuery.data && snapshotQuery.data.length === 0 && (
              <EmptyState
                title="No activity yet"
                description="No on-hand, reservations, or incoming found for this item at the selected location."
              />
            )}
            {snapshotQuery.data && snapshotQuery.data.length > 0 && (
              <InventorySnapshotTable
                rows={snapshotQuery.data}
                showItem={false}
                showLocation={false}
              />
            )}
          </>
        )}
      </Section>

      <Section title="BOMs">
        {bomsQuery.isLoading && <LoadingSpinner label="Loading BOMs..." />}
        {bomsQuery.isError && bomsQuery.error && (
          <ErrorState error={bomsQuery.error as unknown as ApiError} onRetry={() => void bomsQuery.refetch()} />
        )}
        <div className="flex justify-between items-center pb-2">
          <div className="text-sm text-slate-700">
            Define the recipe for this item. Activate a version before using it in a work order.
          </div>
          <Button variant="secondary" size="sm" onClick={() => setShowBomForm((v) => !v)}>
            {showBomForm ? 'Hide form' : 'Add BOM'}
          </Button>
        </div>
        {showBomForm && itemQuery.data && (
          <div className="pb-4">
            <BomForm
              outputItemId={itemQuery.data.id}
              onSuccess={() => {
                setShowBomForm(false)
                void bomsQuery.refetch()
              }}
            />
          </div>
        )}
        {!bomsQuery.isLoading && !bomsQuery.isError && bomsQuery.data?.boms.length === 0 && (
          <EmptyState
            title="No BOMs yet"
            description="Create a BOM to define components for this item."
          />
        )}
        <div className="grid gap-4">
          {bomsQuery.data?.boms.map((bom) => (
            <BomCard key={bom.id} bomId={bom.id} fallback={bom} onChanged={() => void bomsQuery.refetch()} />
          ))}
        </div>
      </Section>
    </div>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { ApiError, Location } from '@api/types'
import { useLocationsList } from '@features/locations/queries'
import { Alert, Button, EmptyState, LoadingSpinner, PageHeader, Panel, Select } from '@shared/ui'
import { InventoryCountsTable } from '../components/InventoryCountsTable'
import { useInventoryCountsList } from '../queries'

function buildWarehouseOptions(locations: Location[]) {
  const warehouseRoots = locations.filter((location) => location.type === 'warehouse')
  if (warehouseRoots.length > 0) {
    return warehouseRoots.map((location) => ({
      value: location.id,
      label: `${location.code} — ${location.name}`,
    }))
  }
  const seen = new Set<string>()
  return locations
    .filter((location) => {
      if (!location.warehouseId || seen.has(location.warehouseId)) return false
      seen.add(location.warehouseId)
      return true
    })
    .map((location) => ({
      value: location.warehouseId as string,
      label: location.warehouseId as string,
    }))
}

function formatError(err: unknown, fallback: string) {
  if (!err) return fallback
  if (typeof err === 'string') return err
  if (err instanceof Error && err.message) return err.message
  const apiErr = err as ApiError
  if (typeof apiErr?.message === 'string') return apiErr.message
  return fallback
}

export function InventoryCountsListPage() {
  const navigate = useNavigate()
  const [warehouseId, setWarehouseId] = useState('')
  const [status, setStatus] = useState('')
  const locationsQuery = useLocationsList({ active: true, limit: 1000 }, { staleTime: 60_000 })

  const warehouseOptions = useMemo(
    () => buildWarehouseOptions(locationsQuery.data?.data ?? []),
    [locationsQuery.data],
  )

  useEffect(() => {
    if (!warehouseId && warehouseOptions[0]?.value) {
      setWarehouseId(warehouseOptions[0].value)
    }
  }, [warehouseId, warehouseOptions])

  const countsQuery = useInventoryCountsList(
    warehouseId
      ? {
          warehouseId,
          status: status || undefined,
          limit: 100,
        }
      : undefined,
  )

  return (
    <div className="space-y-6">
      <PageHeader
        title="Inventory counts"
        subtitle="Create, review, and post cycle counts by warehouse."
        action={
          <div className="flex gap-2">
            <Link to="/inventory-transfers/new">
              <Button size="sm" variant="secondary">
                Inventory transfer
              </Button>
            </Link>
            <Link to="/inventory-counts/new">
              <Button size="sm">New count</Button>
            </Link>
          </div>
        }
      />
      <Panel title="Count queue" description="Draft counts remain editable until they are posted.">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Warehouse</span>
            <Select value={warehouseId} onChange={(event) => setWarehouseId(event.target.value)}>
              <option value="">Select warehouse</option>
              {warehouseOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Status</span>
            <Select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">All statuses</option>
              <option value="draft">Draft</option>
              <option value="posted">Posted</option>
              <option value="canceled">Canceled</option>
            </Select>
          </label>
        </div>
        {!warehouseId ? (
          <EmptyState
            title="Select a warehouse"
            description="Inventory counts are scoped by warehouse."
          />
        ) : countsQuery.isLoading ? (
          <LoadingSpinner label="Loading inventory counts..." />
        ) : countsQuery.isError ? (
          <Alert
            variant="error"
            title="Counts unavailable"
            message={formatError(countsQuery.error, 'Failed to load inventory counts.')}
          />
        ) : (countsQuery.data?.data ?? []).length === 0 ? (
          <EmptyState
            title="No inventory counts"
            description="Create a new cycle count for this warehouse."
          />
        ) : (
          <InventoryCountsTable
            rows={countsQuery.data?.data ?? []}
            onSelect={(row) => navigate(`/inventory-counts/${row.id}`)}
          />
        )}
      </Panel>
    </div>
  )
}

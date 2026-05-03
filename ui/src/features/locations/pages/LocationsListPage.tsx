import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { useAuth } from '@shared/auth'
import { createStandardWarehouseTemplate } from '../api/locations'
import { useLocationsList } from '../queries'
import type { ApiError, Location } from '../../../api/types'
import { ActiveFiltersSummary, Alert, Button, DataTable, EmptyState, FilterBar, LoadingSpinner, Panel, StatusCell } from '@shared/ui'
import { LocationForm } from '../components/LocationForm'
import { usePageChrome } from '../../../app/layout/usePageChrome'

const activeOptions = [
  { label: 'All', value: '' },
  { label: 'Active', value: 'true' },
  { label: 'Inactive', value: 'false' },
]

const locationTypes = ['warehouse', 'bin', 'store', 'customer', 'vendor', 'scrap', 'virtual']

export default function LocationsListPage() {
  const navigate = useNavigate()
  const { hasPermission } = useAuth()
  const { hideTitle } = usePageChrome()
  const [active, setActive] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [search, setSearch] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [includeReceivingQc, setIncludeReceivingQc] = useState(true)
  const includeWarehouseZones = typeFilter === 'warehouse'

  const { data, isLoading, isError, error, refetch } = useLocationsList({
    active: active === '' ? undefined : active === 'true',
    type: typeFilter || undefined,
    includeWarehouseZones,
  })

  const filtered = useMemo(() => {
    const list = data?.data ?? []
    const filteredByType =
      typeFilter && typeFilter !== 'warehouse' ? list.filter((loc) => loc.type === typeFilter) : list
    if (!search) return filteredByType
    const needle = search.toLowerCase()
    return filteredByType.filter(
      (loc) => loc.code.toLowerCase().includes(needle) || loc.name.toLowerCase().includes(needle),
    )
  }, [data?.data, search, typeFilter])
  const activeFilters = useMemo(
    () =>
      [
        active ? { key: 'active', label: 'State', value: active === 'true' ? 'Active' : 'Inactive' } : null,
        typeFilter ? { key: 'type', label: 'Type', value: typeFilter } : null,
        search ? { key: 'search', label: 'Search', value: search } : null,
      ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
    [active, search, typeFilter],
  )

  const templateMutation = useMutation<{ created: Location[]; skipped: string[] }, ApiError>({
    mutationFn: () => createStandardWarehouseTemplate({ includeReceivingQc }),
    onSuccess: () => {
      void refetch()
    },
  })

  const canCreateTemplate = hasPermission('masterdata:write')

  const handleCreateTemplate = () => {
    if (!canCreateTemplate) return
    templateMutation.mutate()
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        {!hideTitle && <h2 className="text-2xl font-semibold text-slate-900">Locations</h2>}
        <p className="max-w-3xl text-sm text-slate-600">
          Browse locations or add new storage/demand points. Use the form below or click a row to view details and edit.
        </p>
      </div>

      <Panel title="Create location" description="Create storage and demand points without leaving the list.">
        <div className="flex justify-end pb-2">
          <Button variant="secondary" size="sm" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? 'Hide form' : 'New location'}
          </Button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
          <div className="space-y-1">
            <div className="font-semibold text-slate-800">Create a standard warehouse</div>
            <div className="text-slate-600">
              Adds Raw, WIP, FG, Shipping Staging, Store/Customer, and optional Receiving/QC. Skips any that already exist.
            </div>
            {templateMutation.isSuccess && (
              <div className="text-xs text-green-700">
                Added {templateMutation.data?.created.length ?? 0} locations, skipped{' '}
                {templateMutation.data?.skipped.length ?? 0}.
              </div>
            )}
            {templateMutation.isError && (
              <div className="text-xs text-red-600">
                {(templateMutation.error as ApiError)?.message ?? 'Template creation failed.'}
              </div>
            )}
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-600">
              <input
                type="checkbox"
                checked={includeReceivingQc}
                onChange={(e) => setIncludeReceivingQc(e.target.checked)}
                disabled={templateMutation.isPending}
              />
              Include Receiving/QC
            </label>
            <Button
              size="sm"
              onClick={handleCreateTemplate}
              disabled={!canCreateTemplate || templateMutation.isPending}
            >
              {templateMutation.isPending ? 'Creating…' : 'Create standard warehouse'}
            </Button>
          </div>
        </div>
        {showCreate && (
          <LocationForm
            onSuccess={(location) => {
              setShowCreate(false)
              void refetch()
              navigate(`/locations/${location.id}`)
            }}
          />
        )}
      </Panel>

      <Panel title="Filters" description="Filter locations by operational state and type.">
        <FilterBar
          actions={<Button variant="secondary" size="sm" onClick={() => void refetch()}>Refresh</Button>}
          summary={
            <ActiveFiltersSummary
              filters={activeFilters}
              onClearOne={(key) => {
                if (key === 'active') setActive('')
                if (key === 'type') setTypeFilter('')
                if (key === 'search') setSearch('')
              }}
              onClearAll={() => {
                setActive('')
                setTypeFilter('')
                setSearch('')
              }}
            />
          }
        >
          <select
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
            value={active}
            onChange={(e) => setActive(e.target.value)}
          >
            {activeOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <select
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
          >
            <option value="">All types</option>
            {locationTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <input
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
            placeholder="Search by code or name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </FilterBar>
      </Panel>

      <Panel title="Locations" description="Browse locations with standardized operational state rendering.">
          {isLoading && <LoadingSpinner label="Loading locations..." />}
          {isError && error && (
            <Alert
              variant="error"
              title="Failed to load locations"
              message={error.message || 'Endpoint may be missing.'}
              action={
                <Button size="sm" variant="secondary" onClick={() => void refetch()}>
                  Retry
                </Button>
              }
            />
          )}
          {!isLoading && !isError && filtered.length === 0 && (
            <EmptyState
              title="No locations found"
              description="Adjust filters or create a new location to populate this list."
            />
          )}
          {!isLoading && !isError && filtered.length > 0 && (
            <DataTable
              stickyHeader
              keyboardNavigation
              rows={filtered}
              rowKey={(loc) => loc.id}
              onRowClick={(loc) => navigate(`/locations/${loc.id}`)}
              onRowOpen={(loc) => navigate(`/locations/${loc.id}`)}
              shortcutActions={[
                {
                  key: 'l',
                  run: (loc) => navigate(`/locations/${loc.id}`),
                },
              ]}
              getRowState={(loc) => (loc.active ? 'default' : 'warning')}
              columns={[
                { id: 'code', header: 'Code', priority: 'primary', cell: (loc) => loc.code },
                { id: 'name', header: 'Name', cell: (loc) => loc.name },
                { id: 'type', header: 'Type', cell: (loc) => <StatusCell label={loc.type} tone="neutral" compact /> },
                { id: 'active', header: 'State', cell: (loc) => <StatusCell label={loc.active ? 'Ready' : 'Blocked'} tone={loc.active ? 'success' : 'warning'} compact /> },
              ]}
              rowActions={(loc) => <Button variant="secondary" size="sm" onClick={() => navigate(`/locations/${loc.id}`)}>View</Button>}
            />
          )}
      </Panel>
    </div>
  )
}

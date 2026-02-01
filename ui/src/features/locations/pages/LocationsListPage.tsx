import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { createStandardWarehouseTemplate } from '../api/locations'
import { useLocationsList } from '../queries'
import type { ApiError, Location } from '../../../api/types'
import { Alert } from '../../../components/Alert'
import { Badge } from '../../../components/Badge'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { EmptyState } from '../../../components/EmptyState'
import { LoadingSpinner } from '../../../components/Loading'
import { Section } from '../../../components/Section'
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

  const templateMutation = useMutation<{ created: Location[]; skipped: string[] }, ApiError>({
    mutationFn: () => createStandardWarehouseTemplate({ includeReceivingQc }),
    onSuccess: () => {
      void refetch()
    },
  })

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        {!hideTitle && <h2 className="text-2xl font-semibold text-slate-900">Locations</h2>}
        <p className="max-w-3xl text-sm text-slate-600">
          Browse locations or add new storage/demand points. Use the form below or click a row to view details and edit.
        </p>
      </div>

      <Section title="Create location">
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
              onClick={() => templateMutation.mutate()}
              disabled={templateMutation.isPending}
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
      </Section>

      <Section title="Filters">
        <div className="flex flex-wrap items-center gap-3">
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
          <Button variant="secondary" size="sm" onClick={() => void refetch()}>
            Refresh
          </Button>
        </div>
      </Section>

      <Section title="Locations">
        <Card>
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
              title="No locations yet"
              description="Create locations with the form above or via API/migrations."
            />
          )}
          {!isLoading && !isError && filtered.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Code
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Name
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Type
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Active
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white">
                  {filtered.map((loc) => (
                    <tr
                      key={loc.id}
                      className="cursor-pointer hover:bg-slate-50"
                      onClick={() => navigate(`/locations/${loc.id}`)}
                    >
                      <td className="px-4 py-3 text-sm font-semibold text-slate-900">{loc.code}</td>
                      <td className="px-4 py-3 text-sm text-slate-800">{loc.name}</td>
                      <td className="px-4 py-3 text-sm text-slate-800">
                        <Badge variant="neutral">{loc.type}</Badge>
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-800">
                        <Badge variant={loc.active ? 'success' : 'danger'}>
                          {loc.active ? 'Active' : 'Inactive'}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </Section>
    </div>
  )
}

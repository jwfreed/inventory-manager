/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useAuth } from '@shared/auth'
import type { ApiError, Location } from '../../../api/types'
import { createLocation, updateLocation, type LocationPayload } from '../api/locations'
import { useLocationsList } from '../queries'
import {
  buildLocationBehaviorPayload,
  CAPABILITY_LABELS,
  defaultCapabilitiesForBehaviorRole,
  deriveLocationBehavior,
  isReservableEditable,
  LOCATION_BEHAVIOR_ROLE_OPTIONS,
  type LocationBehaviorRole,
  type LocationCapabilities,
} from '../locationBehavior'
import { Alert } from '../../../components/Alert'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { Input, Select } from '../../../components/Inputs'

const locationTypes = ['warehouse', 'bin', 'store', 'customer', 'vendor', 'scrap', 'virtual']

type Props = {
  initialLocation?: Location
  onSuccess?: (location: Location) => void
  onCancel?: () => void
  title?: string
}

export function LocationForm({ initialLocation, onSuccess, onCancel, title }: Props) {
  const { hasPermission } = useAuth()
  const isEdit = Boolean(initialLocation?.id)
  const [code, setCode] = useState(initialLocation?.code ?? '')
  const [name, setName] = useState(initialLocation?.name ?? '')
  const [type, setType] = useState(initialLocation?.type ?? locationTypes[0])
  const [parentLocationId, setParentLocationId] = useState(initialLocation?.parentLocationId ?? '')
  const [active, setActive] = useState(initialLocation?.active ?? true)
  const [maxWeight, setMaxWeight] = useState(initialLocation?.maxWeight ?? '')
  const [maxVolume, setMaxVolume] = useState(initialLocation?.maxVolume ?? '')
  const [zone, setZone] = useState(initialLocation?.zone ?? '')
  const initialBehavior = initialLocation ? deriveLocationBehavior(initialLocation) : null
  const [behaviorRole, setBehaviorRole] = useState<LocationBehaviorRole>(
    initialBehavior?.behaviorRole === 'warehouse_root' ? 'general_sellable' : initialBehavior?.behaviorRole ?? 'general_sellable',
  )
  const [capabilities, setCapabilities] = useState<LocationCapabilities>(
    initialBehavior?.capabilities ?? defaultCapabilitiesForBehaviorRole('general_sellable', true),
  )
  const [formError, setFormError] = useState<string | null>(null)
  const parentLocationsQuery = useLocationsList(
    { active: true, limit: 200 },
    { enabled: type !== 'warehouse', staleTime: 60_000 },
  )

  useEffect(() => {
    if (!initialLocation) return
    setCode(initialLocation.code)
    setName(initialLocation.name)
    setType(initialLocation.type)
    setParentLocationId(initialLocation.parentLocationId ?? '')
    setActive(initialLocation.active)
    setMaxWeight(initialLocation.maxWeight ?? '')
    setMaxVolume(initialLocation.maxVolume ?? '')
    setZone(initialLocation.zone ?? '')
    const nextBehavior = deriveLocationBehavior(initialLocation)
    setBehaviorRole(nextBehavior.behaviorRole === 'warehouse_root' ? 'general_sellable' : nextBehavior.behaviorRole)
    setCapabilities(nextBehavior.capabilities)
    setFormError(null)
  }, [initialLocation])

  const mutation = useMutation<Location, ApiError, LocationPayload>({
    mutationFn: (payload) =>
      isEdit && initialLocation?.id
        ? updateLocation(initialLocation.id, payload)
        : createLocation(payload),
    onSuccess: (location) => {
      onSuccess?.(location)
    },
  })

  const canSaveLocation = hasPermission('masterdata:write')

  const handleBehaviorRoleChange = (nextRole: LocationBehaviorRole) => {
    setBehaviorRole(nextRole)
    setCapabilities(defaultCapabilitiesForBehaviorRole(nextRole, nextRole === 'general_sellable' || nextRole === 'shipping'))
    setFormError(null)
  }

  const setCapability = (key: keyof LocationCapabilities, value: boolean) => {
    setCapabilities((current) => ({ ...current, [key]: value }))
    setFormError(null)
  }

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSaveLocation) return
    const behaviorPayload =
      type === 'warehouse'
        ? { role: null, isSellable: false }
        : buildLocationBehaviorPayload(behaviorRole, capabilities, initialLocation?.role)
    if ('error' in behaviorPayload && behaviorPayload.error) {
      setFormError(behaviorPayload.error)
      return
    }
    mutation.mutate({
      code,
      name,
      type,
      role: behaviorPayload.role,
      isSellable: behaviorPayload.isSellable,
      active,
      parentLocationId: parentLocationId ? parentLocationId : null,
      maxWeight: maxWeight ? Number(maxWeight) : null,
      maxVolume: maxVolume ? Number(maxVolume) : null,
      zone: zone || null,
    })
  }

  return (
    <Card title={title ?? (isEdit ? 'Edit location' : 'Create location')}>
      <form className="space-y-4" onSubmit={onSubmit}>
        {formError && (
          <Alert variant="error" title="Inventory behavior cannot be saved" message={formError} />
        )}
        {mutation.isError && (
          <Alert variant="error" title="Save failed" message={mutation.error.message} />
        )}
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Code</span>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="LOC-001"
              required
              disabled={mutation.isPending}
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Name</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Main warehouse"
              required
              disabled={mutation.isPending}
            />
          </label>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Type</span>
            <Select
              value={type}
              onChange={(e) => setType(e.target.value)}
              disabled={mutation.isPending}
              required
            >
              {locationTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Parent location</span>
            <Select
              value={parentLocationId}
              onChange={(e) => setParentLocationId(e.target.value)}
              disabled={mutation.isPending || type === 'warehouse' || parentLocationsQuery.isLoading}
            >
              <option value="">No parent</option>
              {parentLocationsQuery.data?.data
                ?.filter((loc) => loc.id !== initialLocation?.id)
                .map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.code} - {loc.name}
                  </option>
                ))}
              {parentLocationId &&
                !parentLocationsQuery.data?.data?.some((loc) => loc.id === parentLocationId) && (
                  <option value={parentLocationId}>{parentLocationId}</option>
                )}
            </Select>
          </label>
        </div>
        {type !== 'warehouse' && (
          <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
            <div>
              <div className="text-sm font-semibold text-slate-900">Inventory behavior</div>
              <div className="text-xs text-slate-600">
                These controls map to the current backend role and reservable inventory state.
              </div>
            </div>
            <label className="space-y-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-slate-500">Role</span>
              <Select
                value={behaviorRole}
                onChange={(e) => handleBehaviorRoleChange(e.target.value as LocationBehaviorRole)}
                disabled={mutation.isPending}
              >
                {LOCATION_BEHAVIOR_ROLE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
              <span className="block text-xs text-slate-500">
                {LOCATION_BEHAVIOR_ROLE_OPTIONS.find((option) => option.value === behaviorRole)?.description}
              </span>
            </label>
            {isReservableEditable(behaviorRole) && (
              <label className="flex items-start gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  aria-label="Reservable inventory"
                  className="mt-1"
                  checked={capabilities.canReserveForSales}
                  onChange={(e) => setCapability('canReserveForSales', e.target.checked)}
                  disabled={mutation.isPending}
                />
                <span>
                  <span className="font-medium">Reservable inventory</span>
                  <span className="ml-1 text-xs text-slate-500">
                    — used by sales reservations and, currently, production component reservations.
                  </span>
                </span>
              </label>
            )}
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Derived capabilities
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                {CAPABILITY_LABELS.filter((c) => c.key !== 'canReserveForSales').map((capability) => {
                  const enabled = capabilities[capability.key]
                  return (
                    <div
                      key={capability.key}
                      className={`rounded-lg border px-3 py-2 text-sm ${
                        enabled
                          ? 'border-green-200 bg-green-50 text-green-800'
                          : 'border-slate-200 bg-white text-slate-400'
                      }`}
                    >
                      {enabled ? capability.label : capability.label.replace(/^Can /, 'Cannot ')}
                    </div>
                  )
                })}
              </div>
              <p className="mt-1 text-xs text-slate-500">
                Derived from role. Not independently editable.
              </p>
            </div>
            {capabilities.canReserveForSales && behaviorRole === 'raw_material_store' && (
              <p className="text-xs text-amber-700">
                Current limitation: production component reservations use the same reservable inventory mechanism as sales reservations.
              </p>
            )}
          </div>
        )}
        <div className="grid gap-3 md:grid-cols-3">
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Max Weight</span>
            <Input
              type="number"
              value={maxWeight}
              onChange={(e) => setMaxWeight(e.target.value)}
              placeholder="e.g. 1000"
              disabled={mutation.isPending}
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Max Volume</span>
            <Input
              type="number"
              value={maxVolume}
              onChange={(e) => setMaxVolume(e.target.value)}
              placeholder="e.g. 100"
              disabled={mutation.isPending}
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Zone</span>
            <Input
              value={zone}
              onChange={(e) => setZone(e.target.value)}
              placeholder="e.g. Flammable"
              disabled={mutation.isPending}
            />
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            disabled={mutation.isPending}
          />
          <span>Active</span>
        </label>
        <div className="flex gap-2">
          {onCancel && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onCancel}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
          )}
          <Button type="submit" size="sm" disabled={!canSaveLocation || mutation.isPending}>
            {isEdit ? 'Save changes' : 'Create location'}
          </Button>
        </div>
        {!canSaveLocation && (
          <p className="text-xs text-slate-500">You need master data write permission to save locations.</p>
        )}
      </form>
    </Card>
  )
}

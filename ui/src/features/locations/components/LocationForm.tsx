/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { ApiError, Location } from '../../../api/types'
import { createLocation, updateLocation, type LocationPayload } from '../api/locations'
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
  const isEdit = Boolean(initialLocation?.id)
  const [code, setCode] = useState(initialLocation?.code ?? '')
  const [name, setName] = useState(initialLocation?.name ?? '')
  const [type, setType] = useState(initialLocation?.type ?? locationTypes[0])
  const [parentLocationId, setParentLocationId] = useState(initialLocation?.parentLocationId ?? '')
  const [active, setActive] = useState(initialLocation?.active ?? true)
  const [maxWeight, setMaxWeight] = useState(initialLocation?.maxWeight ?? '')
  const [maxVolume, setMaxVolume] = useState(initialLocation?.maxVolume ?? '')
  const [zone, setZone] = useState(initialLocation?.zone ?? '')

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

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    mutation.mutate({
      code,
      name,
      type,
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
            <span className="text-xs uppercase tracking-wide text-slate-500">Parent Location ID</span>
            <Input
              value={parentLocationId}
              onChange={(e) => setParentLocationId(e.target.value)}
              placeholder="Optional"
              disabled={mutation.isPending}
            />
          </label>
        </div>
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
          <Button type="submit" size="sm" disabled={mutation.isPending}>
            {isEdit ? 'Save changes' : 'Create location'}
          </Button>
        </div>
      </form>
    </Card>
  )
}

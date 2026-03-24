import { useEffect, useMemo, useState } from 'react'
import type { ApiError, Item, Location, ReplenishmentPolicy } from '@api/types'
import { useDebouncedValue } from '@shared'
import { Alert, Banner, Button, Card, Combobox, Input, Select, Textarea } from '@shared/ui'
import { useItemsList } from '@features/items/queries'
import { useLocationsList } from '@features/locations/queries'

type ReorderPointMode = 'manual' | 'derived'

type Props = {
  initialPolicy?: Partial<ReplenishmentPolicy> | null
  preselectedItem?: Item | null
  source?: string | null
  submitLabel?: string
  isSubmitting?: boolean
  submitError?: ApiError | null
  onCancel?: () => void
  onSubmit: (payload: {
    itemId: string
    uom: string
    siteLocationId?: string | null
    policyType: 'q_rop' | 'min_max'
    status?: 'active' | 'inactive'
    leadTimeDays?: number
    demandRatePerDay?: number
    safetyStockMethod: 'none' | 'fixed' | 'ppis'
    safetyStockQty?: number
    ppisPeriods?: number
    orderUpToLevelQty?: number
    reorderPointQty?: number
    orderQuantityQty?: number
    minOrderQty?: number
    maxOrderQty?: number
    notes?: string
  }) => void
}

type FieldErrors = Record<string, string>

function valueOrEmpty(value: number | string | null | undefined) {
  return value == null ? '' : String(value)
}

function defaultUomForItem(item?: Item | null) {
  return item?.stockingUom ?? item?.defaultUom ?? item?.canonicalUom ?? ''
}

function extractFieldErrors(details: unknown): FieldErrors {
  if (!details || typeof details !== 'object') return {}
  const payload = details as {
    error?: {
      fieldErrors?: Record<string, string[]>
      formErrors?: string[]
    }
  }
  return Object.fromEntries(
    Object.entries(payload.error?.fieldErrors ?? {}).flatMap(([field, messages]) => {
      const first = messages.find(Boolean)
      return first ? [[field, first]] : []
    }),
  )
}

function buildInitialState(initialPolicy?: Partial<ReplenishmentPolicy> | null, preselectedItem?: Item | null) {
  const selectedItemId = initialPolicy?.itemId ?? preselectedItem?.id ?? ''
  return {
    itemId: selectedItemId,
    siteLocationId: initialPolicy?.siteLocationId ?? '',
    uom: initialPolicy?.uom ?? defaultUomForItem(preselectedItem),
    policyType: (initialPolicy?.policyType ?? 'min_max') as 'q_rop' | 'min_max',
    status: (initialPolicy?.status ?? 'active') as 'active' | 'inactive',
    reorderPointMode:
      initialPolicy?.reorderPointQty != null ? 'manual' : 'derived' as ReorderPointMode,
    reorderPointQty: valueOrEmpty(initialPolicy?.reorderPointQty),
    leadTimeDays: valueOrEmpty(initialPolicy?.leadTimeDays),
    demandRatePerDay: valueOrEmpty(initialPolicy?.demandRatePerDay),
    safetyStockMethod: (initialPolicy?.safetyStockMethod ?? 'none') as 'none' | 'fixed' | 'ppis',
    safetyStockQty: valueOrEmpty(initialPolicy?.safetyStockQty),
    ppisPeriods: valueOrEmpty(initialPolicy?.ppisPeriods),
    orderUpToLevelQty: valueOrEmpty(initialPolicy?.orderUpToLevelQty),
    orderQuantityQty: valueOrEmpty(initialPolicy?.orderQuantityQty),
    minOrderQty: valueOrEmpty(initialPolicy?.minOrderQty),
    maxOrderQty: valueOrEmpty(initialPolicy?.maxOrderQty),
    notes: initialPolicy?.notes ?? '',
  }
}

function parseNumber(value: string, integer = false) {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const parsed = integer ? Number.parseInt(trimmed, 10) : Number.parseFloat(trimmed)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

export function ReplenishmentPolicyForm({
  initialPolicy,
  preselectedItem,
  source,
  submitLabel = 'Create policy',
  isSubmitting = false,
  submitError,
  onCancel,
  onSubmit,
}: Props) {
  const [itemSearch, setItemSearch] = useState('')
  const debouncedItemSearch = useDebouncedValue(itemSearch, 200)
  const [localFieldErrors, setLocalFieldErrors] = useState<FieldErrors>({})
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false)
  const [state, setState] = useState(() => buildInitialState(initialPolicy, preselectedItem))

  useEffect(() => {
    setState(buildInitialState(initialPolicy, preselectedItem))
    setLocalFieldErrors({})
  }, [initialPolicy, preselectedItem])

  const itemsQuery = useItemsList(
    {
      limit: 20,
      search: debouncedItemSearch || undefined,
      lifecycleStatus: 'Active',
    },
    { staleTime: 60_000, retry: 1 },
  )

  const locationsQuery = useLocationsList(
    { active: true, limit: 1000 },
    { staleTime: 60_000, retry: 1 },
  )

  const itemOptions = useMemo(() => {
    const options = (itemsQuery.data?.data ?? []).map((item) => ({
      value: item.id,
      label: `${item.sku} — ${item.name}`,
      keywords: `${item.sku} ${item.name}`,
    }))
    if (preselectedItem && !options.some((option) => option.value === preselectedItem.id)) {
      options.unshift({
        value: preselectedItem.id,
        label: `${preselectedItem.sku} — ${preselectedItem.name}`,
        keywords: `${preselectedItem.sku} ${preselectedItem.name}`,
      })
    }
    return options
  }, [itemsQuery.data, preselectedItem])

  const itemLookup = useMemo(() => {
    const map = new Map<string, Item>()
    itemsQuery.data?.data?.forEach((item) => map.set(item.id, item))
    if (preselectedItem) map.set(preselectedItem.id, preselectedItem)
    return map
  }, [itemsQuery.data, preselectedItem])

  const selectedItem = state.itemId ? itemLookup.get(state.itemId) ?? preselectedItem ?? null : null

  const locationOptions = useMemo(() => {
    const sorted = [...(locationsQuery.data?.data ?? [])].sort((left, right) => {
      const leftPriority = Number(Boolean(left.isSellable || left.type === 'warehouse'))
      const rightPriority = Number(Boolean(right.isSellable || right.type === 'warehouse'))
      return rightPriority - leftPriority || left.code.localeCompare(right.code)
    })
    return sorted.map((location) => ({
      value: location.id,
      label: `${location.code} — ${location.name}`,
      keywords: `${location.code} ${location.name} ${location.type}`,
    }))
  }, [locationsQuery.data])

  const backendFieldErrors = useMemo(() => extractFieldErrors(submitError?.details), [submitError])
  const fieldErrors = { ...backendFieldErrors, ...localFieldErrors }

  const update = (patch: Partial<typeof state>) => {
    setState((current) => ({ ...current, ...patch }))
  }

  const itemHelper = selectedItem
    ? `Default UOM ${defaultUomForItem(selectedItem) || 'not set'}`
    : undefined

  const validate = () => {
    const nextErrors: FieldErrors = {}
    if (!state.itemId) nextErrors.itemId = 'Select an item.'
    if (!state.uom.trim()) nextErrors.uom = 'UOM is required.'
    if (!state.siteLocationId) nextErrors.siteLocationId = 'Select a location.'
    if (state.reorderPointMode === 'manual') {
      const reorderPointQty = parseNumber(state.reorderPointQty)
      if (reorderPointQty === undefined) {
        nextErrors.reorderPointQty = 'Reorder point is required.'
      } else if (!Number.isFinite(reorderPointQty) || reorderPointQty < 0) {
        nextErrors.reorderPointQty = 'Enter a non-negative reorder point.'
      }
    } else {
      const leadTimeDays = parseNumber(state.leadTimeDays, true)
      const demandRatePerDay = parseNumber(state.demandRatePerDay)
      if (leadTimeDays === undefined || !Number.isFinite(leadTimeDays) || leadTimeDays < 0) {
        nextErrors.leadTimeDays = 'Enter lead time days.'
      }
      if (demandRatePerDay === undefined || !Number.isFinite(demandRatePerDay) || demandRatePerDay < 0) {
        nextErrors.demandRatePerDay = 'Enter demand rate per day.'
      }
    }
    if (state.policyType === 'min_max') {
      const orderUpToLevelQty = parseNumber(state.orderUpToLevelQty)
      if (orderUpToLevelQty === undefined || !Number.isFinite(orderUpToLevelQty) || orderUpToLevelQty < 0) {
        nextErrors.orderUpToLevelQty = 'Enter order-up-to level.'
      }
    }
    if (state.policyType === 'q_rop') {
      const orderQuantityQty = parseNumber(state.orderQuantityQty)
      if (orderQuantityQty === undefined || !Number.isFinite(orderQuantityQty) || orderQuantityQty <= 0) {
        nextErrors.orderQuantityQty = 'Enter a fixed order quantity greater than 0.'
      }
    }
    if (state.safetyStockMethod === 'fixed') {
      const safetyStockQty = parseNumber(state.safetyStockQty)
      if (safetyStockQty === undefined || !Number.isFinite(safetyStockQty) || safetyStockQty < 0) {
        nextErrors.safetyStockQty = 'Enter safety stock quantity.'
      }
    }
    if (state.safetyStockMethod === 'ppis') {
      const ppisPeriods = parseNumber(state.ppisPeriods, true)
      if (ppisPeriods === undefined || !Number.isFinite(ppisPeriods) || ppisPeriods <= 0) {
        nextErrors.ppisPeriods = 'Enter PPIS periods.'
      }
      const demandRatePerDay = parseNumber(state.demandRatePerDay)
      if (demandRatePerDay === undefined || !Number.isFinite(demandRatePerDay) || demandRatePerDay < 0) {
        nextErrors.demandRatePerDay = 'Demand rate per day is required for PPIS.'
      }
    }
    const minOrderQty = parseNumber(state.minOrderQty)
    const maxOrderQty = parseNumber(state.maxOrderQty)
    if (
      minOrderQty !== undefined &&
      maxOrderQty !== undefined &&
      Number.isFinite(minOrderQty) &&
      Number.isFinite(maxOrderQty) &&
      maxOrderQty < minOrderQty
    ) {
      nextErrors.maxOrderQty = 'Maximum order quantity must be greater than or equal to minimum order quantity.'
    }
    const reorderPointQty = parseNumber(state.reorderPointQty)
    const orderUpToLevelQty = parseNumber(state.orderUpToLevelQty)
    if (
      state.policyType === 'min_max' &&
      state.reorderPointMode === 'manual' &&
      reorderPointQty !== undefined &&
      orderUpToLevelQty !== undefined &&
      Number.isFinite(reorderPointQty) &&
      Number.isFinite(orderUpToLevelQty) &&
      orderUpToLevelQty < reorderPointQty
    ) {
      nextErrors.orderUpToLevelQty = 'Order up to level must be greater than or equal to reorder point.'
    }
    setLocalFieldErrors(nextErrors)
    return Object.keys(nextErrors).length === 0
  }

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!validate()) return
    const payload = {
      itemId: state.itemId,
      uom: state.uom.trim(),
      siteLocationId: state.siteLocationId || null,
      policyType: state.policyType,
      status: state.status,
      safetyStockMethod: state.safetyStockMethod,
      reorderPointQty: state.reorderPointMode === 'manual' ? parseNumber(state.reorderPointQty) : undefined,
      leadTimeDays: state.reorderPointMode === 'derived' ? parseNumber(state.leadTimeDays, true) : undefined,
      demandRatePerDay: state.reorderPointMode === 'derived' || state.safetyStockMethod === 'ppis'
        ? parseNumber(state.demandRatePerDay)
        : undefined,
      safetyStockQty: state.safetyStockMethod === 'fixed' ? parseNumber(state.safetyStockQty) : undefined,
      ppisPeriods: state.safetyStockMethod === 'ppis' ? parseNumber(state.ppisPeriods, true) : undefined,
      orderUpToLevelQty: state.policyType === 'min_max' ? parseNumber(state.orderUpToLevelQty) : undefined,
      orderQuantityQty: state.policyType === 'q_rop' ? parseNumber(state.orderQuantityQty) : undefined,
      minOrderQty: state.minOrderQty.trim() ? parseNumber(state.minOrderQty) : undefined,
      maxOrderQty: state.maxOrderQty.trim() ? parseNumber(state.maxOrderQty) : undefined,
      notes: state.notes.trim() || undefined,
    }
    onSubmit(payload)
  }

  return (
    <form className="space-y-6" onSubmit={submit}>
      {source === 'dashboard' ? (
        <Banner
          severity="watch"
          title="Configure replenishment monitoring"
          description="Create a policy record to move dashboard monitoring from not configured to configured."
        />
      ) : null}
      {submitError && !Object.keys(backendFieldErrors).length ? (
        <Alert variant="error" title="Failed to create policy" message={submitError.message} />
      ) : null}

      <Card className="space-y-4 p-5">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Scope</h2>
          <p className="mt-1 text-sm text-slate-500">Policies are standalone records scoped to item, location, and UOM.</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <Combobox
              label="Item"
              value={state.itemId}
              options={itemOptions}
              required
              loading={itemsQuery.isLoading}
              error={fieldErrors.itemId}
              helper={itemHelper}
              emptyMessage="No items found"
              onChange={(nextItemId) => {
                const nextItem = itemLookup.get(nextItemId)
                update({
                  itemId: nextItemId,
                  uom: state.uom || defaultUomForItem(nextItem),
                })
              }}
              onQueryChange={setItemSearch}
            />
            {fieldErrors.itemId ? <p className="mt-1 text-xs text-rose-600">{fieldErrors.itemId}</p> : null}
          </div>
          <div>
            <label className="space-y-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-slate-500">Location<span className="ml-0.5 text-red-500">*</span></span>
              <Select
                value={state.siteLocationId}
                onChange={(event) => update({ siteLocationId: event.target.value })}
                aria-invalid={fieldErrors.siteLocationId ? true : undefined}
              >
                <option value="">Select location</option>
                {locationOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </label>
            {fieldErrors.siteLocationId ? <p className="mt-1 text-xs text-rose-600">{fieldErrors.siteLocationId}</p> : null}
          </div>
          <div>
            <label className="space-y-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-slate-500">UOM<span className="ml-0.5 text-red-500">*</span></span>
              <Input
                value={state.uom}
                onChange={(event) => update({ uom: event.target.value })}
                placeholder="each"
                aria-invalid={fieldErrors.uom ? true : undefined}
              />
            </label>
            {fieldErrors.uom ? <p className="mt-1 text-xs text-rose-600">{fieldErrors.uom}</p> : null}
          </div>
        </div>
      </Card>

      <Card className="space-y-4 p-5">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Policy type</h2>
          <p className="mt-1 text-sm text-slate-500">Choose how reorder quantity is calculated when the trigger is met.</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Policy type</span>
            <Select
              value={state.policyType}
              onChange={(event) => update({ policyType: event.target.value as 'q_rop' | 'min_max' })}
            >
              <option value="min_max">Min-Max (s,S)</option>
              <option value="q_rop">Fixed order / reorder point (s,Q)</option>
            </Select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Status</span>
            <Select value={state.status} onChange={(event) => update({ status: event.target.value as 'active' | 'inactive' })}>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </Select>
          </label>
        </div>
      </Card>

      <Card className="space-y-4 p-5">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Trigger configuration</h2>
          <p className="mt-1 text-sm text-slate-500">Set reorder point directly or derive it from lead time and demand.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant={state.reorderPointMode === 'manual' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => update({ reorderPointMode: 'manual' })}
          >
            Set reorder point manually
          </Button>
          <Button
            type="button"
            variant={state.reorderPointMode === 'derived' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => update({ reorderPointMode: 'derived' })}
          >
            Derive from lead time and demand
          </Button>
        </div>
        {state.reorderPointMode === 'manual' ? (
          <div>
            <label className="space-y-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-slate-500">Reorder point</span>
              <Input
                value={state.reorderPointQty}
                onChange={(event) => update({ reorderPointQty: event.target.value })}
                inputMode="decimal"
                placeholder="0"
                aria-invalid={fieldErrors.reorderPointQty ? true : undefined}
              />
            </label>
            {fieldErrors.reorderPointQty ? <p className="mt-1 text-xs text-rose-600">{fieldErrors.reorderPointQty}</p> : null}
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">Lead time days</span>
                <Input
                  value={state.leadTimeDays}
                  onChange={(event) => update({ leadTimeDays: event.target.value })}
                  inputMode="numeric"
                  placeholder="0"
                  aria-invalid={fieldErrors.leadTimeDays ? true : undefined}
                />
              </label>
              {fieldErrors.leadTimeDays ? <p className="mt-1 text-xs text-rose-600">{fieldErrors.leadTimeDays}</p> : null}
            </div>
            <div>
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">Demand rate per day</span>
                <Input
                  value={state.demandRatePerDay}
                  onChange={(event) => update({ demandRatePerDay: event.target.value })}
                  inputMode="decimal"
                  placeholder="0"
                  aria-invalid={fieldErrors.demandRatePerDay ? true : undefined}
                />
              </label>
              {fieldErrors.demandRatePerDay ? <p className="mt-1 text-xs text-rose-600">{fieldErrors.demandRatePerDay}</p> : null}
            </div>
          </div>
        )}
      </Card>

      <Card className="space-y-4 p-5">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Quantity behavior</h2>
          <p className="mt-1 text-sm text-slate-500">Choose whether to order up to a level or place a fixed replenishment quantity.</p>
        </div>
        {state.policyType === 'min_max' ? (
          <div>
            <label className="space-y-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-slate-500">Order up to level</span>
              <Input
                value={state.orderUpToLevelQty}
                onChange={(event) => update({ orderUpToLevelQty: event.target.value })}
                inputMode="decimal"
                placeholder="0"
                aria-invalid={fieldErrors.orderUpToLevelQty ? true : undefined}
              />
            </label>
            {fieldErrors.orderUpToLevelQty ? <p className="mt-1 text-xs text-rose-600">{fieldErrors.orderUpToLevelQty}</p> : null}
          </div>
        ) : (
          <div>
            <label className="space-y-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-slate-500">Fixed order quantity</span>
              <Input
                value={state.orderQuantityQty}
                onChange={(event) => update({ orderQuantityQty: event.target.value })}
                inputMode="decimal"
                placeholder="0"
                aria-invalid={fieldErrors.orderQuantityQty ? true : undefined}
              />
            </label>
            {fieldErrors.orderQuantityQty ? <p className="mt-1 text-xs text-rose-600">{fieldErrors.orderQuantityQty}</p> : null}
          </div>
        )}

        <details className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3" open={showAdvancedSettings}>
          <summary
            className="cursor-pointer text-sm font-semibold text-slate-700"
            onClick={(event) => {
              event.preventDefault()
              setShowAdvancedSettings((current) => !current)
            }}
          >
            Advanced settings
          </summary>
          {showAdvancedSettings ? (
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <div>
                <label className="space-y-1 text-sm">
                  <span className="text-xs uppercase tracking-wide text-slate-500">Minimum order quantity</span>
                  <Input
                    value={state.minOrderQty}
                    onChange={(event) => update({ minOrderQty: event.target.value })}
                    inputMode="decimal"
                    placeholder="Optional"
                  />
                </label>
              </div>
              <div>
                <label className="space-y-1 text-sm">
                  <span className="text-xs uppercase tracking-wide text-slate-500">Maximum order quantity</span>
                  <Input
                    value={state.maxOrderQty}
                    onChange={(event) => update({ maxOrderQty: event.target.value })}
                    inputMode="decimal"
                    placeholder="Optional"
                    aria-invalid={fieldErrors.maxOrderQty ? true : undefined}
                  />
                </label>
                {fieldErrors.maxOrderQty ? <p className="mt-1 text-xs text-rose-600">{fieldErrors.maxOrderQty}</p> : null}
              </div>
            </div>
          ) : null}
        </details>
      </Card>

      <Card className="space-y-4 p-5">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Buffer settings</h2>
          <p className="mt-1 text-sm text-slate-500">PPIS is treated as cycle coverage metadata, not as safety stock inflation.</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Safety stock method</span>
            <Select
              value={state.safetyStockMethod}
              onChange={(event) =>
                update({ safetyStockMethod: event.target.value as 'none' | 'fixed' | 'ppis' })
              }
            >
              <option value="none">None</option>
              <option value="fixed">Fixed safety stock</option>
              <option value="ppis">PPIS cycle coverage</option>
            </Select>
          </label>
          {state.safetyStockMethod === 'fixed' ? (
            <div>
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">Safety stock quantity</span>
                <Input
                  value={state.safetyStockQty}
                  onChange={(event) => update({ safetyStockQty: event.target.value })}
                  inputMode="decimal"
                  placeholder="0"
                  aria-invalid={fieldErrors.safetyStockQty ? true : undefined}
                />
              </label>
              {fieldErrors.safetyStockQty ? <p className="mt-1 text-xs text-rose-600">{fieldErrors.safetyStockQty}</p> : null}
            </div>
          ) : null}
          {state.safetyStockMethod === 'ppis' ? (
            <div>
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">PPIS periods</span>
                <Input
                  value={state.ppisPeriods}
                  onChange={(event) => update({ ppisPeriods: event.target.value })}
                  inputMode="numeric"
                  placeholder="0"
                  aria-invalid={fieldErrors.ppisPeriods ? true : undefined}
                />
              </label>
              {fieldErrors.ppisPeriods ? <p className="mt-1 text-xs text-rose-600">{fieldErrors.ppisPeriods}</p> : null}
            </div>
          ) : null}
        </div>
      </Card>

      <Card className="space-y-4 p-5">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Notes</h2>
          <p className="mt-1 text-sm text-slate-500">Optional operator context kept on the policy record.</p>
        </div>
        <label className="space-y-1 text-sm">
          <span className="text-xs uppercase tracking-wide text-slate-500">Notes</span>
          <Textarea
            value={state.notes}
            onChange={(event) => update({ notes: event.target.value })}
            placeholder="Optional notes"
          />
        </label>
      </Card>

      <div className="flex flex-wrap items-center justify-end gap-3">
        {onCancel ? (
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" disabled={isSubmitting || itemsQuery.isLoading || locationsQuery.isLoading}>
          {isSubmitting ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </form>
  )
}

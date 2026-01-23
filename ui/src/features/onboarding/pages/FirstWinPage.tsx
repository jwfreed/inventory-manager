import { useEffect, useMemo, useState } from 'react'
import { Button, Input, Alert } from '@shared/ui'
import { useNavigate } from 'react-router-dom'
import OnboardingCard from '../components/OnboardingCard'
import { useOnboarding } from '../hooks'
import { trackOnboardingEvent } from '../analytics'
import { createItem } from '@features/items/api/items'
import { useLocationsList } from '@features/locations/queries'
import { createInventoryAdjustment, postInventoryAdjustment } from '@features/adjustments/api/adjustments'
import { ONBOARDING_FIRST_ACTION_KEY } from '../constants'

const unitDefaults: Record<string, string> = {
  Retail: 'each',
  Warehouse: 'each',
  'E-commerce': 'each',
  Manufacturing: 'g',
}

export default function FirstWinPage() {
  const navigate = useNavigate()
  const { progress, setPathChosen, markItemCreated, setStep } = useOnboarding()
  const [path, setPath] = useState(progress.pathChosen ?? 'add_item')
  const [name, setName] = useState('Sample item')
  const [sku, setSku] = useState('')
  const [locationId, setLocationId] = useState('')
  const [onHand, setOnHand] = useState(1)
  const [unit, setUnit] = useState(unitDefaults[progress.businessType ?? 'Retail'] ?? 'each')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const locationsQuery = useLocationsList({ active: true, limit: 200 }, { staleTime: 60_000 })
  const locationOptions = useMemo(() => locationsQuery.data?.data ?? [], [locationsQuery.data])

  useEffect(() => {
    trackOnboardingEvent('onboarding_firstwin_viewed', {
      step_name: 'first_win',
      step_index: 3,
      timestamp: new Date().toISOString(),
      path_chosen: progress.pathChosen ?? null,
      user_role: progress.userRole ?? null,
      business_type: progress.businessType ?? null,
    })
  }, [progress.pathChosen, progress.userRole, progress.businessType])

  const handlePath = (value: string) => {
    setPath(value)
    setPathChosen(value)
    trackOnboardingEvent('onboarding_firstwin_path_selected', {
      step_name: 'first_win',
      step_index: 3,
      timestamp: new Date().toISOString(),
      path_chosen: value,
      user_role: progress.userRole ?? null,
      business_type: progress.businessType ?? null,
    })
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      const created = await createItem({
        name: name.trim() || 'Sample item',
        sku: sku.trim() || undefined,
        type: 'finished',
        defaultUom: unit,
        uomDimension: unit === 'each' ? 'count' : 'mass',
        canonicalUom: unit === 'each' ? 'each' : 'g',
        stockingUom: unit === 'each' ? 'each' : 'g',
        defaultLocationId: locationId || undefined,
      })

      if (onHand > 0) {
        const targetLocation = locationId || locationOptions[0]?.id
        if (targetLocation) {
          const adjustment = await createInventoryAdjustment({
            occurredAt: new Date().toISOString(),
            notes: 'Onboarding opening balance',
            lines: [
              {
                lineNumber: 1,
                itemId: created.id,
                locationId: targetLocation,
                uom: unit,
                quantityDelta: Number(onHand),
                reasonCode: 'opening_balance',
              },
            ],
          })
          await postInventoryAdjustment(adjustment.id)
        }
      }

      const startedAt = Number(localStorage.getItem(ONBOARDING_FIRST_ACTION_KEY) || 0)
      const duration = startedAt ? Date.now() - startedAt : undefined
      trackOnboardingEvent('inventory_item_created', {
        step_name: 'first_win',
        step_index: 3,
        timestamp: new Date().toISOString(),
        path_chosen: 'add_item',
        user_role: progress.userRole ?? null,
        business_type: progress.businessType ?? null,
      })
      trackOnboardingEvent('onboarding_firstwin_completed', {
        step_name: 'first_win',
        step_index: 3,
        timestamp: new Date().toISOString(),
        path_chosen: 'add_item',
        user_role: progress.userRole ?? null,
        business_type: progress.businessType ?? null,
        duration_ms: duration,
      })
      markItemCreated()
      setStep('checklist')
      navigate('/onboarding/checklist')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create item.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <OnboardingCard
      title="Your first inventory action"
      description="Step 1 of 3 — choose a path to get started."
    >
      <div className="flex flex-wrap gap-2">
        <Button variant={path === 'add_item' ? 'primary' : 'secondary'} onClick={() => handlePath('add_item')}>
          Add your first item
        </Button>
        <Button variant="secondary" disabled>
          Import inventory
        </Button>
        <Button variant="secondary" disabled>
          Scan barcode
        </Button>
      </div>

      {path === 'add_item' && (
        <div className="mt-4 space-y-3">
          {error && <Alert variant="error" title="Save failed" message={error} />}
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-slate-500">Item name</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-slate-500">SKU (optional)</span>
              <Input value={sku} onChange={(e) => setSku(e.target.value)} />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-slate-500">Location (optional)</span>
              <select
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
              >
                <option value="">Choose a location</option>
                {locationOptions.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.code} — {loc.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-slate-500">On-hand qty</span>
              <Input
                type="number"
                min={0}
                value={onHand}
                onChange={(e) => setOnHand(Number(e.target.value))}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-slate-500">Unit</span>
              <select
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
              >
                <option value="each">each</option>
                <option value="g">g</option>
              </select>
            </label>
          </div>
          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={saving}>
              Save item
            </Button>
          </div>
        </div>
      )}
    </OnboardingCard>
  )
}

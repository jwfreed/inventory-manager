/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { createWorkOrder, type WorkOrderCreatePayload } from '../api/workOrders'
import { useBom, useBomsByItem } from '@features/boms/queries'
import { useItemsList } from '@features/items/queries'
import { useLocationsList } from '@features/locations/queries'
import type { ApiError, Bom, Item } from '@api/types'
import { Alert, Button, Card } from '@shared/ui'
import { WorkOrderBomSection } from '../components/WorkOrderBomSection'
import { WorkOrderHeaderSection } from '../components/WorkOrderHeaderSection'

const formatError = (err: unknown): string => {
  if (!err) return ''
  if (typeof err === 'string') return err
  if (typeof err === 'object' && 'message' in (err as { message?: unknown }) && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message
  }
  try {
    return JSON.stringify(err)
  } catch {
    return 'Unknown error'
  }
}

export default function WorkOrderCreatePage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [description, setDescription] = useState('')
  const [kind, setKind] = useState<'production' | 'disassembly'>('production')
  const [outputItemId, setOutputItemId] = useState('')
  const [outputUom, setOutputUom] = useState('')
  const [quantityPlanned, setQuantityPlanned] = useState<number | ''>(1)
  const [scheduledStartAt, setScheduledStartAt] = useState('')
  const [scheduledDueAt, setScheduledDueAt] = useState('')
  const [selectedBomId, setSelectedBomId] = useState('')
  const [selectedVersionId, setSelectedVersionId] = useState('')
  const [defaultConsumeLocationId, setDefaultConsumeLocationId] = useState('')
  const [defaultProduceLocationId, setDefaultProduceLocationId] = useState('')
  const [quantityError, setQuantityError] = useState<string | null>(null)
  const prefillDoneRef = useRef(false)

  const itemsQuery = useItemsList({ limit: 200 }, { staleTime: 1000 * 60 })

  const locationsQuery = useLocationsList({ limit: 200, active: true }, { staleTime: 1000 * 60 })

  const bomsQuery = useBomsByItem(outputItemId)
  const bomDetailQuery = useBom(selectedBomId, { enabled: Boolean(selectedBomId) })

  useEffect(() => {
    if (prefillDoneRef.current) return
    const outputItemParam = searchParams.get('outputItemId')
    const bomIdParam = searchParams.get('bomId')
    if (outputItemParam) {
      setOutputItemId(outputItemParam)
    }
    if (bomIdParam) {
      setSelectedBomId(bomIdParam)
    }
    if (outputItemParam || bomIdParam) {
      prefillDoneRef.current = true
    }
  }, [searchParams])

  const itemsById = useMemo(() => {
    const map = new Map<string, Item>()
    itemsQuery.data?.data?.forEach((item) => map.set(item.id, item))
    return map
  }, [itemsQuery.data])

  const locationOptions = useMemo(
    () =>
      (locationsQuery.data?.data ?? []).map((loc) => ({
        value: loc.id,
        label: `${loc.code} — ${loc.name}`,
      })),
    [locationsQuery.data],
  )

  const bomOptions = useMemo(
    () =>
      (bomsQuery.data?.boms ?? []).map((bom) => ({
        value: bom.id,
        label: bom.bomCode,
        description: bom.defaultUom ? `Default UOM: ${bom.defaultUom}` : undefined,
        keywords: `${bom.bomCode} ${bom.defaultUom ?? ''}`.trim(),
      })),
    [bomsQuery.data],
  )

  useEffect(() => {
    const item = itemsById.get(outputItemId)
    if (!item) return
    setOutputUom((prev) => prev || item.defaultUom || '')
    setDefaultConsumeLocationId((prev) => (prev ? prev : item.defaultLocationId ?? ''))
    setDefaultProduceLocationId((prev) => (prev ? prev : item.defaultLocationId ?? ''))
  }, [itemsById, outputItemId])

  useEffect(() => {
    const bomDefault = bomsQuery.data?.boms?.[0]
    if (bomDefault) {
      setSelectedBomId((prev) => prev || bomDefault.id)
      const version = bomDefault.versions.find((v) => v.status === 'active') ?? bomDefault.versions[0]
      if (version) {
        setSelectedVersionId(version.id)
        setOutputUom((prev) => prev || version.yieldUom || bomDefault.defaultUom)
      } else {
        setOutputUom((prev) => prev || bomDefault.defaultUom)
      }
    } else {
      setSelectedBomId('')
      setSelectedVersionId('')
    }
  }, [bomsQuery.data])

  useEffect(() => {
    if (kind === 'disassembly') {
      setSelectedBomId('')
      setSelectedVersionId('')
    }
  }, [kind])

  const mutation = useMutation({
    mutationFn: (payload: WorkOrderCreatePayload) => createWorkOrder(payload),
    onSuccess: (wo) => {
      navigate(`/work-orders/${wo.id}`)
    },
  })

  const selectedBom: Bom | undefined = useMemo(
    () => bomDetailQuery.data ?? bomsQuery.data?.boms.find((b) => b.id === selectedBomId),
    [bomDetailQuery.data, bomsQuery.data, selectedBomId],
  )
  const selectedItem = itemsById.get(outputItemId)

  const consumeMissing =
    Boolean(defaultConsumeLocationId) &&
    !locationOptions.some((opt) => opt.value === defaultConsumeLocationId)
  const produceMissing =
    Boolean(defaultProduceLocationId) &&
    !locationOptions.some((opt) => opt.value === defaultProduceLocationId)

  const handleOutputItemChange = (nextValue: string) => {
    setOutputItemId(nextValue)
    setSelectedBomId('')
    setSelectedVersionId('')
  }

  const handleQuantityChange = (nextValue: number | '') => {
    setQuantityPlanned(nextValue)
    if (quantityError) setQuantityError(null)
  }

  const handleBomChange = (nextValue: string) => {
    setSelectedBomId(nextValue)
    setSelectedVersionId('')
    const bom = bomsQuery.data?.boms.find((b) => b.id === nextValue)
    if (bom) setOutputUom((prev) => prev || bom.defaultUom)
  }

  useEffect(() => {
    if (!bomDetailQuery.data) return
    if (!selectedVersionId || !bomDetailQuery.data.versions.some((v) => v.id === selectedVersionId)) {
      const active = bomDetailQuery.data.versions.find((v) => v.status === 'active') ?? bomDetailQuery.data.versions[0]
      if (active) {
        setSelectedVersionId(active.id)
        setOutputUom((prev) => prev || active.yieldUom || bomDetailQuery.data?.defaultUom || '')
      }
    }
  }, [bomDetailQuery.data, selectedVersionId])

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setQuantityError(null)
    if (!outputItemId || !outputUom || quantityPlanned === '') {
      return
    }
    if (kind === 'production' && !selectedBomId) return
    if (!(Number(quantityPlanned) > 0)) {
      setQuantityError('Quantity planned must be greater than 0.')
      return
    }
    const toDateTime = (value: string) => (value ? `${value}T00:00:00.000Z` : undefined)
    const start = toDateTime(scheduledStartAt)
    const due = toDateTime(scheduledDueAt)

    mutation.mutate({
      kind,
      bomId: kind === 'production' ? selectedBomId : undefined,
      bomVersionId: kind === 'production' ? selectedVersionId || undefined : undefined,
      outputItemId,
      outputUom,
      quantityPlanned: Number(quantityPlanned),
      defaultConsumeLocationId: defaultConsumeLocationId || undefined,
      defaultProduceLocationId: defaultProduceLocationId || undefined,
      scheduledStartAt: start || undefined,
      scheduledDueAt: due || undefined,
      description: description || undefined,
    })
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">Execution</p>
          <h2 className="text-2xl font-semibold text-slate-900">Create Work Order</h2>
        </div>
        <Button variant="secondary" size="sm" onClick={() => navigate('/work-orders')}>
          Back to list
        </Button>
      </div>

      <Card>
        <form className="space-y-4" onSubmit={onSubmit}>
          {mutation.isError && (
            <Alert variant="error" title="Create failed" message={formatError(mutation.error as ApiError)} />
          )}
          <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Work order type</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {(['production', 'disassembly'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wide ${
                    kind === option
                      ? 'border-brand-400 bg-brand-50 text-brand-700'
                      : 'border-slate-200 text-slate-600 hover:border-slate-300'
                  }`}
                  onClick={() => setKind(option)}
                  disabled={mutation.isPending}
                >
                  {option === 'production' ? 'Production' : 'Disassembly'}
                </button>
              ))}
            </div>
            {kind === 'disassembly' && (
              <p className="mt-2 text-xs text-slate-500">
                Disassembly consumes the selected item in issues and produces recovered outputs in completions.
              </p>
            )}
          </div>
          <WorkOrderHeaderSection
            description={description}
            outputItemId={outputItemId}
            outputUom={outputUom}
            quantityPlanned={quantityPlanned}
            quantityError={quantityError}
            itemLabel={kind === 'disassembly' ? 'Item to disassemble' : undefined}
            quantityLabel={kind === 'disassembly' ? 'Quantity to disassemble' : undefined}
            scheduledStartAt={scheduledStartAt}
            scheduledDueAt={scheduledDueAt}
            defaultConsumeLocationId={defaultConsumeLocationId}
            defaultProduceLocationId={defaultProduceLocationId}
            items={itemsQuery.data?.data ?? []}
            itemsLoading={itemsQuery.isLoading}
            locationsLoading={locationsQuery.isLoading}
            selectedItem={selectedItem}
            locationOptions={locationOptions}
            consumeMissing={consumeMissing}
            produceMissing={produceMissing}
            isPending={mutation.isPending}
            onDescriptionChange={setDescription}
            onOutputItemChange={handleOutputItemChange}
            onOutputUomChange={setOutputUom}
            onQuantityPlannedChange={handleQuantityChange}
            onScheduledStartAtChange={setScheduledStartAt}
            onScheduledDueAtChange={setScheduledDueAt}
            onDefaultConsumeLocationChange={setDefaultConsumeLocationId}
            onDefaultProduceLocationChange={setDefaultProduceLocationId}
          />
          {kind === 'production' && (
            <WorkOrderBomSection
              outputItemId={outputItemId}
              selectedBomId={selectedBomId}
              selectedVersionId={selectedVersionId}
              bomOptions={bomOptions}
              selectedBom={selectedBom}
              isPending={mutation.isPending}
              isLoading={bomsQuery.isLoading || bomDetailQuery.isLoading}
              error={
                bomsQuery.isError
                  ? (bomsQuery.error as ApiError)
                  : bomDetailQuery.isError
                    ? (bomDetailQuery.error as ApiError)
                    : null
              }
              onBomChange={handleBomChange}
              onVersionChange={setSelectedVersionId}
            />
          )}

          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={mutation.isPending}>
              Create work order
            </Button>
          </div>
        </form>
      </Card>
    </div>
  )
}

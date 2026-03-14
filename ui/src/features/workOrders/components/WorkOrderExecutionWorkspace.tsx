import { useEffect, useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { WorkOrder, WorkOrderDisassemblyPlan, WorkOrderReadiness } from '@api/types'
import { Alert, Button } from '@shared/ui'
import { formatDate, formatNumber } from '@shared/formatters'
import {
  executeWorkOrderDisassembly,
  reportWorkOrderProduction,
  reportWorkOrderScrap,
  type ReportProductionResult,
} from '../api/workOrders'
import { normalizeDateInputToIso } from '../../../core/dateAdapter'

type Props = {
  workOrder: WorkOrder
  readiness?: WorkOrderReadiness | null
  disassemblyPlan?: WorkOrderDisassemblyPlan | null
  isLoading?: boolean
  isError?: boolean
  errorMessage?: string
  onRefresh: (options?: { showSummaryToast?: boolean }) => void
  onProductionReported?: (
    result: ReportProductionResult,
    meta: { occurredAt: string; notes: string | null; scrapPosted: boolean },
  ) => void
}

function buildLocationLabel(location?: { code?: string | null; name?: string | null } | null) {
  if (!location) return 'Unresolved'
  if (location.code && location.name) return `${location.code} — ${location.name}`
  return location.name || location.code || 'Unresolved'
}

export function WorkOrderExecutionWorkspace({
  workOrder,
  readiness,
  disassemblyPlan,
  isLoading = false,
  isError = false,
  errorMessage,
  onRefresh,
  onProductionReported,
}: Props) {
  const isDisassembly = workOrder.kind === 'disassembly'
  const [executionQty, setExecutionQty] = useState<number | ''>('')
  const [scrapQty, setScrapQty] = useState<number | ''>('')
  const [occurredAt, setOccurredAt] = useState(formatDate(new Date()))
  const [notes, setNotes] = useState('')
  const [confirmPreview, setConfirmPreview] = useState(false)

  const plannedRemaining =
    readiness?.quantities.remaining ??
    disassemblyPlan?.quantities.remaining ??
    Math.max(1, workOrder.quantityPlanned - (workOrder.quantityCompleted ?? 0) - (workOrder.quantityScrapped ?? 0))

  useEffect(() => {
    setExecutionQty(plannedRemaining > 0 ? plannedRemaining : 1)
    setScrapQty('')
    setConfirmPreview(false)
  }, [plannedRemaining, workOrder.id])

  const normalizedExecutionQty = executionQty === '' ? 0 : Number(executionQty)
  const normalizedScrapQty = scrapQty === '' ? 0 : Number(scrapQty)
  const progressMetrics = [
    { label: 'Planned', value: readiness?.quantities.planned ?? disassemblyPlan?.quantities.planned ?? workOrder.quantityPlanned },
    { label: 'Produced', value: readiness?.quantities.produced ?? disassemblyPlan?.quantities.produced ?? workOrder.quantityCompleted ?? 0 },
    { label: 'Scrap', value: readiness?.quantities.scrapped ?? disassemblyPlan?.quantities.scrapped ?? workOrder.quantityScrapped ?? 0 },
    { label: 'Remaining', value: plannedRemaining },
  ]

  const previewRatio = useMemo(() => {
    if (isDisassembly) {
      const baseQty = disassemblyPlan?.quantities.requestedDisassembly ?? 0
      return baseQty > 0 ? normalizedExecutionQty / baseQty : 0
    }
    const baseQty = readiness?.quantities.remaining ?? 0
    return baseQty > 0 ? normalizedExecutionQty / baseQty : 0
  }, [disassemblyPlan?.quantities.requestedDisassembly, isDisassembly, normalizedExecutionQty, readiness?.quantities.remaining])

  const previewConsumes = useMemo(() => {
    if (isDisassembly) {
      return disassemblyPlan?.consumeLocation
        ? [
            {
              key: disassemblyPlan.consumeItemId,
              label:
                disassemblyPlan.consumeItemName && disassemblyPlan.consumeItemSku
                  ? `${disassemblyPlan.consumeItemName} — ${disassemblyPlan.consumeItemSku}`
                  : disassemblyPlan.consumeItemName || disassemblyPlan.consumeItemSku || disassemblyPlan.consumeItemId,
              location: buildLocationLabel(disassemblyPlan.consumeLocation),
              quantity: normalizedExecutionQty,
              uom: workOrder.outputUom,
            },
          ]
        : []
    }
    return (readiness?.lines ?? [])
      .filter((line) => line.required > 0)
      .map((line) => ({
        key: `${line.componentItemId}-${line.lineNumber}`,
        label:
          line.componentItemName && line.componentItemSku
            ? `${line.componentItemName} — ${line.componentItemSku}`
            : line.componentItemName || line.componentItemSku || line.componentItemId,
        location: buildLocationLabel({
          code: line.consumeLocationCode,
          name: line.consumeLocationName,
        }),
        quantity: previewRatio > 0 ? line.required * previewRatio : 0,
        uom: line.uom,
      }))
  }, [disassemblyPlan, isDisassembly, normalizedExecutionQty, previewRatio, readiness?.lines, workOrder.outputUom])

  const previewProduces = useMemo(() => {
    if (isDisassembly) {
      return (disassemblyPlan?.outputs ?? []).map((line) => ({
        key: `${line.componentItemId}:${line.toLocationId}`,
        label:
          line.componentItemName && line.componentItemSku
            ? `${line.componentItemName} — ${line.componentItemSku}`
            : line.componentItemName || line.componentItemSku || line.componentItemId,
        location: buildLocationLabel({ code: line.toLocationCode, name: line.toLocationName }),
        quantity: previewRatio > 0 ? line.quantityProduced * previewRatio : 0,
        uom: line.uom,
      }))
    }
    return [
      {
        key: workOrder.outputItemId,
        label: workOrder.outputItemName || workOrder.number,
        location: buildLocationLabel(readiness?.produceLocation),
        quantity: normalizedExecutionQty,
        uom: workOrder.outputUom,
      },
    ]
  }, [disassemblyPlan?.outputs, isDisassembly, normalizedExecutionQty, previewRatio, readiness?.produceLocation, workOrder.number, workOrder.outputItemId, workOrder.outputItemName, workOrder.outputUom])

  const executionMutation = useMutation({
    mutationFn: async () => {
      const normalizedOccurredAt = normalizeDateInputToIso(occurredAt) ?? occurredAt
      if (isDisassembly) {
        return executeWorkOrderDisassembly(workOrder.id, {
          quantity: normalizedExecutionQty,
          occurredAt: normalizedOccurredAt,
          notes: notes.trim() || undefined,
        })
      }

      const production = await reportWorkOrderProduction(workOrder.id, {
        outputQty: normalizedExecutionQty,
        outputUom: workOrder.outputUom,
        occurredAt: normalizedOccurredAt,
        notes: notes.trim() || undefined,
      })
      if (normalizedScrapQty > 0) {
        await reportWorkOrderScrap(workOrder.id, {
          workOrderExecutionId: production.productionReportId,
          quantity: normalizedScrapQty,
          uom: workOrder.outputUom,
          reasonCode: 'process_scrap',
          occurredAt: normalizedOccurredAt,
          notes: notes.trim() || undefined,
          idempotencyKey: production.idempotencyKey
            ? `${production.idempotencyKey}:scrap`
            : `${production.productionReportId}:scrap`,
        })
      }
      return production
    },
    onSuccess: (result) => {
      if (!isDisassembly) {
        onProductionReported?.(result as ReportProductionResult, {
          occurredAt: normalizeDateInputToIso(occurredAt) ?? occurredAt,
          notes: notes.trim() || null,
          scrapPosted: normalizedScrapQty > 0,
        })
      }
      onRefresh({ showSummaryToast: true })
      setNotes('')
      setConfirmPreview(false)
    },
  })

  const routingConsumeLabel = isDisassembly
    ? buildLocationLabel(disassemblyPlan?.consumeLocation ?? readiness?.consumeLocation)
    : buildLocationLabel(readiness?.consumeLocation)
  const routingProduceLabel = isDisassembly
    ? 'Auto-derived per output line'
    : buildLocationLabel(readiness?.produceLocation)

  const executionBlocked =
    isLoading ||
    isError ||
    readiness?.hasShortage === true ||
    normalizedExecutionQty <= 0 ||
    normalizedExecutionQty > plannedRemaining ||
    !confirmPreview ||
    (isDisassembly ? previewProduces.length === 0 || !disassemblyPlan?.consumeLocation : !readiness?.produceLocation)

  return (
    <div className="space-y-6">
      {isError ? (
        <Alert
          variant="error"
          title="Readiness unavailable"
          message={errorMessage ?? 'Failed to evaluate work-order readiness.'}
        />
      ) : null}

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="text-sm font-semibold text-slate-900">Execution progress</div>
        <div className="mt-3 grid gap-3 lg:grid-cols-4">
          {progressMetrics.map((metric) => (
            <div key={metric.label} className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{metric.label}</div>
              <div className="mt-2 text-2xl font-semibold text-slate-900">
                {formatNumber(metric.value)} <span className="text-sm text-slate-500">{workOrder.outputUom}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="text-sm font-semibold text-slate-900">Stage routing</div>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
            <div className="text-xs uppercase tracking-wide text-slate-500">Consume from</div>
            <div className="mt-1 font-semibold text-slate-900">{routingConsumeLabel}</div>
            <div className="mt-1 text-xs text-slate-500">Auto-derived and locked.</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
            <div className="text-xs uppercase tracking-wide text-slate-500">Produce to</div>
            <div className="mt-1 font-semibold text-slate-900">{routingProduceLabel}</div>
            <div className="mt-1 text-xs text-slate-500">
              {isDisassembly ? 'Derived per recovered component.' : 'Auto-derived and locked.'}
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="text-sm font-semibold text-slate-900">1. Component readiness</div>
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="pb-2 pr-4">Component</th>
                <th className="pb-2 pr-4">Location</th>
                <th className="pb-2 pr-4">Required</th>
                <th className="pb-2 pr-4">Reserved</th>
                <th className="pb-2 pr-4">Available</th>
                <th className="pb-2 pr-4">Shortage</th>
              </tr>
            </thead>
            <tbody>
              {(readiness?.lines ?? []).map((line) => (
                <tr key={`${line.componentItemId}-${line.lineNumber}`} className="border-t border-slate-100">
                  <td className="py-2 pr-4 text-slate-900">
                    {line.componentItemName || line.componentItemSku || line.componentItemId}
                  </td>
                  <td className="py-2 pr-4 text-slate-600">
                    {buildLocationLabel({ code: line.consumeLocationCode, name: line.consumeLocationName })}
                  </td>
                  <td className="py-2 pr-4 text-slate-900">{formatNumber(line.required)} {line.uom}</td>
                  <td className="py-2 pr-4 text-slate-600">{formatNumber(line.reserved)} {line.uom}</td>
                  <td className="py-2 pr-4 text-slate-600">{formatNumber(line.available)} {line.uom}</td>
                  <td className={`py-2 pr-4 font-semibold ${line.shortage > 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                    {formatNumber(line.shortage)} {line.uom}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {readiness?.hasShortage ? (
          <Alert
            variant="error"
            title="Execution blocked"
            message="At least one required component is short after applying work-order reservations."
          />
        ) : null}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="text-sm font-semibold text-slate-900">2. Material reservations</div>
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="pb-2 pr-4">Component</th>
                <th className="pb-2 pr-4">Location</th>
                <th className="pb-2 pr-4">Required</th>
                <th className="pb-2 pr-4">Reserved</th>
                <th className="pb-2 pr-4">Fulfilled</th>
                <th className="pb-2 pr-4">Status</th>
              </tr>
            </thead>
            <tbody>
              {(readiness?.reservations ?? []).map((reservation) => (
                <tr key={`${reservation.componentItemId}:${reservation.locationId}:${reservation.uom}`} className="border-t border-slate-100">
                  <td className="py-2 pr-4 text-slate-900">
                    {reservation.componentItemName || reservation.componentItemSku || reservation.componentItemId}
                  </td>
                  <td className="py-2 pr-4 text-slate-600">
                    {buildLocationLabel({ code: reservation.locationCode, name: reservation.locationName })}
                  </td>
                  <td className="py-2 pr-4 text-slate-900">{formatNumber(reservation.requiredQty)} {reservation.uom}</td>
                  <td className="py-2 pr-4 text-slate-600">{formatNumber(reservation.reservedQty)} {reservation.uom}</td>
                  <td className="py-2 pr-4 text-slate-600">{formatNumber(reservation.fulfilledQty)} {reservation.uom}</td>
                  <td className="py-2 pr-4 text-slate-600">{reservation.status || 'UNRESERVED'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="text-sm font-semibold text-slate-900">
          {isDisassembly ? '3. Execute disassembly' : '3. Produce output'}
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <label className="grid gap-1 text-sm text-slate-700">
            <span className="font-medium">{isDisassembly ? 'Disassembly quantity' : 'Produced quantity'}</span>
            <input
              className="rounded-lg border border-slate-200 px-3 py-2"
              type="number"
              min={0}
              max={plannedRemaining || undefined}
              step="any"
              value={executionQty}
              onChange={(event) => setExecutionQty(event.target.value === '' ? '' : Number(event.target.value))}
            />
          </label>
          <label className="grid gap-1 text-sm text-slate-700">
            <span className="font-medium">Execution date</span>
            <input
              className="rounded-lg border border-slate-200 px-3 py-2"
              type="text"
              inputMode="numeric"
              placeholder="DD-MM-YY"
              value={occurredAt}
              onChange={(event) => setOccurredAt(event.target.value)}
            />
          </label>
          {!isDisassembly ? (
            <label className="grid gap-1 text-sm text-slate-700">
              <span className="font-medium">Scrap quantity</span>
              <input
                className="rounded-lg border border-slate-200 px-3 py-2"
                type="number"
                min={0}
                max={plannedRemaining || undefined}
                step="any"
                value={scrapQty}
                onChange={(event) => setScrapQty(event.target.value === '' ? '' : Number(event.target.value))}
              />
            </label>
          ) : null}
        </div>
        <label className="mt-3 grid gap-1 text-sm text-slate-700">
          <span className="font-medium">Operator notes</span>
          <textarea
            className="min-h-24 rounded-lg border border-slate-200 px-3 py-2"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Optional execution note"
          />
        </label>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="text-sm font-semibold text-slate-900">4. Review inventory movements</div>
        <div className="mt-3 space-y-2">
          {previewConsumes.map((line) => (
            <div key={line.key} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
              <span className="font-semibold text-slate-900">Consume</span> {line.location} | {line.label} | -{formatNumber(line.quantity)} {line.uom}
            </div>
          ))}
          {previewProduces.map((line) => (
            <div key={line.key} className="rounded-lg border border-slate-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
              <span className="font-semibold">Produce</span> {line.location} | {line.label} | +{formatNumber(line.quantity)} {line.uom}
            </div>
          ))}
          {!isDisassembly && normalizedScrapQty > 0 ? (
            <div className="rounded-lg border border-slate-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <span className="font-semibold">Scrap</span> {buildLocationLabel(readiness?.produceLocation)} | {workOrder.outputItemName || workOrder.number} | -{formatNumber(normalizedScrapQty)} {workOrder.outputUom}
            </div>
          ) : null}
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={confirmPreview}
            onChange={(event) => setConfirmPreview(event.target.checked)}
          />
          <span>I confirm this inventory impact preview.</span>
        </label>
        {executionMutation.isError ? (
          <Alert
            variant="error"
            title="Execution failed"
            message={(executionMutation.error as { message?: string } | null)?.message ?? 'Failed to post work-order execution.'}
          />
        ) : null}
        {executionMutation.isSuccess ? (
          <Alert
            variant="success"
            title="Execution posted"
            message={
              isDisassembly
                ? `Posted deterministic disassembly movements for ${formatNumber(normalizedExecutionQty)} ${workOrder.outputUom}.`
                : `Posted deterministic issue/receipt movements for ${formatNumber(normalizedExecutionQty)} ${workOrder.outputUom}.`
            }
          />
        ) : null}
        <div className="mt-4 flex justify-end">
          <Button
            size="sm"
            onClick={() => executionMutation.mutate()}
            disabled={executionMutation.isPending || executionBlocked}
          >
            {executionMutation.isPending ? 'Posting...' : isDisassembly ? 'Post disassembly' : 'Post execution'}
          </Button>
        </div>
      </div>
    </div>
  )
}

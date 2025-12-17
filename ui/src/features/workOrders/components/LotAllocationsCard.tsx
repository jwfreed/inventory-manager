import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getMovementLines } from '../../../api/endpoints/ledger'
import {
  addMovementLotAllocations,
  listLots,
  listMovementLotAllocations,
  type ListLotsParams,
} from '../../../api/endpoints/lots'
import type { ApiError, MovementLine } from '../../../api/types'
import { Alert } from '../../../components/Alert'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { Input } from '../../../components/Inputs'
import { LoadingSpinner } from '../../../components/Loading'

type AllocationDraft = { lotId: string; quantity: number | '' }

type Props = {
  movementId: string
  title?: string
}

export function LotAllocationsCard({ movementId, title }: Props) {
  const queryClient = useQueryClient()
  const [lineDrafts, setLineDrafts] = useState<Record<string, AllocationDraft[]>>({})
  const [lotFilter, setLotFilter] = useState<ListLotsParams>({})

  const linesQuery = useQuery({
    queryKey: ['movement-lines', movementId],
    queryFn: () => getMovementLines(movementId),
  })

  const lotsQuery = useQuery({
    queryKey: ['lots', lotFilter],
    queryFn: () => listLots(lotFilter),
  })

  const allocationsQuery = useQuery({
    queryKey: ['movement-lot-allocations', movementId],
    queryFn: async () => {
      const lines = await linesQuery.promise
      if (!lines) return {}
      const all = await Promise.all(
        lines.map(async (line) => {
          const allocations = await listMovementLotAllocations(line.id)
          return [line.id, allocations] as const
        }),
      )
      return Object.fromEntries(all)
    },
    enabled: linesQuery.isSuccess,
  })

  const addAllocMutation = useMutation({
    mutationFn: async () => {
      const lines = linesQuery.data ?? []
      for (const line of lines) {
        const drafts = lineDrafts[line.id] ?? []
        if (drafts.length === 0) continue
        for (const alloc of drafts) {
          if (!alloc.lotId || alloc.quantity === '') continue
          const qty = Number(alloc.quantity)
          if (Number.isNaN(qty) || qty <= 0) continue
          const signedQty = qty * (line.quantityDelta >= 0 ? 1 : -1)
          await addMovementLotAllocations(line.id, [
            { lotId: alloc.lotId, uom: line.uom, quantityDelta: signedQty },
          ])
        }
      }
    },
    onSuccess: () => {
      setLineDrafts({})
      void allocationsQuery.refetch()
      queryClient.invalidateQueries({ queryKey: ['movement-lot-allocations', movementId] })
    },
  })

  const addDraft = (lineId: string) =>
    setLineDrafts((prev) => ({
      ...prev,
      [lineId]: [...(prev[lineId] ?? []), { lotId: '', quantity: '' }],
    }))

  const updateDraft = (lineId: string, idx: number, patch: Partial<AllocationDraft>) =>
    setLineDrafts((prev) => ({
      ...prev,
      [lineId]: (prev[lineId] ?? []).map((d, i) => (i === idx ? { ...d, ...patch } : d)),
    }))

  const currentAllocations = allocationsQuery.data ?? {}

  const lotsOptions = useMemo(() => lotsQuery.data?.data ?? [], [lotsQuery.data])

  return (
    <Card title={title ?? 'Lot allocations'}>
      {(linesQuery.isLoading || lotsQuery.isLoading || allocationsQuery.isLoading) && (
        <LoadingSpinner label="Loading lot data..." />
      )}
      {(linesQuery.isError || lotsQuery.isError || allocationsQuery.isError) && (
        <Alert
          variant="error"
          title="Failed to load lot data"
          message={
            (linesQuery.error as ApiError)?.message ||
            (lotsQuery.error as ApiError)?.message ||
            (allocationsQuery.error as ApiError)?.message
          }
        />
      )}

      <div className="mt-3 flex flex-wrap gap-2 text-sm">
        <Input
          placeholder="Filter lots by code"
          value={lotFilter.lotCode ?? ''}
          onChange={(e) => setLotFilter((prev) => ({ ...prev, lotCode: e.target.value }))}
        />
        <Input
          placeholder="Filter lots by item ID"
          value={lotFilter.itemId ?? ''}
          onChange={(e) => setLotFilter((prev) => ({ ...prev, itemId: e.target.value }))}
        />
      </div>

      <div className="mt-4 space-y-4">
        {(linesQuery.data ?? []).map((line: MovementLine) => (
          <div key={line.id} className="rounded border border-slate-200 p-3 space-y-2">
            <div className="flex flex-wrap justify-between gap-2">
              <div className="text-sm font-semibold text-slate-800">
                Line {line.id.slice(0, 8)} — {line.itemId} @ {line.locationId}
              </div>
              <div className="text-sm text-slate-700">
                {line.quantityDelta} {line.uom}
              </div>
            </div>
            <div className="text-xs text-slate-600">Existing allocations</div>
            <div className="overflow-hidden rounded border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Lot</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Qty</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">UOM</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white">
                  {(currentAllocations[line.id] ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={3} className="px-3 py-2 text-sm text-slate-600">
                        None
                      </td>
                    </tr>
                  ) : (
                    currentAllocations[line.id].map((alloc: { id: string; lot_id?: string; lotId?: string; quantity_delta?: number; quantityDelta?: number; uom: string }) => (
                      <tr key={alloc.id}>
                        <td className="px-3 py-2 text-sm text-slate-800">{alloc.lot_id ?? alloc.lotId}</td>
                        <td className="px-3 py-2 text-sm text-slate-800">{alloc.quantity_delta ?? alloc.quantityDelta}</td>
                        <td className="px-3 py-2 text-sm text-slate-800">{alloc.uom}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-800">Add allocations</div>
              <Button variant="secondary" size="sm" type="button" onClick={() => addDraft(line.id)}>
                Add lot
              </Button>
            </div>
            {(lineDrafts[line.id] ?? []).map((draft, idx) => (
              <div key={idx} className="grid gap-2 md:grid-cols-3">
                <select
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  value={draft.lotId}
                  onChange={(e) => updateDraft(line.id, idx, { lotId: e.target.value })}
                >
                  <option value="">Select lot</option>
                  {lotsOptions.map((lot) => (
                    <option key={lot.id} value={lot.id}>
                      {lot.lotCode} ({lot.status})
                    </option>
                  ))}
                </select>
                <Input
                  type="number"
                  min={0}
                  value={draft.quantity}
                  onChange={(e) =>
                    updateDraft(line.id, idx, { quantity: e.target.value === '' ? '' : Number(e.target.value) })
                  }
                  placeholder="Qty"
                />
                <div className="flex items-center text-xs text-slate-600">{line.uom}</div>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="mt-4 flex justify-end">
        <Button size="sm" onClick={() => addAllocMutation.mutate()} disabled={addAllocMutation.isPending}>
          Save lot allocations
        </Button>
      </div>
    </Card>
  )
}

import type { ReceiptLineOption, PutawayLineInput } from '../types'
import { Combobox } from '../../../components/Combobox'
import { Input } from '../../../components/Inputs'
import { SearchableSelect } from '../../../components/SearchableSelect'

type LocationOption = {
  value: string
  label: string
  keywords?: string
}

type Props = {
  lines: PutawayLineInput[]
  receiptLineOptions: ReceiptLineOption[]
  locationOptions: LocationOption[]
  locationsLoading: boolean
  onLocationSearch: (value: string) => void
  onLineChange: (index: number, patch: Partial<PutawayLineInput>) => void
  resolvePutawayDefaults: (opts: { defaultFromLocationId?: string; defaultToLocationId?: string }) => {
    fromId: string
    toId: string
  }
}

export function PutawayLinesEditor({
  lines,
  receiptLineOptions,
  locationOptions,
  locationsLoading,
  onLocationSearch,
  onLineChange,
  resolvePutawayDefaults,
}: Props) {
  return (
    <div className="space-y-3">
      {lines.map((line, idx) => (
        <div key={idx} className="grid gap-3 rounded-lg border border-slate-200 p-3 md:grid-cols-4">
          <div>
            <SearchableSelect
              label="Receipt line"
              value={line.purchaseOrderReceiptLineId}
              options={receiptLineOptions}
              disabled={!receiptLineOptions.length}
              onChange={(nextValue) => {
                const selected = receiptLineOptions.find((opt) => opt.value === nextValue)
                const acceptedQty = selected?.acceptedQty ?? 0
                const availableQty = selected?.availableQty ?? acceptedQty
                const defaults = resolvePutawayDefaults({
                  defaultFromLocationId: selected?.defaultFromLocationId,
                  defaultToLocationId: selected?.defaultToLocationId,
                })
                onLineChange(idx, {
                  purchaseOrderReceiptLineId: nextValue,
                  uom: selected?.uom ?? line.uom,
                  quantity: availableQty > 0 ? availableQty : '',
                  toLocationId: line.toLocationId || defaults.toId,
                  fromLocationId: line.fromLocationId || defaults.fromId,
                })
              }}
            />
            {line.purchaseOrderReceiptLineId && (() => {
              const selected = receiptLineOptions.find((opt) => opt.value === line.purchaseOrderReceiptLineId)
              if (!selected) return null
              const acceptedQty = selected.acceptedQty ?? 0
              const availableQty = selected.availableQty ?? acceptedQty
              const holdQty = selected.holdQty ?? 0
              const rejectQty = selected.rejectQty ?? 0
              const remainingQty = selected.remainingQty ?? 0
              const tone = acceptedQty > 0 ? 'text-slate-500' : 'text-amber-700'
              return (
                <div className={`mt-1 text-xs ${tone}`}>
                  QC accepted {acceptedQty} · Hold {holdQty} · Reject {rejectQty} · Uninspected {remainingQty} · Available {availableQty}
                </div>
              )
            })()}
          </div>
          <div>
            <Combobox
              label="To location"
              value={line.toLocationId}
              options={locationOptions}
              loading={locationsLoading}
              onQueryChange={onLocationSearch}
              placeholder="Search locations (code/name)"
              onChange={(nextValue) => onLineChange(idx, { toLocationId: nextValue })}
            />
          </div>
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">From location</span>
            <Input
              value={line.fromLocationId}
              onChange={(e) => onLineChange(idx, { fromLocationId: e.target.value })}
              placeholder="Defaults from receipt or item"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">UOM</span>
            <Input value={line.uom} onChange={(e) => onLineChange(idx, { uom: e.target.value })} />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Qty to move</span>
            <Input
              type="number"
              min={0}
              max={
                line.purchaseOrderReceiptLineId
                  ? (receiptLineOptions.find((opt) => opt.value === line.purchaseOrderReceiptLineId)?.availableQty ?? undefined)
                  : undefined
              }
              value={line.quantity}
              onChange={(e) =>
                onLineChange(idx, {
                  quantity: e.target.value === '' ? '' : Number(e.target.value),
                })
              }
            />
          </label>
        </div>
      ))}
    </div>
  )
}

import { useState } from 'react'
import type { ReceiptLineOption, PutawayLineInput } from '../types'
import { Button, Combobox, Input, SearchableSelect } from '@shared/ui'

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
  onReorderLines: (startIndex: number, endIndex: number) => void
  onRemoveLine: (index: number) => void
  resolvePutawayDefaults: (opts: { defaultFromLocationId?: string; defaultToLocationId?: string }) => {
    fromId: string
    toId: string
  }
}

export function DraggablePutawayLinesEditor({
  lines,
  receiptLineOptions,
  locationOptions,
  locationsLoading,
  onLocationSearch,
  onLineChange,
  onReorderLines,
  onRemoveLine,
  resolvePutawayDefaults,
}: Props) {
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDraggedIndex(index)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/html', e.currentTarget.innerHTML)
  }

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverIndex(index)
  }

  const handleDragLeave = () => {
    setDragOverIndex(null)
  }

  const handleDrop = (e: React.DragEvent, dropIndex: number) => {
    e.preventDefault()
    if (draggedIndex !== null && draggedIndex !== dropIndex) {
      onReorderLines(draggedIndex, dropIndex)
    }
    setDraggedIndex(null)
    setDragOverIndex(null)
  }

  const handleDragEnd = () => {
    setDraggedIndex(null)
    setDragOverIndex(null)
  }

  return (
    <div className="space-y-3">
      {lines.map((line, idx) => {
        const isDragging = draggedIndex === idx
        const isDragOver = dragOverIndex === idx

        return (
          <div
            key={idx}
            draggable
            onDragStart={(e) => handleDragStart(e, idx)}
            onDragOver={(e) => handleDragOver(e, idx)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, idx)}
            onDragEnd={handleDragEnd}
            className={`
              grid gap-3 rounded-lg border p-3 transition-all
              ${isDragging ? 'opacity-50 scale-95 border-indigo-300' : 'border-slate-200'}
              ${isDragOver ? 'border-indigo-400 bg-indigo-50 shadow-lg' : 'bg-white'}
              hover:border-slate-300 cursor-move
            `}
            style={{
              gridTemplateColumns: 'auto 1fr 1fr 1fr 1fr auto',
            }}
          >
            {/* Drag Handle */}
            <div className="flex items-center justify-center text-slate-400 hover:text-slate-600">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8h16M4 16h16" />
              </svg>
            </div>

            {/* Receipt Line */}
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
                    quantity: availableQty,
                    fromLocationId: defaults.fromId,
                    toLocationId: defaults.toId,
                  })
                }}
              />
            </div>

            {/* Quantity */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Quantity</label>
              <Input
                type="number"
                min="0"
                step="1"
                value={line.quantity}
                onChange={(e) => {
                  const val = e.target.value === '' ? '' : Number(e.target.value)
                  onLineChange(idx, { quantity: val as number })
                }}
              />
            </div>

            {/* From Location */}
            <div>
              <Combobox
                label="From"
                value={line.fromLocationId}
                options={locationOptions}
                loading={locationsLoading}
                onQueryChange={onLocationSearch}
                onChange={(nextValue) => onLineChange(idx, { fromLocationId: nextValue })}
              />
            </div>

            {/* To Location */}
            <div>
              <Combobox
                label="To"
                value={line.toLocationId}
                options={locationOptions}
                loading={locationsLoading}
                onQueryChange={onLocationSearch}
                onChange={(nextValue) => onLineChange(idx, { toLocationId: nextValue })}
              />
            </div>

            {/* Remove Button */}
            <div className="flex items-center justify-center">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => onRemoveLine(idx)}
                className="text-red-600 hover:text-red-700 hover:bg-red-50"
                title="Remove line"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </Button>
            </div>
          </div>
        )
      })}

      {lines.length === 0 && (
        <div className="rounded-lg border-2 border-dashed border-slate-200 p-8 text-center">
          <p className="text-sm text-slate-500">
            No putaway lines yet. Click "Fill from receipt" to generate lines automatically.
          </p>
        </div>
      )}
    </div>
  )
}

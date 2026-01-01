import { Alert, Combobox, DataTable, LoadingSpinner, Section } from '@shared/ui'
import type { ApiError, Bom, BomVersionComponent } from '@api/types'

type Props = {
  outputItemId: string
  selectedBomId: string
  selectedVersionId: string
  bomOptions: { value: string; label: string; keywords?: string }[]
  selectedBom?: Bom
  isPending: boolean
  isLoading: boolean
  error?: ApiError | null
  onBomChange: (value: string) => void
  onVersionChange: (value: string) => void
}

export function WorkOrderBomSection({
  outputItemId,
  selectedBomId,
  selectedVersionId,
  bomOptions,
  selectedBom,
  isPending,
  isLoading,
  error,
  onBomChange,
  onVersionChange,
}: Props) {
  const activeVersion =
    selectedBom?.versions.find((v) => v.id === selectedVersionId) ?? selectedBom?.versions[0]
  const renderComponentLabel = (row: BomVersionComponent) => {
    const name = row.componentItemName ?? ''
    const sku = row.componentItemSku ?? ''
    if (name && sku) return `${name} — ${sku}`
    if (name) return name
    if (sku) return sku
    return row.componentItemId
  }

  return (
    <Section
      title="Bill of materials"
      description="Select the recipe for this item. If multiple versions exist, choose the one you need."
    >
      {isLoading && <LoadingSpinner label="Loading BOMs..." />}
      {error && <Alert variant="error" title="Failed to load BOMs" message={error.message} />}
      <div className="grid gap-3 md:grid-cols-3">
        <div className="md:col-span-2">
          <Combobox
            key={outputItemId || 'bom'}
            label="BOM"
            value={selectedBomId}
            options={bomOptions}
            loading={isLoading}
            disabled={isPending || !outputItemId || isLoading}
            placeholder={outputItemId ? 'Search BOM code' : 'Select item first'}
            emptyMessage={outputItemId ? 'No BOMs found' : 'Select an item first'}
            onChange={(nextValue) => onBomChange(nextValue)}
          />
        </div>
        <label className="space-y-1 text-sm">
          <span className="text-xs uppercase tracking-wide text-slate-500">Version</span>
          <select
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
            value={selectedVersionId}
            onChange={(e) => onVersionChange(e.target.value)}
            disabled={isPending || !selectedBom}
          >
            <option value="">Auto</option>
            {selectedBom?.versions.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.versionNumber} — {v.status}
              </option>
            ))}
          </select>
        </label>
      </div>
      {selectedBom && (
        <div className="mt-3 rounded-lg border border-slate-200 p-3">
          <div className="text-sm font-semibold text-slate-800">
            Components (v{activeVersion?.versionNumber ?? '—'})
          </div>
          <div className="mt-2">
            <DataTable
              rows={activeVersion?.components ?? []}
              rowKey={(row) => row.id}
              columns={[
                { id: 'line', header: 'Line', cell: (row) => row.lineNumber },
                { id: 'component', header: 'Component', cell: (row) => renderComponentLabel(row) },
                { id: 'qty', header: 'Qty per', cell: (row) => row.quantityPer },
                { id: 'uom', header: 'UOM', cell: (row) => row.uom },
              ]}
            />
          </div>
        </div>
      )}
    </Section>
  )
}

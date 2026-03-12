import type { ComboboxOption } from '@shared/ui'
import { Combobox, Input } from '@shared/ui'

export type VendorOption = ComboboxOption

type Props = {
  vendorId: string
  vendorOptions: VendorOption[]
  vendorLoading: boolean
  vendorReference: string
  poNumber: string
  vendorError?: string
  onVendorChange: (nextValue: string) => void
  onVendorReferenceChange: (nextValue: string) => void
  onPoNumberChange: (nextValue: string) => void
}

export function PurchaseOrderVendorSection({
  vendorId,
  vendorOptions,
  vendorLoading,
  vendorReference,
  poNumber,
  vendorError,
  onVendorChange,
  onVendorReferenceChange,
  onPoNumberChange,
}: Props) {
  return (
    <div>
      <div className="text-sm font-semibold text-slate-800">Step 1: Supplier and identity</div>
      <p className="text-xs text-slate-500">Start with the supplier to anchor pricing and lead time.</p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div>
          <Combobox
            label="Supplier"
            value={vendorId}
            options={vendorOptions}
            loading={vendorLoading}
            placeholder="Search suppliers (code/name)"
            required
            error={vendorError}
            showSelectedValue={false}
            onChange={onVendorChange}
          />
        </div>
        <label className="space-y-1 text-sm">
          <span className="text-xs uppercase tracking-wide text-slate-500">Supplier reference</span>
          <Input
            value={vendorReference}
            onChange={(e) => onVendorReferenceChange(e.target.value)}
            placeholder="Optional (supplier reference #)"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-xs uppercase tracking-wide text-slate-500">PO Number</span>
          <Input
            value={poNumber}
            onChange={(e) => onPoNumberChange(e.target.value)}
            placeholder="Leave blank to auto-assign (PO-000123)"
          />
        </label>
      </div>
    </div>
  )
}

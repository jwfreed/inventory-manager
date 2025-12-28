import { Input, SearchableSelect, Textarea } from '@shared/ui'

type LocationOption = {
  value: string
  label: string
  keywords?: string
}

type Props = {
  poNumber: string
  orderDate: string
  expectedDate: string
  shipToLocationId: string
  receivingLocationId: string
  vendorReference: string
  notes: string
  locationOptions: LocationOption[]
  locationsLoading: boolean
  isLocked: boolean
  isBusy: boolean
  onOrderDateChange: (value: string) => void
  onExpectedDateChange: (value: string) => void
  onShipToChange: (value: string) => void
  onReceivingChange: (value: string) => void
  onVendorReferenceChange: (value: string) => void
  onNotesChange: (value: string) => void
}

export function PurchaseOrderDetailsForm({
  poNumber,
  orderDate,
  expectedDate,
  shipToLocationId,
  receivingLocationId,
  vendorReference,
  notes,
  locationOptions,
  locationsLoading,
  isLocked,
  isBusy,
  onOrderDateChange,
  onExpectedDateChange,
  onShipToChange,
  onReceivingChange,
  onVendorReferenceChange,
  onNotesChange,
}: Props) {
  return (
    <div>
      <div className="mt-3 grid gap-3 md:grid-cols-2 lg:grid-cols-3 text-sm text-slate-800">
        <div>
          <div className="text-xs uppercase text-slate-500">PO Number</div>
          <div className="font-semibold">{poNumber}</div>
        </div>
        <label className="space-y-1 text-sm">
          <span className="text-xs uppercase text-slate-500">Order date</span>
          <Input
            type="date"
            value={orderDate}
            onChange={(e) => onOrderDateChange(e.target.value)}
            disabled={isLocked || isBusy}
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-xs uppercase text-slate-500">Expected date</span>
          <Input
            type="date"
            value={expectedDate}
            onChange={(e) => onExpectedDateChange(e.target.value)}
            disabled={isLocked || isBusy}
          />
        </label>
        <div>
          <SearchableSelect
            label="Ship-to"
            value={shipToLocationId}
            options={locationOptions}
            disabled={locationsLoading || isLocked || isBusy}
            onChange={onShipToChange}
          />
        </div>
        <div>
          <SearchableSelect
            label="Receiving/staging"
            value={receivingLocationId}
            options={locationOptions}
            disabled={locationsLoading || isLocked || isBusy}
            onChange={onReceivingChange}
          />
        </div>
        <label className="space-y-1 text-sm">
          <span className="text-xs uppercase text-slate-500">Vendor reference</span>
          <Input
            value={vendorReference}
            onChange={(e) => onVendorReferenceChange(e.target.value)}
            placeholder="Optional"
            disabled={isLocked || isBusy}
          />
        </label>
      </div>
      <label className="mt-3 block space-y-1 text-sm">
        <span className="text-xs uppercase text-slate-500">Notes</span>
        <Textarea value={notes} onChange={(e) => onNotesChange(e.target.value)} disabled={isLocked || isBusy} />
      </label>
    </div>
  )
}

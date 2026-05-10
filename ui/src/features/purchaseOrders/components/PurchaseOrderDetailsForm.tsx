import { Input, SearchableSelect, Textarea } from '@shared/ui'
import { formatDate } from '@shared/formatters'

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

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-sm text-slate-900">{value || '—'}</div>
    </div>
  )
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
  if (isLocked) {
    const shipToLabel = locationOptions.find((o) => o.value === shipToLocationId)?.label ?? ''
    const receivingLabel = locationOptions.find((o) => o.value === receivingLocationId)?.label ?? ''
    return (
      <div data-testid="po-details-readonly">
        <div className="mt-3 grid gap-3 md:grid-cols-2 lg:grid-cols-3 text-sm text-slate-800">
          <ReadOnlyField label="Order date" value={formatDate(orderDate)} />
          <ReadOnlyField label="Expected date" value={formatDate(expectedDate)} />
          <ReadOnlyField label="Ship-to" value={shipToLabel} />
          <ReadOnlyField label="Receiving" value={receivingLabel} />
          {vendorReference && <ReadOnlyField label="Supplier ref" value={vendorReference} />}
        </div>
        {notes && (
          <div className="mt-3 space-y-0.5">
            <div className="text-xs uppercase tracking-wide text-slate-500">Notes</div>
            <div className="text-sm text-slate-900 whitespace-pre-wrap">{notes}</div>
          </div>
        )}
      </div>
    )
  }

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
          <span className="text-xs uppercase text-slate-500">Supplier reference</span>
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

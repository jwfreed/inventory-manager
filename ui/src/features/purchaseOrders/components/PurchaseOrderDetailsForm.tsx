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

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-sm text-slate-900">{value || '—'}</div>
    </div>
  )
}

function formatReadOnlyDate(value: string) {
  if (!value) return ''
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return ''
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(parsed)
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
      <div data-testid="po-details-readonly" className="mt-4">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          PO details
        </div>
        <div className="mt-2 grid gap-3 text-sm text-slate-800 md:grid-cols-2 lg:grid-cols-3">
          <ReadOnlyField label="Order date" value={formatReadOnlyDate(orderDate)} />
          <ReadOnlyField label="Expected date" value={formatReadOnlyDate(expectedDate)} />
          <ReadOnlyField label="Ship-to" value={shipToLabel} />
          <ReadOnlyField label="Receiving" value={receivingLabel} />
          {vendorReference && <ReadOnlyField label="Supplier ref" value={vendorReference} />}
        </div>
        {notes && (
          <div className="mt-3 space-y-0.5">
            <div className="text-xs uppercase tracking-wide text-slate-500">Notes</div>
            <div className="whitespace-pre-wrap text-sm text-slate-900">{notes}</div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div>
      <div className="mt-3 grid gap-3 text-sm text-slate-800 md:grid-cols-2 lg:grid-cols-3">
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
        <Textarea
          value={notes}
          onChange={(e) => onNotesChange(e.target.value)}
          disabled={isLocked || isBusy}
        />
      </label>
    </div>
  )
}

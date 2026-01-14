import { Combobox, type ComboboxOption, Input, Textarea } from '@shared/ui'

export type LocationOption = ComboboxOption

type Props = {
  orderDate: string
  expectedDate: string
  shipToLocationId: string
  receivingLocationId: string
  locationOptions: LocationOption[]
  locationsLoading: boolean
  notes: string
  shipToError?: string
  receivingError?: string
  expectedDateError?: string
  onOrderDateChange: (next: string) => void
  onExpectedDateChange: (next: string) => void
  onShipToLocationChange: (next: string) => void
  onReceivingLocationChange: (next: string) => void
  onLocationSearch: (next: string) => void
  onNotesChange: (next: string) => void
}

export function PurchaseOrderLogisticsSection({
  orderDate,
  expectedDate,
  shipToLocationId,
  receivingLocationId,
  locationOptions,
  locationsLoading,
  notes,
  shipToError,
  receivingError,
  expectedDateError,
  onOrderDateChange,
  onExpectedDateChange,
  onShipToLocationChange,
  onReceivingLocationChange,
  onLocationSearch,
  onNotesChange,
}: Props) {
  return (
    <div>
      <div className="text-sm font-semibold text-slate-800">Step 3: Dates and logistics</div>
      <p className="text-xs text-slate-500">Set the timing and locations for fulfillment.</p>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <label className="space-y-1 text-sm">
          <span className="text-xs uppercase tracking-wide text-slate-500">Order date</span>
          <Input type="date" value={orderDate} onChange={(e) => onOrderDateChange(e.target.value)} />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-xs uppercase tracking-wide text-slate-500">
            Expected date<span className="ml-0.5 text-red-500">*</span>
          </span>
          <Input
            type="date"
            value={expectedDate}
            onChange={(e) => onExpectedDateChange(e.target.value)}
            min={orderDate || undefined}
            aria-invalid={expectedDateError ? true : undefined}
            aria-describedby={expectedDateError ? 'expected-date-error' : undefined}
            className={expectedDateError ? 'border-red-400 focus:border-red-500 focus:ring-red-100' : undefined}
          />
          {expectedDateError && (
            <span id="expected-date-error" className="text-xs text-red-600">
              {expectedDateError}
            </span>
          )}
        </label>
        <div>
          <Combobox
            label="Ship-to location"
            value={shipToLocationId}
            options={locationOptions}
            loading={locationsLoading}
            onQueryChange={onLocationSearch}
            placeholder="Search locations (code/name)"
            required
            error={shipToError}
            showSelectedValue={false}
            onChange={onShipToLocationChange}
          />
        </div>
        <div>
          <Combobox
            label="Receiving/staging location"
            value={receivingLocationId}
            options={locationOptions}
            loading={locationsLoading}
            onQueryChange={onLocationSearch}
            placeholder="Search locations (code/name)"
            required
            error={receivingError}
            showSelectedValue={false}
            onChange={onReceivingLocationChange}
          />
        </div>
      </div>
      <label className="mt-3 block space-y-1 text-sm">
        <span className="text-xs uppercase tracking-wide text-slate-500">Notes</span>
        <Textarea value={notes} onChange={(e) => onNotesChange(e.target.value)} placeholder="Optional" />
      </label>
    </div>
  )
}

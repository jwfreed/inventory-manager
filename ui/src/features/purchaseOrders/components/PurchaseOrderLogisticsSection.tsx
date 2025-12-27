import { Combobox, type ComboboxOption } from '../../../components/Combobox'
import { Input, Textarea } from '../../../components/Inputs'

export type LocationOption = ComboboxOption

type Props = {
  orderDate: string
  expectedDate: string
  shipToLocationId: string
  receivingLocationId: string
  locationOptions: LocationOption[]
  locationsLoading: boolean
  notes: string
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
          <span className="text-xs uppercase tracking-wide text-slate-500">Expected date</span>
          <Input type="date" value={expectedDate} onChange={(e) => onExpectedDateChange(e.target.value)} />
        </label>
        <div>
          <Combobox
            label="Ship-to location"
            value={shipToLocationId}
            options={locationOptions}
            loading={locationsLoading}
            onQueryChange={onLocationSearch}
            placeholder="Search locations (code/name)"
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

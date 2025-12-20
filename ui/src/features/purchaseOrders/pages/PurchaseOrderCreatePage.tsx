import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { createPurchaseOrder, type PurchaseOrderCreateInput } from '../../../api/endpoints/purchaseOrders'
import { listVendors } from '../../../api/endpoints/vendors'
import { listLocations } from '../../../api/endpoints/locations'
import { listItems } from '../../../api/endpoints/items'
import type { ApiError, Item, Location, Vendor } from '../../../api/types'
import { Card } from '../../../components/Card'
import { Section } from '../../../components/Section'
import { Alert } from '../../../components/Alert'
import { LoadingSpinner } from '../../../components/Loading'
import { Button } from '../../../components/Button'
import { Input, Textarea } from '../../../components/Inputs'
import { SearchableSelect } from '../../../components/SearchableSelect'

type LineDraft = {
  itemId: string
  uom: string
  quantityOrdered: number | ''
  notes?: string
}

export default function PurchaseOrderCreatePage() {
  const navigate = useNavigate()
  const [vendorSearch, setVendorSearch] = useState('')
  const [locationSearch, setLocationSearch] = useState('')
  const [itemSearch, setItemSearch] = useState('')

  const [poNumber, setPoNumber] = useState('')
  const [vendorId, setVendorId] = useState('')
  const [shipToLocationId, setShipToLocationId] = useState('')
  const [receivingLocationId, setReceivingLocationId] = useState('')
  const [orderDate, setOrderDate] = useState('')
  const [expectedDate, setExpectedDate] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<LineDraft[]>([{ itemId: '', uom: '', quantityOrdered: '' }])

  const vendorsQuery = useQuery<{ data: Vendor[] }, ApiError>({
    queryKey: ['vendors', vendorSearch],
    queryFn: () => listVendors({ limit: 200, active: true }),
    staleTime: 60_000,
  })

  const locationsQuery = useQuery<{ data: Location[] }, ApiError>({
    queryKey: ['locations', 'po-create', locationSearch],
    queryFn: () => listLocations({ limit: 200, search: locationSearch || undefined, active: true }),
    staleTime: 60_000,
    retry: 1,
  })

  const itemsQuery = useQuery<{ data: Item[] }, ApiError>({
    queryKey: ['items', 'po-create', itemSearch],
    queryFn: () => listItems({ limit: 200, search: itemSearch || undefined, active: true }),
    staleTime: 60_000,
    retry: 1,
  })

  const vendorOptions = useMemo(
    () =>
      (vendorsQuery.data?.data ?? []).map((vendor) => ({
        value: vendor.id,
        label: `${vendor.code} — ${vendor.name}`,
        keywords: `${vendor.code} ${vendor.name} ${vendor.email ?? ''}`,
      })),
    [vendorsQuery.data],
  )

  const locationOptions = useMemo(
    () =>
      (locationsQuery.data?.data ?? []).map((loc) => ({
        value: loc.id,
        label: `${loc.code} — ${loc.name}`,
        keywords: `${loc.code} ${loc.name} ${loc.type}`,
      })),
    [locationsQuery.data],
  )

  const itemOptions = useMemo(
    () =>
      (itemsQuery.data?.data ?? []).map((item) => ({
        value: item.id,
        label: `${item.sku} — ${item.name}`,
        keywords: `${item.sku} ${item.name}`,
      })),
    [itemsQuery.data],
  )

  const itemLookup = useMemo(() => {
    const map = new Map<string, Item>()
    itemsQuery.data?.data?.forEach((item) => map.set(item.id, item))
    return map
  }, [itemsQuery.data])

  const addLine = () => setLines((prev) => [...prev, { itemId: '', uom: '', quantityOrdered: '' }])
  const updateLine = (idx: number, patch: Partial<LineDraft>) => {
    setLines((prev) => prev.map((line, i) => (i === idx ? { ...line, ...patch } : line)))
  }
  const removeLine = (idx: number) => setLines((prev) => prev.filter((_, i) => i !== idx))

  const mutation = useMutation({
    mutationFn: (payload: PurchaseOrderCreateInput) => createPurchaseOrder(payload),
    onSuccess: () => {
      navigate('/purchase-orders')
    },
  })

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const validLines = lines
      .map((line, idx) => ({
        ...line,
        quantityOrdered: line.quantityOrdered === '' ? 0 : Number(line.quantityOrdered),
        lineNumber: idx + 1,
      }))
      .filter((line) => line.itemId && line.uom && line.quantityOrdered > 0)

    if (!vendorId) {
      mutation.reset()
      return
    }
    if (validLines.length === 0) {
      mutation.reset()
      return
    }

    const payload: PurchaseOrderCreateInput = {
      poNumber: poNumber.trim() || undefined,
      vendorId,
      shipToLocationId: shipToLocationId || undefined,
      receivingLocationId: receivingLocationId || undefined,
      orderDate: orderDate || undefined,
      expectedDate: expectedDate || undefined,
      notes: notes || undefined,
      lines: validLines.map((line) => ({
        itemId: line.itemId,
        uom: line.uom,
        quantityOrdered: Number(line.quantityOrdered),
        lineNumber: line.lineNumber,
        notes: line.notes,
      })),
    }
    mutation.mutate(payload)
  }

  const successMessage =
    mutation.isSuccess && mutation.data
      ? `PO created: ${mutation.data.poNumber} (id ${mutation.data.id})`
      : null

  return (
    <div className="space-y-6">
      <Section
        title="Create Purchase Order"
        description="Capture a PO so receipts can be matched. Leave PO number blank to auto-generate."
      >
        <Card>
          <form className="space-y-4" onSubmit={onSubmit}>
            {(vendorsQuery.isLoading || locationsQuery.isLoading || itemsQuery.isLoading) && (
              <LoadingSpinner label="Loading reference data..." />
            )}
            {mutation.isError && (
              <Alert
                variant="error"
                title="Failed to create PO"
                message={(mutation.error as ApiError)?.message ?? 'Unknown error'}
              />
            )}
            {successMessage && <Alert variant="success" title="Saved" message={successMessage} />}
            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">PO Number</span>
                <Input
                  value={poNumber}
                  onChange={(e) => setPoNumber(e.target.value)}
                  placeholder="Leave blank to auto-assign (PO-000123)"
                />
              </label>
              <div>
                <SearchableSelect
                  label="Vendor"
                  value={vendorId}
                  options={vendorOptions}
                  disabled={vendorsQuery.isLoading}
                  onChange={(nextValue) => setVendorId(nextValue)}
                />
                <Input
                  className="mt-2"
                  value={vendorSearch}
                  onChange={(e) => setVendorSearch(e.target.value)}
                  placeholder="Search vendors"
                />
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">Order date</span>
                <Input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">Expected date</span>
                <Input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />
              </label>
              <div>
                <SearchableSelect
                  label="Ship-to location"
                  value={shipToLocationId}
                  options={locationOptions}
                  disabled={locationsQuery.isLoading}
                  onChange={(nextValue) => setShipToLocationId(nextValue)}
                />
                <Input
                  className="mt-2"
                  value={locationSearch}
                  onChange={(e) => setLocationSearch(e.target.value)}
                  placeholder="Search locations"
                />
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="md:col-span-1">
                <SearchableSelect
                  label="Default receiving/staging location"
                  value={receivingLocationId}
                  options={locationOptions}
                  disabled={locationsQuery.isLoading}
                  onChange={(nextValue) => setReceivingLocationId(nextValue)}
                />
              </div>
            </div>
            <label className="space-y-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-slate-500">Notes</span>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
            </label>

            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-800">Lines</div>
              <div className="flex gap-2">
                <Input
                  className="w-48"
                  value={itemSearch}
                  onChange={(e) => setItemSearch(e.target.value)}
                  placeholder="Search items (SKU/name)"
                />
                <Button type="button" variant="secondary" size="sm" onClick={addLine}>
                  Add line
                </Button>
              </div>
            </div>
            <div className="space-y-3">
              {lines.map((line, idx) => (
                <div key={idx} className="grid gap-3 rounded-lg border border-slate-200 p-3 md:grid-cols-5">
                  <div>
                    <SearchableSelect
                      label="Item"
                      value={line.itemId}
                      options={itemOptions}
                      disabled={itemsQuery.isLoading}
                      onChange={(nextValue) => {
                        const selected = nextValue ? itemLookup.get(nextValue) : undefined
                        updateLine(idx, { itemId: nextValue, uom: line.uom || selected?.defaultUom || '' })
                      }}
                    />
                  </div>
                  <label className="space-y-1 text-sm">
                    <span className="text-xs uppercase tracking-wide text-slate-500">UOM</span>
                    <Input value={line.uom} onChange={(e) => updateLine(idx, { uom: e.target.value })} />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-xs uppercase tracking-wide text-slate-500">Quantity</span>
                    <Input
                      type="number"
                      min={0}
                      value={line.quantityOrdered}
                      onChange={(e) =>
                        updateLine(idx, { quantityOrdered: e.target.value === '' ? '' : Number(e.target.value) })
                      }
                    />
                  </label>
                  <label className="space-y-1 text-sm md:col-span-2">
                    <span className="text-xs uppercase tracking-wide text-slate-500">Notes</span>
                    <Textarea
                      value={line.notes ?? ''}
                      onChange={(e) => updateLine(idx, { notes: e.target.value })}
                      placeholder="Optional"
                    />
                  </label>
                  {lines.length > 1 && (
                    <div className="md:col-span-5">
                      <Button variant="secondary" size="sm" onClick={() => removeLine(idx)}>
                        Remove line
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between">
              <p className="text-sm text-slate-600">PO number auto-generates if left blank. Lines require item, UOM, qty.</p>
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? 'Saving…' : 'Create PO'}
              </Button>
            </div>
          </form>
        </Card>
      </Section>
    </div>
  )
}

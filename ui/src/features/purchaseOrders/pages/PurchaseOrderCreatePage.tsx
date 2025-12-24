import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { createPurchaseOrder, type PurchaseOrderCreateInput } from '../api/purchaseOrders'
import { useVendorsList } from '../../vendors/queries'
import { useLocationsList } from '../../locations/queries'
import { useItemsList } from '../../items/queries'
import type { ApiError, Item } from '../../../api/types'
import { Card } from '../../../components/Card'
import { Section } from '../../../components/Section'
import { Alert } from '../../../components/Alert'
import { LoadingSpinner } from '../../../components/Loading'
import { Button } from '../../../components/Button'
import { Input, Textarea } from '../../../components/Inputs'
import { Combobox } from '../../../components/Combobox'
import { useDebouncedValue } from '../../../lib/useDebouncedValue'

type LineDraft = {
  itemId: string
  uom: string
  quantityOrdered: number | ''
  notes?: string
}

const defaultOrderDate = new Date().toISOString().slice(0, 10)

export default function PurchaseOrderCreatePage() {
  const navigate = useNavigate()
  const [locationSearch, setLocationSearch] = useState('')
  const [itemSearch, setItemSearch] = useState('')

  const [poNumber, setPoNumber] = useState('')
  const [vendorId, setVendorId] = useState('')
  const [vendorReference, setVendorReference] = useState('')
  const [shipToLocationId, setShipToLocationId] = useState('')
  const [receivingLocationId, setReceivingLocationId] = useState('')
  const [orderDate, setOrderDate] = useState(defaultOrderDate)
  const [expectedDate, setExpectedDate] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<LineDraft[]>([{ itemId: '', uom: '', quantityOrdered: '' }])
  const [lastAction, setLastAction] = useState<'draft' | 'submitted' | null>(null)

  const vendorsQuery = useVendorsList({ limit: 200, active: true }, { staleTime: 60_000 })

  const debouncedItemSearch = useDebouncedValue(itemSearch, 200)
  const debouncedLocationSearch = useDebouncedValue(locationSearch, 200)

  const locationsQuery = useLocationsList(
    { limit: 200, search: debouncedLocationSearch || undefined, active: true },
    { staleTime: 60_000, retry: 1 },
  )

  const itemsQuery = useItemsList(
    { limit: 200, search: debouncedItemSearch || undefined, active: true },
    { staleTime: 60_000, retry: 1 },
  )

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
    onSuccess: (created) => {
      navigate(`/purchase-orders/${created.id}`)
    },
  })

  const lineStats = useMemo(() => {
    const normalized = lines.map((line, idx) => ({
      ...line,
      quantityOrdered: line.quantityOrdered === '' ? 0 : Number(line.quantityOrdered),
      lineNumber: idx + 1,
    }))
    const withIntent = normalized.filter(
      (line) => line.itemId || line.uom || line.quantityOrdered > 0 || (line.notes ?? '').trim().length > 0,
    )
    const valid = normalized.filter((line) => line.itemId && line.uom && line.quantityOrdered > 0)
    const missingCount = withIntent.length - valid.length
    const totalQty = valid.reduce((sum, line) => sum + line.quantityOrdered, 0)
    return { normalized, valid, missingCount, totalQty }
  }, [lines])

  const isReadyForSubmit =
    !!vendorId &&
    lineStats.valid.length > 0 &&
    !!orderDate &&
    !!expectedDate

  const submitPo = (status: 'draft' | 'submitted') => {
    mutation.reset()
    setLastAction(status)
    if (!vendorId || lineStats.valid.length === 0) {
      return
    }
    if (status === 'submitted' && (!orderDate || !expectedDate)) {
      return
    }
    const payload: PurchaseOrderCreateInput = {
      poNumber: poNumber.trim() || undefined,
      vendorId,
      status,
      shipToLocationId: shipToLocationId || undefined,
      receivingLocationId: receivingLocationId || undefined,
      orderDate: orderDate || undefined,
      expectedDate: expectedDate || undefined,
      vendorReference: vendorReference.trim() || undefined,
      notes: notes || undefined,
      lines: lineStats.valid.map((line) => ({
        itemId: line.itemId,
        uom: line.uom,
        quantityOrdered: Number(line.quantityOrdered),
        lineNumber: line.lineNumber,
        notes: line.notes,
      })),
    }
    mutation.mutate(payload)
  }

  const onSaveDraft = (e: React.FormEvent) => {
    e.preventDefault()
    submitPo('draft')
  }

  return (
    <div className="space-y-6">
      <Section
        title="New Purchase Order (Draft)"
        description="Drafts are safe and reversible. Submit only when you are ready to commit."
      >
        <Card>
          <form className="space-y-4" onSubmit={onSaveDraft}>
            {(vendorsQuery.isLoading || locationsQuery.isLoading || itemsQuery.isLoading) && (
              <LoadingSpinner label="Loading reference data..." />
            )}
            {mutation.isError && (
              <Alert
                variant="error"
                title={lastAction === 'submitted' ? 'Failed to submit PO' : 'Failed to save draft'}
                message={(mutation.error as ApiError)?.message ?? 'Unknown error'}
              />
            )}
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
              <div className="space-y-6">
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-semibold text-slate-800">Draft intent</div>
                      <p className="text-xs text-slate-500">
                        Draft POs have no operational impact until submitted.
                      </p>
                    </div>
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">Draft</span>
                  </div>
                </div>

                <div>
                  <div className="text-sm font-semibold text-slate-800">Step 1: Vendor and identity</div>
                  <p className="text-xs text-slate-500">Start with the vendor to anchor pricing and lead time.</p>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <Combobox
                      label="Vendor"
                      value={vendorId}
                      options={vendorOptions}
                      loading={vendorsQuery.isLoading}
                      placeholder="Search vendors (code/name)"
                      onChange={(nextValue) => setVendorId(nextValue)}
                    />
                  </div>
                  <label className="space-y-1 text-sm">
                    <span className="text-xs uppercase tracking-wide text-slate-500">Vendor reference</span>
                    <Input
                      value={vendorReference}
                      onChange={(e) => setVendorReference(e.target.value)}
                      placeholder="Optional (vendor's reference #)"
                    />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-xs uppercase tracking-wide text-slate-500">PO Number</span>
                    <Input
                      value={poNumber}
                      onChange={(e) => setPoNumber(e.target.value)}
                      placeholder="Leave blank to auto-assign (PO-000123)"
                    />
                  </label>
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold text-slate-800">Step 2: Line items</div>
                    <p className="text-xs text-slate-500">Lines drive cost and inventory impact.</p>
                  </div>
                  <Button type="button" variant="secondary" size="sm" onClick={addLine}>
                    Add line
                  </Button>
                </div>
                <div className="space-y-3">
                  {lines.map((line, idx) => (
                    <div key={idx} className="grid gap-3 rounded-lg border border-slate-200 p-3 md:grid-cols-5">
                      <div>
                        <Combobox
                          label="Item"
                          value={line.itemId}
                          options={itemOptions}
                          loading={itemsQuery.isLoading}
                          onQueryChange={setItemSearch}
                          placeholder="Search items (SKU/name)"
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
                <div className="text-xs text-slate-500">
                  {lineStats.valid.length} line(s) ready · Total qty {lineStats.totalQty}
                </div>

                <div>
                  <div className="text-sm font-semibold text-slate-800">Step 3: Dates and logistics</div>
                  <p className="text-xs text-slate-500">Set the timing and locations for fulfillment.</p>
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
                    <Combobox
                      label="Ship-to location"
                      value={shipToLocationId}
                      options={locationOptions}
                      loading={locationsQuery.isLoading}
                      onQueryChange={setLocationSearch}
                      placeholder="Search locations (code/name)"
                      onChange={(nextValue) => setShipToLocationId(nextValue)}
                    />
                  </div>
                  <div>
                    <Combobox
                      label="Receiving/staging location"
                      value={receivingLocationId}
                      options={locationOptions}
                      loading={locationsQuery.isLoading}
                      onQueryChange={setLocationSearch}
                      placeholder="Search locations (code/name)"
                      onChange={(nextValue) => setReceivingLocationId(nextValue)}
                    />
                  </div>
                </div>
                <label className="space-y-1 text-sm">
                  <span className="text-xs uppercase tracking-wide text-slate-500">Notes</span>
                  <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
                </label>

                <div className="flex items-center justify-between">
                  <p className="text-sm text-slate-600">
                    Save keeps this draft private. Submit signals a commitment to spend and receive inventory.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      type="submit"
                      variant="secondary"
                      disabled={mutation.isPending || !vendorId || lineStats.valid.length === 0}
                    >
                      {mutation.isPending && lastAction === 'draft' ? 'Saving…' : 'Save draft'}
                    </Button>
                    <Button
                      type="button"
                      disabled={mutation.isPending || !isReadyForSubmit}
                      onClick={() => submitPo('submitted')}
                    >
                      {mutation.isPending && lastAction === 'submitted' ? 'Submitting…' : 'Submit PO for approval'}
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-slate-500">
                  Submitting will lock edits and notify Finance for approval.
                </p>
              </div>

              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="text-xs uppercase tracking-wide text-slate-500">Submission readiness</div>
                <ul className="mt-2 space-y-2 text-sm text-slate-700">
                  <li className="flex items-center justify-between">
                    <span>Vendor selected</span>
                    <span>{vendorId ? '✓' : '—'}</span>
                  </li>
                  <li className="flex items-center justify-between">
                    <span>At least one line</span>
                    <span>{lineStats.valid.length > 0 ? '✓' : '—'}</span>
                  </li>
                  <li className="flex items-center justify-between">
                    <span>Quantities valid</span>
                    <span>{lineStats.missingCount === 0 ? '✓' : '—'}</span>
                  </li>
                  <li className="flex items-center justify-between">
                    <span>Dates set</span>
                    <span>{orderDate && expectedDate ? '✓' : '—'}</span>
                  </li>
                </ul>
                <p className="mt-3 text-xs text-slate-500">
                  Submit becomes available only when all checks are complete.
                </p>
              </div>
            </div>
          </form>
        </Card>
      </Section>
    </div>
  )
}

import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { createPurchaseOrder, type PurchaseOrderCreateInput } from '../api/purchaseOrders'
import { useVendorsList } from '@features/vendors/queries'
import { useLocationsList } from '@features/locations/queries'
import { useItemsList } from '@features/items/queries'
import type { ApiError, Item } from '@api/types'
import { Alert, Button, Card, LoadingSpinner, Section } from '@shared/ui'
import { useDebouncedValue } from '@shared'
import { PurchaseOrderVendorSection } from '../components/PurchaseOrderVendorSection'
import { PurchaseOrderLinesSection } from '../components/PurchaseOrderLinesSection'
import { PurchaseOrderLogisticsSection } from '../components/PurchaseOrderLogisticsSection'
import { PurchaseOrderReadinessPanel } from '../components/PurchaseOrderReadinessPanel'
import type { PurchaseOrderLineDraft } from '../types'

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
  const [lines, setLines] = useState<PurchaseOrderLineDraft[]>([
    { itemId: '', uom: '', quantityOrdered: '' },
  ])
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

                <PurchaseOrderVendorSection
                  vendorId={vendorId}
                  vendorOptions={vendorOptions}
                  vendorLoading={vendorsQuery.isLoading}
                  vendorReference={vendorReference}
                  poNumber={poNumber}
                  onVendorChange={setVendorId}
                  onVendorReferenceChange={setVendorReference}
                  onPoNumberChange={setPoNumber}
                />

                <PurchaseOrderLinesSection
                  lines={lines}
                  itemOptions={itemOptions}
                  itemLookup={itemLookup}
                  itemsLoading={itemsQuery.isLoading}
                  lineStats={lineStats}
                  onAddLine={addLine}
                  onRemoveLine={removeLine}
                  onUpdateLine={updateLine}
                  onItemSearch={setItemSearch}
                />

                <PurchaseOrderLogisticsSection
                  orderDate={orderDate}
                  expectedDate={expectedDate}
                  shipToLocationId={shipToLocationId}
                  receivingLocationId={receivingLocationId}
                  locationOptions={locationOptions}
                  locationsLoading={locationsQuery.isLoading}
                  notes={notes}
                  onOrderDateChange={setOrderDate}
                  onExpectedDateChange={setExpectedDate}
                  onShipToLocationChange={setShipToLocationId}
                  onReceivingLocationChange={setReceivingLocationId}
                  onLocationSearch={setLocationSearch}
                  onNotesChange={setNotes}
                />

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

              <PurchaseOrderReadinessPanel
                vendorId={vendorId}
                lineStats={lineStats}
                orderDate={orderDate}
                expectedDate={expectedDate}
              />
            </div>
          </form>
        </Card>
      </Section>
    </div>
  )
}

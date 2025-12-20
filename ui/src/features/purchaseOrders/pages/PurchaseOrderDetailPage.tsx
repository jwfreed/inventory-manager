import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { deletePurchaseOrderApi, getPurchaseOrder, updatePurchaseOrder } from '../../../api/endpoints/purchaseOrders'
import type { ApiError, PurchaseOrder } from '../../../api/types'
import { Section } from '../../../components/Section'
import { Card } from '../../../components/Card'
import { LoadingSpinner } from '../../../components/Loading'
import { Alert } from '../../../components/Alert'
import { Button } from '../../../components/Button'
import { Input, Textarea } from '../../../components/Inputs'
import { useEffect, useMemo, useState } from 'react'
import { SearchableSelect } from '../../../components/SearchableSelect'
import { listLocations } from '../../../api/endpoints/locations'
import type { Location } from '../../../api/types'
import { useNavigate } from 'react-router-dom'

export default function PurchaseOrderDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [orderDate, setOrderDate] = useState('')
  const [expectedDate, setExpectedDate] = useState('')
  const [shipToLocationId, setShipToLocationId] = useState('')
  const [receivingLocationId, setReceivingLocationId] = useState('')
  const [status, setStatus] = useState('draft')
  const [notes, setNotes] = useState('')

  const poQuery = useQuery<PurchaseOrder, ApiError>({
    queryKey: ['purchase-order', id],
    queryFn: () => getPurchaseOrder(id as string),
    enabled: !!id,
  })

  const locationsQuery = useQuery<{ data: Location[] }, ApiError>({
    queryKey: ['locations', 'po-detail'],
    queryFn: () => listLocations({ limit: 200, active: true }),
    staleTime: 60_000,
    retry: 1,
  })

  const locationOptions = useMemo(
    () =>
      (locationsQuery.data?.data ?? []).map((loc) => ({
        value: loc.id,
        label: `${loc.code} — ${loc.name}`,
        keywords: `${loc.code} ${loc.name} ${loc.type}`,
      })),
    [locationsQuery.data],
  )

  useEffect(() => {
    if (!poQuery.data) return
    // eslint-disable-next-line react-hooks/exhaustive-deps
    setOrderDate(poQuery.data.orderDate ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
    setExpectedDate(poQuery.data.expectedDate ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
    setShipToLocationId(poQuery.data.shipToLocationId ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
    setReceivingLocationId(poQuery.data.receivingLocationId ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
    setStatus(poQuery.data.status ?? 'draft')
    // eslint-disable-next-line react-hooks/exhaustive-deps
    setNotes(poQuery.data.notes ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poQuery.data?.id])

  const updateMutation = useMutation({
    mutationFn: () =>
      updatePurchaseOrder(id as string, {
        orderDate: orderDate || undefined,
        expectedDate: expectedDate || undefined,
        shipToLocationId: shipToLocationId || undefined,
        receivingLocationId: receivingLocationId || undefined,
        status,
        notes: notes || undefined,
      }),
    onSuccess: () => {
      void poQuery.refetch()
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => deletePurchaseOrderApi(id as string),
    onSuccess: () => {
      navigate('/purchase-orders')
    },
  })

  if (poQuery.isLoading) {
    return (
      <Section title="Purchase Order">
        <Card>
          <LoadingSpinner label="Loading PO..." />
        </Card>
      </Section>
    )
  }

  if (poQuery.isError || !poQuery.data) {
    return (
      <Section title="Purchase Order">
        <Card>
          <Alert variant="error" title="Error" message={(poQuery.error as ApiError)?.message ?? 'PO not found'} />
        </Card>
      </Section>
    )
  }

  const po = poQuery.data

  return (
    <div className="space-y-4">
      <Section title={`Purchase Order ${po.poNumber}`} description="Full details and lines.">
        <Card>
          <div className="flex items-center justify-between">
            <div className="text-sm text-slate-700">
              Vendor: {po.vendorCode ?? po.vendorId} {po.vendorName ? `— ${po.vendorName}` : ''}
            </div>
            <div className="text-xs uppercase tracking-wide text-slate-500">Status: {po.status}</div>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-2 lg:grid-cols-3 text-sm text-slate-800">
            <div>
              <div className="text-xs uppercase text-slate-500">PO Number</div>
              <div className="font-semibold">{po.poNumber}</div>
            </div>
            <label className="space-y-1 text-sm">
              <span className="text-xs uppercase text-slate-500">Order date</span>
              <Input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-xs uppercase text-slate-500">Expected date</span>
              <Input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />
            </label>
            <div>
              <div className="text-xs uppercase text-slate-500">Status</div>
              <select
                className="w-full rounded border border-slate-200 px-2 py-1 text-sm"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="draft">draft</option>
                <option value="submitted">submitted</option>
                <option value="received">received</option>
                <option value="closed">closed</option>
              </select>
            </div>
            <div>
              <SearchableSelect
                label="Ship-to"
                value={shipToLocationId}
                options={locationOptions}
                disabled={locationsQuery.isLoading}
                onChange={(nextValue) => setShipToLocationId(nextValue)}
              />
            </div>
            <div>
              <SearchableSelect
                label="Receiving/staging"
                value={receivingLocationId}
                options={locationOptions}
                disabled={locationsQuery.isLoading}
                onChange={(nextValue) => setReceivingLocationId(nextValue)}
              />
            </div>
          </div>
          <label className="mt-3 block space-y-1 text-sm">
            <span className="text-xs uppercase text-slate-500">Notes</span>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
          <div className="mt-4 flex gap-2">
            <Button size="sm" onClick={() => updateMutation.mutate()} disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving…' : 'Save'}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                if (confirm('Delete this purchase order?')) {
                  deleteMutation.mutate()
                }
              }}
              disabled={deleteMutation.isPending}
            >
              Delete
            </Button>
            <Link to="/purchase-orders">
              <Button variant="secondary" size="sm">
                Back to list
              </Button>
            </Link>
            <Link to="/purchase-orders/new">
              <Button variant="secondary" size="sm">
                New PO
              </Button>
            </Link>
          </div>
        </Card>
      </Section>

      <Section title="Lines">
        <Card>
          {po.lines && po.lines.length > 0 ? (
            <div className="overflow-hidden rounded-lg border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Line</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Item</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Qty</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">UOM</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white">
                  {po.lines.map((line) => (
                    <tr key={line.id}>
                      <td className="px-3 py-2 text-sm text-slate-800">{line.lineNumber}</td>
                      <td className="px-3 py-2 text-sm text-slate-800">
                        {line.itemSku ?? line.itemId}
                        {line.itemName ? ` — ${line.itemName}` : ''}
                      </td>
                      <td className="px-3 py-2 text-sm text-slate-800">{line.quantityOrdered}</td>
                      <td className="px-3 py-2 text-sm text-slate-800">{line.uom}</td>
                      <td className="px-3 py-2 text-sm text-slate-800">{line.notes ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="py-4 text-sm text-slate-600">No lines.</div>
          )}
        </Card>
      </Section>
    </div>
  )
}

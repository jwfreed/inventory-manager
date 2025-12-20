import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getPurchaseOrder } from '../../../api/endpoints/purchaseOrders'
import type { ApiError, PurchaseOrder } from '../../../api/types'
import { Section } from '../../../components/Section'
import { Card } from '../../../components/Card'
import { LoadingSpinner } from '../../../components/Loading'
import { Alert } from '../../../components/Alert'
import { Button } from '../../../components/Button'

export default function PurchaseOrderDetailPage() {
  const { id } = useParams<{ id: string }>()

  const poQuery = useQuery<PurchaseOrder, ApiError>({
    queryKey: ['purchase-order', id],
    queryFn: () => getPurchaseOrder(id as string),
    enabled: !!id,
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
          <div className="mt-3 grid gap-2 md:grid-cols-2 lg:grid-cols-3 text-sm text-slate-800">
            <div>
              <div className="text-xs uppercase text-slate-500">PO Number</div>
              <div className="font-semibold">{po.poNumber}</div>
            </div>
            <div>
              <div className="text-xs uppercase text-slate-500">Order date</div>
              <div>{po.orderDate ?? '—'}</div>
            </div>
            <div>
              <div className="text-xs uppercase text-slate-500">Expected date</div>
              <div>{po.expectedDate ?? '—'}</div>
            </div>
            <div>
              <div className="text-xs uppercase text-slate-500">Ship-to</div>
              <div>{po.shipToLocationCode ?? po.shipToLocationId ?? '—'}</div>
            </div>
            <div>
              <div className="text-xs uppercase text-slate-500">Receiving/staging</div>
              <div>{po.receivingLocationCode ?? po.receivingLocationId ?? '—'}</div>
            </div>
            <div>
              <div className="text-xs uppercase text-slate-500">Vendor ref</div>
              <div>{po.vendorReference ?? '—'}</div>
            </div>
          </div>
          {po.notes && (
            <div className="mt-3 text-sm text-slate-700">
              <div className="text-xs uppercase text-slate-500">Notes</div>
              <div>{po.notes}</div>
            </div>
          )}
          <div className="mt-4 flex gap-2">
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

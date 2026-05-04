import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { postShipment } from '../api/shipments'
import { orderToCashQueryKeys, useShipment } from '../queries'
import type { ApiError, ShipmentLine } from '../../../api/types'
import {
  ActionGuardMessage,
  Alert,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LoadingSpinner,
  Modal,
  PageHeader,
  Panel,
} from '@shared/ui'
import { formatDate, formatNumber } from '@shared/formatters'
import { formatStatusLabel } from '@shared/ui'
import { ledgerQueryKeys } from '@features/ledger/queries'
import { formatShipmentError } from '../lib/shipmentErrorMessaging'
import { logOperationalMutationFailure } from '../../../lib/operationalLogging'
import { useAuth } from '@shared/auth'

async function invalidateShipmentQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  shipmentId: string,
  salesOrderId?: string,
) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: orderToCashQueryKeys.shipments.all }),
    queryClient.invalidateQueries({ queryKey: orderToCashQueryKeys.shipments.detail(shipmentId) }),
    queryClient.invalidateQueries({ queryKey: orderToCashQueryKeys.reservations.all }),
    queryClient.invalidateQueries({ queryKey: ledgerQueryKeys.all }),
    queryClient.invalidateQueries({ queryKey: orderToCashQueryKeys.salesOrders.all }),
    ...(salesOrderId
      ? [queryClient.invalidateQueries({ queryKey: orderToCashQueryKeys.salesOrders.detail(salesOrderId) })]
      : []),
  ])
}

export default function ShipmentDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { hasPermission } = useAuth()
  const [confirmPostOpen, setConfirmPostOpen] = useState(false)
  const [postError, setPostError] = useState<string | null>(null)

  const query = useShipment(id)

  useEffect(() => {
    const err = query.error as ApiError | undefined
    if (query.isError && err?.status === 404) {
      navigate('/not-found', { replace: true })
    }
  }, [query.isError, query.error, navigate])

  const postMutation = useMutation({
    mutationFn: async () => postShipment(id as string),
    onSuccess: async (shipment) => {
      setPostError(null)
      setConfirmPostOpen(false)
      await invalidateShipmentQueries(queryClient, shipment.id, shipment.salesOrderId)
    },
    onError: (err) => {
      logOperationalMutationFailure('shipments', 'post', err, { shipmentId: id })
      setPostError(formatShipmentError(err, 'Failed to post shipment.'))
    },
  })

  const lines: ShipmentLine[] = query.data?.lines || []
  const canPostShipment = hasPermission('outbound:post')
  const canPost = useMemo(() => {
    if (!query.data) return false
    return canPostShipment && !query.data.inventoryMovementId && query.data.status !== 'posted' && lines.length > 0
  }, [canPostShipment, lines.length, query.data])

  const handleRequestPost = () => {
    if (!canPost) return
    setConfirmPostOpen(true)
  }

  const handleConfirmPost = () => {
    if (!canPost) return
    postMutation.mutate()
  }

  const copyId = async () => {
    if (!id) return
    try {
      await navigator.clipboard.writeText(id)
    } catch {
      // ignore
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Shipment detail"
        subtitle="Post the shipment only after the lines, location, and outbound validation are ready."
        action={
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => navigate('/shipments')}>
              Back to list
            </Button>
            <Button variant="secondary" size="sm" onClick={copyId}>
              Copy ID
            </Button>
            {canPostShipment ? (
              <Button size="sm" disabled={!canPost} onClick={handleRequestPost}>
                Post shipment
              </Button>
            ) : null}
          </div>
        }
      />

      {query.isLoading && <LoadingSpinner label="Loading shipment..." />}
      {query.isError && query.error && !query.isLoading && (
        <ErrorState error={query.error as ApiError} onRetry={() => void query.refetch()} />
      )}

      {query.data && !query.isError ? (
        <>
          <Panel
            title="Shipment state"
            description="Shipment posting performs the final stock validation, fulfills matched reservations, and writes the authoritative issue movement."
          >
            {postError ? <Alert variant="error" title="Shipment post failed" message={postError} /> : null}
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-slate-500">Status</div>
                <div className="mt-2">
                  <Badge variant="neutral">{formatStatusLabel(query.data.status)}</Badge>
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-slate-500">Sales order</div>
                <div className="mt-2 text-sm text-slate-900">{query.data.salesOrderId || '—'}</div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-slate-500">Shipped at</div>
                <div className="mt-2 text-sm text-slate-900">
                  {query.data.shippedAt ? formatDate(query.data.shippedAt) : '—'}
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-slate-500">Posted at</div>
                <div className="mt-2 text-sm text-slate-900">
                  {query.data.postedAt ? formatDate(query.data.postedAt) : '—'}
                </div>
              </div>
            </div>

            <div className="mt-4 grid gap-3 text-sm text-slate-800 md:grid-cols-2">
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Ship from</div>
                <div>{query.data.shipFromLocationId || '—'}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">External ref</div>
                <div>{query.data.externalRef || '—'}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Movement</div>
                <div>
                  {query.data.inventoryMovementId ? (
                    <Link
                      to={`/movements/${query.data.inventoryMovementId}`}
                      className="text-brand-700 hover:underline"
                    >
                      {query.data.inventoryMovementId}
                    </Link>
                  ) : (
                    'Pending post'
                  )}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Notes</div>
                <div>{query.data.notes || '—'}</div>
              </div>
            </div>

            {canPostShipment && !canPost ? (
              <div className="mt-4">
                <ActionGuardMessage
                  title="Shipment posting locked"
                  message={
                    query.data.inventoryMovementId || query.data.status === 'posted'
                      ? 'This shipment is already posted and linked to the ledger.'
                      : 'A shipment requires at least one valid line and a ship-from location before it can be posted.'
                  }
                  action={
                    query.data.inventoryMovementId ? (
                      <Link to={`/movements/${query.data.inventoryMovementId}`}>
                        <Button size="sm" variant="secondary">
                          View movement
                        </Button>
                      </Link>
                    ) : undefined
                  }
                />
              </div>
            ) : null}
          </Panel>

          <Panel title="Lines" description="Shipment lines are posted together as one outbound issue movement.">
            {lines.length === 0 ? (
              <EmptyState title="No lines" description="No lines returned for this shipment." />
            ) : (
              <div className="overflow-hidden rounded-xl border border-slate-200">
                <table className="min-w-full divide-y divide-slate-200">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Sales order line
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        UOM
                      </th>
                      <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Quantity
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 bg-white">
                    {lines.map((line) => (
                      <tr key={line.id}>
                        <td className="px-4 py-3 text-sm text-slate-800">{line.salesOrderLineId || '—'}</td>
                        <td className="px-4 py-3 text-sm text-slate-800">{line.uom || '—'}</td>
                        <td className="px-4 py-3 text-right text-sm text-slate-800">
                          {line.quantityShipped !== undefined ? formatNumber(line.quantityShipped) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      ) : null}

      <Modal
        isOpen={confirmPostOpen}
        onClose={() => {
          if (postMutation.isPending) return
          setConfirmPostOpen(false)
          setPostError(null)
        }}
        title="Post shipment"
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => setConfirmPostOpen(false)}
              disabled={postMutation.isPending}
            >
              Back
            </Button>
            <Button
              onClick={handleConfirmPost}
              disabled={!canPost || postMutation.isPending}
            >
              {postMutation.isPending ? 'Posting...' : 'Confirm post'}
            </Button>
          </div>
        }
      >
        <div className="space-y-4 text-sm text-slate-700">
          {postError ? <Alert variant="error" title="Shipment post failed" message={postError} /> : null}
          <Alert
            variant="warning"
            title="Final outbound validation"
            message="Posting validates available stock, fulfills any matched reservations, and writes the final outbound movement. Negative override is intentionally unavailable from this screen."
          />
        </div>
      </Modal>
    </div>
  )
}

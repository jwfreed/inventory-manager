import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query'
import { allocateReservation, cancelReservation, fulfillReservation } from '../api/reservations'
import { orderToCashQueryKeys, useReservation, useShipmentsList } from '../queries'
import type { ApiError, Reservation, Shipment } from '../../../api/types'
import {
  ActionGuardMessage,
  Alert,
  Badge,
  Button,
  ErrorState,
  Input,
  LoadingSpinner,
  Modal,
  PageHeader,
  Panel,
} from '@shared/ui'
import { formatNumber, formatDate } from '@shared/formatters'
import { formatStatusLabel } from '@shared/ui'
import {
  canAllocateReservation,
  canCancelReservation,
  canFulfillReservation,
  getReservationActionGuardMessage,
} from '../lib/reservationActionPolicy'
import { formatReservationError } from '../lib/reservationErrorMessaging'
import { logOperationalMutationFailure } from '../../../lib/operationalLogging'
import { getShipment } from '../api/shipments'
import { useAuth } from '@shared/auth'

type ActionType = 'allocate' | 'cancel' | 'fulfill'

async function invalidateReservationQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  reservationId: string,
) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: orderToCashQueryKeys.reservations.all }),
    queryClient.invalidateQueries({ queryKey: orderToCashQueryKeys.reservations.detail(reservationId) }),
    queryClient.invalidateQueries({ queryKey: orderToCashQueryKeys.salesOrders.all }),
    queryClient.invalidateQueries({ queryKey: orderToCashQueryKeys.shipments.all }),
  ])
}

function getOpenReservationQuantity(reservation: Reservation | undefined) {
  if (!reservation) return 0
  return Math.max(0, (reservation.quantityReserved ?? 0) - (reservation.quantityFulfilled ?? 0))
}

export default function ReservationDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { hasPermission } = useAuth()
  const [activeAction, setActiveAction] = useState<ActionType | null>(null)
  const [cancelReason, setCancelReason] = useState('')
  const [fulfillQuantity, setFulfillQuantity] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)

  const query = useReservation(id)
  const shipmentsQuery = useShipmentsList({ limit: 100 }, { staleTime: 30_000 })

  useEffect(() => {
    const err = query.error as ApiError | undefined
    if (query.isError && err?.status === 404) {
      navigate('/not-found', { replace: true })
    }
  }, [query.isError, query.error, navigate])

  const matchingShipmentSummaries = useMemo(() => {
    if (query.data?.demandType !== 'sales_order_line' || !query.data?.demandId) {
      return []
    }
    return shipmentsQuery.data?.data ?? []
  }, [query.data?.demandId, query.data?.demandType, shipmentsQuery.data])

  const shipmentDetailsQueries = useQueries({
    queries: matchingShipmentSummaries.map((shipment) => ({
      queryKey: orderToCashQueryKeys.shipments.detail(shipment.id),
      queryFn: () => getShipment(shipment.id),
      staleTime: 30_000,
      retry: 1,
    })),
  })

  const linkedShipments = useMemo(() => {
    if (!query.data?.demandId) return []
    return shipmentDetailsQueries
      .map((shipmentQuery) => shipmentQuery.data)
      .filter((shipment): shipment is Shipment => Boolean(shipment))
      .filter((shipment) =>
        (shipment.lines ?? []).some((line) => line.salesOrderLineId === query.data?.demandId),
      )
      .sort((left, right) => {
        const leftTimestamp = left.postedAt ?? left.shippedAt ?? left.id
        const rightTimestamp = right.postedAt ?? right.shippedAt ?? right.id
        return String(rightTimestamp).localeCompare(String(leftTimestamp))
      })
  }, [query.data?.demandId, shipmentDetailsQueries])

  useEffect(() => {
    if (!query.data) return
    if (!activeAction || activeAction !== 'fulfill') return
    setFulfillQuantity(String(getOpenReservationQuantity(query.data)))
  }, [activeAction, query.data])

  const allocateMutation = useMutation({
    mutationFn: async (reservation: Reservation) => allocateReservation(reservation.id, reservation.warehouseId),
    onSuccess: async (reservation) => {
      setActionError(null)
      setActiveAction(null)
      await invalidateReservationQueries(queryClient, reservation.id)
    },
    onError: (err, reservation) => {
      logOperationalMutationFailure('reservations', 'allocate', err, { reservationId: reservation.id })
      setActionError(formatReservationError(err, 'Failed to allocate reservation.'))
    },
  })

  const cancelMutation = useMutation({
    mutationFn: async (reservation: Reservation) =>
      cancelReservation(reservation.id, {
        warehouseId: reservation.warehouseId,
        reason: cancelReason,
      }),
    onSuccess: async (reservation) => {
      setActionError(null)
      setCancelReason('')
      setActiveAction(null)
      await invalidateReservationQueries(queryClient, reservation.id)
    },
    onError: (err, reservation) => {
      logOperationalMutationFailure('reservations', 'cancel', err, { reservationId: reservation.id })
      setActionError(formatReservationError(err, 'Failed to cancel reservation.'))
    },
  })

  const fulfillMutation = useMutation({
    mutationFn: async (reservation: Reservation) =>
      fulfillReservation(reservation.id, {
        warehouseId: reservation.warehouseId,
        quantity: Number(fulfillQuantity),
      }),
    onSuccess: async (reservation) => {
      setActionError(null)
      setActiveAction(null)
      await invalidateReservationQueries(queryClient, reservation.id)
    },
    onError: (err, reservation) => {
      logOperationalMutationFailure('reservations', 'fulfill', err, {
        reservationId: reservation.id,
        quantity: Number(fulfillQuantity),
      })
      setActionError(formatReservationError(err, 'Failed to fulfill reservation.'))
    },
  })

  const currentReservation = query.data
  const guards = getReservationActionGuardMessage(currentReservation)
  const canAllocate =
    hasPermission('outbound:allocate') &&
    !!currentReservation &&
    canAllocateReservation(currentReservation)
  const canCancel =
    hasPermission('outbound:write') &&
    !!currentReservation &&
    canCancelReservation(currentReservation)
  const canFulfill =
    hasPermission('outbound:post') &&
    !!currentReservation &&
    canFulfillReservation(currentReservation)
  const mutationBusy =
    allocateMutation.isPending || cancelMutation.isPending || fulfillMutation.isPending

  const handleAllocate = () => {
    if (!canAllocate || !currentReservation) return
    allocateMutation.mutate(currentReservation)
  }

  const handleCancel = () => {
    if (!canCancel || !currentReservation) return
    cancelMutation.mutate(currentReservation)
  }

  const handleFulfill = () => {
    if (!canFulfill || !currentReservation || !(Number(fulfillQuantity) > 0)) return
    fulfillMutation.mutate(currentReservation)
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
        title="Reservation detail"
        subtitle="Manage reservation allocation, cancellation, and fulfillment without bypassing warehouse state constraints."
        action={
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => navigate('/reservations')}>
              Back to list
            </Button>
            <Button variant="secondary" size="sm" onClick={copyId}>
              Copy ID
            </Button>
          </div>
        }
      />

      {query.isLoading && <LoadingSpinner label="Loading reservation..." />}
      {query.isError && query.error && !query.isLoading && (
        <ErrorState error={query.error as ApiError} onRetry={() => void query.refetch()} />
      )}

      {currentReservation && !query.isError ? (
        <>
          <Panel
            title="Reservation state"
            description="Reservation actions remain ledger-safe: they shift reserved and allocated commitments without directly changing on-hand inventory."
          >
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-slate-500">Status</div>
                <div className="mt-2">
                  <Badge variant="neutral">{formatStatusLabel(currentReservation.status)}</Badge>
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-slate-500">Demand</div>
                <div className="mt-2 text-sm text-slate-900">
                  {currentReservation.demandType || '—'} {currentReservation.demandId || ''}
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-slate-500">Reserved qty</div>
                <div className="mt-2 text-sm text-slate-900">
                  {formatNumber(currentReservation.quantityReserved ?? 0)} {currentReservation.uom || ''}
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-slate-500">Open qty</div>
                <div className="mt-2 text-sm text-slate-900">
                  {formatNumber(getOpenReservationQuantity(currentReservation))} {currentReservation.uom || ''}
                </div>
              </div>
            </div>

            <div className="mt-4 grid gap-3 text-sm text-slate-800 md:grid-cols-2">
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Item</div>
                <div>{currentReservation.itemId || '—'}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Location</div>
                <div>{currentReservation.locationId || '—'}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Warehouse</div>
                <div>{currentReservation.warehouseId || '—'}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Reserved at</div>
                <div>{currentReservation.reservedAt ? formatDate(currentReservation.reservedAt) : '—'}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Allocated at</div>
                <div>{currentReservation.allocatedAt ? formatDate(currentReservation.allocatedAt) : '—'}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Fulfilled at</div>
                <div>{currentReservation.fulfilledAt ? formatDate(currentReservation.fulfilledAt) : '—'}</div>
              </div>
              <div className="md:col-span-2">
                <div className="text-xs uppercase tracking-wide text-slate-500">Notes</div>
                <div>{currentReservation.notes || currentReservation.cancelReason || '—'}</div>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={!canAllocate}
                title={guards.allocate ?? undefined}
                onClick={() => {
                  setActionError(null)
                  setActiveAction('allocate')
                }}
              >
                Allocate reservation
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={!canCancel}
                title={guards.cancel ?? undefined}
                onClick={() => {
                  setActionError(null)
                  setActiveAction('cancel')
                }}
              >
                Cancel reservation
              </Button>
              <Button
                size="sm"
                disabled={!canFulfill}
                title={guards.fulfill ?? undefined}
                onClick={() => {
                  setActionError(null)
                  setActiveAction('fulfill')
                }}
              >
                Fulfill reservation
              </Button>
            </div>

            {!canAllocate && !canCancel && !canFulfill ? (
              <div className="mt-4">
                <ActionGuardMessage
                  title="Reservation actions locked"
                  message="This reservation has reached a terminal or non-mutable state. Refresh the page if another workflow has recently changed it."
                />
              </div>
            ) : null}
          </Panel>

          <Panel
            title="Shipment linkage"
            description="Reservation linkage is inferred from recent shipment documents whose lines reference the same sales-order line demand."
          >
            {shipmentsQuery.isLoading ? (
              <LoadingSpinner label="Loading recent shipment linkage..." />
            ) : shipmentsQuery.isError ? (
              <Alert
                variant="error"
                title="Shipment linkage unavailable"
                message={shipmentsQuery.error?.message ?? 'Failed to load recent shipments.'}
              />
            ) : linkedShipments.length === 0 ? (
              <ActionGuardMessage
                title="No recent shipment linkage"
                message="No recent shipment document lines matched this reservation demand in the latest shipment query window."
              />
            ) : (
              <div className="overflow-hidden rounded-xl border border-slate-200">
                <table className="min-w-full divide-y divide-slate-200">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Shipment
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Status
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Shipped at
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Movement
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 bg-white">
                    {linkedShipments.map((shipment) => (
                      <tr key={shipment.id}>
                        <td className="px-4 py-3 text-sm text-slate-800">
                          <Link className="text-brand-700 hover:underline" to={`/shipments/${shipment.id}`}>
                            {shipment.id}
                          </Link>
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-800">
                          <Badge variant="neutral">{formatStatusLabel(shipment.status)}</Badge>
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-800">
                          {shipment.shippedAt ? formatDate(shipment.shippedAt) : '—'}
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-800">
                          {shipment.inventoryMovementId ? (
                            <Link
                              className="text-brand-700 hover:underline"
                              to={`/movements/${shipment.inventoryMovementId}`}
                            >
                              {shipment.inventoryMovementId}
                            </Link>
                          ) : (
                            'Pending post'
                          )}
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
        isOpen={Boolean(activeAction && currentReservation)}
        onClose={() => {
          if (mutationBusy) return
          setActiveAction(null)
          setActionError(null)
          setCancelReason('')
        }}
        title={
          activeAction === 'allocate'
            ? 'Allocate reservation'
            : activeAction === 'cancel'
              ? 'Cancel reservation'
              : activeAction === 'fulfill'
                ? 'Fulfill reservation'
                : 'Reservation action'
        }
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setActiveAction(null)
                setActionError(null)
              }}
              disabled={mutationBusy}
            >
              Back
            </Button>
            {activeAction === 'allocate' && currentReservation ? (
              <Button
                disabled={!canAllocate || mutationBusy}
                onClick={handleAllocate}
              >
                {allocateMutation.isPending ? 'Allocating...' : 'Confirm allocate'}
              </Button>
            ) : null}
            {activeAction === 'cancel' && currentReservation ? (
              <Button
                variant="danger"
                disabled={!canCancel || mutationBusy}
                onClick={handleCancel}
              >
                {cancelMutation.isPending ? 'Canceling...' : 'Confirm cancel'}
              </Button>
            ) : null}
            {activeAction === 'fulfill' && currentReservation ? (
              <Button
                disabled={!canFulfill || mutationBusy || !(Number(fulfillQuantity) > 0)}
                onClick={handleFulfill}
              >
                {fulfillMutation.isPending ? 'Fulfilling...' : 'Confirm fulfill'}
              </Button>
            ) : null}
          </div>
        }
      >
        {currentReservation ? (
          <div className="space-y-4">
            {actionError ? <Alert variant="error" title="Action failed" message={actionError} /> : null}
            {activeAction === 'allocate' ? (
              <Alert
                variant="info"
                title="Allocate reservation"
                message="Allocation moves the open quantity from reserved to allocated so shipment posting can consume it cleanly."
              />
            ) : null}
            {activeAction === 'cancel' ? (
              <>
                <Alert
                  variant="warning"
                  title="Cancel reservation"
                  message="Canceling releases the demand commitment before shipment posting. This does not create or reverse an inventory movement."
                />
                <label className="block space-y-1">
                  <span className="text-xs uppercase tracking-wide text-slate-500">Cancel reason</span>
                  <textarea
                    className="min-h-[96px] w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    value={cancelReason}
                    onChange={(event) => setCancelReason(event.target.value)}
                    placeholder="Optional cancellation reason"
                    disabled={mutationBusy}
                  />
                </label>
              </>
            ) : null}
            {activeAction === 'fulfill' ? (
              <>
                <Alert
                  variant="info"
                  title="Fulfill reservation"
                  message="Fulfillment consumes allocated quantity. Enter the quantity to fulfill from this reservation."
                />
                <label className="block space-y-1">
                  <span className="text-xs uppercase tracking-wide text-slate-500">Fulfill quantity</span>
                  <Input
                    type="number"
                    min={0}
                    step="any"
                    value={fulfillQuantity}
                    onChange={(event) => setFulfillQuantity(event.target.value)}
                    disabled={mutationBusy}
                  />
                </label>
              </>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </div>
  )
}

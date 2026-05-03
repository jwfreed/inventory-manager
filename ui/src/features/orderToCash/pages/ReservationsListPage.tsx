import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { cancelReservation, allocateReservation } from '../api/reservations'
import { orderToCashQueryKeys, useReservationsList } from '../queries'
import type { Reservation } from '../../../api/types'
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  LoadingSpinner,
  Modal,
  PageHeader,
  Panel,
} from '@shared/ui'
import { formatStatusLabel } from '@shared/ui'
import { usePageChrome } from '../../../app/layout/usePageChrome'
import {
  canAllocateReservation,
  canCancelReservation,
  getReservationActionGuardMessage,
} from '../lib/reservationActionPolicy'
import { formatReservationError } from '../lib/reservationErrorMessaging'
import { logOperationalMutationFailure } from '../../../lib/operationalLogging'
import { useAuth } from '@shared/auth'

type QuickActionState =
  | { type: 'allocate'; reservation: Reservation }
  | { type: 'cancel'; reservation: Reservation }
  | null

async function invalidateReservationQueries(queryClient: ReturnType<typeof useQueryClient>, id: string) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: orderToCashQueryKeys.reservations.all }),
    queryClient.invalidateQueries({ queryKey: orderToCashQueryKeys.reservations.detail(id) }),
    queryClient.invalidateQueries({ queryKey: orderToCashQueryKeys.salesOrders.all }),
    queryClient.invalidateQueries({ queryKey: orderToCashQueryKeys.shipments.all }),
  ])
}

export default function ReservationsListPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { hasPermission } = useAuth()
  const { hideTitle } = usePageChrome()
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [quickAction, setQuickAction] = useState<QuickActionState>(null)
  const [cancelReason, setCancelReason] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)

  const { data, isLoading, isError, error, refetch } = useReservationsList({ limit: 100 })

  const allocateMutation = useMutation({
    mutationFn: async (reservation: Reservation) => allocateReservation(reservation.id, reservation.warehouseId),
    onSuccess: async (reservation) => {
      setActionError(null)
      setQuickAction(null)
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
      setQuickAction(null)
      await invalidateReservationQueries(queryClient, reservation.id)
    },
    onError: (err, reservation) => {
      logOperationalMutationFailure('reservations', 'cancel', err, { reservationId: reservation.id })
      setActionError(formatReservationError(err, 'Failed to cancel reservation.'))
    },
  })

  const filtered = useMemo(() => {
    const list = data?.data ?? []
    const statusFiltered = status
      ? list.filter((reservation) => (reservation.status ?? '').toUpperCase() === status)
      : list
    if (!search) return statusFiltered
    const needle = search.toLowerCase()
    return statusFiltered.filter((reservation) =>
      [reservation.itemId, reservation.locationId, reservation.demandId, reservation.demandType]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    )
  }, [data?.data, search, status])

  const selectedReservation = quickAction?.reservation ?? null
  const canAllocate =
    hasPermission('outbound:allocate') &&
    selectedReservation !== null &&
    canAllocateReservation(selectedReservation)
  const canCancel =
    hasPermission('outbound:write') &&
    selectedReservation !== null &&
    canCancelReservation(selectedReservation)
  const quickActionBusy = allocateMutation.isPending || cancelMutation.isPending

  const handleAllocate = () => {
    if (!canAllocate || !selectedReservation) return
    allocateMutation.mutate(selectedReservation)
  }

  const handleCancel = () => {
    if (!canCancel || !selectedReservation) return
    cancelMutation.mutate(selectedReservation)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={hideTitle ? '' : 'Reservations'}
        subtitle="Allocate, cancel, and inspect reservation demand without bypassing warehouse state gating."
        action={
          <Button variant="secondary" size="sm" onClick={() => void refetch()}>
            Refresh
          </Button>
        }
      />

      <Panel title="Filters" description="Filter reservations by lifecycle status, item, demand, or location.">
        <div className="flex flex-wrap items-center gap-3">
          <select
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="">All statuses</option>
            <option value="RESERVED">Reserved</option>
            <option value="ALLOCATED">Allocated</option>
            <option value="FULFILLED">Fulfilled</option>
            <option value="CANCELLED">Canceled</option>
            <option value="EXPIRED">Expired</option>
          </select>
          <input
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
            placeholder="Search by demand, item, or location"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </Panel>

      <Panel title="Reservations" description="The reservation ledger records allocation state separately from on-hand inventory.">
        <Card>
          {isLoading && <LoadingSpinner label="Loading reservations..." />}
          {isError && error && <Alert variant="error" title="Failed to load" message={error.message} />}
          {!isLoading && !isError && filtered.length === 0 && (
            <EmptyState
              title="No reservations found"
              description="No reservations matched the current filters."
            />
          )}
          {!isLoading && !isError && filtered.length > 0 ? (
            <div className="overflow-hidden rounded-xl border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Status
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Demand
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Item
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Location
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Reserved
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Fulfilled
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white">
                  {filtered.map((reservation) => {
                    const guards = getReservationActionGuardMessage(reservation)
                    return (
                      <tr key={reservation.id} className="hover:bg-slate-50">
                        <td className="px-4 py-3 text-sm text-slate-800">
                          <Badge variant="neutral">{formatStatusLabel(reservation.status)}</Badge>
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-700">
                          <button
                            className="text-left text-brand-700 hover:underline"
                            onClick={() => navigate(`/reservations/${reservation.id}`)}
                          >
                            {reservation.demandType || '—'} {reservation.demandId || ''}
                          </button>
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-700">{reservation.itemId || '—'}</td>
                        <td className="px-4 py-3 text-sm text-slate-700">{reservation.locationId || '—'}</td>
                        <td className="px-4 py-3 text-right text-sm text-slate-800">
                          {reservation.quantityReserved ?? '—'} {reservation.uom || ''}
                        </td>
                        <td className="px-4 py-3 text-right text-sm text-slate-800">
                          {reservation.quantityFulfilled ?? 0} {reservation.uom || ''}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap justify-end gap-2">
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => navigate(`/reservations/${reservation.id}`)}
                            >
                              View
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={!canAllocateReservation(reservation)}
                              title={guards.allocate ?? undefined}
                              onClick={() => {
                                setActionError(null)
                                setQuickAction({ type: 'allocate', reservation })
                              }}
                            >
                              Allocate
                            </Button>
                            <Button
                              size="sm"
                              variant="danger"
                              disabled={!canCancelReservation(reservation)}
                              title={guards.cancel ?? undefined}
                              onClick={() => {
                                setActionError(null)
                                setQuickAction({ type: 'cancel', reservation })
                              }}
                            >
                              Cancel
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </Card>
      </Panel>

      <Modal
        isOpen={Boolean(quickAction && selectedReservation)}
        onClose={() => {
          if (quickActionBusy) return
          setQuickAction(null)
          setActionError(null)
          setCancelReason('')
        }}
        title={
          quickAction?.type === 'allocate'
            ? 'Allocate reservation'
            : quickAction?.type === 'cancel'
              ? 'Cancel reservation'
              : 'Reservation action'
        }
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setQuickAction(null)
                setActionError(null)
                setCancelReason('')
              }}
              disabled={quickActionBusy}
            >
              Back
            </Button>
            {quickAction?.type === 'allocate' && selectedReservation ? (
              <Button
                onClick={handleAllocate}
                disabled={!canAllocate || quickActionBusy}
              >
                {allocateMutation.isPending ? 'Allocating...' : 'Confirm allocate'}
              </Button>
            ) : null}
            {quickAction?.type === 'cancel' && selectedReservation ? (
              <Button
                variant="danger"
                onClick={handleCancel}
                disabled={!canCancel || quickActionBusy}
              >
                {cancelMutation.isPending ? 'Canceling...' : 'Confirm cancel'}
              </Button>
            ) : null}
          </div>
        }
      >
        {selectedReservation ? (
          <div className="space-y-4 text-sm text-slate-700">
            {actionError ? <Alert variant="error" title="Action failed" message={actionError} /> : null}
            <div>
              Reservation <span className="font-semibold text-slate-900">{selectedReservation.id}</span>{' '}
              for item <span className="font-semibold text-slate-900">{selectedReservation.itemId || '—'}</span>{' '}
              currently shows status{' '}
              <span className="font-semibold text-slate-900">
                {formatStatusLabel(selectedReservation.status)}
              </span>
              .
            </div>
            {quickAction?.type === 'allocate' ? (
              <Alert
                variant="info"
                title="Allocate reservation"
                message="Allocation shifts the reservation from reserved to allocated inventory without changing on-hand stock."
              />
            ) : null}
            {quickAction?.type === 'cancel' ? (
              <>
                <Alert
                  variant="warning"
                  title="Cancel reservation"
                  message="Canceling the reservation releases the demand commitment. This does not create or reverse an inventory movement."
                />
                <label className="block space-y-1">
                  <span className="text-xs uppercase tracking-wide text-slate-500">Cancel reason</span>
                  <textarea
                    className="min-h-[96px] w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    value={cancelReason}
                    onChange={(event) => setCancelReason(event.target.value)}
                    placeholder="Optional reason for releasing the reservation"
                    disabled={quickActionBusy}
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

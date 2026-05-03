import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { allocateReservation } from '../api/reservations'
import { createShipment } from '../api/shipments'
import { orderToCashQueryKeys, useReservationsList, useSalesOrder, useShipmentsList } from '../queries'
import type { ApiError, Reservation, SalesOrderLine, Shipment } from '../../../api/types'
import {
  ActionGuardMessage,
  Alert,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Input,
  LoadingSpinner,
  PageHeader,
  Panel,
  Textarea,
} from '@shared/ui'
import { formatDate, formatNumber } from '@shared/formatters'
import { formatStatusLabel } from '@shared/ui'
import { canAllocateReservation } from '../lib/reservationActionPolicy'
import { formatReservationError } from '../lib/reservationErrorMessaging'
import { formatShipmentError } from '../lib/shipmentErrorMessaging'
import { logOperationalMutationFailure } from '../../../lib/operationalLogging'
import { useAuth } from '@shared/auth'

type ShipmentCreateResult = {
  shipment: Shipment
  allocatedCount: number
  allocationWarnings: string[]
}

function toLocalDateTimeInput(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const offset = date.getTimezoneOffset()
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16)
}

async function invalidateSalesOrderWorkflowQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  salesOrderId: string,
  shipmentId: string,
) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: orderToCashQueryKeys.salesOrders.all }),
    queryClient.invalidateQueries({ queryKey: orderToCashQueryKeys.salesOrders.detail(salesOrderId) }),
    queryClient.invalidateQueries({ queryKey: orderToCashQueryKeys.shipments.all }),
    queryClient.invalidateQueries({ queryKey: orderToCashQueryKeys.shipments.detail(shipmentId) }),
    queryClient.invalidateQueries({ queryKey: orderToCashQueryKeys.reservations.all }),
  ])
}

export default function SalesOrderDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { hasPermission } = useAuth()
  const [shipFromLocationId, setShipFromLocationId] = useState('')
  const [shippedAt, setShippedAt] = useState('')
  const [externalRef, setExternalRef] = useState('')
  const [notes, setNotes] = useState('')
  const [lineQuantities, setLineQuantities] = useState<Record<string, string>>({})
  const [shipmentError, setShipmentError] = useState<string | null>(null)
  const [shipmentWarning, setShipmentWarning] = useState<string | null>(null)
  const [shipmentResult, setShipmentResult] = useState<ShipmentCreateResult | null>(null)

  const orderQuery = useSalesOrder(id)
  const shipmentsQuery = useShipmentsList({ limit: 100 }, { staleTime: 30_000 })
  const reservationsQuery = useReservationsList(
    { warehouseId: orderQuery.data?.warehouseId ?? undefined, limit: 100 },
    { enabled: Boolean(orderQuery.data?.warehouseId), staleTime: 30_000 },
  )

  useEffect(() => {
    const err = orderQuery.error as ApiError | undefined
    if (orderQuery.isError && err?.status === 404) {
      navigate('/not-found', { replace: true })
    }
  }, [orderQuery.isError, orderQuery.error, navigate])

  useEffect(() => {
    if (!orderQuery.data) return
    setShipFromLocationId((current) => current || orderQuery.data?.shipFromLocationId || '')
    setShippedAt((current) => current || toLocalDateTimeInput(new Date().toISOString()))
  }, [orderQuery.data])

  const lines: SalesOrderLine[] = orderQuery.data?.lines ?? []
  const linkedShipments = useMemo(
    () => (shipmentsQuery.data?.data ?? []).filter((shipment) => shipment.salesOrderId === id),
    [id, shipmentsQuery.data],
  )

  const reservationsByLineId = useMemo(() => {
    const byLine = new Map<string, Reservation>()
    for (const reservation of reservationsQuery.data?.data ?? []) {
      if (reservation.demandType !== 'sales_order_line' || !reservation.demandId) continue
      if (!byLine.has(reservation.demandId)) {
        byLine.set(reservation.demandId, reservation)
      }
    }
    return byLine
  }, [reservationsQuery.data])

  const shipmentCreateMutation = useMutation({
    mutationFn: async (): Promise<ShipmentCreateResult> => {
      if (!orderQuery.data) {
        throw new Error('Sales order not loaded.')
      }
      const selectedLines = lines
        .map((line) => ({
          line,
          quantity: Number(lineQuantities[line.id] ?? 0),
        }))
        .filter(({ quantity }) => Number.isFinite(quantity) && quantity > 0)

      if (selectedLines.length === 0) {
        throw new Error('Select at least one sales-order line quantity before creating a shipment.')
      }

      const shipment = await createShipment({
        salesOrderId: orderQuery.data.id,
        shippedAt: new Date(shippedAt).toISOString(),
        shipFromLocationId: shipFromLocationId || undefined,
        externalRef: externalRef.trim() || undefined,
        notes: notes.trim() || undefined,
        lines: selectedLines.map(({ line, quantity }) => ({
          salesOrderLineId: line.id,
          uom: line.uom || '',
          quantityShipped: quantity,
        })),
      })

      const allocationWarnings: string[] = []
      let allocatedCount = 0
      const reservationsToAllocate = selectedLines
        .map(({ line }) => reservationsByLineId.get(line.id) ?? null)
        .filter((reservation): reservation is Reservation => Boolean(reservation))
        .filter(canAllocateReservation)

      for (const reservation of reservationsToAllocate) {
        try {
          await allocateReservation(reservation.id, reservation.warehouseId)
          allocatedCount += 1
        } catch (err) {
          allocationWarnings.push(
            `${reservation.itemId || reservation.id}: ${formatReservationError(
              err,
              'Reservation allocation failed after shipment creation.',
            )}`,
          )
        }
      }

      return {
        shipment,
        allocatedCount,
        allocationWarnings,
      }
    },
    onSuccess: async (result) => {
      setShipmentError(null)
      setShipmentResult(result)
      setShipmentWarning(
        result.allocationWarnings.length > 0
          ? result.allocationWarnings.join(' ')
          : result.allocatedCount > 0
            ? `${result.allocatedCount} matching reservation${result.allocatedCount === 1 ? '' : 's'} allocated during shipment creation.`
            : null,
      )
      setLineQuantities({})
      setExternalRef('')
      setNotes('')
      await invalidateSalesOrderWorkflowQueries(queryClient, result.shipment.salesOrderId || id || '', result.shipment.id)
    },
    onError: (err) => {
      logOperationalMutationFailure('shipments', 'create', err, { salesOrderId: id })
      setShipmentResult(null)
      setShipmentWarning(null)
      setShipmentError(formatShipmentError(err, 'Failed to create shipment.'))
    },
  })

  const copyId = async () => {
    if (!id) return
    try {
      await navigator.clipboard.writeText(id)
    } catch {
      // ignore
    }
  }

  const canCreateShipment =
    hasPermission('outbound:write') &&
    Boolean(orderQuery.data?.id) &&
    Boolean(shipFromLocationId) &&
    Boolean(shippedAt) &&
    lines.some((line) => Number(lineQuantities[line.id] ?? 0) > 0)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sales order detail"
        subtitle="Create outbound shipment documents from eligible sales-order lines and surface reservation readiness before posting."
        action={
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => navigate('/sales-orders')}>
              Back to list
            </Button>
            <Button variant="secondary" size="sm" onClick={copyId}>
              Copy ID
            </Button>
          </div>
        }
      />

      {orderQuery.isLoading && <LoadingSpinner label="Loading sales order..." />}
      {orderQuery.isError && orderQuery.error && !orderQuery.isLoading && (
        <ErrorState error={orderQuery.error as ApiError} onRetry={() => void orderQuery.refetch()} />
      )}

      {orderQuery.data && !orderQuery.isError ? (
        <>
          <Panel
            title="Order context"
            description="Shipment posting consumes sellable inventory and fulfills matched reservations. Available-to-promise should still be derived from ledger-backed availability."
          >
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-slate-500">SO number</div>
                <div className="mt-2 text-lg font-semibold text-slate-900">{orderQuery.data.soNumber}</div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-slate-500">Status</div>
                <div className="mt-2">
                  <Badge variant="neutral">{formatStatusLabel(orderQuery.data.status)}</Badge>
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-slate-500">Customer</div>
                <div className="mt-2 text-sm text-slate-900">{orderQuery.data.customerId || '—'}</div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-slate-500">Warehouse</div>
                <div className="mt-2 text-sm text-slate-900">{orderQuery.data.warehouseId || '—'}</div>
              </div>
            </div>

            <div className="mt-4 grid gap-3 text-sm text-slate-800 md:grid-cols-2">
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Order date</div>
                <div>{orderQuery.data.orderDate ? formatDate(orderQuery.data.orderDate) : '—'}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Requested ship date</div>
                <div>
                  {orderQuery.data.requestedShipDate ? formatDate(orderQuery.data.requestedShipDate) : '—'}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Default ship-from location</div>
                <div>{orderQuery.data.shipFromLocationId || '—'}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Customer reference</div>
                <div>{orderQuery.data.customerReference || '—'}</div>
              </div>
            </div>
          </Panel>

          <Panel
            title="Create shipment"
            description="Select the order lines to stage into one shipment document. Matching reserved inventory is allocated after shipment creation when possible."
          >
            {shipmentError ? <Alert variant="error" title="Shipment creation failed" message={shipmentError} /> : null}
            {shipmentWarning ? (
              <Alert
                variant={shipmentResult?.allocationWarnings.length ? 'warning' : 'info'}
                title={
                  shipmentResult?.allocationWarnings.length
                    ? 'Shipment created with reservation warnings'
                    : 'Shipment created'
                }
                message={shipmentWarning}
              />
            ) : null}
            {shipmentResult ? (
              <Alert
                variant="success"
                title="Shipment document ready"
                message={`Shipment ${shipmentResult.shipment.id} was created successfully.`}
                action={
                  <Link to={`/shipments/${shipmentResult.shipment.id}`}>
                    <Button size="sm" variant="secondary">
                      Open shipment
                    </Button>
                  </Link>
                }
              />
            ) : null}

            {!orderQuery.data.warehouseId ? (
              <ActionGuardMessage
                title="Shipment creation unavailable"
                message="This sales order has no warehouse scope, so reservation lookup and shipment creation are blocked until warehouse scope is defined."
              />
            ) : (
              <div className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <label className="block space-y-1">
                    <span className="text-xs uppercase tracking-wide text-slate-500">Shipped at</span>
                    <Input
                      type="datetime-local"
                      value={shippedAt}
                      onChange={(event) => setShippedAt(event.target.value)}
                      disabled={shipmentCreateMutation.isPending}
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-xs uppercase tracking-wide text-slate-500">Ship-from location</span>
                    <Input
                      value={shipFromLocationId}
                      onChange={(event) => setShipFromLocationId(event.target.value)}
                      placeholder="Required before posting"
                      disabled={shipmentCreateMutation.isPending}
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-xs uppercase tracking-wide text-slate-500">External reference</span>
                    <Input
                      value={externalRef}
                      onChange={(event) => setExternalRef(event.target.value)}
                      placeholder="Optional"
                      disabled={shipmentCreateMutation.isPending}
                    />
                  </label>
                  <label className="block space-y-1 md:col-span-2 xl:col-span-1">
                    <span className="text-xs uppercase tracking-wide text-slate-500">Notes</span>
                    <Textarea
                      value={notes}
                      onChange={(event) => setNotes(event.target.value)}
                      disabled={shipmentCreateMutation.isPending}
                    />
                  </label>
                </div>
                <div className="flex justify-end">
                  <Button
                    onClick={() => {
                      if (!hasPermission('outbound:write')) return
                      shipmentCreateMutation.mutate()
                    }}
                    disabled={!canCreateShipment || shipmentCreateMutation.isPending}
                  >
                    {shipmentCreateMutation.isPending ? 'Creating shipment...' : 'Create shipment'}
                  </Button>
                </div>
              </div>
            )}
          </Panel>

          <Panel title="Lines" description="Line-level reservation state is derived from reservation demand rows in the order warehouse.">
            {lines.length === 0 ? (
              <EmptyState title="No lines" description="No lines returned for this sales order." />
            ) : (
              <div className="overflow-hidden rounded-xl border border-slate-200">
                <table className="min-w-full divide-y divide-slate-200">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Line
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Item
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        UOM
                      </th>
                      <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Qty ordered
                      </th>
                      <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Backorder
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Reservation state
                      </th>
                      <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Ship qty
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 bg-white">
                    {lines.map((line) => {
                      const reservation = reservationsByLineId.get(line.id)
                      return (
                        <tr key={line.id}>
                          <td className="px-4 py-3 text-sm text-slate-800">{line.lineNumber ?? '—'}</td>
                          <td className="px-4 py-3 text-sm text-slate-800">{line.itemId || '—'}</td>
                          <td className="px-4 py-3 text-sm text-slate-800">{line.uom || '—'}</td>
                          <td className="px-4 py-3 text-right text-sm text-slate-800">
                            {line.quantityOrdered !== undefined ? formatNumber(line.quantityOrdered) : '—'}
                          </td>
                          <td className="px-4 py-3 text-right text-sm text-slate-800">
                            {line.derivedBackorderQty !== undefined ? formatNumber(line.derivedBackorderQty) : '—'}
                          </td>
                          <td className="px-4 py-3 text-sm text-slate-800">
                            {reservation ? (
                              <div className="space-y-1">
                                <Badge variant="neutral">{formatStatusLabel(reservation.status)}</Badge>
                                <div className="text-xs text-slate-500">
                                  {formatNumber(reservation.quantityReserved ?? 0)} reserved /{' '}
                                  {formatNumber(reservation.quantityFulfilled ?? 0)} fulfilled
                                </div>
                              </div>
                            ) : (
                              <span className="text-slate-500">No reservation</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <Input
                              type="number"
                              min={0}
                              step="any"
                              value={lineQuantities[line.id] ?? ''}
                              onChange={(event) =>
                                setLineQuantities((current) => ({
                                  ...current,
                                  [line.id]: event.target.value,
                                }))
                              }
                              disabled={shipmentCreateMutation.isPending}
                              className="ml-auto w-28"
                            />
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel title="Linked shipments" description="Recent shipment documents for this sales order. Posted shipments link to the authoritative movement ledger.">
            {shipmentsQuery.isLoading ? (
              <LoadingSpinner label="Loading linked shipments..." />
            ) : shipmentsQuery.isError ? (
              <Alert
                variant="error"
                title="Shipments unavailable"
                message={shipmentsQuery.error?.message ?? 'Failed to load shipment linkage.'}
              />
            ) : linkedShipments.length === 0 ? (
              <EmptyState
                title="No shipments linked"
                description="Create a shipment from the sales-order lines above to begin outbound execution."
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
                            'Draft'
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
    </div>
  )
}

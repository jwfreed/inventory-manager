import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useMovementsList } from '@features/ledger/queries'
import { useShipmentsList, useReturnDispositionsList, useReturnReceiptsList } from '@features/orderToCash/queries'
import {
  Alert,
  Button,
  Card,
  LoadingSpinner,
  OperationTimeline,
  PageHeader,
  Panel,
} from '@shared/ui'
import type { Movement, ReturnDisposition, ReturnReceipt, Shipment } from '@api/types'
import type { OperationTimelineItem } from '@shared/ui'
import { formatStatusLabel } from '@shared/ui'
import { getRecentProductionActivityItems } from '@features/workOrders/lib/workOrderOperationalHistory'

function toTransferTimelineItems(movements: Movement[]): OperationTimelineItem[] {
  return movements.map((movement) => ({
    id: movement.id,
    kindLabel: 'Transfer',
    title: `Transfer ${movement.id.slice(0, 8)}`,
    subtitle: movement.notes ?? 'Inventory transfer posted.',
    statusLabel: formatStatusLabel(movement.status),
    occurredAt: movement.occurredAt,
    postedAt: movement.postedAt,
    linkTo: `/movements/${movement.id}`,
    metadata: movement.externalRef ? [movement.externalRef] : undefined,
  }))
}

function toShipmentTimelineItems(shipments: Shipment[]): OperationTimelineItem[] {
  return shipments.map((shipment) => ({
    id: shipment.id,
    kindLabel: 'Shipment',
    title: `Shipment ${shipment.id.slice(0, 8)}`,
    subtitle: shipment.salesOrderId ? `Sales order ${shipment.salesOrderId}` : 'Shipment document created.',
    statusLabel: formatStatusLabel(shipment.status),
    occurredAt: shipment.shippedAt,
    postedAt: shipment.postedAt,
    linkTo: `/shipments/${shipment.id}`,
    metadata: shipment.inventoryMovementId ? [`Movement ${shipment.inventoryMovementId}`] : ['Pending post'],
  }))
}

function sortReturnActivityItems(items: OperationTimelineItem[]) {
  return [...items].sort((left, right) => {
    const leftTimestamp = left.occurredAt || left.postedAt || null
    const rightTimestamp = right.occurredAt || right.postedAt || null
    const leftMillis = leftTimestamp ? Date.parse(leftTimestamp) : Number.NaN
    const rightMillis = rightTimestamp ? Date.parse(rightTimestamp) : Number.NaN
    if (Number.isFinite(leftMillis) && Number.isFinite(rightMillis) && leftMillis !== rightMillis) {
      return rightMillis - leftMillis
    }
    if (Number.isFinite(leftMillis) && !Number.isFinite(rightMillis)) return -1
    if (!Number.isFinite(leftMillis) && Number.isFinite(rightMillis)) return 1
    return right.id.localeCompare(left.id)
  })
}

function toReturnActivityItems(receipts: ReturnReceipt[], dispositions: ReturnDisposition[]) {
  const receiptItems = receipts.map<OperationTimelineItem>((receipt) => ({
    id: `receipt:${receipt.id}`,
    kindLabel: 'Return receipt',
    title: `Receipt ${receipt.id.slice(0, 8)}`,
    subtitle: receipt.returnAuthorizationId
      ? `Return authorization ${receipt.returnAuthorizationId}`
      : 'Return receipt recorded.',
    statusLabel: formatStatusLabel(receipt.status),
    occurredAt: receipt.receivedAt,
    linkTo: `/return-receipts/${receipt.id}`,
    metadata: receipt.inventoryMovementId ? [`Movement ${receipt.inventoryMovementId}`] : ['No linked movement'],
  }))

  const dispositionItems = dispositions.map<OperationTimelineItem>((disposition) => ({
    id: `disposition:${disposition.id}`,
    kindLabel: 'Return disposition',
    title: `Disposition ${disposition.id.slice(0, 8)}`,
    subtitle: disposition.dispositionType
      ? `Disposition ${formatStatusLabel(disposition.dispositionType)}`
      : 'Return disposition recorded.',
    statusLabel: formatStatusLabel(disposition.status),
    occurredAt: disposition.occurredAt,
    linkTo: disposition.returnReceiptId ? `/return-receipts/${disposition.returnReceiptId}` : undefined,
    metadata: disposition.inventoryMovementId
      ? [`Movement ${disposition.inventoryMovementId}`]
      : ['No linked movement'],
  }))

  return sortReturnActivityItems([...receiptItems, ...dispositionItems]).slice(0, 6)
}

export default function WarehouseActivityBoardPage() {
  const transfersQuery = useMovementsList({ movementType: 'transfer', limit: 6 }, { staleTime: 30_000 })
  const productionQuery = useMovementsList({ externalRef: 'work_order_', limit: 12 }, { staleTime: 30_000 })
  const shipmentsQuery = useShipmentsList({ limit: 6 }, { staleTime: 30_000 })
  const returnReceiptsQuery = useReturnReceiptsList({ limit: 6 }, { staleTime: 30_000 })
  const returnDispositionsQuery = useReturnDispositionsList({ limit: 6 }, { staleTime: 30_000 })

  const transferItems = useMemo(
    () => toTransferTimelineItems(transfersQuery.data?.data ?? []),
    [transfersQuery.data],
  )
  const productionItems = useMemo(
    () => getRecentProductionActivityItems(productionQuery.data?.data ?? []).slice(0, 6),
    [productionQuery.data],
  )
  const shipmentItems = useMemo(
    () => toShipmentTimelineItems(shipmentsQuery.data?.data ?? []),
    [shipmentsQuery.data],
  )
  const returnItems = useMemo(
    () =>
      toReturnActivityItems(
        returnReceiptsQuery.data?.data ?? [],
        returnDispositionsQuery.data?.data ?? [],
      ),
    [returnDispositionsQuery.data, returnReceiptsQuery.data],
  )

  return (
    <div className="space-y-6">
      <PageHeader
        title="Warehouse Activity"
        subtitle="Read-only latest activity for warehouse supervisors across transfers, production, shipments, and returns."
        action={
          <div className="flex gap-2">
            <Link to="/inventory/operations">
              <Button size="sm" variant="secondary">
                Inventory operations
              </Button>
            </Link>
            <Link to="/shipments">
              <Button size="sm" variant="secondary">
                Shipments
              </Button>
            </Link>
          </div>
        }
      />

      <div className="grid gap-4 md:grid-cols-4">
        {[
          { label: 'Transfers', value: transferItems.length },
          { label: 'Production', value: productionItems.length },
          { label: 'Shipments', value: shipmentItems.length },
          { label: 'Returns', value: returnItems.length },
        ].map((item) => (
          <Card key={item.label}>
            <div className="p-4">
              <div className="text-xs uppercase tracking-wide text-slate-500">{item.label}</div>
              <div className="mt-2 text-2xl font-semibold text-slate-900">{item.value}</div>
            </div>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Panel title="Recent transfers" description="Latest posted transfer movements from the ledger.">
          {transfersQuery.isLoading ? (
            <LoadingSpinner label="Loading transfers..." />
          ) : transfersQuery.isError ? (
            <Alert
              variant="error"
              title="Transfers unavailable"
              message={transfersQuery.error?.message ?? 'Failed to load transfer activity.'}
            />
          ) : (
            <OperationTimeline
              items={transferItems}
              emptyTitle="No recent transfers"
              emptyDescription="Post a transfer to see recent warehouse transfer activity."
            />
          )}
        </Panel>

        <Panel title="Recent production activity" description="Latest production and disassembly activity from the movement ledger.">
          {productionQuery.isLoading ? (
            <LoadingSpinner label="Loading production activity..." />
          ) : productionQuery.isError ? (
            <Alert
              variant="error"
              title="Production activity unavailable"
              message={productionQuery.error?.message ?? 'Failed to load recent production activity.'}
            />
          ) : (
            <OperationTimeline
              items={productionItems}
              emptyTitle="No recent production activity"
              emptyDescription="Post production or disassembly activity to populate this panel."
            />
          )}
        </Panel>

        <Panel title="Recent shipments" description="Latest shipment documents and their posting status.">
          {shipmentsQuery.isLoading ? (
            <LoadingSpinner label="Loading shipments..." />
          ) : shipmentsQuery.isError ? (
            <Alert
              variant="error"
              title="Shipments unavailable"
              message={shipmentsQuery.error?.message ?? 'Failed to load recent shipment activity.'}
            />
          ) : (
            <OperationTimeline
              items={shipmentItems}
              emptyTitle="No recent shipments"
              emptyDescription="Create or post a shipment to populate this activity panel."
            />
          )}
        </Panel>

        <Panel title="Recent returns" description="Latest return receipts and disposition records from the existing returns workflow.">
          {returnReceiptsQuery.isLoading || returnDispositionsQuery.isLoading ? (
            <LoadingSpinner label="Loading return activity..." />
          ) : returnReceiptsQuery.isError || returnDispositionsQuery.isError ? (
            <Alert
              variant="error"
              title="Return activity unavailable"
              message={
                returnReceiptsQuery.error?.message ??
                returnDispositionsQuery.error?.message ??
                'Failed to load recent return activity.'
              }
            />
          ) : (
            <OperationTimeline
              items={returnItems}
              emptyTitle="No recent returns"
              emptyDescription="Create a return receipt or disposition to populate this activity panel."
            />
          )}
        </Panel>
      </div>
    </div>
  )
}

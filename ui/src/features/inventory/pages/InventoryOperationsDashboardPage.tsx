import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useLocationsList } from '@features/locations/queries'
import { useInventoryAdjustmentsList } from '@features/adjustments/queries'
import { useMovementsList } from '@features/ledger/queries'
import {
  ActionGuardMessage,
  Alert,
  Button,
  Card,
  LoadingSpinner,
  OperationTimeline,
  PageHeader,
  Panel,
} from '@shared/ui'
import type { Location, Movement } from '@api/types'
import type { OperationTimelineItem } from '@shared/ui'
import { useInventoryCountsList } from '../queries'
import { getRecentProductionActivityItems } from '@features/workOrders/lib/workOrderOperationalHistory'
import { formatStatusLabel } from '@shared/ui'

function buildWarehouseOptions(locations: Location[]) {
  const warehouseRoots = locations.filter((location) => location.type === 'warehouse')
  if (warehouseRoots.length > 0) {
    return warehouseRoots.map((location) => ({
      value: location.id,
      label: `${location.code} — ${location.name}`,
    }))
  }
  const seen = new Set<string>()
  return locations
    .filter((location) => {
      if (!location.warehouseId || seen.has(location.warehouseId)) return false
      seen.add(location.warehouseId)
      return true
    })
    .map((location) => ({
      value: location.warehouseId as string,
      label: location.warehouseId as string,
    }))
}

function toTransferTimelineItems(movements: Movement[]): OperationTimelineItem[] {
  return movements.map((movement) => ({
    id: movement.id,
    kindLabel: 'Transfer',
    title: `Transfer movement ${movement.id.slice(0, 8)}`,
    subtitle: movement.notes ?? 'Direct inventory transfer posted.',
    statusLabel: formatStatusLabel(movement.status),
    occurredAt: movement.occurredAt,
    postedAt: movement.postedAt,
    linkTo: `/movements/${movement.id}`,
    metadata: movement.externalRef ? [movement.externalRef] : undefined,
  }))
}

export default function InventoryOperationsDashboardPage() {
  const locationsQuery = useLocationsList({ active: true, limit: 1000 }, { staleTime: 60_000 })
  const warehouseOptions = useMemo(
    () => buildWarehouseOptions(locationsQuery.data?.data ?? []),
    [locationsQuery.data],
  )
  const defaultWarehouse = warehouseOptions[0] ?? null

  const countsQuery = useInventoryCountsList(
    defaultWarehouse
      ? {
          warehouseId: defaultWarehouse.value,
          limit: 6,
        }
      : undefined,
    { staleTime: 30_000 },
  )
  const adjustmentsQuery = useInventoryAdjustmentsList({ limit: 6, offset: 0 }, { staleTime: 30_000 })
  const transfersQuery = useMovementsList({ movementType: 'transfer', limit: 6 }, { staleTime: 30_000 })
  const productionQuery = useMovementsList({ externalRef: 'work_order_', limit: 12 }, { staleTime: 30_000 })

  const countTimelineItems = useMemo(
    () =>
      (countsQuery.data?.data ?? []).map((count) => ({
        id: count.id,
        kindLabel: 'Count',
        title: `Count ${count.id.slice(0, 8)}`,
        subtitle: `${count.summary.lineCount} lines · ${count.summary.linesWithVariance} variance lines`,
        statusLabel: formatStatusLabel(count.status),
        occurredAt: count.countedAt,
        linkTo: `/inventory-counts/${count.id}`,
        metadata: count.updatedAt ? [`Last updated ${new Date(count.updatedAt).toLocaleString()}`] : undefined,
      })),
    [countsQuery.data],
  )

  const adjustmentTimelineItems = useMemo(
    () =>
      (adjustmentsQuery.data?.data ?? []).map((adjustment) => ({
        id: adjustment.id,
        kindLabel: 'Adjustment',
        title: `Adjustment ${adjustment.id.slice(0, 8)}`,
        subtitle: adjustment.notes ?? 'Inventory correction recorded.',
        statusLabel: formatStatusLabel(adjustment.status),
        occurredAt: adjustment.occurredAt,
        linkTo: `/inventory-adjustments/${adjustment.id}`,
        metadata: adjustment.updatedAt
          ? [`Last updated ${new Date(adjustment.updatedAt).toLocaleString()}`]
          : undefined,
      })),
    [adjustmentsQuery.data],
  )

  const transferTimelineItems = useMemo(
    () => toTransferTimelineItems(transfersQuery.data?.data ?? []),
    [transfersQuery.data],
  )

  const productionTimelineItems = useMemo(
    () => getRecentProductionActivityItems(productionQuery.data?.data ?? []).slice(0, 6),
    [productionQuery.data],
  )

  return (
    <div className="space-y-6">
      <PageHeader
        title="Inventory Operations"
        subtitle="Latest operational activity across counts, adjustments, transfers, and production."
        action={
          <div className="flex gap-2">
            <Link to="/inventory-counts/new">
              <Button size="sm">New count</Button>
            </Link>
            <Link to="/inventory-transfers/new">
              <Button size="sm" variant="secondary">
                New transfer
              </Button>
            </Link>
          </div>
        }
      />

      <div className="grid gap-4 md:grid-cols-4">
        {[
          { label: 'Recent counts', value: countTimelineItems.length },
          { label: 'Recent adjustments', value: adjustmentTimelineItems.length },
          { label: 'Recent transfers', value: transferTimelineItems.length },
          { label: 'Production activity', value: productionTimelineItems.length },
        ].map((card) => (
          <Card key={card.label}>
            <div className="p-4">
              <div className="text-xs uppercase tracking-wide text-slate-500">{card.label}</div>
              <div className="mt-2 text-2xl font-semibold text-slate-900">{card.value}</div>
            </div>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Panel
          title="Recent counts"
          description={
            defaultWarehouse
              ? `Latest count activity for ${defaultWarehouse.label}.`
              : 'Count activity requires at least one warehouse location.'
          }
        >
          {!defaultWarehouse ? (
            <ActionGuardMessage
              title="Count activity unavailable"
              message="No warehouse locations are available yet, so count activity cannot be shown on the operations dashboard."
            />
          ) : countsQuery.isLoading ? (
            <LoadingSpinner label="Loading recent counts..." />
          ) : countsQuery.isError ? (
            <Alert
              variant="error"
              title="Counts unavailable"
              message={countsQuery.error?.message ?? 'Failed to load recent counts.'}
            />
          ) : (
            <OperationTimeline
              items={countTimelineItems}
              emptyTitle="No recent counts"
              emptyDescription="Create a new cycle count to begin tracking warehouse count activity."
            />
          )}
          <div className="mt-4">
            <Link to="/inventory-counts">
              <Button size="sm" variant="secondary">
                View all counts
              </Button>
            </Link>
          </div>
        </Panel>

        <Panel title="Recent adjustments" description="Latest posted and draft adjustment activity.">
          {adjustmentsQuery.isLoading ? (
            <LoadingSpinner label="Loading recent adjustments..." />
          ) : adjustmentsQuery.isError ? (
            <Alert
              variant="error"
              title="Adjustments unavailable"
              message={adjustmentsQuery.error?.message ?? 'Failed to load recent adjustments.'}
            />
          ) : (
            <OperationTimeline
              items={adjustmentTimelineItems}
              emptyTitle="No recent adjustments"
              emptyDescription="Create an inventory adjustment to capture correction activity."
            />
          )}
          <div className="mt-4">
            <Link to="/inventory-adjustments">
              <Button size="sm" variant="secondary">
                View all adjustments
              </Button>
            </Link>
          </div>
        </Panel>

        <Panel title="Recent transfers" description="Latest posted transfer movements from the inventory ledger.">
          {transfersQuery.isLoading ? (
            <LoadingSpinner label="Loading recent transfers..." />
          ) : transfersQuery.isError ? (
            <Alert
              variant="error"
              title="Transfers unavailable"
              message={transfersQuery.error?.message ?? 'Failed to load recent transfer activity.'}
            />
          ) : (
            <OperationTimeline
              items={transferTimelineItems}
              emptyTitle="No recent transfers"
              emptyDescription="Post a direct transfer to see transfer activity here."
            />
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Link to="/inventory-transfers/new">
              <Button size="sm" variant="secondary">
                Create transfer
              </Button>
            </Link>
            <Link to="/movements?movementType=transfer">
              <Button size="sm" variant="secondary">
                View transfer movements
              </Button>
            </Link>
          </div>
        </Panel>

        <Panel title="Recent production activity" description="Latest production and disassembly movements from the ledger.">
          {productionQuery.isLoading ? (
            <LoadingSpinner label="Loading production activity..." />
          ) : productionQuery.isError ? (
            <Alert
              variant="error"
              title="Production activity unavailable"
              message={productionQuery.error?.message ?? 'Failed to load production activity.'}
            />
          ) : (
            <OperationTimeline
              items={productionTimelineItems}
              emptyTitle="No recent production activity"
              emptyDescription="Post work-order activity to populate the latest production timeline."
            />
          )}
          <div className="mt-4">
            <Link to="/work-orders">
              <Button size="sm" variant="secondary">
                View work orders
              </Button>
            </Link>
          </div>
        </Panel>
      </div>
    </div>
  )
}

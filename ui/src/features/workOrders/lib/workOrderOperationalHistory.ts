import type { Movement } from '@api/types'
import type { OperationTimelineItem } from '@shared/ui'
import { formatStatusLabel } from '@shared/ui'

const WORK_ORDER_OPERATION_PREFIXES = [
  'work_order_batch_issue:',
  'work_order_batch_completion:',
  'work_order_disassembly_issue:',
  'work_order_disassembly_completion:',
  'work_order_batch_void_output:',
  'work_order_batch_void_components:',
] as const

function getTimestampValue(movement: Movement) {
  const candidate = movement.occurredAt || movement.postedAt || movement.id
  return candidate
}

function getWorkOrderIdFromMovement(movement: Movement) {
  const ref = movement.externalRef ?? ''
  const parts = ref.split(':')
  const metadataWorkOrderId =
    movement.metadata && typeof movement.metadata.workOrderId === 'string'
      ? movement.metadata.workOrderId
      : null
  return metadataWorkOrderId ?? parts[parts.length - 1] ?? null
}

function getMovementPrefix(movement: Movement) {
  const ref = movement.externalRef ?? ''
  return WORK_ORDER_OPERATION_PREFIXES.find((prefix) => ref.startsWith(prefix)) ?? null
}

function getTimelineDescriptor(movement: Movement) {
  const prefix = getMovementPrefix(movement)
  const ref = movement.externalRef ?? ''
  const parts = ref.split(':')
  const entityId = parts[1] ?? movement.id

  switch (prefix) {
    case 'work_order_batch_issue:':
      return {
        kindLabel: 'Production',
        title: `Component issue ${entityId.slice(0, 8)} posted`,
        subtitle: movement.notes ?? 'Components were issued to production.',
      }
    case 'work_order_batch_completion:':
      return {
        kindLabel: 'Production',
        title: `Production report ${entityId.slice(0, 8)} posted`,
        subtitle: movement.notes ?? 'Finished output was received into inventory.',
      }
    case 'work_order_disassembly_issue:':
      return {
        kindLabel: 'Disassembly',
        title: `Disassembly issue ${entityId.slice(0, 8)} posted`,
        subtitle: movement.notes ?? 'Parent inventory was consumed for disassembly.',
      }
    case 'work_order_disassembly_completion:':
      return {
        kindLabel: 'Disassembly',
        title: `Disassembly output ${entityId.slice(0, 8)} posted`,
        subtitle: movement.notes ?? 'Recovered components were received into inventory.',
      }
    case 'work_order_batch_void_output:':
      return {
        kindLabel: 'Void',
        title: `Production output void ${entityId.slice(0, 8)} posted`,
        subtitle: movement.notes ?? 'Previously reported output was reversed.',
      }
    case 'work_order_batch_void_components:':
      return {
        kindLabel: 'Void',
        title: `Component return ${entityId.slice(0, 8)} posted`,
        subtitle: movement.notes ?? 'Consumed components were returned during void processing.',
      }
    default:
      return null
  }
}

export function isKnownWorkOrderOperationalMovement(movement: Movement) {
  return Boolean(getMovementPrefix(movement))
}

export function isWorkOrderOperationalMovementFor(movement: Movement, workOrderId: string) {
  if (!isKnownWorkOrderOperationalMovement(movement)) return false
  return getWorkOrderIdFromMovement(movement) === workOrderId
}

function toTimelineItem(movement: Movement): OperationTimelineItem | null {
  const descriptor = getTimelineDescriptor(movement)
  if (!descriptor) return null

  return {
    id: movement.id,
    kindLabel: descriptor.kindLabel,
    title: descriptor.title,
    subtitle: descriptor.subtitle,
    statusLabel: formatStatusLabel(movement.status),
    occurredAt: movement.occurredAt,
    postedAt: movement.postedAt,
    linkTo: `/movements/${movement.id}`,
    metadata: movement.externalRef ? [movement.externalRef] : undefined,
  }
}

function sortTimelineItems(items: OperationTimelineItem[]) {
  return [...items].sort((left, right) => {
    const leftTimestamp = left.occurredAt || left.postedAt || null
    const rightTimestamp = right.occurredAt || right.postedAt || null
    const leftMillis = leftTimestamp ? Date.parse(leftTimestamp) : Number.NaN
    const rightMillis = rightTimestamp ? Date.parse(rightTimestamp) : Number.NaN

    if (Number.isFinite(leftMillis) && Number.isFinite(rightMillis) && leftMillis !== rightMillis) {
      return rightMillis - leftMillis
    }
    if (Number.isFinite(leftMillis) && !Number.isFinite(rightMillis)) {
      return -1
    }
    if (!Number.isFinite(leftMillis) && Number.isFinite(rightMillis)) {
      return 1
    }
    return right.id.localeCompare(left.id)
  })
}

export function getWorkOrderOperationalHistoryItems(movements: Movement[], workOrderId: string) {
  return sortTimelineItems(
    movements
      .filter((movement) => isWorkOrderOperationalMovementFor(movement, workOrderId))
      .map((movement) => toTimelineItem(movement))
      .filter((item): item is OperationTimelineItem => Boolean(item)),
  )
}

export function getRecentProductionActivityItems(movements: Movement[]) {
  return sortTimelineItems(
    movements
      .filter(isKnownWorkOrderOperationalMovement)
      .map((movement) => {
        const item = toTimelineItem(movement)
        if (!item) return null
        const workOrderId = getWorkOrderIdFromMovement(movement)
        return {
          ...item,
          linkTo: workOrderId ? `/work-orders/${workOrderId}` : item.linkTo,
          metadata: [
            ...(item.metadata ?? []),
            workOrderId ? `Work order ${workOrderId}` : 'Work order unavailable',
          ],
        }
      })
      .filter((item): item is OperationTimelineItem => Boolean(item)),
  )
}

export function getOperationalHistoryTimestamp(movement: Movement) {
  return getTimestampValue(movement)
}

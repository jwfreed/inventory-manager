import { useMemo } from 'react'
import { useMovement, useMovementLines } from '../queries'
import { formatStatusLabel } from '@shared/ui'

type Params = {
  movementId?: string
}

export const movementDetailSections = [
  { id: 'overview', label: 'Overview' },
  { id: 'lines', label: 'Lines' },
  { id: 'investigation', label: 'Investigation' },
] as const

export function useMovementDetailViewModel({ movementId }: Params) {
  const movementQuery = useMovement(movementId)
  const linesQuery = useMovementLines(movementId)

  const totals = useMemo(() => {
    const map = new Map<string, { itemId: string; uom: string; quantity: number }>()
    for (const line of linesQuery.data ?? []) {
      const key = `${line.itemId}-${line.uom}`
      const current = map.get(key) ?? { itemId: line.itemId, uom: line.uom, quantity: 0 }
      current.quantity += line.quantityDelta || 0
      map.set(key, current)
    }
    return Array.from(map.values()).sort((left, right) => Math.abs(right.quantity) - Math.abs(left.quantity))
  }, [linesQuery.data])

  const sourceLink = useMemo(() => {
    const ref = movementQuery.data?.externalRef
    if (!ref) return null

    const workOrderLink = (label: string) => {
      const parts = ref.split(':')
      const id = parts[1]
      const workOrderId = parts[2]
      return workOrderId
        ? { label: `${label} ${id.slice(0, 8)}…`, to: `/work-orders/${workOrderId}` }
        : null
    }

    if (ref.startsWith('putaway:')) {
      const id = ref.split(':')[1]
      return { label: `Putaway ${id.slice(0, 8)}…`, to: `/receiving?putawayId=${id}` }
    }
    if (ref.startsWith('qc_accept:')) {
      const id = ref.split(':')[1]
      return { label: `QC event ${id.slice(0, 8)}…`, to: `/qc-events/${id}` }
    }
    if (ref.startsWith('inventory_adjustment:')) {
      const id = ref.split(':')[1]
      return { label: `Adjustment ${id.slice(0, 8)}…`, to: `/inventory-adjustments/${id}` }
    }
    if (ref.startsWith('work_order_issue:')) return workOrderLink('Work order issue')
    if (ref.startsWith('work_order_completion:')) return workOrderLink('Work order completion')
    if (ref.startsWith('work_order_batch_issue:')) return workOrderLink('Batch issue')
    if (ref.startsWith('work_order_batch_completion:')) return workOrderLink('Batch completion')
    if (ref.startsWith('work_order_disassembly_issue:') || ref.startsWith('work_order_disassembly_completion:')) {
      const parts = ref.split(':')
      const workOrderId = parts[2] ?? parts[1]
      return workOrderId
        ? { label: `Disassembly WO ${workOrderId.slice(0, 8)}…`, to: `/work-orders/${workOrderId}` }
        : null
    }
    return null
  }, [movementQuery.data?.externalRef])

  const negativeOverride = useMemo(() => {
    const metadata = movementQuery.data?.metadata as
      | {
          negative_override?: boolean
          override_reason?: string
          override_actor_id?: string
          override_reference?: string
        }
      | null
    if (!metadata?.negative_override) return null
    return {
      reason: metadata.override_reason,
      actorId: metadata.override_actor_id,
      reference: metadata.override_reference,
    }
  }, [movementQuery.data?.metadata])

  const anomaly = useMemo(() => {
    if (negativeOverride) {
      return {
        title: 'Movement anomaly detected',
        message: negativeOverride.reason || 'Negative-stock override was used when posting this movement.',
      }
    }
    if (movementQuery.data?.status === 'draft') {
      return {
        title: 'Movement still in draft',
        message: 'Draft movements do not affect stock until they are posted.',
      }
    }
    return null
  }, [movementQuery.data?.status, negativeOverride])

  const contextSections = useMemo(
    () => [
      {
        title: 'Entity identity',
        rows: [
          { label: 'Movement ID', value: movementQuery.data?.id ?? movementId ?? '—' },
          { label: 'Type', value: movementQuery.data?.movementType ?? '—' },
          { label: 'Status', value: movementQuery.data ? formatStatusLabel(movementQuery.data.status) : '—' },
        ],
      },
      {
        title: 'Supporting metadata',
        rows: [
          { label: 'Occurred', value: movementQuery.data?.occurredAt ?? '—' },
          { label: 'Posted', value: movementQuery.data?.postedAt ?? '—' },
          { label: 'External ref', value: movementQuery.data?.externalRef ?? '—' },
          { label: 'Line count', value: String(linesQuery.data?.length ?? 0) },
        ],
      },
    ],
    [linesQuery.data?.length, movementId, movementQuery.data],
  )

  return {
    movementQuery,
    linesQuery,
    totals,
    sourceLink,
    negativeOverride,
    anomaly,
    contextSections,
  }
}

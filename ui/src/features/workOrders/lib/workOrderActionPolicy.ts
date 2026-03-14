import type { WorkOrder } from '@api/types'

type WorkOrderStatus = WorkOrder['status'] | string | undefined | null

export type RecentProductionReportCandidate = {
  workOrderExecutionId: string
  productionReportId: string
  occurredAt?: string | null
  notes?: string | null
  scrapPosted: boolean
}

function normalizeStatus(status: WorkOrderStatus) {
  return String(status ?? '').toLowerCase()
}

export function canQuickMarkReadyWorkOrder(status: WorkOrderStatus) {
  return normalizeStatus(status) === 'draft'
}

export function canMarkReadyWorkOrder(status: WorkOrderStatus) {
  return normalizeStatus(status) === 'draft'
}

export function canCancelWorkOrder(status: WorkOrderStatus) {
  const normalized = normalizeStatus(status)
  return normalized === 'draft' || normalized === 'ready'
}

export function canQuickCancelWorkOrder(status: WorkOrderStatus) {
  return canCancelWorkOrder(status)
}

export function canCloseWorkOrder(status: WorkOrderStatus) {
  return normalizeStatus(status) === 'completed'
}

export function isExecutionLockedWorkOrder(status: WorkOrderStatus) {
  const normalized = normalizeStatus(status)
  return normalized === 'completed' || normalized === 'closed' || normalized === 'canceled'
}

export function getCancelDisabledReason(status: WorkOrderStatus) {
  const normalized = normalizeStatus(status)
  if (normalized === 'in_progress' || normalized === 'partially_completed') {
    return 'Active production cannot be canceled from the UI once execution has started.'
  }
  if (normalized === 'completed') {
    return 'Completed work orders must be closed, not canceled.'
  }
  if (normalized === 'closed') {
    return 'Closed work orders are final and cannot be canceled.'
  }
  if (normalized === 'canceled') {
    return 'This work order is already canceled.'
  }
  return 'This work order cannot be canceled in its current state.'
}

export function getCloseDisabledReason(status: WorkOrderStatus) {
  const normalized = normalizeStatus(status)
  if (normalized === 'draft' || normalized === 'ready') {
    return 'Only completed work orders can be closed.'
  }
  if (normalized === 'in_progress' || normalized === 'partially_completed') {
    return 'Finish production before closing the work order.'
  }
  if (normalized === 'closed') {
    return 'This work order is already closed.'
  }
  if (normalized === 'canceled') {
    return 'Canceled work orders cannot be closed.'
  }
  return 'This work order cannot be closed in its current state.'
}

export function getExecutionLockedReason(status: WorkOrderStatus) {
  const normalized = normalizeStatus(status)
  if (normalized === 'completed') {
    return 'Execution is locked after completion. Review movements or close the work order.'
  }
  if (normalized === 'closed') {
    return 'Execution is locked because this work order is closed.'
  }
  if (normalized === 'canceled') {
    return 'Execution is locked because this work order is canceled.'
  }
  return ''
}

export function canVoidRecentProductionReport(
  status: WorkOrderStatus,
  recentReport?: RecentProductionReportCandidate | null,
) {
  if (!recentReport) return false
  if (recentReport.scrapPosted) return false
  return !isExecutionLockedWorkOrder(status)
}

export function getVoidRecentReportDisabledReason(
  status: WorkOrderStatus,
  recentReport?: RecentProductionReportCandidate | null,
) {
  if (!recentReport) return 'Only the most recent production report from this session can be voided.'
  if (recentReport.scrapPosted) {
    return 'Production reports that also posted scrap cannot be voided from the UI.'
  }
  if (isExecutionLockedWorkOrder(status)) {
    return 'Terminal work orders do not allow voiding production from the UI.'
  }
  return ''
}

export function getWorkOrderActionPolicy(
  workOrder?: Pick<WorkOrder, 'status'> | null,
  recentReport?: RecentProductionReportCandidate | null,
) {
  const status = workOrder?.status
  const canCancel = canCancelWorkOrder(status)
  const canClose = canCloseWorkOrder(status)
  const canMarkReady = canMarkReadyWorkOrder(status)
  const executionLocked = isExecutionLockedWorkOrder(status)

  return {
    canQuickMarkReady: canQuickMarkReadyWorkOrder(status),
    canMarkReady,
    canCancel,
    canQuickCancel: canQuickCancelWorkOrder(status),
    canClose,
    executionLocked,
    cancelDisabledReason: canCancel ? '' : getCancelDisabledReason(status),
    closeDisabledReason: canClose ? '' : getCloseDisabledReason(status),
    executionLockedReason: executionLocked ? getExecutionLockedReason(status) : '',
    canVoidRecentReport: canVoidRecentProductionReport(status, recentReport),
    voidRecentReportDisabledReason: getVoidRecentReportDisabledReason(status, recentReport),
  }
}

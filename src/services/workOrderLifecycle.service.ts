export const WORK_ORDER_STATUSES = [
  'draft',
  'ready',
  'in_progress',
  'partially_completed',
  'completed',
  'closed',
  'canceled'
] as const;

export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];

export function normalizeWorkOrderStatus(status?: string | null): WorkOrderStatus {
  switch ((status ?? '').trim().toLowerCase()) {
    case 'released':
      return 'ready';
    case 'draft':
    case 'ready':
    case 'in_progress':
    case 'partially_completed':
    case 'completed':
    case 'closed':
    case 'canceled':
      return status!.trim().toLowerCase() as WorkOrderStatus;
    default:
      return 'draft';
  }
}

export function isTerminalWorkOrderStatus(status?: string | null) {
  const normalized = normalizeWorkOrderStatus(status);
  return normalized === 'completed' || normalized === 'closed' || normalized === 'canceled';
}

export function isEditableWorkOrderStatus(status?: string | null) {
  const normalized = normalizeWorkOrderStatus(status);
  return normalized === 'draft' || normalized === 'ready';
}

export function nextStatusAfterExecutionStart(status?: string | null): WorkOrderStatus {
  const normalized = normalizeWorkOrderStatus(status);
  if (normalized === 'draft' || normalized === 'ready') {
    return 'in_progress';
  }
  return normalized;
}

export function nextStatusFromProgress(params: {
  currentStatus?: string | null;
  plannedQuantity: number;
  completedQuantity: number;
}) {
  const current = normalizeWorkOrderStatus(params.currentStatus);
  if (params.completedQuantity >= params.plannedQuantity) {
    return 'completed' as const;
  }
  if (params.completedQuantity > 0) {
    return 'partially_completed' as const;
  }
  if (current === 'draft') {
    return 'ready' as const;
  }
  return current;
}

export function assertWorkOrderStatusTransition(currentStatus: string | null | undefined, nextStatus: WorkOrderStatus) {
  const current = normalizeWorkOrderStatus(currentStatus);
  const allowedTransitions: Record<WorkOrderStatus, WorkOrderStatus[]> = {
    draft: ['ready', 'in_progress', 'canceled'],
    ready: ['in_progress', 'canceled'],
    in_progress: ['partially_completed', 'completed', 'canceled'],
    partially_completed: ['in_progress', 'completed', 'canceled'],
    completed: ['closed'],
    closed: [],
    canceled: []
  };
  if (!allowedTransitions[current].includes(nextStatus) && current !== nextStatus) {
    const error = new Error('WO_STATUS_TRANSITION_INVALID') as Error & {
      code?: string;
      details?: Record<string, unknown>;
    };
    error.code = 'WO_STATUS_TRANSITION_INVALID';
    error.details = { currentStatus: current, nextStatus };
    throw error;
  }
}

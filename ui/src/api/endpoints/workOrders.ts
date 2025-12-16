import { apiGet, apiPost } from '../http'
import type {
  WorkOrder,
  WorkOrderListResponse,
  WorkOrderExecutionSummary,
  WorkOrderIssue,
  WorkOrderCompletion,
} from '../types'

export type WorkOrderListParams = {
  status?: string
  plannedFrom?: string
  plannedTo?: string
  limit?: number
  offset?: number
}

export async function listWorkOrders(params: WorkOrderListParams = {}): Promise<WorkOrderListResponse> {
  const response = await apiGet<WorkOrderListResponse>('/work-orders', { params })
  // If backend returns only data array
  if (Array.isArray((response as any).data)) {
    return response
  }
  if (Array.isArray(response as any)) {
    return { data: response as unknown as WorkOrder[] }
  }
  return response
}

export async function getWorkOrder(id: string): Promise<WorkOrder> {
  return apiGet<WorkOrder>(`/work-orders/${id}`)
}

export async function getWorkOrderExecution(id: string): Promise<WorkOrderExecutionSummary> {
  return apiGet<WorkOrderExecutionSummary>(`/work-orders/${id}/execution`)
}

export type WorkOrderCreatePayload = {
  workOrderNumber: string
  bomId: string
  bomVersionId?: string
  outputItemId: string
  outputUom: string
  quantityPlanned: number
  quantityCompleted?: number
  scheduledStartAt?: string
  scheduledDueAt?: string
  notes?: string
}

export async function createWorkOrder(payload: WorkOrderCreatePayload): Promise<WorkOrder> {
  return apiPost<WorkOrder>('/work-orders', payload)
}

export type IssueDraftPayload = {
  occurredAt: string
  notes?: string | null
  lines: {
    lineNumber?: number
    componentItemId: string
    fromLocationId: string
    uom: string
    quantityIssued: number
    notes?: string | null
  }[]
}

export async function createWorkOrderIssue(
  workOrderId: string,
  payload: IssueDraftPayload,
): Promise<WorkOrderIssue> {
  return apiPost<WorkOrderIssue>(`/work-orders/${workOrderId}/issues`, payload)
}

export async function postWorkOrderIssue(
  workOrderId: string,
  issueId: string,
): Promise<WorkOrderIssue> {
  return apiPost<WorkOrderIssue>(`/work-orders/${workOrderId}/issues/${issueId}/post`)
}

export type CompletionDraftPayload = {
  occurredAt: string
  notes?: string | null
  lines: {
    outputItemId: string
    toLocationId: string
    uom: string
    quantityCompleted: number
    notes?: string | null
  }[]
}

export async function createWorkOrderCompletion(
  workOrderId: string,
  payload: CompletionDraftPayload,
): Promise<WorkOrderCompletion> {
  return apiPost<WorkOrderCompletion>(`/work-orders/${workOrderId}/completions`, payload)
}

export async function postWorkOrderCompletion(
  workOrderId: string,
  completionId: string,
): Promise<WorkOrderCompletion> {
  return apiPost<WorkOrderCompletion>(`/work-orders/${workOrderId}/completions/${completionId}/post`)
}

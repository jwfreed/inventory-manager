import { apiGet, apiPatch, apiPost } from '../../../api/http'
import type {
  WorkOrder,
  WorkOrderListResponse,
  WorkOrderExecutionSummary,
  WorkOrderIssue,
  WorkOrderCompletion,
  WorkOrderRequirements,
} from '../../../api/types'

export type WorkOrderListParams = {
  status?: string
  kind?: string
  plannedFrom?: string
  plannedTo?: string
  limit?: number
  offset?: number
}

export async function listWorkOrders(params: WorkOrderListParams = {}): Promise<WorkOrderListResponse> {
  const response = await apiGet<WorkOrderListResponse | WorkOrder[]>('/work-orders', { params })
  if (Array.isArray(response)) {
    return { data: response }
  }
  if (Array.isArray(response.data)) {
    return response
  }
  return { data: [], paging: response.paging }
}

export async function getWorkOrder(id: string): Promise<WorkOrder> {
  return apiGet<WorkOrder>(`/work-orders/${id}`)
}

export async function getWorkOrderExecution(id: string): Promise<WorkOrderExecutionSummary> {
  return apiGet<WorkOrderExecutionSummary>(`/work-orders/${id}/execution`)
}

export async function getWorkOrderRequirements(
  id: string,
  quantity?: number,
  packSize?: number,
): Promise<WorkOrderRequirements> {
  const params: Record<string, number> = {}
  if (quantity) params.quantity = quantity
  if (packSize) params.packSize = packSize
  return apiGet<WorkOrderRequirements>(`/work-orders/${id}/requirements`, { params })
}

export type WorkOrderCreatePayload = {
  kind?: 'production' | 'disassembly'
  bomId?: string
  bomVersionId?: string
  relatedWorkOrderId?: string
  outputItemId: string
  outputUom: string
  quantityPlanned: number
  quantityCompleted?: number
  defaultConsumeLocationId?: string
  defaultProduceLocationId?: string
  scheduledStartAt?: string
  scheduledDueAt?: string
  description?: string
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
    reasonCode?: string | null
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
  payload?: { overrideNegative?: boolean; overrideReason?: string | null },
): Promise<WorkOrderIssue> {
  return apiPost<WorkOrderIssue>(`/work-orders/${workOrderId}/issues/${issueId}/post`, payload)
}

export type CompletionDraftPayload = {
  occurredAt: string
  notes?: string | null
  lines: {
    outputItemId: string
    toLocationId: string
    uom: string
    quantityCompleted: number
    packSize?: number
    reasonCode?: string | null
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

export type WorkOrderDefaultsPayload = {
  defaultConsumeLocationId?: string | null
  defaultProduceLocationId?: string | null
}

export async function updateWorkOrderDefaultsApi(
  workOrderId: string,
  payload: WorkOrderDefaultsPayload,
): Promise<WorkOrder> {
  return apiPatch<WorkOrder>(`/work-orders/${workOrderId}/default-locations`, payload)
}

export async function useActiveBomVersion(workOrderId: string): Promise<WorkOrder> {
  return apiPost<WorkOrder>(`/work-orders/${workOrderId}/use-active-bom`)
}

export async function updateWorkOrderDescription(
  workOrderId: string,
  payload: { description?: string | null },
): Promise<WorkOrder> {
  return apiPatch<WorkOrder>(`/work-orders/${workOrderId}`, payload)
}

export type RecordBatchPayload = {
  occurredAt: string
  notes?: string | null
  overrideNegative?: boolean
  overrideReason?: string | null
  consumeLines: {
    componentItemId: string
    fromLocationId: string
    uom: string
    quantity: number
    reasonCode?: string | null
    notes?: string | null
  }[]
  produceLines: {
    outputItemId: string
    toLocationId: string
    uom: string
    quantity: number
    packSize?: number
    reasonCode?: string | null
    notes?: string | null
  }[]
}

export type RecordBatchResult = {
  workOrderId: string
  issueMovementId: string
  receiveMovementId: string
  quantityCompleted: number
  workOrderStatus: string
}

export async function recordWorkOrderBatch(
  workOrderId: string,
  payload: RecordBatchPayload,
): Promise<RecordBatchResult> {
  return apiPost<RecordBatchResult>(`/work-orders/${workOrderId}/record-batch`, payload)
}

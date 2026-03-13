import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import type {
  ApiError,
  WorkOrder,
  WorkOrderDisassemblyPlan,
  WorkOrderExecutionSummary,
  WorkOrderReadiness,
  WorkOrderRequirements,
} from '../../api/types'
import {
  getWorkOrderDisassemblyPlan,
  getWorkOrder,
  getWorkOrderExecution,
  getWorkOrderReadiness,
  getWorkOrderRequirements,
  listWorkOrders,
  type WorkOrderListParams,
} from './api/workOrders'

export const workOrdersQueryKeys = {
  all: ['work-orders'] as const,
  list: (params: WorkOrderListParams = {}) => [...workOrdersQueryKeys.all, 'list', params] as const,
  detail: (id: string) => [...workOrdersQueryKeys.all, 'detail', id] as const,
  execution: (id: string) => [...workOrdersQueryKeys.all, 'execution', id] as const,
  readiness: (id: string) => [...workOrdersQueryKeys.all, 'readiness', id] as const,
  disassemblyPlan: (id: string, quantity?: number) =>
    [...workOrdersQueryKeys.all, 'disassembly-plan', id, quantity ?? null] as const,
  requirements: (id: string, params?: { quantity?: number; packSize?: number }) =>
    [...workOrdersQueryKeys.all, 'requirements', id, params ?? {}] as const,
}

type WorkOrdersListOptions = Omit<
  UseQueryOptions<Awaited<ReturnType<typeof listWorkOrders>>, ApiError>,
  'queryKey' | 'queryFn'
>

type WorkOrderOptions = Omit<UseQueryOptions<WorkOrder, ApiError>, 'queryKey' | 'queryFn'>

type ExecutionOptions = Omit<
  UseQueryOptions<WorkOrderExecutionSummary, ApiError>,
  'queryKey' | 'queryFn'
>

type RequirementsOptions = Omit<
  UseQueryOptions<WorkOrderRequirements, ApiError>,
  'queryKey' | 'queryFn'
>

type ReadinessOptions = Omit<
  UseQueryOptions<WorkOrderReadiness, ApiError>,
  'queryKey' | 'queryFn'
>

type DisassemblyPlanOptions = Omit<
  UseQueryOptions<WorkOrderDisassemblyPlan, ApiError>,
  'queryKey' | 'queryFn'
>

export function useWorkOrdersList(params: WorkOrderListParams = {}, options: WorkOrdersListOptions = {}) {
  return useQuery({
    queryKey: workOrdersQueryKeys.list(params),
    queryFn: () => listWorkOrders(params),
    retry: 1,
    ...options,
  })
}

export function useWorkOrder(id?: string, options: WorkOrderOptions = {}) {
  return useQuery({
    queryKey: workOrdersQueryKeys.detail(id ?? ''),
    queryFn: () => getWorkOrder(id as string),
    enabled: Boolean(id),
    retry: 1,
    ...options,
  })
}

export function useWorkOrderExecution(id?: string, options: ExecutionOptions = {}) {
  return useQuery({
    queryKey: workOrdersQueryKeys.execution(id ?? ''),
    queryFn: () => getWorkOrderExecution(id as string),
    enabled: Boolean(id),
    retry: 1,
    ...options,
  })
}

export function useWorkOrderReadiness(id?: string, options: ReadinessOptions = {}) {
  return useQuery({
    queryKey: workOrdersQueryKeys.readiness(id ?? ''),
    queryFn: () => getWorkOrderReadiness(id as string),
    enabled: Boolean(id),
    retry: 1,
    ...options,
  })
}

export function useWorkOrderDisassemblyPlan(
  id?: string,
  quantity?: number,
  options: DisassemblyPlanOptions = {},
) {
  return useQuery({
    queryKey: workOrdersQueryKeys.disassemblyPlan(id ?? '', quantity),
    queryFn: () => getWorkOrderDisassemblyPlan(id as string, quantity),
    enabled: Boolean(id),
    retry: 1,
    ...options,
  })
}

export function useWorkOrderRequirements(
  id?: string,
  params?: { quantity?: number; packSize?: number },
  options: RequirementsOptions = {},
) {
  return useQuery({
    queryKey: workOrdersQueryKeys.requirements(id ?? '', params),
    queryFn: () => getWorkOrderRequirements(id as string, params?.quantity, params?.packSize),
    enabled: Boolean(id),
    retry: 1,
    ...options,
  })
}

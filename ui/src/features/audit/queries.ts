import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import type { ApiError, AuditLogEntry } from '../../api/types'
import { listAuditLog, type AuditLogParams } from './api/audit'

export const auditQueryKeys = {
  all: ['audit-log'] as const,
  list: (params: AuditLogParams) => [...auditQueryKeys.all, params] as const,
}

type AuditOptions = Omit<UseQueryOptions<AuditLogEntry[], ApiError>, 'queryKey' | 'queryFn'>

export function useAuditLog(params: AuditLogParams, options: AuditOptions = {}) {
  return useQuery({
    queryKey: auditQueryKeys.list(params),
    queryFn: async () => {
      const response = await listAuditLog(params)
      return response.data ?? []
    },
    retry: 1,
    ...options,
  })
}

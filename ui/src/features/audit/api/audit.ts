import { apiGet } from '../../../api/http'
import type { AuditLogEntry } from '../../../api/types'

export type AuditLogParams = {
  entityType: string
  entityId: string
  limit?: number
  offset?: number
}

export type AuditLogResponse = {
  data: AuditLogEntry[]
  paging?: { limit: number; offset: number }
}

export async function listAuditLog(params: AuditLogParams): Promise<AuditLogResponse> {
  return apiGet<AuditLogResponse>('/audit-log', { params })
}

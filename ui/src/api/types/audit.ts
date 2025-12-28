export type AuditLogEntry = {
  id: string
  occurredAt: string
  actorType: string
  actorId?: string | null
  action: string
  entityType: string
  entityId: string
  requestId?: string | null
  metadata?: Record<string, unknown> | null
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
}

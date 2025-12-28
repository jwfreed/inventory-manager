import { query } from '../db';

export type AuditLogRow = {
  id: string;
  occurred_at: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  request_id: string | null;
  metadata: Record<string, unknown> | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

export async function listAuditLog(
  tenantId: string,
  params: { entityType: string; entityId: string; limit: number; offset: number }
) {
  const { rows } = await query<AuditLogRow>(
    `SELECT id,
            occurred_at,
            actor_type,
            actor_id,
            action,
            entity_type,
            entity_id,
            request_id,
            metadata,
            before,
            after
       FROM audit_log
      WHERE tenant_id = $1
        AND entity_type = $2
        AND entity_id = $3
      ORDER BY occurred_at DESC
      LIMIT $4 OFFSET $5`,
    [tenantId, params.entityType, params.entityId, params.limit, params.offset]
  );

  return rows.map((row) => ({
    id: row.id,
    occurredAt: row.occurred_at,
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    requestId: row.request_id,
    metadata: row.metadata,
    before: row.before,
    after: row.after
  }));
}

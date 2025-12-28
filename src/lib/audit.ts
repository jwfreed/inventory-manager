import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { query } from '../db';

type AuditInput = {
  tenantId: string;
  actorType: 'user' | 'system';
  actorId?: string | null;
  action: 'create' | 'update' | 'delete' | 'post' | 'unpost';
  entityType: string;
  entityId: string;
  occurredAt?: Date;
  requestId?: string | null;
  metadata?: Record<string, unknown> | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
};

export async function recordAuditLog(input: AuditInput, client?: PoolClient) {
  const {
    tenantId,
    actorType,
    actorId,
    action,
    entityType,
    entityId,
    occurredAt,
    requestId,
    metadata,
    before,
    after
  } = input;

  const executor = client ? client.query.bind(client) : query;
  await executor(
    `INSERT INTO audit_log (
        id, tenant_id, actor_type, actor_id, action, entity_type, entity_id, occurred_at, request_id, metadata, before, after
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      uuidv4(),
      tenantId,
      actorType,
      actorId ?? null,
      action,
      entityType,
      entityId,
      occurredAt ?? new Date(),
      requestId ?? null,
      metadata ?? null,
      before ?? null,
      after ?? null
    ]
  );
}

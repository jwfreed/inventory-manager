import type { PoolClient } from 'pg';

type InventoryMutationLockMark = {
  txid: string;
  operation: string | null;
  tenantId: string | null;
  lockKeysCount: number;
};

const inventoryMutationLockMarks = new WeakMap<PoolClient, InventoryMutationLockMark>();

function buildInventoryGuardError(code: string, details?: Record<string, unknown>) {
  const error = new Error(code) as Error & {
    code?: string;
    status?: number;
    details?: Record<string, unknown>;
  };
  error.code = code;
  error.status = 500;
  if (details) {
    error.details = details;
  }
  return error;
}

async function resolveExplicitTransactionId(
  client: PoolClient,
  phase: string
): Promise<string> {
  const initial = await client.query<{ xid: string | null }>(
    `SELECT txid_current_if_assigned()::text AS xid`
  );
  if (initial.rows[0]?.xid) {
    return initial.rows[0].xid;
  }

  await client.query(`SELECT txid_current()::text AS xid`);
  const verified = await client.query<{ xid: string | null }>(
    `SELECT txid_current_if_assigned()::text AS xid`
  );
  const xid = verified.rows[0]?.xid;
  if (!xid) {
    throw buildInventoryGuardError('INVENTORY_MUTATION_REQUIRES_TRANSACTION', { phase });
  }
  return xid;
}

export async function markInventoryMutationLocksHeld(
  client: PoolClient,
  params: {
    operation?: string | null;
    tenantId?: string | null;
    lockKeysCount: number;
  }
): Promise<void> {
  const txid = await resolveExplicitTransactionId(client, 'lock');
  inventoryMutationLockMarks.set(client, {
    txid,
    operation: params.operation ?? null,
    tenantId: params.tenantId ?? null,
    lockKeysCount: params.lockKeysCount
  });
}

export async function assertInventoryMutationBoundary(
  client: PoolClient,
  details?: Record<string, unknown>
): Promise<void> {
  const txid = await resolveExplicitTransactionId(client, 'write');
  const lockMark = inventoryMutationLockMarks.get(client);
  if (!lockMark || lockMark.txid !== txid) {
    throw buildInventoryGuardError('INVENTORY_MUTATION_LOCK_NOT_HELD', {
      ...(details ?? {}),
      heldOperation: lockMark?.operation ?? null,
      heldTenantId: lockMark?.tenantId ?? null,
      heldLockKeysCount: lockMark?.lockKeysCount ?? 0
    });
  }
}

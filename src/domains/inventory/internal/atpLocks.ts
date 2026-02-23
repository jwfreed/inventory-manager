import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

export type AtpLockTarget = {
  tenantId: string;
  warehouseId: string;
  itemId: string;
};

export type AtpLockKey = AtpLockTarget & {
  key1: number;
  key2: number;
};

export type AtpLockContext = {
  operation: string;
  tenantId: string;
  held: boolean;
  lockKeysCount: number;
};

export type AcquireAtpLocksResult = {
  lockKeys: AtpLockKey[];
  lockWaitMs: number;
};

const VALID_HASH_OFFSETS = new Set([0, 4, 8, 12, 16, 20, 24, 28]);
// Guardrail for VALUES parameter fan-out and planner overhead in a single lock query.
export const MAX_ATP_LOCK_TARGETS = 5000;

function nowMonotonicNs(): bigint {
  return process.hrtime.bigint();
}

function normalizeDurationMs(startNs: bigint, endNs: bigint): number {
  const elapsedNs = endNs - startNs;
  return Math.max(0, Number(elapsedNs) / 1_000_000);
}

function normalizeLockTarget(target: AtpLockTarget): AtpLockTarget | null {
  const tenantId = String(target.tenantId ?? '').trim();
  const warehouseId = String(target.warehouseId ?? '').trim();
  const itemId = String(target.itemId ?? '').trim();
  if (!tenantId || !warehouseId || !itemId) return null;
  return { tenantId, warehouseId, itemId };
}

function compareAtpLockTarget(left: AtpLockTarget, right: AtpLockTarget): number {
  const tenant = left.tenantId.localeCompare(right.tenantId);
  if (tenant !== 0) return tenant;
  const warehouse = left.warehouseId.localeCompare(right.warehouseId);
  if (warehouse !== 0) return warehouse;
  return left.itemId.localeCompare(right.itemId);
}

export function stableHashInt32(value: string, offset = 0): number {
  if (!VALID_HASH_OFFSETS.has(offset)) {
    throw Object.assign(new Error('ATP_LOCK_HASH_OFFSET_INVALID'), {
      code: 'ATP_LOCK_HASH_OFFSET_INVALID',
      details: {
        offset,
        validOffsets: Array.from(VALID_HASH_OFFSETS.values()).sort((a, b) => a - b)
      }
    });
  }
  const digest = createHash('sha256').update(value, 'utf8').digest();
  return digest.readInt32BE(offset);
}

function pairKeyForTarget(target: AtpLockTarget): Pick<AtpLockKey, 'key1' | 'key2'> {
  const tupleKey = `atp:v1:tenant:${target.tenantId}:warehouse:${target.warehouseId}:item:${target.itemId}`;
  // Collision model:
  // - key1 + key2 together provide a 64-bit advisory lock identity.
  // - collisions are theoretically possible, but at expected cardinality the probability is extremely low.
  // - correctness impact is extra serialization (contention), not oversell, because collisions only over-lock.
  return {
    key1: stableHashInt32(tupleKey, 0),
    key2: stableHashInt32(tupleKey, 4)
  };
}

export function buildAtpLockKeys(targets: AtpLockTarget[]): AtpLockKey[] {
  const deduped = new Map<string, AtpLockTarget>();
  for (const rawTarget of targets) {
    const target = normalizeLockTarget(rawTarget);
    if (!target) continue;
    const composite = `${target.tenantId}:${target.warehouseId}:${target.itemId}`;
    if (!deduped.has(composite)) {
      deduped.set(composite, target);
    }
  }
  const sortedTargets = Array.from(deduped.values()).sort(compareAtpLockTarget);
  return sortedTargets.map((target) => ({
    ...target,
    ...pairKeyForTarget(target)
  }));
}

export function createAtpLockContext(params: {
  operation: string;
  tenantId: string;
}): AtpLockContext {
  return {
    operation: params.operation,
    tenantId: params.tenantId,
    held: false,
    lockKeysCount: 0
  };
}

export function assertAtpLockHeldOrThrow(
  lockContext: AtpLockContext | undefined | null,
  details?: Record<string, unknown>
): void {
  if (lockContext?.held) return;
  const error = new Error('ATP_LOCK_NOT_HELD') as Error & {
    code?: string;
    status?: number;
    details?: Record<string, unknown>;
  };
  error.code = 'ATP_LOCK_NOT_HELD';
  error.status = 500;
  error.details = {
    ...(lockContext
      ? {
          operation: lockContext.operation,
          tenantId: lockContext.tenantId,
          lockKeysCount: lockContext.lockKeysCount
        }
      : {}),
    ...(details ?? {})
  };
  throw error;
}

export async function acquireAtpLocks(
  client: PoolClient,
  targets: AtpLockTarget[],
  options?: { lockContext?: AtpLockContext | null }
): Promise<AcquireAtpLocksResult> {
  const lockKeys = buildAtpLockKeys(targets);
  if (lockKeys.length === 0) {
    if (options?.lockContext) {
      options.lockContext.held = true;
      options.lockContext.lockKeysCount = 0;
    }
    return { lockKeys, lockWaitMs: 0 };
  }

  if (lockKeys.length > MAX_ATP_LOCK_TARGETS) {
    const error = new Error('ATP_LOCK_TARGETS_TOO_MANY') as Error & {
      code?: string;
      status?: number;
      details?: Record<string, unknown>;
    };
    error.code = 'ATP_LOCK_TARGETS_TOO_MANY';
    error.status = 409;
    error.details = {
      count: lockKeys.length,
      max: MAX_ATP_LOCK_TARGETS,
      operation: options?.lockContext?.operation ?? null,
      tenantId: options?.lockContext?.tenantId ?? null
    };
    throw error;
  }

  const params: number[] = [];
  const valueTuples = lockKeys.map((key, idx) => {
    const p1 = idx * 2 + 1;
    const p2 = p1 + 1;
    params.push(key.key1, key.key2);
    return `($${p1}::integer, $${p2}::integer)`;
  });

  const startNs = nowMonotonicNs();
  await client.query(
    `SELECT pg_advisory_xact_lock(v.key1, v.key2)
       FROM (VALUES ${valueTuples.join(', ')}) AS v(key1, key2)
      ORDER BY v.key1 ASC, v.key2 ASC`,
    params
  );
  const endNs = nowMonotonicNs();

  if (options?.lockContext) {
    options.lockContext.held = true;
    options.lockContext.lockKeysCount = lockKeys.length;
  }

  return {
    lockKeys,
    lockWaitMs: normalizeDurationMs(startNs, endNs)
  };
}

import { query } from '../db';

export type InventoryChangeScope = {
  itemId?: string;
  locationId?: string;
};

export type InventoryChangeEvent = {
  seq: string;
  type: string;
  scope: InventoryChangeScope;
  occurredAt: string;
};

export type InventoryChangesResponse = {
  events: InventoryChangeEvent[];
  nextSeq: string;
  resetRequired?: boolean;
};

type OutboxChangeRow = {
  event_seq: string;
  event_type: string;
  aggregate_id: string;
  payload: Record<string, unknown> | null;
  created_at: string;
};

type MovementScopeRow = {
  movement_id: string;
  item_id: string;
  location_id: string;
};

const INVENTORY_EVENT_TYPES = ['inventory.movement.posted', 'inventory.reservation.changed'] as const;

function buildMovementScopeMap(rows: MovementScopeRow[]) {
  const map = new Map<string, InventoryChangeScope[]>();
  const seen = new Set<string>();

  for (const row of rows) {
    const key = `${row.movement_id}:${row.item_id}:${row.location_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const scopes = map.get(row.movement_id) ?? [];
    scopes.push({ itemId: row.item_id, locationId: row.location_id });
    map.set(row.movement_id, scopes);
  }

  return map;
}

function toString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizePayload(payload: unknown): Record<string, unknown> {
  if (!payload) return {};
  if (typeof payload === 'string') {
    try {
      return JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (typeof payload === 'object') {
    return payload as Record<string, unknown>;
  }
  return {};
}

export async function getInventoryChanges(
  tenantId: string,
  params: { since?: string; limit?: number }
): Promise<InventoryChangesResponse> {
  const since = params.since ?? '0';
  const limit = Math.min(params.limit ?? 200, 500);

  const outboxRes = await query<OutboxChangeRow>(
    `SELECT event_seq, event_type, aggregate_id, payload, created_at
       FROM outbox_events
      WHERE tenant_id = $1
        AND event_seq > $2::bigint
        AND event_type = ANY($3)
      ORDER BY event_seq ASC
      LIMIT $4`,
    [tenantId, since, INVENTORY_EVENT_TYPES, limit]
  );

  const rows = outboxRes.rows;
  const movementIds = Array.from(
    new Set(
      rows
        .filter((row) => row.event_type === 'inventory.movement.posted')
        .map((row) => row.aggregate_id)
    )
  );

  let movementScopes = new Map<string, InventoryChangeScope[]>();
  if (movementIds.length > 0) {
    const movementRes = await query<MovementScopeRow>(
      `SELECT DISTINCT movement_id, item_id, location_id
         FROM inventory_movement_lines
        WHERE tenant_id = $1
          AND movement_id = ANY($2)`,
      [tenantId, movementIds]
    );
    movementScopes = buildMovementScopeMap(movementRes.rows);
  }

  const events: InventoryChangeEvent[] = [];
  for (const row of rows) {
    if (row.event_type === 'inventory.movement.posted') {
      const scopes = movementScopes.get(row.aggregate_id) ?? [];
      for (const scope of scopes) {
        events.push({
          seq: row.event_seq,
          type: row.event_type,
          scope,
          occurredAt: row.created_at
        });
      }
      continue;
    }

    if (row.event_type === 'inventory.reservation.changed') {
      const payload = normalizePayload(row.payload);
      const scope = {
        itemId: toString(payload.itemId),
        locationId: toString(payload.locationId)
      };
      if (scope.itemId || scope.locationId) {
        events.push({
          seq: row.event_seq,
          type: row.event_type,
          scope,
          occurredAt: row.created_at
        });
      }
    }
  }

  let resetRequired = false;
  if (since !== '0' && rows.length > 0) {
    const firstSeq = BigInt(rows[0].event_seq);
    const sinceSeq = BigInt(since);
    if (firstSeq > sinceSeq + 1n) {
      resetRequired = true;
    }
  }

  if (since !== '0' && rows.length === 0) {
    const minRes = await query<{ event_seq: string }>(
      `SELECT event_seq
         FROM outbox_events
        WHERE tenant_id = $1
        ORDER BY event_seq ASC
        LIMIT 1`,
      [tenantId]
    );
    if (minRes.rowCount > 0) {
      const minSeq = BigInt(minRes.rows[0].event_seq);
      const sinceSeq = BigInt(since);
      if (minSeq > sinceSeq) {
        resetRequired = true;
      }
    }
  }

  const nextSeq = rows.length > 0 ? rows[rows.length - 1].event_seq : since;

  return {
    events,
    nextSeq,
    resetRequired: resetRequired || undefined
  };
}

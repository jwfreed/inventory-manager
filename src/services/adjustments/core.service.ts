import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { pool, withTransaction } from '../../db';
import { recordAuditLog } from '../../lib/audit';
import { normalizeAdjustmentLines, mapInventoryAdjustment, mapInventoryAdjustmentSummary } from './mappers';
import type {
  InventoryAdjustmentInput,
  InventoryAdjustmentRow,
  InventoryAdjustmentLineRow,
  InventoryAdjustmentSummaryRow,
  ActorContext
} from './types';

export async function fetchInventoryAdjustmentById(tenantId: string, id: string, client?: PoolClient) {
  const executor = client ?? pool;
  const adjustmentResult = await executor.query<InventoryAdjustmentRow>(
    `SELECT ia.*,
            EXISTS (
              SELECT 1
                FROM inventory_adjustments child
               WHERE child.corrected_from_adjustment_id = ia.id
                 AND child.tenant_id = ia.tenant_id
            ) AS is_corrected
       FROM inventory_adjustments ia
      WHERE ia.id = $1 AND ia.tenant_id = $2`,
    [id, tenantId]
  );
  if (adjustmentResult.rowCount === 0) {
    return null;
  }
  const linesResult = await executor.query<InventoryAdjustmentLineRow>(
    `SELECT ial.*,
            i.sku AS item_sku,
            i.name AS item_name,
            l.code AS location_code,
            l.name AS location_name
       FROM inventory_adjustment_lines ial
       LEFT JOIN items i ON i.id = ial.item_id AND i.tenant_id = ial.tenant_id
       LEFT JOIN locations l ON l.id = ial.location_id AND l.tenant_id = ial.tenant_id
      WHERE ial.inventory_adjustment_id = $1 AND ial.tenant_id = $2
      ORDER BY ial.line_number ASC`,
    [id, tenantId]
  );
  return mapInventoryAdjustment(adjustmentResult.rows[0], linesResult.rows);
}

async function assertCorrectionTarget(
  tenantId: string,
  correctedFromAdjustmentId: string,
  client: PoolClient
) {
  const result = await client.query<{ status: string }>(
    'SELECT status FROM inventory_adjustments WHERE id = $1 AND tenant_id = $2',
    [correctedFromAdjustmentId, tenantId]
  );
  if (result.rowCount === 0) {
    throw new Error('ADJUSTMENT_CORRECTION_NOT_FOUND');
  }
  if (result.rows[0].status !== 'posted') {
    throw new Error('ADJUSTMENT_CORRECTION_NOT_POSTED');
  }
}

export async function createInventoryAdjustment(
  tenantId: string,
  data: InventoryAdjustmentInput,
  actor?: ActorContext,
  options?: { idempotencyKey?: string | null }
) {
  const normalizedLines = normalizeAdjustmentLines(data);
  const now = new Date();
  const adjustmentId = uuidv4();
  const correctedFromAdjustmentId = data.correctedFromAdjustmentId ?? null;
  const idempotencyKey = options?.idempotencyKey ?? null;

  await withTransaction(async (client: PoolClient) => {
    if (idempotencyKey) {
      const existing = await client.query(
        `SELECT id FROM inventory_adjustments WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenantId, idempotencyKey]
      );
      if (existing.rowCount > 0) {
        return;
      }
    }
    if (correctedFromAdjustmentId) {
      await assertCorrectionTarget(tenantId, correctedFromAdjustmentId, client);
    }

    await client.query(
      `INSERT INTO inventory_adjustments (
          id, tenant_id, status, occurred_at, notes, corrected_from_adjustment_id, idempotency_key, created_at, updated_at
       ) VALUES ($1, $2, 'draft', $3, $4, $5, $6, $7, $7)`,
      [
        adjustmentId,
        tenantId,
        new Date(data.occurredAt),
        data.notes ?? null,
        correctedFromAdjustmentId,
        idempotencyKey,
        now
      ]
    );

    for (const line of normalizedLines) {
      await client.query(
        `INSERT INTO inventory_adjustment_lines (
            id, tenant_id, inventory_adjustment_id, line_number, item_id, location_id, uom, quantity_delta, reason_code, notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          uuidv4(),
          tenantId,
          adjustmentId,
          line.lineNumber,
          line.itemId,
          line.locationId,
          line.uom,
          line.quantityDelta,
          line.reasonCode,
          line.notes
        ]
      );
    }

    if (actor) {
      await recordAuditLog(
        {
          tenantId,
          actorType: actor.type,
          actorId: actor.id ?? null,
          action: 'create',
          entityType: 'inventory_adjustment',
          entityId: adjustmentId,
          occurredAt: now,
          metadata: {
            status: 'draft',
            lineCount: normalizedLines.length,
            correctedFromAdjustmentId: correctedFromAdjustmentId ?? null
          }
        },
        client
      );
    }
  });

  const adjustment = idempotencyKey
    ? await fetchInventoryAdjustmentById(
        tenantId,
        (await pool.query<{ id: string }>(
          'SELECT id FROM inventory_adjustments WHERE tenant_id = $1 AND idempotency_key = $2',
          [tenantId, idempotencyKey]
        )).rows[0]?.id ?? adjustmentId
      )
    : await fetchInventoryAdjustmentById(tenantId, adjustmentId);
  if (!adjustment) {
    throw new Error('ADJUSTMENT_NOT_FOUND');
  }
  return adjustment;
}

export async function getInventoryAdjustment(tenantId: string, id: string) {
  return fetchInventoryAdjustmentById(tenantId, id);
}

export async function listInventoryAdjustments(
  tenantId: string,
  filters: {
    status?: string;
    occurredFrom?: string;
    occurredTo?: string;
    itemId?: string;
    locationId?: string;
    limit: number;
    offset: number;
  }
) {
  const conditions: string[] = ['ia.tenant_id = $1'];
  const params: any[] = [tenantId];

  if (filters.status) {
    params.push(filters.status);
    conditions.push(`ia.status = $${params.length}`);
  }
  if (filters.occurredFrom) {
    params.push(filters.occurredFrom);
    conditions.push(`ia.occurred_at >= $${params.length}`);
  }
  if (filters.occurredTo) {
    params.push(filters.occurredTo);
    conditions.push(`ia.occurred_at <= $${params.length}`);
  }
  if (filters.itemId) {
    params.push(filters.itemId);
    conditions.push(
      `EXISTS (
        SELECT 1 FROM inventory_adjustment_lines ial
         WHERE ial.inventory_adjustment_id = ia.id
           AND ial.tenant_id = ia.tenant_id
           AND ial.item_id = $${params.length}
      )`
    );
  }
  if (filters.locationId) {
    params.push(filters.locationId);
    conditions.push(
      `EXISTS (
        SELECT 1 FROM inventory_adjustment_lines ial
         WHERE ial.inventory_adjustment_id = ia.id
           AND ial.tenant_id = ia.tenant_id
           AND ial.location_id = $${params.length}
      )`
    );
  }

  params.push(filters.limit, filters.offset);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await pool.query<InventoryAdjustmentSummaryRow>(
    `SELECT ia.*,
            EXISTS (
              SELECT 1
                FROM inventory_adjustments child
               WHERE child.corrected_from_adjustment_id = ia.id
                 AND child.tenant_id = ia.tenant_id
            ) AS is_corrected,
            line_counts.line_count,
            totals.totals_by_uom
       FROM inventory_adjustments ia
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS line_count
           FROM inventory_adjustment_lines ial
          WHERE ial.inventory_adjustment_id = ia.id
            AND ial.tenant_id = ia.tenant_id
       ) line_counts ON true
       LEFT JOIN LATERAL (
         SELECT COALESCE(
           json_agg(json_build_object('uom', uom, 'quantityDelta', quantity_delta) ORDER BY uom),
           '[]'::json
         ) AS totals_by_uom
           FROM (
             SELECT uom, SUM(quantity_delta) AS quantity_delta
               FROM inventory_adjustment_lines
              WHERE inventory_adjustment_id = ia.id
                AND tenant_id = ia.tenant_id
              GROUP BY uom
           ) uom_totals
       ) totals ON true
      ${where}
      ORDER BY ia.occurred_at DESC, ia.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return rows.map(mapInventoryAdjustmentSummary);
}

export async function updateInventoryAdjustment(
  tenantId: string,
  id: string,
  data: InventoryAdjustmentInput,
  actor?: ActorContext
) {
  const normalizedLines = normalizeAdjustmentLines(data);

  return withTransaction(async (client: PoolClient) => {
    const now = new Date();
    const adjustmentResult = await client.query<InventoryAdjustmentRow>(
      'SELECT * FROM inventory_adjustments WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [id, tenantId]
    );
    if (adjustmentResult.rowCount === 0) {
      throw new Error('ADJUSTMENT_NOT_FOUND');
    }
    const adjustmentRow = adjustmentResult.rows[0];
    if (adjustmentRow.status === 'posted' || adjustmentRow.inventory_movement_id) {
      throw new Error('ADJUSTMENT_IMMUTABLE');
    }
    if (adjustmentRow.status === 'canceled') {
      throw new Error('ADJUSTMENT_CANCELED');
    }

    const correctedFromAdjustmentId =
      data.correctedFromAdjustmentId ?? adjustmentRow.corrected_from_adjustment_id ?? null;
    if (correctedFromAdjustmentId) {
      if (correctedFromAdjustmentId === id) {
        throw new Error('ADJUSTMENT_CORRECTION_SELF');
      }
      await assertCorrectionTarget(tenantId, correctedFromAdjustmentId, client);
    }

    await client.query(
      `UPDATE inventory_adjustments
          SET occurred_at = $1,
              notes = $2,
              corrected_from_adjustment_id = $3,
              updated_at = $4
       WHERE id = $5 AND tenant_id = $6`,
      [
        new Date(data.occurredAt),
        data.notes ?? null,
        correctedFromAdjustmentId,
        now,
        id,
        tenantId
      ]
    );

    await client.query(
      'DELETE FROM inventory_adjustment_lines WHERE inventory_adjustment_id = $1 AND tenant_id = $2',
      [id, tenantId]
    );

    for (const line of normalizedLines) {
      await client.query(
        `INSERT INTO inventory_adjustment_lines (
            id, tenant_id, inventory_adjustment_id, line_number, item_id, location_id, uom, quantity_delta, reason_code, notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          uuidv4(),
          tenantId,
          id,
          line.lineNumber,
          line.itemId,
          line.locationId,
          line.uom,
          line.quantityDelta,
          line.reasonCode,
          line.notes
        ]
      );
    }

    if (actor) {
      await recordAuditLog(
        {
          tenantId,
          actorType: actor.type,
          actorId: actor.id ?? null,
          action: 'update',
          entityType: 'inventory_adjustment',
          entityId: id,
          occurredAt: now,
          metadata: { status: 'draft', lineCount: normalizedLines.length }
        },
        client
      );
    }

    return fetchInventoryAdjustmentById(tenantId, id, client);
  });
}

export async function cancelInventoryAdjustment(
  tenantId: string,
  id: string,
  actor?: ActorContext
) {
  return withTransaction(async (client: PoolClient) => {
    const now = new Date();
    const adjustmentResult = await client.query<InventoryAdjustmentRow>(
      'SELECT * FROM inventory_adjustments WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [id, tenantId]
    );
    if (adjustmentResult.rowCount === 0) {
      throw new Error('ADJUSTMENT_NOT_FOUND');
    }
    const adjustmentRow = adjustmentResult.rows[0];
    if (adjustmentRow.status === 'canceled') {
      throw new Error('ADJUSTMENT_ALREADY_CANCELED');
    }
    if (adjustmentRow.status !== 'draft') {
      throw new Error('ADJUSTMENT_NOT_CANCELLABLE');
    }

    await client.query(
      `UPDATE inventory_adjustments
          SET status = 'canceled',
              updated_at = $1
       WHERE id = $2 AND tenant_id = $3`,
      [now, id, tenantId]
    );

    if (actor) {
      await recordAuditLog(
        {
          tenantId,
          actorType: actor.type,
          actorId: actor.id ?? null,
          action: 'cancel',
          entityType: 'inventory_adjustment',
          entityId: id,
          occurredAt: now,
          metadata: { status: 'canceled' }
        },
        client
      );
    }

    return fetchInventoryAdjustmentById(tenantId, id, client);
  });
}

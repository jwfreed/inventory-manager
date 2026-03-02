import { query, pool } from '../db';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  createWorkCenterSchema,
  updateWorkCenterSchema,
  createRoutingSchema,
  updateRoutingSchema,
  workCenterSchema,
  routingSchema,
  routingStepSchema
} from '../schemas/routings.schema';

type WorkCenter = z.infer<typeof workCenterSchema>;
type Routing = z.infer<typeof routingSchema>;
type RoutingStep = z.infer<typeof routingStepSchema>;

type SqlExecutor = <T>(sql: string, params?: any[]) => Promise<{ rows: T[]; rowCount: number | null }>;

function executorFor(client?: PoolClient): SqlExecutor {
  if (client) {
    return client.query.bind(client) as SqlExecutor;
  }
  return query as SqlExecutor;
}

async function assertLocationBelongsToTenant(
  tenantId: string,
  locationId: string | null | undefined,
  client?: PoolClient
): Promise<void> {
  if (!locationId) return;
  const executor = executorFor(client);
  const res = await executor<{ id: string }>(
    'SELECT id FROM locations WHERE id = $1 AND tenant_id = $2',
    [locationId, tenantId]
  );
  if (!res.rows[0]) {
    throw new Error('WORK_CENTER_LOCATION_NOT_FOUND');
  }
}

async function assertItemBelongsToTenant(
  tenantId: string,
  itemId: string,
  client?: PoolClient
): Promise<void> {
  const executor = executorFor(client);
  const res = await executor<{ id: string }>(
    'SELECT id FROM items WHERE id = $1 AND tenant_id = $2',
    [itemId, tenantId]
  );
  if (!res.rows[0]) {
    throw new Error('ROUTING_ITEM_NOT_FOUND');
  }
}

async function assertWorkCentersBelongToTenant(
  tenantId: string,
  workCenterIds: string[],
  client?: PoolClient
): Promise<void> {
  if (workCenterIds.length === 0) return;
  const executor = executorFor(client);
  const uniqueIds = Array.from(new Set(workCenterIds));
  const res = await executor<{ id: string }>(
    'SELECT id FROM work_centers WHERE tenant_id = $1 AND id = ANY($2::uuid[])',
    [tenantId, uniqueIds]
  );
  const found = new Set(res.rows.map((row) => row.id));
  const missing = uniqueIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new Error('WORK_CENTER_NOT_FOUND');
  }
}

export class RoutingsService {
  async getAllWorkCenters(tenantId: string): Promise<WorkCenter[]> {
    const res = await query<WorkCenter>(
      `SELECT
         id, code, name, description, location_id as "locationId",
         hourly_rate::float as "hourlyRate", capacity, status,
         created_at as "createdAt", updated_at as "updatedAt"
        FROM work_centers
       WHERE tenant_id = $1
       ORDER BY code`,
      [tenantId]
    );
    return res.rows;
  }

  async getWorkCenterById(tenantId: string, id: string): Promise<WorkCenter | null> {
    const res = await query<WorkCenter>(
      `SELECT
         id, code, name, description, location_id as "locationId",
         hourly_rate::float as "hourlyRate", capacity, status,
         created_at as "createdAt", updated_at as "updatedAt"
        FROM work_centers
       WHERE id = $1
         AND tenant_id = $2`,
      [id, tenantId]
    );
    return res.rows[0] || null;
  }

  async createWorkCenter(tenantId: string, data: z.infer<typeof createWorkCenterSchema>): Promise<WorkCenter> {
    await assertLocationBelongsToTenant(tenantId, data.locationId ?? null);
    const res = await query<WorkCenter>(
      `INSERT INTO work_centers (
         tenant_id, code, name, description, location_id, hourly_rate, capacity, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING
         id, code, name, description, location_id as "locationId",
         hourly_rate::float as "hourlyRate", capacity, status,
         created_at as "createdAt", updated_at as "updatedAt"`,
      [
        tenantId,
        data.code,
        data.name,
        data.description,
        data.locationId,
        data.hourlyRate ?? 0,
        data.capacity ?? 1,
        data.status ?? 'active'
      ]
    );
    return res.rows[0];
  }

  async updateWorkCenter(
    tenantId: string,
    id: string,
    data: z.infer<typeof updateWorkCenterSchema>
  ): Promise<WorkCenter | null> {
    const updates: string[] = [];
    const values: any[] = [id, tenantId];
    let paramIndex = 3;

    if (data.code !== undefined) {
      updates.push(`code = $${paramIndex++}`);
      values.push(data.code);
    }
    if (data.name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      values.push(data.name);
    }
    if (data.description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      values.push(data.description);
    }
    if (data.locationId !== undefined) {
      await assertLocationBelongsToTenant(tenantId, data.locationId ?? null);
      updates.push(`location_id = $${paramIndex++}`);
      values.push(data.locationId);
    }
    if (data.hourlyRate !== undefined) {
      updates.push(`hourly_rate = $${paramIndex++}`);
      values.push(data.hourlyRate);
    }
    if (data.capacity !== undefined) {
      updates.push(`capacity = $${paramIndex++}`);
      values.push(data.capacity);
    }
    if (data.status !== undefined) {
      updates.push(`status = $${paramIndex++}`);
      values.push(data.status);
    }

    if (updates.length === 0) return this.getWorkCenterById(tenantId, id);

    const res = await query<WorkCenter>(
      `UPDATE work_centers
          SET ${updates.join(', ')}
        WHERE id = $1
          AND tenant_id = $2
      RETURNING
        id, code, name, description, location_id as "locationId",
        hourly_rate::float as "hourlyRate", capacity, status,
        created_at as "createdAt", updated_at as "updatedAt"`,
      values
    );
    return res.rows[0] || null;
  }

  async getRoutingsByItemId(tenantId: string, itemId: string): Promise<Routing[]> {
    const res = await query<Routing>(
      `SELECT
         id, item_id as "itemId", name, version, is_default as "isDefault",
         status, notes, created_at as "createdAt", updated_at as "updatedAt"
        FROM routings
       WHERE item_id = $1
         AND tenant_id = $2
       ORDER BY version DESC`,
      [itemId, tenantId]
    );

    const routings = res.rows;
    for (const routing of routings) {
      routing.steps = await this.getRoutingSteps(tenantId, routing.id);
    }
    return routings;
  }

  async getRoutingById(tenantId: string, id: string): Promise<Routing | null> {
    const res = await query<Routing>(
      `SELECT
         id, item_id as "itemId", name, version, is_default as "isDefault",
         status, notes, created_at as "createdAt", updated_at as "updatedAt"
        FROM routings
       WHERE id = $1
         AND tenant_id = $2`,
      [id, tenantId]
    );

    if (!res.rows[0]) return null;

    const routing = res.rows[0];
    routing.steps = await this.getRoutingSteps(tenantId, routing.id);
    return routing;
  }

  async getRoutingSteps(tenantId: string, routingId: string): Promise<RoutingStep[]> {
    const res = await query<RoutingStep>(
      `SELECT
         id, sequence_number as "sequenceNumber", work_center_id as "workCenterId",
         description, setup_time_minutes::float as "setupTimeMinutes",
         run_time_minutes::float as "runTimeMinutes",
         machine_time_minutes::float as "machineTimeMinutes"
        FROM routing_steps
       WHERE routing_id = $1
         AND tenant_id = $2
       ORDER BY sequence_number`,
      [routingId, tenantId]
    );
    return res.rows;
  }

  async createRouting(tenantId: string, data: z.infer<typeof createRoutingSchema>): Promise<Routing> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await assertItemBelongsToTenant(tenantId, data.itemId, client);
      await assertWorkCentersBelongToTenant(
        tenantId,
        (data.steps ?? []).map((step) => step.workCenterId),
        client
      );

      if (data.isDefault) {
        await client.query(
          `UPDATE routings
              SET is_default = false
            WHERE tenant_id = $1
              AND item_id = $2`,
          [tenantId, data.itemId]
        );
      }

      const res = await client.query<Routing>(
        `INSERT INTO routings (
           tenant_id, item_id, name, version, is_default, status, notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING
           id, item_id as "itemId", name, version, is_default as "isDefault",
           status, notes, created_at as "createdAt", updated_at as "updatedAt"`,
        [
          tenantId,
          data.itemId,
          data.name,
          data.version,
          data.isDefault ?? false,
          data.status ?? 'draft',
          data.notes
        ]
      );
      const routing = res.rows[0];

      if (data.steps && data.steps.length > 0) {
        for (const step of data.steps) {
          await client.query(
            `INSERT INTO routing_steps (
               tenant_id, routing_id, sequence_number, work_center_id, description,
               setup_time_minutes, run_time_minutes, machine_time_minutes
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              tenantId,
              routing.id,
              step.sequenceNumber,
              step.workCenterId,
              step.description,
              step.setupTimeMinutes,
              step.runTimeMinutes,
              step.machineTimeMinutes
            ]
          );
        }
      }

      await client.query('COMMIT');
      routing.steps = await this.getRoutingSteps(tenantId, routing.id);
      return routing;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async updateRouting(
    tenantId: string,
    id: string,
    data: z.infer<typeof updateRoutingSchema>
  ): Promise<Routing | null> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const currentRes = await client.query<{ item_id: string }>(
        `SELECT item_id
           FROM routings
          WHERE id = $1
            AND tenant_id = $2
          FOR UPDATE`,
        [id, tenantId]
      );
      if (!currentRes.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      const currentItemId = currentRes.rows[0].item_id;

      if (data.steps) {
        await assertWorkCentersBelongToTenant(
          tenantId,
          data.steps.map((step) => step.workCenterId),
          client
        );
      }

      if (data.isDefault) {
        await client.query(
          `UPDATE routings
              SET is_default = false
            WHERE tenant_id = $1
              AND item_id = $2
              AND id != $3`,
          [tenantId, currentItemId, id]
        );
      }

      const updates: string[] = [];
      const values: any[] = [id, tenantId];
      let paramIndex = 3;

      if (data.name !== undefined) {
        updates.push(`name = $${paramIndex++}`);
        values.push(data.name);
      }
      if (data.version !== undefined) {
        updates.push(`version = $${paramIndex++}`);
        values.push(data.version);
      }
      if (data.isDefault !== undefined) {
        updates.push(`is_default = $${paramIndex++}`);
        values.push(data.isDefault);
      }
      if (data.status !== undefined) {
        updates.push(`status = $${paramIndex++}`);
        values.push(data.status);
      }
      if (data.notes !== undefined) {
        updates.push(`notes = $${paramIndex++}`);
        values.push(data.notes);
      }

      if (updates.length > 0) {
        await client.query(
          `UPDATE routings
              SET ${updates.join(', ')}
            WHERE id = $1
              AND tenant_id = $2`,
          values
        );
      }

      if (data.steps) {
        await client.query(
          `DELETE FROM routing_steps
            WHERE routing_id = $1
              AND tenant_id = $2`,
          [id, tenantId]
        );
        for (const step of data.steps) {
          await client.query(
            `INSERT INTO routing_steps (
               tenant_id, routing_id, sequence_number, work_center_id, description,
               setup_time_minutes, run_time_minutes, machine_time_minutes
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              tenantId,
              id,
              step.sequenceNumber,
              step.workCenterId,
              step.description,
              step.setupTimeMinutes,
              step.runTimeMinutes,
              step.machineTimeMinutes
            ]
          );
        }
      }

      await client.query('COMMIT');
      return this.getRoutingById(tenantId, id);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}

export const routingsService = new RoutingsService();

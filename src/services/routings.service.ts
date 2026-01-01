import { query, pool } from '../db';
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

export class RoutingsService {
  // Work Center Methods

  async getAllWorkCenters(): Promise<WorkCenter[]> {
    const res = await query<WorkCenter>(
      `SELECT 
        id, code, name, description, location_id as "locationId", 
        hourly_rate::float as "hourlyRate", capacity, status, 
        created_at as "createdAt", updated_at as "updatedAt"
       FROM work_centers
       ORDER BY code`
    );
    return res.rows;
  }

  async getWorkCenterById(id: string): Promise<WorkCenter | null> {
    const res = await query<WorkCenter>(
      `SELECT 
        id, code, name, description, location_id as "locationId", 
        hourly_rate::float as "hourlyRate", capacity, status, 
        created_at as "createdAt", updated_at as "updatedAt"
       FROM work_centers
       WHERE id = $1`,
      [id]
    );
    return res.rows[0] || null;
  }

  async createWorkCenter(data: z.infer<typeof createWorkCenterSchema>): Promise<WorkCenter> {
    const res = await query<WorkCenter>(
      `INSERT INTO work_centers (
        code, name, description, location_id, hourly_rate, capacity, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING 
        id, code, name, description, location_id as "locationId", 
        hourly_rate::float as "hourlyRate", capacity, status, 
        created_at as "createdAt", updated_at as "updatedAt"`,
      [
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

  async updateWorkCenter(id: string, data: z.infer<typeof updateWorkCenterSchema>): Promise<WorkCenter | null> {
    const updates: string[] = [];
    const values: any[] = [id];
    let paramIndex = 2;

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

    if (updates.length === 0) return this.getWorkCenterById(id);

    const res = await query<WorkCenter>(
      `UPDATE work_centers 
       SET ${updates.join(', ')} 
       WHERE id = $1
       RETURNING 
        id, code, name, description, location_id as "locationId", 
        hourly_rate::float as "hourlyRate", capacity, status, 
        created_at as "createdAt", updated_at as "updatedAt"`,
      values
    );
    return res.rows[0] || null;
  }

  // Routing Methods

  async getRoutingsByItemId(itemId: string): Promise<Routing[]> {
    const res = await query<Routing>(
      `SELECT 
        id, item_id as "itemId", name, version, is_default as "isDefault", 
        status, notes, created_at as "createdAt", updated_at as "updatedAt"
       FROM routings
       WHERE item_id = $1
       ORDER BY version DESC`,
      [itemId]
    );
    
    const routings = res.rows;
    for (const routing of routings) {
      routing.steps = await this.getRoutingSteps(routing.id);
    }
    return routings;
  }

  async getRoutingById(id: string): Promise<Routing | null> {
    const res = await query<Routing>(
      `SELECT 
        id, item_id as "itemId", name, version, is_default as "isDefault", 
        status, notes, created_at as "createdAt", updated_at as "updatedAt"
       FROM routings
       WHERE id = $1`,
      [id]
    );
    
    if (!res.rows[0]) return null;
    
    const routing = res.rows[0];
    routing.steps = await this.getRoutingSteps(routing.id);
    return routing;
  }

  async getRoutingSteps(routingId: string) {
    const res = await query<RoutingStep>(
      `SELECT 
        id, sequence_number as "sequenceNumber", work_center_id as "workCenterId", 
        description, setup_time_minutes::float as "setupTimeMinutes", 
        run_time_minutes::float as "runTimeMinutes", 
        machine_time_minutes::float as "machineTimeMinutes"
       FROM routing_steps
       WHERE routing_id = $1
       ORDER BY sequence_number`,
      [routingId]
    );
    return res.rows;
  }

  async createRouting(data: z.infer<typeof createRoutingSchema>): Promise<Routing> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // If this is set as default, unset other defaults for the item
      if (data.isDefault) {
        await client.query(
          `UPDATE routings SET is_default = false WHERE item_id = $1`,
          [data.itemId]
        );
      }

      const res = await client.query<Routing>(
        `INSERT INTO routings (
          item_id, name, version, is_default, status, notes
         ) VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING 
          id, item_id as "itemId", name, version, is_default as "isDefault", 
          status, notes, created_at as "createdAt", updated_at as "updatedAt"`,
        [
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
              routing_id, sequence_number, work_center_id, description, 
              setup_time_minutes, run_time_minutes, machine_time_minutes
             ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
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
      routing.steps = await this.getRoutingSteps(routing.id); // Re-fetch steps to be sure
      return routing;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async updateRouting(id: string, data: z.infer<typeof updateRoutingSchema>): Promise<Routing | null> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const currentRouting = await this.getRoutingById(id);
      if (!currentRouting) {
        throw new Error('Routing not found');
      }

      // If setting as default, unset others
      if (data.isDefault) {
        await client.query(
          `UPDATE routings SET is_default = false WHERE item_id = $1 AND id != $2`,
          [currentRouting.itemId, id]
        );
      }

      const updates: string[] = [];
      const values: any[] = [id];
      let paramIndex = 2;

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
          `UPDATE routings SET ${updates.join(', ')} WHERE id = $1`,
          values
        );
      }

      if (data.steps) {
        // Replace all steps
        await client.query(`DELETE FROM routing_steps WHERE routing_id = $1`, [id]);
        
        for (const step of data.steps) {
          await client.query(
            `INSERT INTO routing_steps (
              routing_id, sequence_number, work_center_id, description, 
              setup_time_minutes, run_time_minutes, machine_time_minutes
             ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
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
      return this.getRoutingById(id);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}

export const routingsService = new RoutingsService();

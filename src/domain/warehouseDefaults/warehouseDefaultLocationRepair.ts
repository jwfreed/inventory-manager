import type { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../../db';
import type {
  WarehouseDefaultRepairEndPayload,
  WarehouseDefaultRepairStartPayload
} from '../../observability/warehouseDefaults.events';
import {
  type WarehouseDefaultRepairOptions
} from './warehouseDefaultsDetection';
import {
  buildWarehouseDefaultActual,
  buildWarehouseDefaultExpected,
  warehouseDefaultInternalDerivedIdWithoutMappingError,
  warehouseDefaultInvalidError
} from './warehouseDefaultsDiagnostics';
import {
  DEFAULT_ROLES,
  warehouseDefaultsPolicy,
  type LocationRole
} from './warehouseDefaultsPolicy';

export type DefaultLocationRepairCallbacks = {
  onRepairing?: (payload: WarehouseDefaultRepairStartPayload) => void;
  onRepaired?: (payload: WarehouseDefaultRepairEndPayload) => void;
  onAutoCreatedDefaultLocation?: (payload: {
    tenantId: string;
    warehouseId: string;
    role: LocationRole;
    locationId: string;
    localCode: string;
    now: Date;
  }) => Promise<void> | void;
};

export async function ensureDefaultsForWarehouse(
  tenantId: string,
  warehouseId: string,
  repairInvalidDefaults: boolean,
  client?: PoolClient,
  options?: WarehouseDefaultRepairOptions,
  callbacks?: DefaultLocationRepairCallbacks
): Promise<void> {
  const executor = client ? client.query.bind(client) : query;
  const warehouseRes = await executor<{
    role: LocationRole | null;
    is_sellable: boolean;
    parent_location_id: string | null;
  }>(
    `SELECT role, is_sellable, parent_location_id
       FROM locations
      WHERE tenant_id = $1
        AND id = $2
        AND type = 'warehouse'`,
    [tenantId, warehouseId]
  );
  if (warehouseRes.rowCount === 0) {
    throw warehouseDefaultInvalidError({
      tenantId,
      warehouseId,
      role: null,
      defaultLocationId: null,
      mappingId: null,
      reason: 'missing_warehouse',
      expected: {
        role: null,
        warehouse_id: warehouseId,
        parent_location_id: null,
        type: 'warehouse',
        is_sellable: false
      },
      actual: {
        role: null,
        warehouse_id: null,
        parent_location_id: null,
        type: null,
        is_sellable: null
      }
    }, { repairEnabled: repairInvalidDefaults });
  }
  const warehouse = warehouseRes.rows[0];
  if (!warehouseDefaultsPolicy.topology.isWarehouseRootValid(warehouse)) {
    throw new Error(warehouseDefaultsPolicy.topology.formatWarehouseRootInvalidMessage(warehouse));
  }
  const defaultsRes = await executor<{ role: LocationRole; location_id: string; mapping_id: string | null }>(
    `SELECT role,
            location_id,
            to_jsonb(warehouse_default_location)->>'id' AS mapping_id
       FROM warehouse_default_location
      WHERE tenant_id = $1 AND warehouse_id = $2`,
    [tenantId, warehouseId]
  );
  const defaults = new Map<LocationRole, { locationId: string; mappingId: string | null }>();
  for (const row of defaultsRes.rows) {
    defaults.set(row.role, { locationId: row.location_id, mappingId: row.mapping_id });
  }
  const defaultLocationIds = Array.from(defaults.values()).map((row) => row.locationId);
  const defaultLocationById = new Map<
    string,
    {
      id: string;
      tenant_id: string;
      role: LocationRole;
      parent_location_id: string | null;
      warehouse_id: string;
      type: string;
      is_sellable: boolean;
    }
  >();
  if (defaultLocationIds.length > 0) {
    const defaultLocRes = await executor<{
      id: string;
      tenant_id: string;
      role: LocationRole;
      parent_location_id: string | null;
      warehouse_id: string;
      type: string;
      is_sellable: boolean;
    }>(
      `SELECT id, tenant_id, role, parent_location_id, warehouse_id, type, is_sellable
         FROM locations
        WHERE id = ANY($1::uuid[])`,
      [defaultLocationIds]
    );
    for (const row of defaultLocRes.rows) {
      defaultLocationById.set(row.id, row);
    }
  }
  for (const role of DEFAULT_ROLES) {
    const existingDefaultMapping = defaults.get(role) ?? null;
    const derivedDefaultIdWithoutMapping =
      existingDefaultMapping == null
        ? (options?.debugDerivedDefaultByRole?.[role] ?? null)
        : null;
    if (existingDefaultMapping == null && derivedDefaultIdWithoutMapping != null) {
      throw warehouseDefaultInternalDerivedIdWithoutMappingError({
        tenantId,
        warehouseId,
        role,
        derivedId: derivedDefaultIdWithoutMapping
      });
    }
    const existingDefaultId = existingDefaultMapping?.locationId ?? null;
    if (existingDefaultMapping == null && existingDefaultId != null) {
      throw warehouseDefaultInternalDerivedIdWithoutMappingError({
        tenantId,
        warehouseId,
        role,
        derivedId: existingDefaultId
      });
    }
    const existingDefault = existingDefaultId ? defaultLocationById.get(existingDefaultId) : null;
    const invalidReason = warehouseDefaultsPolicy.defaults.detectInvalidReason({
      tenantId,
      warehouseId,
      role,
      existingDefault
    });
    const invalidDetails = invalidReason
      ? {
          tenantId,
          warehouseId,
          role,
          defaultLocationId: existingDefaultId,
          mappingId: existingDefaultMapping?.mappingId ?? null,
          reason: invalidReason,
          expected: buildWarehouseDefaultExpected(role, warehouseId),
          actual: buildWarehouseDefaultActual(role, existingDefault)
        }
      : null;
    const repairDecision = warehouseDefaultsPolicy.repair.getRepairDecision(invalidReason);

    if (defaults.has(role)) {
      if (repairDecision.requiresMappingDeletion) {
        const invalidError = warehouseDefaultInvalidError(invalidDetails!, { repairEnabled: repairInvalidDefaults });
        if (!repairInvalidDefaults) {
          throw invalidError;
        }
        if (invalidDetails) {
          callbacks?.onRepairing?.(invalidDetails);
        }
        await executor(
          `DELETE FROM warehouse_default_location
            WHERE tenant_id = $1
              AND warehouse_id = $2
              AND role = $3`,
          [tenantId, warehouseId, role]
        );
        defaults.delete(role);
      }
      if (!repairDecision.requiresMappingDeletion) continue;
    } else if (repairDecision.shouldRepair) {
      if (!repairInvalidDefaults) {
        throw warehouseDefaultInvalidError(invalidDetails!, { repairEnabled: repairInvalidDefaults });
      }
      if (invalidDetails) {
        callbacks?.onRepairing?.(invalidDetails);
      }
    }

    const expectedType = warehouseDefaultsPolicy.defaults.getExpectedLocationType(role);
    const candidateRes = await executor<{ id: string }>(
      `SELECT id
         FROM locations
        WHERE tenant_id = $1
          AND warehouse_id = $2
          AND parent_location_id = $2
          AND role = $3
          AND type = $4
          ${warehouseDefaultsPolicy.defaults.requiresSellableFlag(role) ? 'AND is_sellable = true' : ''}
        ORDER BY created_at ASC, id ASC
        LIMIT 1`,
      [tenantId, warehouseId, role, expectedType]
    );
    let locationId = candidateRes.rows[0]?.id ?? null;
    if (!locationId) {
      if (!repairInvalidDefaults) {
        if (warehouseDefaultsPolicy.roles.isRequiredRole(role)) {
          throw warehouseDefaultInvalidError(invalidDetails!, { repairEnabled: repairInvalidDefaults });
        }
        continue;
      }
      const id = uuidv4();
      const code = `${role}-${warehouseId}`;
      const name = `${role} Default`;
      const isSellable = warehouseDefaultsPolicy.defaults.requiresSellableFlag(role);
      const now = new Date();
      const localCodeCandidates = [role, `${role}_${warehouseId.slice(0, 8)}`];

      for (const localCode of localCodeCandidates) {
        const insertRes = await executor(
          `INSERT INTO locations (
              id,
              tenant_id,
              code,
              local_code,
              name,
              type,
              role,
              is_sellable,
              active,
              parent_location_id,
           warehouse_id,
           created_at,
            updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, $10, $11, $11)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [id, tenantId, code, localCode, name, expectedType, role, isSellable, warehouseId, warehouseId, now]
        );
        if ((insertRes.rowCount ?? 0) > 0 && insertRes.rows[0]?.id) {
          locationId = insertRes.rows[0].id;
          await callbacks?.onAutoCreatedDefaultLocation?.({
            tenantId,
            warehouseId,
            role,
            locationId,
            localCode,
            now
          });
          break;
        }
        const existingLoc = await executor<{ id: string }>(
          `SELECT id FROM locations WHERE tenant_id = $1 AND code = $2`,
          [tenantId, code]
        );
        if ((existingLoc.rowCount ?? 0) > 0) {
          locationId = existingLoc.rows[0].id;
          break;
        }
      }
    }
    if (!locationId) {
      throw new Error('WAREHOUSE_DEFAULT_LOCATION_REQUIRED');
    }
    await executor(
      `INSERT INTO warehouse_default_location (tenant_id, warehouse_id, role, location_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, warehouse_id, role)
       DO NOTHING`,
      [tenantId, warehouseId, role, locationId]
    );
    if (repairInvalidDefaults && repairDecision.shouldRepair && invalidDetails) {
      const ensuredMappingRes = await executor<{ location_id: string; mapping_id: string | null }>(
        `SELECT location_id,
                to_jsonb(warehouse_default_location)->>'id' AS mapping_id
           FROM warehouse_default_location
          WHERE tenant_id = $1
            AND warehouse_id = $2
            AND role = $3`,
        [tenantId, warehouseId, role]
      );
      callbacks?.onRepaired?.({
        ...invalidDetails,
        repaired: {
          tenantId,
          warehouseId,
          role,
          locationId: ensuredMappingRes.rows[0]?.location_id ?? locationId,
          defaultLocationId: ensuredMappingRes.rows[0]?.location_id ?? locationId,
          mappingId: ensuredMappingRes.rows[0]?.mapping_id ?? null
        }
      });
    }
  }
}

import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import { query, withTransaction } from '../db';
import { getExchangeRate } from './currencies.service';
import type { itemSchema, locationSchema, uomConversionSchema } from '../schemas/masterData.schema';
import { ItemLifecycleStatus } from '../types/item';
import { ensureWarehouseDefaultsForWarehouse } from './warehouseDefaults.service';
import {
  assertCanonicalFieldsPresent,
  getItemUomConfigIfPresent,
  validateConversionAgainstItemDimension
} from './uomCanonical.service';

export type ItemInput = z.infer<typeof itemSchema>;
export type LocationInput = z.infer<typeof locationSchema>;
export type UomConversionInput = z.infer<typeof uomConversionSchema>;

const itemSelectColumns = `
  i.id,
  i.sku,
  i.name,
  i.description,
  i.type,
  i.is_phantom,
  i.default_uom,
  i.uom_dimension,
  i.canonical_uom,
  i.stocking_uom,
  i.default_location_id,
  i.requires_lot,
  i.requires_serial,
  i.requires_qc,
  i.lifecycle_status,
  i.abc_class,
  i.weight,
  i.weight_uom,
  i.volume,
  i.volume_uom,
  i.standard_cost,
  i.standard_cost_currency,
  i.standard_cost_exchange_rate_to_base,
  i.standard_cost_base,
  i.average_cost,
  i.rolled_cost,
  i.rolled_cost_at,
  i.cost_method,
  i.selling_price,
  i.list_price,
  i.price_currency,
  i.created_at,
  i.updated_at,
  l.code AS default_location_code,
  l.name AS default_location_name
`;

const DEFAULT_BASE_CURRENCY = process.env.BASE_CURRENCY || 'THB';

async function resolveStandardCostFields(data: ItemInput, baseCurrency: string = DEFAULT_BASE_CURRENCY) {
  if (data.standardCost == null) {
    return {
      standardCostCurrency: null,
      standardCostExchangeRateToBase: null,
      standardCostBase: null
    };
  }

  const standardCostCurrency = data.standardCostCurrency ?? baseCurrency;
  let standardCostExchangeRateToBase = 1;

  if (standardCostCurrency !== baseCurrency) {
    const rate = await getExchangeRate(standardCostCurrency, baseCurrency);
    if (rate === null) {
      throw new Error(`Missing exchange rate for ${standardCostCurrency} to ${baseCurrency}`);
    }
    standardCostExchangeRateToBase = rate;
  }

  return {
    standardCostCurrency,
    standardCostExchangeRateToBase,
    standardCostBase: Number(data.standardCost) * standardCostExchangeRateToBase
  };
}

export function mapItem(row: any) {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    description: row.description,
    isPhantom: !!row.is_phantom,
    type: row.type ?? 'raw',
    defaultUom: row.defaultUom ?? row.default_uom ?? row.stocking_uom ?? null,
    uomDimension: row.uomDimension ?? row.uom_dimension ?? null,
    canonicalUom: row.canonicalUom ?? row.canonical_uom ?? null,
    stockingUom: row.stockingUom ?? row.stocking_uom ?? null,
    defaultLocationId: row.defaultLocationId ?? row.default_location_id ?? null,
    defaultLocationCode: row.defaultLocationCode ?? row.default_location_code ?? null,
    defaultLocationName: row.defaultLocationName ?? row.default_location_name ?? null,
    requiresLot: row.requires_lot ?? false,
    requiresSerial: row.requires_serial ?? false,
    requiresQc: row.requires_qc ?? false,
    lifecycleStatus: row.lifecycle_status,
    abcClass: row.abc_class ?? row.abcClass ?? null,
    weight: row.weight ? Number(row.weight) : null,
    weightUom: row.weight_uom ?? null,
    volume: row.volume ? Number(row.volume) : null,
    volumeUom: row.volume_uom ?? null,
    standardCost: row.standard_cost ? Number(row.standard_cost) : null,
    standardCostCurrency: row.standard_cost_currency ?? null,
    standardCostExchangeRateToBase: row.standard_cost_exchange_rate_to_base
      ? Number(row.standard_cost_exchange_rate_to_base)
      : null,
    standardCostBase: row.standard_cost_base ? Number(row.standard_cost_base) : null,
    averageCost: row.average_cost ? Number(row.average_cost) : null,
    rolledCost: row.rolled_cost ? Number(row.rolled_cost) : null,
    rolledCostAt: row.rolled_cost_at ?? null,
    costMethod: row.cost_method ?? null,
    sellingPrice: row.selling_price ? Number(row.selling_price) : null,
    listPrice: row.list_price ? Number(row.list_price) : null,
    priceCurrency: row.price_currency ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function createItem(tenantId: string, data: ItemInput, baseCurrency: string = DEFAULT_BASE_CURRENCY) {
  const now = new Date();
  const id = uuidv4();
  const lifecycleStatus = data.lifecycleStatus ?? ItemLifecycleStatus.ACTIVE;
  const isPhantom = data.isPhantom ?? false;
  const defaultUom = data.defaultUom ?? data.stockingUom ?? null;
  const uomDimension = data.uomDimension ?? null;
  const canonicalUom = data.canonicalUom ?? null;
  const stockingUom = data.stockingUom ?? null;
  assertCanonicalFieldsPresent({ uomDimension, canonicalUom, stockingUom });
  const defaultLocationId = data.defaultLocationId ?? null;
  const {
    standardCostCurrency,
    standardCostExchangeRateToBase,
    standardCostBase
  } = await resolveStandardCostFields(data, baseCurrency);
  await query(
    `INSERT INTO items (
        id, tenant_id, sku, name, description, type, is_phantom, default_uom, uom_dimension, canonical_uom, stocking_uom, default_location_id, requires_lot, requires_serial, requires_qc, lifecycle_status, weight, weight_uom, volume, volume_uom,
        standard_cost, standard_cost_currency, standard_cost_exchange_rate_to_base, standard_cost_base,
        rolled_cost, cost_method, selling_price, list_price, price_currency, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $30)`,
    [
      id,
      tenantId,
      data.sku,
      data.name,
      data.description ?? null,
      data.type,
      isPhantom,
      defaultUom,
      uomDimension,
      canonicalUom,
      stockingUom,
      defaultLocationId,
      data.requiresLot ?? false,
      data.requiresSerial ?? false,
      data.requiresQc ?? false,
      lifecycleStatus,
      data.weight ?? null,
      data.weightUom ?? null,
      data.volume ?? null,
      data.volumeUom ?? null,
      data.standardCost ?? null,
      standardCostCurrency,
      standardCostExchangeRateToBase,
      standardCostBase,
      data.rolledCost ?? null,
      data.costMethod ?? null,
      data.sellingPrice ?? null,
      data.listPrice ?? null,
      data.priceCurrency ?? null,
      now
    ]
  );
  const created = await getItem(tenantId, id);
  if (!created) throw new Error('Failed to create item.');
  return created;
}

export async function getItem(tenantId: string, id: string) {
  const res = await query(
    `
    SELECT ${itemSelectColumns}
    FROM items i
    LEFT JOIN locations l ON l.id = i.default_location_id AND l.tenant_id = i.tenant_id
    WHERE i.id = $1 AND i.tenant_id = $2
  `,
    [id, tenantId]
  );
  if (res.rowCount === 0) return null;
  return mapItem(res.rows[0]);
}

export async function updateItem(
  tenantId: string,
  id: string,
  data: ItemInput,
  baseCurrency: string = DEFAULT_BASE_CURRENCY
) {
  const now = new Date();
  const type = data.type ?? 'raw';
  const isPhantom = data.isPhantom ?? false;
  const defaultUom = data.defaultUom ?? data.stockingUom ?? null;
  const uomDimension = data.uomDimension ?? null;
  const canonicalUom = data.canonicalUom ?? null;
  const stockingUom = data.stockingUom ?? null;
  if (uomDimension || canonicalUom || stockingUom) {
    assertCanonicalFieldsPresent({ uomDimension, canonicalUom, stockingUom });
  }
  const defaultLocationId = data.defaultLocationId ?? null;
  const lifecycleStatus = data.lifecycleStatus ?? ItemLifecycleStatus.ACTIVE;
  const {
    standardCostCurrency,
    standardCostExchangeRateToBase,
    standardCostBase
  } = await resolveStandardCostFields(data, baseCurrency);
  const res = await query(
    `UPDATE items
       SET sku = $1,
           name = $2,
           description = $3,
           type = $4,
           is_phantom = $5,
           default_uom = $6,
           uom_dimension = $7,
           canonical_uom = $8,
           stocking_uom = $9,
           default_location_id = $10,
           requires_lot = $11,
           requires_serial = $12,
           requires_qc = $13,
           lifecycle_status = $14,
           weight = $15,
           weight_uom = $16,
           volume = $17,
           volume_uom = $18,
           standard_cost = $19,
           standard_cost_currency = $20,
           standard_cost_exchange_rate_to_base = $21,
           standard_cost_base = $22,
           rolled_cost = $23,
           cost_method = $24,
           selling_price = $25,
           list_price = $26,
           price_currency = $27,
           updated_at = $28
     WHERE id = $29 AND tenant_id = $30
     RETURNING id`,
    [
      data.sku,
      data.name,
      data.description ?? null,
      type,
      isPhantom,
      defaultUom,
      uomDimension,
      canonicalUom,
      stockingUom,
      defaultLocationId,
      data.requiresLot ?? false,
      data.requiresSerial ?? false,
      data.requiresQc ?? false,
      lifecycleStatus,
      data.weight ?? null,
      data.weightUom ?? null,
      data.volume ?? null,
      data.volumeUom ?? null,
      data.standardCost ?? null,
      standardCostCurrency,
      standardCostExchangeRateToBase,
      standardCostBase,
      data.rolledCost ?? null,
      data.costMethod ?? null,
      data.sellingPrice ?? null,
      data.listPrice ?? null,
      data.priceCurrency ?? null,
      now,
      id,
      tenantId
    ]
  );
  const updated = await getItem(tenantId, id);
  if (!updated) throw new Error('Failed to update item.');
  return updated;
}

export async function listItems(
  tenantId: string,
  filters: { lifecycleStatus?: ItemLifecycleStatus[]; search?: string; limit: number; offset: number }
) {
  const conditions: string[] = ['i.tenant_id = $1'];
  const params: any[] = [tenantId];
  if (filters.lifecycleStatus && filters.lifecycleStatus.length > 0) {
    params.push(filters.lifecycleStatus);
    conditions.push(`i.lifecycle_status = ANY($${params.length}::text[])`);
  }
  if (filters.search) {
    params.push(`%${filters.search}%`);
    const idx = params.length;
    conditions.push(`(i.sku ILIKE $${idx} OR i.name ILIKE $${idx})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const countRes = await query(
    `SELECT COUNT(*)::int AS total
       FROM items i
       ${where}`,
    params
  );
  params.push(filters.limit, filters.offset);
  const { rows } = await query(
    `SELECT ${itemSelectColumns}
     FROM items i
     LEFT JOIN locations l ON l.id = i.default_location_id AND l.tenant_id = i.tenant_id
     ${where}
     ORDER BY i.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { items: rows.map(mapItem), total: countRes.rows[0]?.total ?? 0 };
}

export function mapLocation(row: any) {
  const resolvedRole = row.role ?? (row.is_sellable ? 'SELLABLE' : null);
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    role: resolvedRole,
    isSellable: row.is_sellable,
    active: row.active,
    parentLocationId: row.parent_location_id,
    path: row.path,
    depth: row.depth,
    maxWeight: row.max_weight,
    maxVolume: row.max_volume,
    zone: row.zone,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createLocation(tenantId: string, data: LocationInput) {
  const now = new Date();
  const id = uuidv4();
  const active = data.active ?? true;
  const role = data.type === 'warehouse' ? null : (data.role ?? 'SELLABLE');
  const isSellable = data.type === 'warehouse' ? false : (data.isSellable ?? role === 'SELLABLE');

  return withTransaction(async (client) => {
    if (role === 'SELLABLE' && !isSellable) {
      throw new Error('LOCATION_ROLE_SELLABLE_MISMATCH');
    }
    if (role !== 'SELLABLE' && isSellable) {
      throw new Error('LOCATION_ROLE_SELLABLE_MISMATCH');
    }
    const res = await client.query(
      `INSERT INTO locations (
          id, tenant_id, code, name, type, role, is_sellable, active, parent_location_id,
          max_weight, max_volume, zone, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
       RETURNING *`,
      [
        id,
        tenantId,
        data.code,
        data.name,
        data.type,
        role,
        isSellable,
        active,
        data.type === 'warehouse' ? null : (data.parentLocationId ?? null),
        data.maxWeight ?? null,
        data.maxVolume ?? null,
        data.zone ?? null,
        now,
      ]
    );
    const created = mapLocation(res.rows[0]);
    if (data.type === 'warehouse') {
      await ensureWarehouseDefaultsForWarehouse(tenantId, created.id, client);
    }
    return created;
  });
}

export async function getLocation(tenantId: string, id: string) {
  const res = await query('SELECT * FROM locations WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
  if (res.rowCount === 0) return null;
  return mapLocation(res.rows[0]);
}

export async function updateLocation(tenantId: string, id: string, data: LocationInput) {
  const now = new Date();
  const active = data.active ?? true;
  return withTransaction(async (client) => {
    const existingRes = await client.query<{
      role: string | null;
      is_sellable: boolean;
      type: string;
      parent_location_id: string | null;
    }>(
      `SELECT role, is_sellable, type, parent_location_id
         FROM locations
        WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    if (existingRes.rowCount === 0) return null;
    const existing = existingRes.rows[0];
    let role: string | null;
    let isSellable: boolean;
    let parentLocationId: string | null;
    const targetType = data.type ?? existing.type;
    if (targetType === 'warehouse') {
      if (existing.type === 'warehouse' &&
          (existing.role !== null || existing.is_sellable || existing.parent_location_id !== null)) {
        throw new Error('WAREHOUSE_ROOT_INVALID');
      }
      if (data.role != null || data.isSellable === true || data.parentLocationId != null) {
        throw new Error('WAREHOUSE_ROOT_INVALID');
      }
      role = null;
      isSellable = false;
      parentLocationId = null;
    } else {
      role = data.role ?? existing.role ?? 'SELLABLE';
      isSellable = data.isSellable ?? existing.is_sellable ?? role === 'SELLABLE';
      parentLocationId = data.parentLocationId ?? null;
    }
    if (role === 'SELLABLE' && !isSellable) {
      throw new Error('LOCATION_ROLE_SELLABLE_MISMATCH');
    }
    if (role !== 'SELLABLE' && isSellable) {
      throw new Error('LOCATION_ROLE_SELLABLE_MISMATCH');
    }
    const res = await client.query(
      `UPDATE locations
         SET code = $1,
             name = $2,
             type = $3,
             role = $4,
             is_sellable = $5,
             active = $6,
             parent_location_id = $7,
             max_weight = $8,
             max_volume = $9,
             zone = $10,
             updated_at = $11
       WHERE id = $12 AND tenant_id = $13
       RETURNING *`,
      [
        data.code,
        data.name,
        data.type,
        role,
        isSellable,
        active,
        parentLocationId,
        data.maxWeight ?? null,
        data.maxVolume ?? null,
        data.zone ?? null,
        now,
        id,
        tenantId,
      ]
    );
    if (res.rowCount === 0) return null;
    return mapLocation(res.rows[0]);
  });
}

export async function listLocations(filters: {
  tenantId: string;
  active?: boolean;
  type?: string;
  search?: string;
  includeWarehouseZones?: boolean;
  limit: number;
  offset: number;
}) {
  const conditions: string[] = ['tenant_id = $1'];
  const params: any[] = [filters.tenantId];
  if (filters.active !== undefined) {
    params.push(filters.active);
    conditions.push(`active = $${params.length}`);
  }
  const includeWarehouseZones = Boolean(filters.includeWarehouseZones && filters.type === 'warehouse');
  if (includeWarehouseZones) {
    conditions.push(
      `(type = 'warehouse' OR (parent_location_id IN (SELECT id FROM locations WHERE tenant_id = $1 AND type = 'warehouse') AND is_sellable = true))`
    );
  } else if (filters.type) {
    params.push(filters.type);
    conditions.push(`type = $${params.length}`);
  }
  if (filters.search) {
    params.push(`%${filters.search}%`);
    const idx = params.length;
    conditions.push(`(code ILIKE $${idx} OR name ILIKE $${idx})`);
  }
  params.push(filters.limit, filters.offset);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT * FROM locations
     ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows.map(mapLocation);
}

export async function createStandardWarehouseTemplate(
  tenantId: string,
  includeReceivingQc: boolean = true
) {
  const now = new Date();
  async function resolveUniqueLocationCode(
    client: any,
    scopedTenantId: string,
    desiredCode: string,
    suffixSeed: string
  ): Promise<string> {
    const exists = await client.query(
      'SELECT 1 FROM locations WHERE tenant_id = $1 AND code = $2 LIMIT 1',
      [scopedTenantId, desiredCode]
    );
    if ((exists.rowCount ?? 0) === 0) return desiredCode;
    const suffixBase = suffixSeed.slice(0, 8);
    let candidate = `${desiredCode}-${suffixBase}`;
    let counter = 1;
    while (true) {
      const res = await client.query(
        'SELECT 1 FROM locations WHERE tenant_id = $1 AND code = $2 LIMIT 1',
        [scopedTenantId, candidate]
      );
      if ((res.rowCount ?? 0) === 0) return candidate;
      candidate = `${desiredCode}-${suffixBase}-${counter}`;
      counter += 1;
    }
  }
  return withTransaction(async (client) => {
    const created: any[] = [];
    let warehouseId: string;
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('warehouse_template:' || $1::text))`,
      [tenantId]
    );

    const existingWarehouseRes = await client.query<{
      id: string;
      role: string | null;
      is_sellable: boolean;
      parent_location_id: string | null;
    }>(
      `SELECT id, role, is_sellable, parent_location_id
         FROM locations
        WHERE tenant_id = $1 AND type = 'warehouse'
        ORDER BY created_at ASC
        LIMIT 1`,
      [tenantId]
    );
    if (existingWarehouseRes.rowCount > 0) {
      const existingWarehouse = existingWarehouseRes.rows[0];
      if (
        existingWarehouse.role !== null ||
        existingWarehouse.is_sellable ||
        existingWarehouse.parent_location_id !== null
      ) {
        throw new Error(
          `WAREHOUSE_ROOT_INVALID role=${existingWarehouse.role ?? 'null'} is_sellable=${existingWarehouse.is_sellable} parent_location_id=${existingWarehouse.parent_location_id ?? 'null'}`
        );
      }
      warehouseId = existingWarehouse.id;
    } else {
      const warehouseIdNew = uuidv4();
      const warehouseCode = await resolveUniqueLocationCode(client, tenantId, 'MAIN', tenantId);
      const warehouseRes = await client.query(
        `INSERT INTO locations (
            id, tenant_id, code, name, type, role, is_sellable, active, parent_location_id, warehouse_id, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, NULL, false, true, NULL, $6, $7, $7)
         RETURNING *`,
        [warehouseIdNew, tenantId, warehouseCode, 'Main Warehouse', 'warehouse', warehouseIdNew, now]
      );
      if (warehouseRes.rowCount > 0) {
        created.push(mapLocation(warehouseRes.rows[0]));
      }
      warehouseId = warehouseIdNew;
    }

    const baseLocations = [
      { code: 'SELLABLE', name: 'Sellable', type: 'bin', role: 'SELLABLE', parentLocationId: warehouseId },
      { code: 'QA', name: 'Quality Inspection', type: 'bin', role: 'QA', parentLocationId: warehouseId },
      { code: 'HOLD', name: 'QC Hold', type: 'bin', role: 'HOLD', parentLocationId: warehouseId },
      { code: 'REJECT', name: 'QC Reject', type: 'bin', role: 'REJECT', parentLocationId: warehouseId },
      { code: 'SCRAP', name: 'Scrap', type: 'scrap', role: 'SCRAP', parentLocationId: warehouseId }
    ];
    if (includeReceivingQc) {
      baseLocations.push({
        code: 'RECV',
        name: 'Receiving',
        type: 'bin',
        role: null,
        parentLocationId: warehouseId
      });
    }

    const existingRoleRes = await client.query<{ role: string }>(
      `SELECT role
         FROM locations
        WHERE tenant_id = $1
          AND parent_location_id = $2
          AND role = ANY($3::text[])
          AND warehouse_id = $2`,
      [tenantId, warehouseId, ['SELLABLE', 'QA', 'HOLD', 'REJECT', 'SCRAP']]
    );
    const existingRoles = new Set(existingRoleRes.rows.map((r) => r.role));
    const skippedRoles: string[] = [];
    const recvRes = await client.query<{ id: string }>(
      `SELECT id
         FROM locations
        WHERE tenant_id = $1
          AND parent_location_id = $2
          AND warehouse_id = $2
          AND code = $3
        LIMIT 1`,
      [tenantId, warehouseId, 'RECV']
    );
    const hasRecv = (recvRes.rowCount ?? 0) > 0;

    for (const loc of baseLocations) {
      if (loc.role && existingRoles.has(loc.role)) {
        skippedRoles.push(loc.role);
        continue;
      }
      if (!loc.role && loc.code === 'RECV' && hasRecv) {
        continue;
      }
      const code = await resolveUniqueLocationCode(client, tenantId, loc.code, warehouseId);
      const id = uuidv4();
      const res = await client.query(
        `INSERT INTO locations (
            id, tenant_id, code, name, type, role, is_sellable, active, parent_location_id, warehouse_id, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9, $10, $10)
         RETURNING *`,
        [
          id,
          tenantId,
          code,
          loc.name,
          loc.type,
          loc.role,
          loc.role === 'SELLABLE',
          loc.parentLocationId ?? null,
          warehouseId,
          now
        ]
      );
      if (res && (res.rowCount ?? 0) > 0) {
        created.push(mapLocation(res.rows[0]));
      }
    }

    await ensureWarehouseDefaultsForWarehouse(tenantId, warehouseId, client);

    return {
      created,
      skipped: skippedRoles
    };
  });
}

export async function createUomConversion(tenantId: string, data: UomConversionInput) {
  const now = new Date();
  const id = uuidv4();
  const itemConfig = await getItemUomConfigIfPresent(tenantId, data.itemId);
  if (itemConfig) {
    validateConversionAgainstItemDimension(itemConfig, data.fromUom, data.toUom);
    if (itemConfig.uomDimension === 'count' && !Number.isInteger(data.factor)) {
      const err = new Error('COUNT_CONVERSION_FACTOR_MUST_BE_INTEGER') as Error & { code?: string; status?: number };
      err.code = 'COUNT_CONVERSION_FACTOR_MUST_BE_INTEGER';
      err.status = 400;
      throw err;
    }
    const fromKey = data.fromUom.trim().toLowerCase();
    const toKey = data.toUom.trim().toLowerCase();
    const canonicalKey = itemConfig.canonicalUom.toLowerCase();
    if (fromKey !== canonicalKey && toKey !== canonicalKey) {
      throw new Error('UOM_CONVERSION_CANONICAL_REQUIRED');
    }
  }
  await query(
    `INSERT INTO uom_conversions (
        id, tenant_id, item_id, from_uom, to_uom, factor, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
    [
      id,
      tenantId,
      data.itemId,
      data.fromUom,
      data.toUom,
      data.factor,
      now
    ]
  );
  const created = await getUomConversion(tenantId, id);
  if (!created) throw new Error('Failed to create UoM conversion.');
  return created;
}

export async function getUomConversion(tenantId: string, id: string) {
  const res = await query(
    `SELECT * FROM uom_conversions WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  );
  if (res.rowCount === 0) return null;
  return res.rows[0];
}

export async function listUomConversionsByItem(tenantId: string, itemId: string) {
  const res = await query(
    `SELECT * FROM uom_conversions WHERE item_id = $1 AND tenant_id = $2 ORDER BY from_uom, to_uom`,
    [itemId, tenantId]
  );
  return res.rows;
}

export async function deleteUomConversion(tenantId: string, id: string) {
  const conversion = await getUomConversion(tenantId, id);
  if (!conversion) return;

  const inUse = await query(
    `SELECT 1
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND item_id = $2
        AND (
          uom = $3 OR uom = $4
          OR uom_entered = $3 OR uom_entered = $4
        )
      LIMIT 1`,
    [tenantId, conversion.item_id, conversion.from_uom, conversion.to_uom]
  );

  if (inUse.rowCount && inUse.rowCount > 0) {
    throw new Error('UOM_CONVERSION_IN_USE');
  }

  await query(
    `DELETE FROM uom_conversions WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  );
}

export async function convertQuantity(
  tenantId: string,
  itemId: string,
  quantity: number,
  fromUom: string,
  toUom: string
): Promise<number> {
  const itemConfig = await getItemUomConfigIfPresent(tenantId, itemId);
  if (itemConfig) {
    validateConversionAgainstItemDimension(itemConfig, fromUom, toUom);
  }
  if (fromUom === toUom) return quantity;

  // Try direct conversion
  const direct = await query<{ factor: string }>(
    `SELECT factor FROM uom_conversions 
     WHERE tenant_id = $1 AND item_id = $2 AND from_uom = $3 AND to_uom = $4`,
    [tenantId, itemId, fromUom, toUom]
  );
  if (direct.rowCount && direct.rowCount > 0) {
    return quantity * Number(direct.rows[0].factor);
  }

  // Try reverse conversion
  const reverse = await query<{ factor: string }>(
    `SELECT factor FROM uom_conversions 
     WHERE tenant_id = $1 AND item_id = $2 AND from_uom = $4 AND to_uom = $3`,
    [tenantId, itemId, fromUom, toUom]
  );
  if (reverse.rowCount && reverse.rowCount > 0) {
    return quantity / Number(reverse.rows[0].factor);
  }

  throw new Error(`UOM_CONVERSION_MISSING: ${fromUom} to ${toUom} for item ${itemId}`);
}

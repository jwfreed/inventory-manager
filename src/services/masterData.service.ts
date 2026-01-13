import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import { query, withTransaction } from '../db';
import { getExchangeRate } from './currencies.service';
import type { itemSchema, locationSchema, uomConversionSchema } from '../schemas/masterData.schema';
import { ItemLifecycleStatus } from '../types/item';

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
  i.default_location_id,
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
    defaultUom: row.defaultUom ?? row.default_uom ?? null,
    defaultLocationId: row.defaultLocationId ?? row.default_location_id ?? null,
    defaultLocationCode: row.defaultLocationCode ?? row.default_location_code ?? null,
    defaultLocationName: row.defaultLocationName ?? row.default_location_name ?? null,
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
  const defaultUom = data.defaultUom ?? null;
  const defaultLocationId = data.defaultLocationId ?? null;
  const {
    standardCostCurrency,
    standardCostExchangeRateToBase,
    standardCostBase
  } = await resolveStandardCostFields(data, baseCurrency);
  await query(
    `INSERT INTO items (
        id, tenant_id, sku, name, description, type, is_phantom, default_uom, default_location_id, lifecycle_status, weight, weight_uom, volume, volume_uom,
        standard_cost, standard_cost_currency, standard_cost_exchange_rate_to_base, standard_cost_base,
        rolled_cost, cost_method, selling_price, list_price, price_currency, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $25)`,
    [
      id,
      tenantId,
      data.sku,
      data.name,
      data.description ?? null,
      data.type,
      isPhantom,
      defaultUom,
      defaultLocationId,
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
  const defaultUom = data.defaultUom ?? null;
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
           default_location_id = $7,
           lifecycle_status = $8,
           weight = $9,
           weight_uom = $10,
           volume = $11,
           volume_uom = $12,
           standard_cost = $13,
           standard_cost_currency = $14,
           standard_cost_exchange_rate_to_base = $15,
           standard_cost_base = $16,
           rolled_cost = $17,
           cost_method = $18,
           selling_price = $19,
           list_price = $20,
           price_currency = $21,
           updated_at = $22
     WHERE id = $23 AND tenant_id = $24
     RETURNING id`,
    [
      data.sku,
      data.name,
      data.description ?? null,
      type,
      isPhantom,
      defaultUom,
      defaultLocationId,
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
  params.push(filters.limit, filters.offset);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT ${itemSelectColumns}
     FROM items i
     LEFT JOIN locations l ON l.id = i.default_location_id AND l.tenant_id = i.tenant_id
     ${where}
     ORDER BY i.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows.map(mapItem);
}

export function mapLocation(row: any) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
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

  return withTransaction(async (client) => {
    const res = await client.query(
      `INSERT INTO locations (
          id, tenant_id, code, name, type, active, parent_location_id, max_weight, max_volume, zone, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
       RETURNING *`,
      [
        id,
        tenantId,
        data.code,
        data.name,
        data.type,
        active,
        data.parentLocationId ?? null,
        data.maxWeight ?? null,
        data.maxVolume ?? null,
        data.zone ?? null,
        now,
      ]
    );
    return mapLocation(res.rows[0]);
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
    const res = await client.query(
      `UPDATE locations
         SET code = $1,
             name = $2,
             type = $3,
             active = $4,
             parent_location_id = $5,
             max_weight = $6,
             max_volume = $7,
             zone = $8,
             updated_at = $9
       WHERE id = $10 AND tenant_id = $11
       RETURNING *`,
      [
        data.code,
        data.name,
        data.type,
        active,
        data.parentLocationId ?? null,
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
  limit: number;
  offset: number;
}) {
  const conditions: string[] = ['tenant_id = $1'];
  const params: any[] = [filters.tenantId];
  if (filters.active !== undefined) {
    params.push(filters.active);
    conditions.push(`active = $${params.length}`);
  }
  if (filters.type) {
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
  const baseLocations = [
    { code: 'RAW', name: 'Raw Stock', type: 'warehouse' },
    { code: 'WIP', name: 'Work in Progress', type: 'warehouse' },
    { code: 'FG', name: 'Finished Goods', type: 'warehouse' },
    { code: 'SHIP-STG', name: 'Shipping Staging', type: 'warehouse' },
    { code: 'STORE', name: 'Store/Customer', type: 'customer' }
  ];
  if (includeReceivingQc) {
    baseLocations.push({ code: 'RECV', name: 'Receiving', type: 'warehouse' });
    baseLocations.push({ code: 'QC', name: 'Quality Inspection', type: 'warehouse' });
  }

  const codes = baseLocations.map((loc) => loc.code);
  return withTransaction(async (client) => {
    const existingRes = await client.query<{ code: string }>(
      'SELECT code FROM locations WHERE tenant_id = $1 AND code = ANY($2)',
      [tenantId, codes]
    );
    const existingCodes = new Set(existingRes.rows.map((r) => r.code));
    const created: any[] = [];

    for (const loc of baseLocations) {
      if (existingCodes.has(loc.code)) continue;
      const id = uuidv4();
      const res = await client.query(
        `INSERT INTO locations (
            id, tenant_id, code, name, type, active, parent_location_id, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, true, NULL, $6, $6)
         ON CONFLICT (code) DO NOTHING
         RETURNING *`,
        [id, tenantId, loc.code, loc.name, loc.type, now]
      );
      if (res && (res.rowCount ?? 0) > 0) {
        created.push(mapLocation(res.rows[0]));
      }
    }

    return {
      created,
      skipped: Array.from(existingCodes)
    };
  });
}

export async function createUomConversion(tenantId: string, data: UomConversionInput) {
  const now = new Date();
  const id = uuidv4();
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

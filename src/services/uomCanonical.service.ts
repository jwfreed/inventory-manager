import type { PoolClient } from 'pg';
import { query } from '../db';

export type UomDimension = 'mass' | 'volume' | 'count' | 'length' | 'area' | 'time';

const CANONICAL_UOM_BY_DIMENSION: Record<UomDimension, string> = {
  mass: 'kg',
  volume: 'L',
  count: 'each',
  length: 'm',
  area: 'm2',
  time: 'seconds'
};

const KNOWN_UOM_DIMENSION: Record<string, UomDimension> = {
  kg: 'mass',
  g: 'mass',
  mg: 'mass',
  lb: 'mass',
  lbs: 'mass',
  oz: 'mass',
  l: 'volume',
  ml: 'volume',
  each: 'count',
  ea: 'count',
  pc: 'count',
  pcs: 'count',
  m: 'length',
  cm: 'length',
  mm: 'length',
  m2: 'area',
  cm2: 'area',
  s: 'time',
  sec: 'time',
  secs: 'time',
  second: 'time',
  seconds: 'time',
  min: 'time',
  mins: 'time',
  minute: 'time',
  minutes: 'time',
  h: 'time',
  hr: 'time',
  hrs: 'time',
  hour: 'time',
  hours: 'time'
};

export type ItemUomConfig = {
  itemId: string;
  uomDimension: UomDimension;
  canonicalUom: string;
  stockingUom: string;
};

export type CanonicalQuantity = {
  quantity: number;
  canonicalUom: string;
  uomDimension: UomDimension;
};

function normalizeUom(value: string): string {
  return value.trim();
}

function normalizeUomKey(value: string): string {
  return normalizeUom(value).toLowerCase();
}

function getUomDimension(uom: string): UomDimension | null {
  const key = normalizeUomKey(uom);
  return KNOWN_UOM_DIMENSION[key] ?? null;
}

function assertUomMatchesDimension(uom: string, dimension: UomDimension) {
  const resolved = getUomDimension(uom);
  if (!resolved) {
    if (dimension === 'count') {
      return;
    }
    throw new Error(`UOM_DIMENSION_UNKNOWN:${uom}`);
  }
  if (resolved !== dimension) {
    throw new Error(`UOM_DIMENSION_MISMATCH:${uom}`);
  }
}

export function getCanonicalUomForDimension(dimension: UomDimension): string {
  return CANONICAL_UOM_BY_DIMENSION[dimension];
}

async function getItemUomRow(
  tenantId: string,
  itemId: string,
  client?: PoolClient
): Promise<{
  uom_dimension: string | null;
  canonical_uom: string | null;
  stocking_uom: string | null;
}> {
  const executor = client ? client.query.bind(client) : query;
  const res = await executor(
    `SELECT uom_dimension, canonical_uom, stocking_uom
       FROM items
      WHERE id = $1 AND tenant_id = $2`,
    [itemId, tenantId]
  );
  if (res.rowCount === 0) {
    throw new Error('ITEM_NOT_FOUND');
  }
  return res.rows[0];
}

export async function getItemUomConfig(
  tenantId: string,
  itemId: string,
  client?: PoolClient
): Promise<ItemUomConfig> {
  const row = await getItemUomRow(tenantId, itemId, client);
  if (!row.uom_dimension || !row.canonical_uom || !row.stocking_uom) {
    throw new Error('ITEM_CANONICAL_UOM_REQUIRED');
  }
  const dimension = row.uom_dimension as UomDimension;
  const canonicalExpected = getCanonicalUomForDimension(dimension);
  if (row.canonical_uom !== canonicalExpected) {
    throw new Error('ITEM_CANONICAL_UOM_INVALID');
  }
  assertUomMatchesDimension(row.canonical_uom, dimension);
  assertUomMatchesDimension(row.stocking_uom, dimension);
  return {
    itemId,
    uomDimension: dimension,
    canonicalUom: row.canonical_uom,
    stockingUom: row.stocking_uom
  };
}

export async function getItemUomConfigIfPresent(
  tenantId: string,
  itemId: string,
  client?: PoolClient
): Promise<ItemUomConfig | null> {
  const row = await getItemUomRow(tenantId, itemId, client);
  if (!row.uom_dimension || !row.canonical_uom || !row.stocking_uom) {
    return null;
  }
  const dimension = row.uom_dimension as UomDimension;
  const canonicalExpected = getCanonicalUomForDimension(dimension);
  if (row.canonical_uom !== canonicalExpected) {
    throw new Error('ITEM_CANONICAL_UOM_INVALID');
  }
  return {
    itemId,
    uomDimension: dimension,
    canonicalUom: row.canonical_uom,
    stockingUom: row.stocking_uom
  };
}

async function lookupConversionFactor(
  tenantId: string,
  itemId: string,
  fromUom: string,
  toUom: string,
  client?: PoolClient
): Promise<number | null> {
  const executor = client ? client.query.bind(client) : query;
  const params = [tenantId, itemId, fromUom, toUom];
  const direct = await executor<{ factor: string }>(
    `SELECT factor
       FROM uom_conversions
      WHERE tenant_id = $1
        AND item_id = $2
        AND LOWER(from_uom) = LOWER($3)
        AND LOWER(to_uom) = LOWER($4)`,
    params
  );
  if (direct.rowCount && direct.rows[0]) {
    return Number(direct.rows[0].factor);
  }
  const reverse = await executor<{ factor: string }>(
    `SELECT factor
       FROM uom_conversions
      WHERE tenant_id = $1
        AND item_id = $2
        AND LOWER(from_uom) = LOWER($4)
        AND LOWER(to_uom) = LOWER($3)`,
    params
  );
  if (reverse.rowCount && reverse.rows[0]) {
    return 1 / Number(reverse.rows[0].factor);
  }
  return null;
}

export async function convertToCanonical(
  tenantId: string,
  itemId: string,
  quantity: number,
  fromUom: string,
  client?: PoolClient
): Promise<CanonicalQuantity> {
  const config = await getItemUomConfig(tenantId, itemId, client);
  const enteredUom = normalizeUom(fromUom);
  if (!enteredUom) {
    throw new Error('UOM_REQUIRED');
  }
  assertUomMatchesDimension(enteredUom, config.uomDimension);
  if (normalizeUomKey(enteredUom) === normalizeUomKey(config.canonicalUom)) {
    return {
      quantity,
      canonicalUom: config.canonicalUom,
      uomDimension: config.uomDimension
    };
  }
  const factor = await lookupConversionFactor(
    tenantId,
    itemId,
    enteredUom,
    config.canonicalUom,
    client
  );
  if (factor === null || Number.isNaN(factor) || factor <= 0) {
    throw new Error(`UOM_CONVERSION_MISSING:${enteredUom}->${config.canonicalUom}`);
  }
  return {
    quantity: quantity * factor,
    canonicalUom: config.canonicalUom,
    uomDimension: config.uomDimension
  };
}

export type CanonicalMovementFields = {
  quantityDeltaEntered: number;
  uomEntered: string;
  quantityDeltaCanonical: number;
  canonicalUom: string;
  uomDimension: UomDimension;
};

export async function getCanonicalMovementFields(
  tenantId: string,
  itemId: string,
  quantityDelta: number,
  uom: string,
  client?: PoolClient
): Promise<CanonicalMovementFields> {
  const canonical = await convertToCanonical(tenantId, itemId, quantityDelta, uom, client);
  return {
    quantityDeltaEntered: quantityDelta,
    uomEntered: normalizeUom(uom),
    quantityDeltaCanonical: canonical.quantity,
    canonicalUom: canonical.canonicalUom,
    uomDimension: canonical.uomDimension
  };
}

export function assertCanonicalFieldsPresent(
  data: {
    uomDimension?: string | null;
    canonicalUom?: string | null;
    stockingUom?: string | null;
  }
) {
  if (!data.uomDimension || !data.canonicalUom || !data.stockingUom) {
    throw new Error('ITEM_CANONICAL_UOM_REQUIRED');
  }
  const dimension = data.uomDimension as UomDimension;
  const canonicalExpected = getCanonicalUomForDimension(dimension);
  if (data.canonicalUom !== canonicalExpected) {
    throw new Error('ITEM_CANONICAL_UOM_INVALID');
  }
  assertUomMatchesDimension(data.canonicalUom, dimension);
  assertUomMatchesDimension(data.stockingUom, dimension);
}

export function validateConversionAgainstItemDimension(
  item: ItemUomConfig,
  fromUom: string,
  toUom: string
) {
  assertUomMatchesDimension(fromUom, item.uomDimension);
  assertUomMatchesDimension(toUom, item.uomDimension);
}

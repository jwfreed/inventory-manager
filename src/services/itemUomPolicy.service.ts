import type { PoolClient } from 'pg';
import { query } from '../db';
import { canonicalizeRequiredUom } from './uomCanonical.service';
import { convertQty, type UomRoundingContext } from './uomConvert.service';

export type ItemStockUomConfig = {
  stockUom: string | null;
  dimension: string | null;
  canonicalUom: string | null;
};

export type ItemStockUomValidation = {
  warnings: string[];
};

export type NormalizeToStockUomResult = {
  qty: string;
  uom: string;
  warnings: string[];
};

export async function getItemStockUom(
  tenantId: string,
  itemId: string,
  client?: PoolClient
): Promise<ItemStockUomConfig> {
  const executor = client ? client.query.bind(client) : query;
  const result = await executor<{
    stocking_uom: string | null;
    uom_dimension: string | null;
    canonical_uom: string | null;
  }>(
    `SELECT stocking_uom, uom_dimension, canonical_uom
       FROM items
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, itemId]
  );

  if (result.rowCount === 0) {
    throw new Error('ITEM_NOT_FOUND');
  }

  const row = result.rows[0];
  return {
    stockUom: row.stocking_uom,
    dimension: row.uom_dimension,
    canonicalUom: row.canonical_uom
  };
}

export async function assertConvertibleToStockUom(
  tenantId: string,
  itemId: string,
  uomCode: string,
  client?: PoolClient
): Promise<ItemStockUomValidation> {
  const stockConfig = await getItemStockUom(tenantId, itemId, client);
  const normalizedUom = canonicalizeRequiredUom(uomCode);
  if (!stockConfig.stockUom) {
    return { warnings: ['ITEM_STOCK_UOM_UNSET'] };
  }

  await convertQty({
    qty: 1,
    fromUom: normalizedUom,
    toUom: stockConfig.stockUom,
    roundingContext: 'transfer',
    tenantId,
    itemId
  });

  return { warnings: [] };
}

export async function normalizeToStockUomOrWarn(input: {
  tenantId: string;
  itemId: string;
  qty: number | string;
  uom: string;
  roundingContext?: UomRoundingContext;
  contextPrecision?: number;
  client?: PoolClient;
}): Promise<NormalizeToStockUomResult> {
  const stockConfig = await getItemStockUom(input.tenantId, input.itemId, input.client);
  const normalizedUom = canonicalizeRequiredUom(input.uom);
  if (!stockConfig.stockUom) {
    return {
      qty: String(input.qty),
      uom: normalizedUom,
      warnings: ['ITEM_STOCK_UOM_UNSET']
    };
  }

  if (stockConfig.stockUom.toLowerCase() === normalizedUom.toLowerCase()) {
    return {
      qty: String(input.qty),
      uom: stockConfig.stockUom,
      warnings: []
    };
  }

  const converted = await convertQty({
    qty: input.qty,
    fromUom: normalizedUom,
    toUom: stockConfig.stockUom,
    roundingContext: input.roundingContext ?? 'transfer',
    contextPrecision: input.contextPrecision,
    tenantId: input.tenantId,
    itemId: input.itemId
  });

  return {
    qty: converted.exactQty,
    uom: stockConfig.stockUom,
    warnings: converted.warnings
  };
}

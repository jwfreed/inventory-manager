import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { v5 as uuidv5 } from 'uuid';
import type { PoolClient } from 'pg';
import bcrypt from 'bcryptjs';
import {
  createInventoryMovement,
  createInventoryMovementLine
} from '../../../src/domains/inventory/internal/ledgerWriter';
import { createOpeningBalanceCostLayerOnce } from '../../../src/services/costLayers.service';
import {
  importBomDatasetFromFile,
  type ImportedBom,
  type ImportedItem
} from '../siamaya/import_bom_from_xlsx';

const ID_NAMESPACE = '85fc700f-6f58-4d79-a7db-7af0951374fd';
const REQUIRED_ROLES = ['SELLABLE', 'QA', 'HOLD'] as const;
const DEFAULT_BOM_JSON_PATH = path.resolve(process.cwd(), 'scripts/seed/siamaya/siamaya-bom-production.json');
const DEFAULT_INITIAL_STOCK_SPEC_PATH = path.resolve(process.cwd(), 'scripts/seed/siamaya/initial-stock-spec.json');
const LOT_TRACKED_ITEM_KEYS = new Set([
  'cacao beans',
  'cacao butter',
  'powdered milk',
  'coconut milk powder'
]);
const FACTORY_OPERATIONAL_LOCATIONS = [
  { code: 'FACTORY_RECEIVING', localCode: 'RECEIVING', name: 'Factory Receiving' },
  { code: 'FACTORY_RM_STORE', localCode: 'RM_STORE', name: 'Factory Raw Material Store' },
  { code: 'FACTORY_PACK_STORE', localCode: 'PACK_STORE', name: 'Factory Packaging Store' },
  { code: 'FACTORY_PRODUCTION', localCode: 'PRODUCTION', name: 'Factory Production' },
  { code: 'FACTORY_FG_STAGE', localCode: 'FG_STAGE', name: 'Factory Finished Goods Stage' }
] as const;
// Non-root locations currently require a role by DB constraint; HOLD keeps them non-sellable
// while preserving distinct operational codes (RECEIVING/RM_STORE/PACK_STORE/PRODUCTION/FG_STAGE).
const OPERATIONAL_LOCATION_ROLE = 'HOLD';

const DEFAULT_OPTIONS = {
  pack: 'siamaya_factory',
  tenantSlug: 'siamaya',
  tenantName: 'SIAMAYA',
  adminEmail: 'jon.freed@gmail.com',
  adminPassword: 'admin@local',
  warehouses: [
    { code: 'FACTORY', name: 'Factory' },
    { code: 'STORE_1', name: 'Store 1' },
    { code: 'STORE_2', name: 'Store 2' },
    { code: 'STORE_3', name: 'Store 3' }
  ]
} as const;

export type SiamayaPackOptions = {
  pack?: string;
  tenantSlug?: string;
  tenantName?: string;
  adminEmail?: string;
  adminPassword?: string;
  bomFilePath?: string;
  bomSheetName?: string;
  initialStockSpecPath?: string;
  warehouses?: Array<{ code: string; name: string }>;
  datasetOverride?: {
    items: ImportedItem[];
    boms: ImportedBom[];
    unknownUoms?: string[];
  };
};

export type SeedSummary = {
  pack: string;
  tenant: string;
  receiptMode: 'none' | 'clean' | 'partial_then_close_short' | 'partial_with_discrepancy';
  warehousesCreated: number;
  locationsCreated: number;
  usersUpserted: number;
  itemsUpserted: number;
  bomsUpserted: number;
  bomVersionsUpserted: number;
  bomLinesUpserted: number;
  uomConversionsUpserted: number;
  purchaseOrdersCreated: number;
  purchaseOrdersReused: number;
  purchaseOrderLinesCreated: number;
  purchaseOrderLinesReused: number;
  receiptsAttempted: number;
  receiptsCreated: number;
  receiptsReplayed: number;
  receiptLinesAttempted: number;
  lineClosuresAttempted: number;
  lineClosuresApplied: number;
  lineClosuresReplayed: number;
  receiptMovementsCreated: number;
  costLayersCreatedEstimate: number;
  unknownUoms: string[];
  checksum: string;
};

type CanonicalItem = ImportedItem & {
  type: 'raw' | 'wip' | 'finished' | 'packaging';
};

type CanonicalBom = ImportedBom;

type TenantRow = { id: string };
type LocationRow = { id: string; code: string };
type UserRow = { id: string; email: string };
type ItemRow = { id: string; name: string };
type BomRow = { id: string };
type BomVersionRow = { id: string };
type StockSpecLine = {
  itemKey: string;
  quantity: number;
  uom: string;
  unitCost: number;
  locationCode: string;
  lotCode?: string;
  productionDate?: string;
  expirationDate?: string;
};

type InitialStockSpec = {
  version: number;
  stockDate: string;
  items: StockSpecLine[];
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeTenantSlug(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

function normalizeEmail(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

function normalizeItemKey(value: string): string {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function deterministicId(...parts: string[]): string {
  return uuidv5(parts.join(':'), ID_NAMESPACE);
}

function slugifyForCode(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36);
}

function deterministicSku(tenantSlug: string, itemKey: string): string {
  const readable = slugifyForCode(itemKey) || 'item';
  const hash = createHash('sha256').update(`${tenantSlug}:${itemKey}`).digest('hex').slice(0, 8).toUpperCase();
  return `${tenantSlug.toUpperCase()}-${readable.toUpperCase()}-${hash}`.slice(0, 255);
}

function deterministicBomCode(tenantSlug: string, outputItemKey: string): string {
  const readable = slugifyForCode(outputItemKey) || 'item';
  const hash = createHash('sha256').update(`bom:${tenantSlug}:${outputItemKey}`).digest('hex').slice(0, 8).toUpperCase();
  return `BOM-${tenantSlug.toUpperCase()}-${readable.toUpperCase()}-${hash}`.slice(0, 255);
}

function toStableQuantity(value: number): string {
  const fixed = value.toFixed(12);
  return fixed.replace(/\.?0+$/, '');
}

function buildChecksum(input: {
  tenantSlug: string;
  warehouseCodes: string[];
  locationCodes: string[];
  userEmail: string;
  items: CanonicalItem[];
  boms: CanonicalBom[];
  initialStock: InitialStockSpec;
}): string {
  const lines: string[] = [];
  lines.push(`tenant:${input.tenantSlug}`);
  for (const warehouseCode of [...input.warehouseCodes].sort((left, right) => left.localeCompare(right))) {
    lines.push(`warehouse:${warehouseCode}`);
  }
  for (const locationCode of [...input.locationCodes].sort((left, right) => left.localeCompare(right))) {
    lines.push(`location:${locationCode}`);
  }
  lines.push(`user:${input.userEmail}`);

  for (const item of [...input.items].sort((left, right) => left.key.localeCompare(right.key))) {
    lines.push(`item:${item.key}|${item.baseUom}`);
  }

  for (const bom of [...input.boms].sort((left, right) => left.outputKey.localeCompare(right.outputKey))) {
    lines.push(`bom:${bom.outputKey}|1|${toStableQuantity(bom.outputQuantity)}|${bom.outputUom}`);
    for (const component of bom.components) {
      lines.push(
        `bom_line:${bom.outputKey}|${component.componentKey}|${toStableQuantity(component.quantity)}|${component.uom}`
      );
    }
  }

  lines.push(`initial_stock_date:${input.initialStock.stockDate}`);
  for (const stockLine of [...input.initialStock.items].sort((left, right) => {
    const itemCompare = left.itemKey.localeCompare(right.itemKey);
    if (itemCompare !== 0) return itemCompare;
    const locationCompare = left.locationCode.localeCompare(right.locationCode);
    if (locationCompare !== 0) return locationCompare;
    return left.uom.localeCompare(right.uom);
  })) {
    lines.push(
      [
        'initial_stock',
        stockLine.itemKey,
        toStableQuantity(stockLine.quantity),
        stockLine.uom,
        toStableQuantity(stockLine.unitCost),
        stockLine.locationCode,
        stockLine.lotCode ?? ''
      ].join(':')
    );
  }

  const digest = createHash('sha256').update(lines.join('\n')).digest('hex');
  return `sha256:${digest}`;
}

function isPackagingName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes('wrapper')
    || lower.includes('sticker')
    || lower.includes('label')
    || lower.includes('sleeve')
    || lower.includes('gold paper')
    || lower.includes('flow wrap foil')
    || lower.includes('shrink film')
    || lower.includes('box')
    || lower.includes('bags')
    || lower.includes('bag')
    || lower.includes('bottle')
    || lower.includes('tin')
  );
}

function isWipName(name: string): boolean {
  const normalized = normalizeWhitespace(name);
  return (
    normalized.startsWith('Base - ')
    || normalized.includes(' - FLOW WRAP')
    || normalized.includes(' - GOLD FOIL')
    || normalized.includes(' - UNWRAPPED')
    || normalized === 'Cacao Nibs - Raw Material'
  );
}

function inferCanonicalItemType(item: ImportedItem): 'raw' | 'wip' | 'finished' | 'packaging' {
  if (isPackagingName(item.name)) {
    return 'packaging';
  }
  if (item.appearsAsOutput && isWipName(item.name)) {
    return 'wip';
  }
  if (item.appearsAsOutput) {
    return 'finished';
  }
  return 'raw';
}

function loadInitialStockSpec(filePath: string): InitialStockSpec {
  if (!fs.existsSync(filePath)) {
    throw new Error(`SEED_INITIAL_STOCK_SPEC_NOT_FOUND file=${filePath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<InitialStockSpec>;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) {
    throw new Error(`SEED_INITIAL_STOCK_SPEC_INVALID file=${filePath}`);
  }
  const version = Number(parsed.version ?? 0);
  if (version !== 1) {
    throw new Error(`SEED_INITIAL_STOCK_SPEC_VERSION_UNSUPPORTED version=${parsed.version}`);
  }
  const stockDate = String(parsed.stockDate ?? '').trim();
  if (!stockDate) {
    throw new Error('SEED_INITIAL_STOCK_SPEC_STOCK_DATE_REQUIRED');
  }
  const items = parsed.items.map((line, index) => {
    const itemKey = normalizeItemKey(String(line.itemKey ?? ''));
    const quantity = Number(line.quantity);
    const unitCost = Number(line.unitCost);
    const uom = normalizeWhitespace(String(line.uom ?? '')).toLowerCase();
    const locationCode = normalizeWhitespace(String(line.locationCode ?? '')).toUpperCase();
    if (!itemKey || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitCost) || unitCost < 0 || !uom || !locationCode) {
      throw new Error(`SEED_INITIAL_STOCK_SPEC_LINE_INVALID index=${index}`);
    }
    return {
      itemKey,
      quantity,
      uom,
      unitCost,
      locationCode,
      lotCode: line.lotCode ? normalizeWhitespace(String(line.lotCode)) : undefined,
      productionDate: line.productionDate ? String(line.productionDate) : undefined,
      expirationDate: line.expirationDate ? String(line.expirationDate) : undefined
    };
  });
  return {
    version,
    stockDate,
    items
  };
}

function canonicalUomFields(baseUom: string): {
  defaultUom: string;
  uomDimension: string | null;
  canonicalUom: string | null;
  stockingUom: string | null;
} {
  if (baseUom === 'piece' || baseUom === 'each') {
    return {
      defaultUom: baseUom,
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: baseUom
    };
  }
  if (baseUom === 'g') {
    return {
      defaultUom: baseUom,
      uomDimension: 'mass',
      canonicalUom: 'g',
      stockingUom: baseUom
    };
  }
  if (baseUom === 'kg') {
    return {
      defaultUom: baseUom,
      uomDimension: 'mass',
      canonicalUom: 'g',
      stockingUom: baseUom
    };
  }
  return {
    defaultUom: baseUom,
    uomDimension: null,
    canonicalUom: null,
    stockingUom: null
  };
}

function canonicalBomLineFields(
  quantity: number,
  uom: string
): {
  componentQuantityEntered: number | null;
  componentUomEntered: string | null;
  componentQuantityCanonical: number | null;
  componentUomCanonical: string | null;
  componentUomDimension: string | null;
} {
  if (uom === 'piece' || uom === 'each') {
    return {
      componentQuantityEntered: quantity,
      componentUomEntered: uom,
      componentQuantityCanonical: quantity,
      componentUomCanonical: 'each',
      componentUomDimension: 'count'
    };
  }
  if (uom === 'g') {
    return {
      componentQuantityEntered: quantity,
      componentUomEntered: uom,
      componentQuantityCanonical: quantity,
      componentUomCanonical: 'g',
      componentUomDimension: 'mass'
    };
  }
  if (uom === 'kg') {
    return {
      componentQuantityEntered: quantity,
      componentUomEntered: uom,
      componentQuantityCanonical: quantity * 1000,
      componentUomCanonical: 'g',
      componentUomDimension: 'mass'
    };
  }
  return {
    componentQuantityEntered: null,
    componentUomEntered: null,
    componentQuantityCanonical: null,
    componentUomCanonical: null,
    componentUomDimension: null
  };
}

async function ensureCurrency(client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO currencies (code, name, symbol, decimal_places, active, created_at, updated_at)
     VALUES ('THB', 'Thai Baht', 'THB', 2, true, now(), now())
     ON CONFLICT (code) DO NOTHING`
  );
}

async function upsertTenant(client: PoolClient, slug: string, name: string): Promise<{ id: string; created: boolean }> {
  const existing = await client.query<TenantRow>('SELECT id FROM tenants WHERE slug = $1', [slug]);
  if ((existing.rowCount ?? 0) > 0) {
    const tenantId = existing.rows[0].id;
    await client.query('UPDATE tenants SET name = $1 WHERE id = $2', [name, tenantId]);
    return { id: tenantId, created: false };
  }
  const tenantId = deterministicId('tenant', slug);
  await client.query(
    `INSERT INTO tenants (id, name, slug, parent_tenant_id, created_at)
     VALUES ($1, $2, $3, NULL, now())`,
    [tenantId, name, slug]
  );
  return { id: tenantId, created: true };
}

async function upsertWarehouseRoot(
  client: PoolClient,
  args: { tenantId: string; code: string; name: string }
): Promise<{ id: string; created: boolean }> {
  const existing = await client.query<LocationRow>(
    `SELECT id, code
       FROM locations
      WHERE tenant_id = $1
        AND code = $2`,
    [args.tenantId, args.code]
  );
  if ((existing.rowCount ?? 0) > 0) {
    const warehouseId = existing.rows[0].id;
    await client.query(
      `UPDATE locations
          SET local_code = $3,
              name = $4,
              type = 'warehouse',
              role = NULL,
              is_sellable = false,
              active = true,
              parent_location_id = NULL,
              warehouse_id = id,
              updated_at = now()
        WHERE tenant_id = $1
          AND id = $2`,
      [args.tenantId, warehouseId, args.code, args.name]
    );
    return { id: warehouseId, created: false };
  }

  const warehouseId = deterministicId('location', args.tenantId, 'warehouse', args.code);
  await client.query(
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
     ) VALUES ($1, $2, $3, $4, $5, 'warehouse', NULL, false, true, NULL, $1, now(), now())`,
    [warehouseId, args.tenantId, args.code, args.code, args.name]
  );
  return { id: warehouseId, created: true };
}

async function upsertWarehouseRoleLocation(
  client: PoolClient,
  args: { tenantId: string; warehouseId: string; warehouseCode: string; role: typeof REQUIRED_ROLES[number] }
): Promise<{ id: string; code: string; created: boolean }> {
  const code = `${args.warehouseCode}_${args.role}`;
  const name = `${args.warehouseCode} ${args.role}`;
  const existing = await client.query<LocationRow>(
    `SELECT id, code
       FROM locations
      WHERE tenant_id = $1
        AND code = $2`,
    [args.tenantId, code]
  );
  const isSellable = args.role === 'SELLABLE';
  if ((existing.rowCount ?? 0) > 0) {
    const locationId = existing.rows[0].id;
    await client.query(
      `UPDATE locations
          SET local_code = $3,
              name = $4,
              type = 'bin',
              role = $5,
              is_sellable = $6,
              active = true,
              parent_location_id = $7,
              warehouse_id = $7,
              updated_at = now()
        WHERE tenant_id = $1
          AND id = $2`,
      [args.tenantId, locationId, args.role, name, args.role, isSellable, args.warehouseId]
    );
    return { id: locationId, code, created: false };
  }
  const locationId = deterministicId('location', args.tenantId, args.warehouseCode, args.role);
  await client.query(
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
     ) VALUES ($1, $2, $3, $4, $5, 'bin', $6, $7, true, $8, $8, now(), now())`,
    [locationId, args.tenantId, code, args.role, name, args.role, isSellable, args.warehouseId]
  );
  return { id: locationId, code, created: true };
}

async function upsertOperationalLocation(
  client: PoolClient,
  args: {
    tenantId: string;
    warehouseId: string;
    code: string;
    localCode: string;
    name: string;
  }
): Promise<{ id: string; code: string; created: boolean }> {
  const existing = await client.query<LocationRow>(
    `SELECT id, code
       FROM locations
      WHERE tenant_id = $1
        AND code = $2`,
    [args.tenantId, args.code]
  );
  if ((existing.rowCount ?? 0) > 0) {
    const locationId = existing.rows[0].id;
    await client.query(
      `UPDATE locations
          SET local_code = $3,
              name = $4,
              type = 'bin',
              role = $5,
              is_sellable = false,
              active = true,
              parent_location_id = $6,
              warehouse_id = $6,
              updated_at = now()
        WHERE tenant_id = $1
          AND id = $2`,
      [args.tenantId, locationId, args.localCode, args.name, OPERATIONAL_LOCATION_ROLE, args.warehouseId]
    );
    return { id: locationId, code: args.code, created: false };
  }

  const locationId = deterministicId('location', args.tenantId, args.code);
  await client.query(
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
     ) VALUES ($1, $2, $3, $4, $5, 'bin', $6, false, true, $7, $7, now(), now())`,
    [locationId, args.tenantId, args.code, args.localCode, args.name, OPERATIONAL_LOCATION_ROLE, args.warehouseId]
  );
  return { id: locationId, code: args.code, created: true };
}

async function upsertWarehouseDefault(
  client: PoolClient,
  args: { tenantId: string; warehouseId: string; role: typeof REQUIRED_ROLES[number]; locationId: string }
): Promise<void> {
  await client.query(
    `INSERT INTO warehouse_default_location (tenant_id, warehouse_id, role, location_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, warehouse_id, role)
     DO UPDATE
        SET location_id = EXCLUDED.location_id`,
    [args.tenantId, args.warehouseId, args.role, args.locationId]
  );
}

async function upsertAdminUser(
  client: PoolClient,
  args: { tenantId: string; email: string; password: string }
): Promise<void> {
  await ensureCurrency(client);
  const passwordHash = await bcrypt.hash(args.password, 12);
  const existing = await client.query<UserRow>(
    `SELECT id, email
       FROM users
      WHERE lower(email) = $1
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
    [args.email]
  );
  let userId: string;
  if ((existing.rowCount ?? 0) > 0) {
    userId = existing.rows[0].id;
    await client.query(
      `UPDATE users
          SET email = $1,
              password_hash = $2,
              active = true,
              base_currency = COALESCE(base_currency, 'THB'),
              updated_at = now()
        WHERE id = $3`,
      [args.email, passwordHash, userId]
    );
  } else {
    userId = deterministicId('user', args.email);
    await client.query(
      `INSERT INTO users (
          id,
          email,
          password_hash,
          full_name,
          active,
          base_currency,
          created_at,
          updated_at
       ) VALUES ($1, $2, $3, NULL, true, 'THB', now(), now())`,
      [userId, args.email, passwordHash]
    );
  }

  await client.query(
    `INSERT INTO tenant_memberships (id, tenant_id, user_id, role, status, created_at)
     VALUES ($1, $2, $3, 'admin', 'active', now())
     ON CONFLICT (tenant_id, user_id)
     DO UPDATE
        SET role = 'admin',
            status = 'active'`,
    [deterministicId('membership', args.tenantId, userId), args.tenantId, userId]
  );
}

async function loadExistingItemsByNormalizedName(client: PoolClient, tenantId: string): Promise<Map<string, ItemRow>> {
  const rows = await client.query<ItemRow>(
    `SELECT id, name
       FROM items
      WHERE tenant_id = $1`,
    [tenantId]
  );
  const map = new Map<string, ItemRow>();
  for (const row of rows.rows) {
    const key = normalizeItemKey(row.name);
    const existing = map.get(key);
    if (existing) {
      throw new Error(
        `SEED_ITEM_NAME_AMBIGUOUS tenant_id=${tenantId} normalized_name=${key} item_ids=${existing.id},${row.id}`
      );
    }
    map.set(key, row);
  }
  return map;
}

async function upsertItems(
  client: PoolClient,
  args: { tenantId: string; tenantSlug: string; items: CanonicalItem[] }
): Promise<Map<string, string>> {
  const existingByNormalizedName = await loadExistingItemsByNormalizedName(client, args.tenantId);
  const idByItemKey = new Map<string, string>();

  for (const item of args.items) {
    const canonical = canonicalUomFields(item.baseUom);
    const existing = existingByNormalizedName.get(item.key);
    if (existing) {
      await client.query(
        `UPDATE items
            SET name = $1,
                description = $2,
                type = $3,
                default_uom = $4,
                uom_dimension = $5,
                canonical_uom = $6,
                stocking_uom = $7,
                requires_lot = $8,
                active = true,
                lifecycle_status = 'Active',
                updated_at = now()
          WHERE id = $9
            AND tenant_id = $10`,
        [
          item.name,
          'Seeded by siamaya_factory',
          item.type,
          canonical.defaultUom,
          canonical.uomDimension,
          canonical.canonicalUom,
          canonical.stockingUom,
          LOT_TRACKED_ITEM_KEYS.has(item.key),
          existing.id,
          args.tenantId
        ]
      );
      idByItemKey.set(item.key, existing.id);
      continue;
    }

    const itemId = deterministicId('item', args.tenantId, item.key);
    const sku = deterministicSku(args.tenantSlug, item.key);
    await client.query(
      `INSERT INTO items (
          id,
          tenant_id,
          sku,
          name,
          description,
          type,
          default_uom,
          uom_dimension,
          canonical_uom,
          stocking_uom,
          requires_lot,
          active,
          lifecycle_status,
          created_at,
          updated_at
       ) VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          true,
          'Active',
          now(),
          now()
       )`,
      [
        itemId,
        args.tenantId,
        sku,
        item.name,
        'Seeded by siamaya_factory',
        item.type,
        canonical.defaultUom,
        canonical.uomDimension,
        canonical.canonicalUom,
        canonical.stockingUom,
        LOT_TRACKED_ITEM_KEYS.has(item.key)
      ]
    );
    idByItemKey.set(item.key, itemId);
  }

  return idByItemKey;
}

async function upsertSeedUomConversions(
  client: PoolClient,
  args: { tenantId: string; items: CanonicalItem[]; itemIdByKey: Map<string, string> }
): Promise<number> {
  let upserted = 0;

  for (const item of args.items) {
    const itemId = args.itemIdByKey.get(item.key);
    if (!itemId) {
      throw new Error(`SEED_UOM_ITEM_MISSING key=${item.key}`);
    }

    const pairs: Array<{ fromUom: string; toUom: string; factor: string }> = [];
    if (item.baseUom === 'piece' || item.baseUom === 'each') {
      pairs.push({ fromUom: 'piece', toUom: 'each', factor: '1' });
      pairs.push({ fromUom: 'each', toUom: 'piece', factor: '1' });
    }
    if (item.baseUom === 'kg' || item.baseUom === 'g') {
      pairs.push({ fromUom: 'kg', toUom: 'g', factor: '1000' });
      pairs.push({ fromUom: 'g', toUom: 'kg', factor: '0.001' });
    }

    for (const pair of pairs) {
      await client.query(
        `INSERT INTO uom_conversions (
            tenant_id,
            item_id,
            from_uom,
            to_uom,
            factor,
            created_at,
            updated_at
         ) VALUES ($1, $2, $3, $4, $5, now(), now())
         ON CONFLICT (tenant_id, item_id, from_uom, to_uom)
         DO UPDATE
            SET factor = EXCLUDED.factor,
                updated_at = EXCLUDED.updated_at`,
        [args.tenantId, itemId, pair.fromUom, pair.toUom, pair.factor]
      );
      upserted += 1;
    }
  }

  return upserted;
}

function canonicalMovementFields(uom: string, quantity: number): {
  quantityDeltaEntered: number;
  uomEntered: string;
  quantityDeltaCanonical: number;
  canonicalUom: string;
  uomDimension: string;
} {
  const normalizedUom = normalizeWhitespace(uom).toLowerCase();
  if (normalizedUom === 'kg') {
    return {
      quantityDeltaEntered: quantity,
      uomEntered: 'kg',
      quantityDeltaCanonical: quantity * 1000,
      canonicalUom: 'g',
      uomDimension: 'mass'
    };
  }
  if (normalizedUom === 'g') {
    return {
      quantityDeltaEntered: quantity,
      uomEntered: 'g',
      quantityDeltaCanonical: quantity,
      canonicalUom: 'g',
      uomDimension: 'mass'
    };
  }
  return {
    quantityDeltaEntered: quantity,
    uomEntered: normalizedUom,
    quantityDeltaCanonical: quantity,
    canonicalUom: 'each',
    uomDimension: 'count'
  };
}

async function upsertSeedLot(
  client: PoolClient,
  args: {
    tenantId: string;
    itemId: string;
    lotCode: string;
    productionDate?: string;
    expirationDate?: string;
  }
): Promise<{ id: string; created: boolean }> {
  const existing = await client.query<{ id: string }>(
    `SELECT id
       FROM lots
      WHERE tenant_id = $1
        AND item_id = $2
        AND lot_code = $3
      LIMIT 1`,
    [args.tenantId, args.itemId, args.lotCode]
  );
  const lotId = deterministicId('lot', args.tenantId, args.itemId, args.lotCode);
  if ((existing.rowCount ?? 0) > 0) {
    await client.query(
      `UPDATE lots
          SET status = 'active',
              manufactured_at = COALESCE($4::timestamptz, manufactured_at),
              expires_at = COALESCE($5::timestamptz, expires_at),
              updated_at = now()
        WHERE id = $1
          AND tenant_id = $2
          AND item_id = $3`,
      [existing.rows[0].id, args.tenantId, args.itemId, args.productionDate ?? null, args.expirationDate ?? null]
    );
    return { id: existing.rows[0].id, created: false };
  }

  await client.query(
    `INSERT INTO lots (
        id,
        tenant_id,
        item_id,
        lot_code,
        status,
        manufactured_at,
        received_at,
        expires_at,
        vendor_lot_code,
        notes,
        created_at,
        updated_at
     ) VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, NULL, 'Seeded by siamaya_factory', now(), now())`,
    [lotId, args.tenantId, args.itemId, args.lotCode, args.productionDate ?? null, args.productionDate ?? null, args.expirationDate ?? null]
  );
  return { id: lotId, created: true };
}

async function seedInitialStockMovement(
  client: PoolClient,
  args: {
    pack: string;
    tenantId: string;
    tenantSlug: string;
    itemIdByKey: Map<string, string>;
    spec: InitialStockSpec;
    strictMissingItems: boolean;
  }
): Promise<{
  movementId: string | null;
  linesCreated: number;
  costLayersCreated: number;
  lotsCreated: number;
  expectedLotCount: number;
}> {
  const missingItemKeys = args.spec.items
    .filter((line) => !args.itemIdByKey.has(line.itemKey))
    .map((line) => line.itemKey);
  if (args.strictMissingItems && missingItemKeys.length > 0) {
    throw new Error(`SEED_INITIAL_STOCK_ITEMS_MISSING keys=${missingItemKeys.join(',')}`);
  }
  const seedLines = args.spec.items.filter((line) => args.itemIdByKey.has(line.itemKey));
  if (seedLines.length === 0) {
    if (args.strictMissingItems) {
      throw new Error('SEED_INITIAL_STOCK_NO_MATCHING_ITEMS');
    }
    return {
      movementId: null,
      linesCreated: 0,
      costLayersCreated: 0,
      lotsCreated: 0,
      expectedLotCount: 0
    };
  }

  const locationCodes = Array.from(new Set(seedLines.map((line) => line.locationCode)));
  const locationRows = await client.query<{ id: string; code: string }>(
    `SELECT id, code
       FROM locations
      WHERE tenant_id = $1
        AND code = ANY($2::text[])`,
    [args.tenantId, locationCodes]
  );
  const locationIdByCode = new Map(locationRows.rows.map((row) => [row.code, row.id]));
  for (const code of locationCodes) {
    if (!locationIdByCode.has(code)) {
      throw new Error(`SEED_INITIAL_STOCK_LOCATION_MISSING code=${code}`);
    }
  }

  const movementExternalRef = `seed:${args.pack}:initial-stock:${args.tenantSlug}:v${args.spec.version}`;
  const movementSourceId = deterministicId('seed-source', args.tenantId, movementExternalRef);
  const movementResult = await createInventoryMovement(client, {
    id: deterministicId('movement', args.tenantId, movementExternalRef),
    tenantId: args.tenantId,
    movementType: 'receive',
    status: 'posted',
    externalRef: movementExternalRef,
    sourceType: 'seed_initial_stock',
    sourceId: movementSourceId,
    idempotencyKey: movementExternalRef,
    occurredAt: args.spec.stockDate,
    postedAt: args.spec.stockDate,
    notes: 'Seeded initial stock'
  });

  const movementId = movementResult.id;
  const expectedLotCount = new Set(seedLines.filter((line) => !!line.lotCode).map((line) => line.lotCode)).size;
  if (!movementResult.created) {
    const lineCountRes = await client.query<{ count: string }>(
      `SELECT COUNT(*)::int::text AS count
         FROM inventory_movement_lines
        WHERE tenant_id = $1
          AND movement_id = $2`,
      [args.tenantId, movementId]
    );
    const expected = seedLines.length;
    const actual = Number(lineCountRes.rows[0]?.count ?? 0);
    if (actual !== expected) {
      throw new Error(`SEED_INITIAL_STOCK_MOVEMENT_LINE_COUNT_MISMATCH expected=${expected} actual=${actual}`);
    }
    return { movementId, linesCreated: 0, costLayersCreated: 0, lotsCreated: 0, expectedLotCount };
  }

  let linesCreated = 0;
  let costLayersCreated = 0;
  let lotsCreated = 0;
  const itemIdsInSeed = Array.from(new Set(seedLines.map((line) => args.itemIdByKey.get(line.itemKey)).filter((id): id is string => !!id)));
  const itemRequiresLotRows = await client.query<{ id: string; requires_lot: boolean }>(
    `SELECT id, requires_lot
       FROM items
      WHERE tenant_id = $1
        AND id = ANY($2::uuid[])`,
    [args.tenantId, itemIdsInSeed]
  );
  const requiresLotByItemId = new Map(itemRequiresLotRows.rows.map((row) => [row.id, row.requires_lot]));

  for (let index = 0; index < seedLines.length; index += 1) {
    const line = seedLines[index];
    const itemId = args.itemIdByKey.get(line.itemKey);
    if (!itemId) {
      throw new Error(`SEED_INITIAL_STOCK_ITEM_MISSING key=${line.itemKey}`);
    }
    const isLotTracked = requiresLotByItemId.get(itemId) === true;
    if (isLotTracked && !line.lotCode) {
      throw new Error(`SEED_INITIAL_STOCK_LOT_REQUIRED item=${line.itemKey}`);
    }
    if (!isLotTracked && line.lotCode) {
      throw new Error(`SEED_INITIAL_STOCK_LOT_NOT_ALLOWED item=${line.itemKey}`);
    }

    let lotId: string | null = null;
    if (line.lotCode) {
      const lotResult = await upsertSeedLot(client, {
        tenantId: args.tenantId,
        itemId,
        lotCode: line.lotCode,
        productionDate: line.productionDate,
        expirationDate: line.expirationDate
      });
      lotId = lotResult.id;
      if (lotResult.created) {
        lotsCreated += 1;
      }
    }

    const canonicalFields = canonicalMovementFields(line.uom, line.quantity);
    const locationId = locationIdByCode.get(line.locationCode);
    if (!locationId) {
      throw new Error(`SEED_INITIAL_STOCK_LOCATION_UNRESOLVED code=${line.locationCode}`);
    }
    const lineId = deterministicId('movement-line', movementId, String(index + 1), itemId, locationId);
    await createInventoryMovementLine(client, {
      id: lineId,
      tenantId: args.tenantId,
      movementId,
      itemId,
      locationId,
      quantityDelta: line.quantity,
      uom: line.uom,
      quantityDeltaEntered: canonicalFields.quantityDeltaEntered,
      uomEntered: canonicalFields.uomEntered,
      quantityDeltaCanonical: canonicalFields.quantityDeltaCanonical,
      canonicalUom: canonicalFields.canonicalUom,
      uomDimension: canonicalFields.uomDimension,
      unitCost: line.unitCost,
      extendedCost: line.quantity * line.unitCost,
      reasonCode: 'seed_initial_stock',
      lineNotes: 'Seeded opening stock',
      createdAt: args.spec.stockDate
    });
    linesCreated += 1;

    if (lotId) {
      await client.query(
        `INSERT INTO inventory_movement_lots (
            id,
            tenant_id,
            inventory_movement_line_id,
            lot_id,
            uom,
            quantity_delta,
            created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING`,
        [
          deterministicId('movement-lot', args.tenantId, lineId, lotId),
          args.tenantId,
          lineId,
          lotId,
          line.uom,
          line.quantity,
          args.spec.stockDate
        ]
      );
    }

    const layer = await createOpeningBalanceCostLayerOnce({
      id: deterministicId('seed-opening-layer', args.tenantId, movementId, lineId),
      tenant_id: args.tenantId,
      item_id: itemId,
      location_id: locationId,
      uom: line.uom,
      quantity: line.quantity,
      unit_cost: line.unitCost,
      source_type: 'opening_balance',
      source_document_id: movementId,
      movement_id: movementId,
      lot_id: lotId ?? undefined,
      layer_date: new Date(args.spec.stockDate),
      notes: 'Seeded opening stock',
      client
    });
    if (layer.id) {
      costLayersCreated += 1;
    }
  }

  return { movementId, linesCreated, costLayersCreated, lotsCreated, expectedLotCount };
}

async function upsertBomAndVersion(
  client: PoolClient,
  args: {
    tenantId: string;
    tenantSlug: string;
    bom: CanonicalBom;
    outputItemId: string;
  }
): Promise<{ bomId: string; versionId: string }> {
  const bomCode = deterministicBomCode(args.tenantSlug, args.bom.outputKey);
  const existingBom = await client.query<BomRow>(
    `SELECT id
       FROM boms
      WHERE tenant_id = $1
        AND bom_code = $2
      LIMIT 1`,
    [args.tenantId, bomCode]
  );

  let bomId: string;
  if ((existingBom.rowCount ?? 0) > 0) {
    bomId = existingBom.rows[0].id;
    await client.query(
      `UPDATE boms
          SET output_item_id = $1,
              default_uom = $2,
              active = true,
              notes = $3,
              updated_at = now()
        WHERE id = $4
          AND tenant_id = $5`,
      [args.outputItemId, args.bom.outputUom, 'Imported from Siamaya sheet 3. bom', bomId, args.tenantId]
    );
  } else {
    bomId = deterministicId('bom', args.tenantId, args.bom.outputKey);
    await client.query(
      `INSERT INTO boms (
          id,
          tenant_id,
          bom_code,
          output_item_id,
          default_uom,
          active,
          notes,
          created_at,
          updated_at
       ) VALUES ($1, $2, $3, $4, $5, true, $6, now(), now())`,
      [bomId, args.tenantId, bomCode, args.outputItemId, args.bom.outputUom, 'Imported from Siamaya sheet 3. bom']
    );
  }

  const existingVersion = await client.query<BomVersionRow>(
    `SELECT id
       FROM bom_versions
      WHERE tenant_id = $1
        AND bom_id = $2
        AND version_number = 1
      LIMIT 1`,
    [args.tenantId, bomId]
  );

  let versionId: string;
  if ((existingVersion.rowCount ?? 0) > 0) {
    versionId = existingVersion.rows[0].id;
    await client.query(
      `UPDATE bom_versions
          SET status = 'active',
              effective_from = NULL,
              effective_to = NULL,
              yield_quantity = $1,
              yield_uom = $2,
              yield_factor = 1,
              notes = $3,
              updated_at = now()
        WHERE id = $4
          AND tenant_id = $5`,
      [args.bom.outputQuantity, args.bom.outputUom, 'Authoritative import version', versionId, args.tenantId]
    );
  } else {
    versionId = deterministicId('bom-version', bomId, '1');
    await client.query(
      `INSERT INTO bom_versions (
          id,
          tenant_id,
          bom_id,
          version_number,
          status,
          effective_from,
          effective_to,
          yield_quantity,
          yield_uom,
          yield_factor,
          notes,
          created_at,
          updated_at
       ) VALUES ($1, $2, $3, 1, 'active', NULL, NULL, $4, $5, 1, $6, now(), now())`,
      [
        versionId,
        args.tenantId,
        bomId,
        args.bom.outputQuantity,
        args.bom.outputUom,
        'Authoritative import version'
      ]
    );
  }

  return { bomId, versionId };
}

async function replaceBomVersionLines(
  client: PoolClient,
  args: { tenantId: string; versionId: string; bom: CanonicalBom; itemIdByKey: Map<string, string> }
): Promise<number> {
  await client.query(
    `DELETE FROM bom_version_lines
      WHERE tenant_id = $1
        AND bom_version_id = $2`,
    [args.tenantId, args.versionId]
  );

  let insertedCount = 0;
  let lineNumber = 0;
  for (const component of args.bom.components) {
    lineNumber += 1;
    const componentItemId = args.itemIdByKey.get(component.componentKey);
    if (!componentItemId) {
      throw new Error(`SEED_BOM_COMPONENT_ITEM_MISSING key=${component.componentKey}`);
    }
    const canonical = canonicalBomLineFields(component.quantity, component.uom);
    await client.query(
      `INSERT INTO bom_version_lines (
          id,
          tenant_id,
          bom_version_id,
          line_number,
          component_item_id,
          component_quantity,
          component_uom,
          component_quantity_entered,
          component_uom_entered,
          component_quantity_canonical,
          component_uom_canonical,
          component_uom_dimension,
          scrap_factor,
          uses_pack_size,
          variable_uom,
          notes,
          created_at
       ) VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12,
          NULL,
          false,
          NULL,
          $13,
          now()
       )`,
      [
        deterministicId('bom-line', args.versionId, String(lineNumber), component.componentKey),
        args.tenantId,
        args.versionId,
        lineNumber,
        componentItemId,
        component.quantity,
        component.uom,
        canonical.componentQuantityEntered,
        canonical.componentUomEntered,
        canonical.componentQuantityCanonical,
        canonical.componentUomCanonical,
        canonical.componentUomDimension,
        component.note
      ]
    );
    insertedCount += 1;
  }
  return insertedCount;
}

async function assertSeedInvariants(
  client: PoolClient,
  args: { tenantId: string; warehouseCodes: string[]; seedMovementId?: string; expectedLotCount?: number }
): Promise<void> {
  const missingWarehouses = await client.query<{ code: string }>(
    `SELECT expected.code
       FROM unnest($2::text[]) AS expected(code)
       LEFT JOIN locations l
         ON l.tenant_id = $1
        AND l.code = expected.code
        AND l.type = 'warehouse'
        AND l.parent_location_id IS NULL
      WHERE l.id IS NULL`,
    [args.tenantId, args.warehouseCodes]
  );
  if ((missingWarehouses.rowCount ?? 0) > 0) {
    throw new Error(
      `SEED_INVARIANT_WAREHOUSE_ROOTS_MISSING missing=${missingWarehouses.rows
        .map((row) => row.code)
        .join(',')}`
    );
  }

  const missingDefaults = await client.query<{ warehouse_code: string; role: string }>(
    `WITH required AS (
       SELECT warehouse.code AS warehouse_code, role.role
         FROM unnest($2::text[]) AS warehouse(code)
         CROSS JOIN unnest($3::text[]) AS role(role)
     ),
     mapped AS (
       SELECT w.code AS warehouse_code, wdl.role
         FROM warehouse_default_location wdl
         JOIN locations w
           ON w.id = wdl.warehouse_id
          AND w.tenant_id = wdl.tenant_id
        WHERE wdl.tenant_id = $1
     )
     SELECT required.warehouse_code, required.role
       FROM required
       LEFT JOIN mapped
         ON mapped.warehouse_code = required.warehouse_code
        AND mapped.role = required.role
      WHERE mapped.warehouse_code IS NULL`,
    [args.tenantId, args.warehouseCodes, [...REQUIRED_ROLES]]
  );
  if ((missingDefaults.rowCount ?? 0) > 0) {
    throw new Error(
      `SEED_INVARIANT_DEFAULTS_MISSING missing=${missingDefaults.rows
        .map((row) => `${row.warehouse_code}:${row.role}`)
        .join(',')}`
    );
  }

  const selfReferencingBoms = await client.query<{ bom_code: string; output_item_id: string; component_item_id: string }>(
    `SELECT b.bom_code, b.output_item_id, bvl.component_item_id
       FROM boms b
       JOIN bom_versions bv
         ON bv.bom_id = b.id
        AND bv.tenant_id = b.tenant_id
        AND bv.status = 'active'
       JOIN bom_version_lines bvl
         ON bvl.bom_version_id = bv.id
        AND bvl.tenant_id = bv.tenant_id
      WHERE b.tenant_id = $1
        AND b.output_item_id = bvl.component_item_id
      LIMIT 1`,
    [args.tenantId]
  );
  if ((selfReferencingBoms.rowCount ?? 0) > 0) {
    const row = selfReferencingBoms.rows[0];
    throw new Error(
      `SEED_INVARIANT_BOM_SELF_REFERENCE bom_code=${row.bom_code} output_item_id=${row.output_item_id} component_item_id=${row.component_item_id}`
    );
  }

  if (args.seedMovementId) {
    const costLayerIntegrity = await client.query<{ movement_line_count: string; cost_layer_count: string; non_positive_remaining_layers: string }>(
      `WITH movement_lines AS (
         SELECT id
           FROM inventory_movement_lines
          WHERE tenant_id = $1
            AND movement_id = $2
       ),
       movement_layers AS (
         SELECT id, remaining_quantity
           FROM inventory_cost_layers
          WHERE tenant_id = $1
            AND source_type = 'opening_balance'
            AND movement_id = $2
            AND voided_at IS NULL
       ),
       non_positive_remaining AS (
         SELECT id
           FROM movement_layers
          WHERE remaining_quantity <= 0
       )
       SELECT
         (SELECT COUNT(*)::int::text FROM movement_lines) AS movement_line_count,
         (SELECT COUNT(*)::int::text FROM movement_layers) AS cost_layer_count,
         (SELECT COUNT(*)::int::text FROM non_positive_remaining) AS non_positive_remaining_layers`,
      [args.tenantId, args.seedMovementId]
    );
    const movementLineCount = Number(costLayerIntegrity.rows[0]?.movement_line_count ?? 0);
    const costLayerCount = Number(costLayerIntegrity.rows[0]?.cost_layer_count ?? 0);
    const nonPositiveRemainingLayerCount = Number(costLayerIntegrity.rows[0]?.non_positive_remaining_layers ?? 0);
    if (movementLineCount !== costLayerCount || nonPositiveRemainingLayerCount !== 0) {
      throw new Error(
        `SEED_INVARIANT_COST_LAYER_INTEGRITY movement_lines=${movementLineCount} cost_layers=${costLayerCount} non_positive_remaining_layers=${nonPositiveRemainingLayerCount}`
      );
    }

    const lotIntegrity = await client.query<{ lot_required_lines: string; lot_linked_lines: string; lots_count: string }>(
      `WITH seed_lines AS (
         SELECT iml.id, iml.item_id
           FROM inventory_movement_lines iml
          WHERE iml.tenant_id = $1
            AND iml.movement_id = $2
       ),
       lot_required AS (
         SELECT sl.id
           FROM seed_lines sl
           JOIN items i
             ON i.id = sl.item_id
            AND i.tenant_id = $1
          WHERE i.requires_lot = true
       ),
       lot_linked AS (
         SELECT DISTINCT iml_lot.inventory_movement_line_id AS id
           FROM inventory_movement_lots iml_lot
           JOIN seed_lines sl
             ON sl.id = iml_lot.inventory_movement_line_id
          WHERE iml_lot.tenant_id = $1
       )
       SELECT
         (SELECT COUNT(*)::int::text FROM lot_required) AS lot_required_lines,
         (SELECT COUNT(*)::int::text FROM lot_linked) AS lot_linked_lines,
         (SELECT COUNT(*)::int::text
            FROM lots
           WHERE tenant_id = $1
             AND item_id IN (SELECT item_id FROM seed_lines)) AS lots_count`,
      [args.tenantId, args.seedMovementId]
    );
    const lotRequiredLines = Number(lotIntegrity.rows[0]?.lot_required_lines ?? 0);
    const lotLinkedLines = Number(lotIntegrity.rows[0]?.lot_linked_lines ?? 0);
    const lotCount = Number(lotIntegrity.rows[0]?.lots_count ?? 0);
    if (lotRequiredLines !== lotLinkedLines) {
      throw new Error(
        `SEED_INVARIANT_LOT_LINKS_MISSING lot_required_lines=${lotRequiredLines} lot_linked_lines=${lotLinkedLines}`
      );
    }
    if (typeof args.expectedLotCount === 'number' && lotCount < args.expectedLotCount) {
      throw new Error(`SEED_INVARIANT_LOT_COUNT_MISMATCH expected_min=${args.expectedLotCount} actual=${lotCount}`);
    }
  }
}

function toCanonicalItems(items: ImportedItem[]): CanonicalItem[] {
  return items
    .map((item) => ({
      ...item,
      type: inferCanonicalItemType(item)
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

export async function runSiamayaFactoryPack(client: PoolClient, options: SiamayaPackOptions = {}): Promise<SeedSummary> {
  const pack = options.pack ?? DEFAULT_OPTIONS.pack;
  const tenantSlug = normalizeTenantSlug(options.tenantSlug ?? DEFAULT_OPTIONS.tenantSlug);
  const tenantName = normalizeWhitespace(options.tenantName ?? DEFAULT_OPTIONS.tenantName);
  const adminEmail = normalizeEmail(options.adminEmail ?? DEFAULT_OPTIONS.adminEmail);
  const adminPassword = options.adminPassword ?? DEFAULT_OPTIONS.adminPassword;
  const warehouseSpecs = options.warehouses ?? DEFAULT_OPTIONS.warehouses;
  const bomFilePath = options.bomFilePath ?? DEFAULT_BOM_JSON_PATH;
  const initialStockSpec = loadInitialStockSpec(options.initialStockSpecPath ?? DEFAULT_INITIAL_STOCK_SPEC_PATH);

  const bomDataset = options.datasetOverride
    ? {
        sourcePath: 'dataset:override',
        sourceKind: 'json' as const,
        sheetName: options.bomSheetName ?? 'override',
        rowCount: options.datasetOverride.boms.length,
        items: options.datasetOverride.items,
        boms: options.datasetOverride.boms,
        unknownUoms: options.datasetOverride.unknownUoms ?? []
      }
    : await importBomDatasetFromFile({
        filePath: bomFilePath,
        sheetName: options.bomSheetName
      });
  if (bomDataset.boms.length === 0) {
    throw new Error(`SEED_BOM_EMPTY source=${bomDataset.sourcePath}`);
  }

  const canonicalItems = toCanonicalItems(bomDataset.items);
  const canonicalBoms = bomDataset.boms;
  const { id: tenantId } = await upsertTenant(client, tenantSlug, tenantName);

  let warehousesCreated = 0;
  let locationsCreated = 0;
  const seededWarehouseCodes: string[] = [];
  const seededLocationCodes: string[] = [];
  let factoryWarehouseId: string | null = null;

  for (const warehouse of warehouseSpecs) {
    const warehouseCode = normalizeWhitespace(warehouse.code).toUpperCase();
    const warehouseName = normalizeWhitespace(warehouse.name);
    const warehouseRow = await upsertWarehouseRoot(client, {
      tenantId,
      code: warehouseCode,
      name: warehouseName
    });
    seededWarehouseCodes.push(warehouseCode);
    if (warehouseRow.created) warehousesCreated += 1;
    if (warehouseCode === 'FACTORY') {
      factoryWarehouseId = warehouseRow.id;
    }

    for (const role of REQUIRED_ROLES) {
      const roleLocation = await upsertWarehouseRoleLocation(client, {
        tenantId,
        warehouseId: warehouseRow.id,
        warehouseCode,
        role
      });
      seededLocationCodes.push(roleLocation.code);
      if (roleLocation.created) locationsCreated += 1;
      await upsertWarehouseDefault(client, {
        tenantId,
        warehouseId: warehouseRow.id,
        role,
        locationId: roleLocation.id
      });
    }
  }

  if (!factoryWarehouseId) {
    throw new Error('SEED_FACTORY_WAREHOUSE_REQUIRED');
  }

  for (const locationSpec of FACTORY_OPERATIONAL_LOCATIONS) {
    const location = await upsertOperationalLocation(client, {
      tenantId,
      warehouseId: factoryWarehouseId,
      code: locationSpec.code,
      localCode: locationSpec.localCode,
      name: locationSpec.name
    });
    seededLocationCodes.push(location.code);
    if (location.created) locationsCreated += 1;
  }

  await upsertAdminUser(client, {
    tenantId,
    email: adminEmail,
    password: adminPassword
  });

  const itemIdByKey = await upsertItems(client, {
    tenantId,
    tenantSlug,
    items: canonicalItems
  });
  const uomConversionsUpserted = await upsertSeedUomConversions(client, {
    tenantId,
    items: canonicalItems,
    itemIdByKey
  });

  const seededStock = await seedInitialStockMovement(client, {
    pack,
    tenantId,
    tenantSlug,
    itemIdByKey,
    spec: initialStockSpec,
    strictMissingItems: !options.datasetOverride && (!options.bomFilePath || path.resolve(options.bomFilePath) === DEFAULT_BOM_JSON_PATH)
  });

  let bomLinesUpserted = 0;
  for (const bom of canonicalBoms) {
    const outputItemId = itemIdByKey.get(bom.outputKey);
    if (!outputItemId) {
      throw new Error(`SEED_BOM_OUTPUT_ITEM_MISSING key=${bom.outputKey}`);
    }
    const { versionId } = await upsertBomAndVersion(client, {
      tenantId,
      tenantSlug,
      bom,
      outputItemId
    });
    bomLinesUpserted += await replaceBomVersionLines(client, {
      tenantId,
      versionId,
      bom,
      itemIdByKey
    });
  }

  await assertSeedInvariants(
    client,
    seededStock.movementId
      ? {
          tenantId,
          warehouseCodes: seededWarehouseCodes,
          seedMovementId: seededStock.movementId,
          expectedLotCount: seededStock.expectedLotCount
        }
      : {
          tenantId,
          warehouseCodes: seededWarehouseCodes
        }
  );

  const checksum = buildChecksum({
    tenantSlug,
    warehouseCodes: seededWarehouseCodes,
    locationCodes: seededLocationCodes,
    userEmail: adminEmail,
    items: canonicalItems,
    boms: canonicalBoms,
    initialStock: initialStockSpec
  });

  return {
    pack,
    tenant: tenantSlug,
    receiptMode: 'none',
    warehousesCreated,
    locationsCreated,
    usersUpserted: 1,
    itemsUpserted: canonicalItems.length,
    bomsUpserted: canonicalBoms.length,
    bomVersionsUpserted: canonicalBoms.length,
    bomLinesUpserted,
    uomConversionsUpserted,
    purchaseOrdersCreated: 0,
    purchaseOrdersReused: 0,
    purchaseOrderLinesCreated: 0,
    purchaseOrderLinesReused: 0,
    receiptsAttempted: 0,
    receiptsCreated: 0,
    receiptsReplayed: 0,
    receiptLinesAttempted: 0,
    lineClosuresAttempted: 0,
    lineClosuresApplied: 0,
    lineClosuresReplayed: 0,
    receiptMovementsCreated: 0,
    costLayersCreatedEstimate: 0,
    unknownUoms: [...bomDataset.unknownUoms].sort((left, right) => left.localeCompare(right)),
    checksum
  };
}

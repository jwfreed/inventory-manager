import { createHash } from 'node:crypto';
import { v5 as uuidv5 } from 'uuid';
import type { PoolClient } from 'pg';
import bcrypt from 'bcryptjs';
import {
  importBomDatasetFromFile,
  type ImportedBom,
  type ImportedItem
} from '../siamaya/import_bom_from_xlsx';

const ID_NAMESPACE = '85fc700f-6f58-4d79-a7db-7af0951374fd';
const REQUIRED_ROLES = ['SELLABLE', 'QA', 'HOLD'] as const;

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
  type: 'finished' | 'raw';
};

type CanonicalBom = ImportedBom;

type TenantRow = { id: string };
type LocationRow = { id: string; code: string };
type UserRow = { id: string; email: string };
type ItemRow = { id: string; name: string };
type BomRow = { id: string };
type BomVersionRow = { id: string };

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

  const digest = createHash('sha256').update(lines.join('\n')).digest('hex');
  return `sha256:${digest}`;
}

function inferCanonicalItemType(item: ImportedItem): 'finished' | 'raw' {
  return item.appearsAsOutput ? 'finished' : 'raw';
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
                active = true,
                lifecycle_status = 'Active',
                updated_at = now()
          WHERE id = $8
            AND tenant_id = $9`,
        [
          item.name,
          'Seeded by siamaya_factory',
          item.type,
          canonical.defaultUom,
          canonical.uomDimension,
          canonical.canonicalUom,
          canonical.stockingUom,
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
        canonical.stockingUom
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
  args: { tenantId: string; warehouseCodes: string[] }
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
        filePath: options.bomFilePath,
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

  await assertSeedInvariants(client, { tenantId, warehouseCodes: seededWarehouseCodes });

  const checksum = buildChecksum({
    tenantSlug,
    warehouseCodes: seededWarehouseCodes,
    locationCodes: seededLocationCodes,
    userEmail: adminEmail,
    items: canonicalItems,
    boms: canonicalBoms
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

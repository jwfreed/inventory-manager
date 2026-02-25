import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { SeedHttpClient } from '../httpClient';

const RAW_LAYER_SPECS = [
  { layerIndex: 1, quantity: 10, unitCost: 100.0, receivedAt: '2026-01-10T00:00:00.000Z' },
  { layerIndex: 2, quantity: 20, unitCost: 110.0, receivedAt: '2026-01-20T00:00:00.000Z' },
  { layerIndex: 3, quantity: 15, unitCost: 105.0, receivedAt: '2026-02-05T00:00:00.000Z' }
] as const;

const PACK_LAYER_SPECS = [
  { layerIndex: 1, quantity: 1000, unitCost: 0.05, receivedAt: '2026-01-12T00:00:00.000Z' },
  { layerIndex: 2, quantity: 1500, unitCost: 0.06, receivedAt: '2026-02-02T00:00:00.000Z' }
] as const;

const FACTORY_CODE = 'FACTORY';
const SEED_VENDOR_NAME = 'Seed Vendor Siamaya Factory';
const PARTIAL_SHORTFALL_BY_CATEGORY: Record<SeedItemCategory, number> = {
  raw: 5,
  pack: 100
};

type SeedItemCategory = 'raw' | 'pack';

export type SeedReceiptMode = 'clean' | 'partial_then_close_short' | 'partial_with_discrepancy';

type SelectedItem = {
  itemId: string;
  itemNormKey: string;
  itemName: string;
  uom: string;
  category: SeedItemCategory;
  receivedToLocationId: string;
};

type PurchaseOrderLineSnapshot = {
  id: string;
  itemId: string;
  uom: string;
  quantityOrdered: number;
  status: string;
};

type PurchaseOrderSnapshot = {
  id: string;
  status: string;
  vendorReference: string | null;
  lines: PurchaseOrderLineSnapshot[];
};

type ReceiptLinePlan = {
  idempotencyKey: string;
  externalRef: string;
  quantity: number;
  unitCost: number;
  receivedAt: string;
  includeDiscrepancyReason: boolean;
};

type LineClosePlan = {
  idempotencyKey: string;
  closeAs: 'short';
  reason: string;
  notes?: string;
};

type PurchaseOrderPlan = {
  vendorReference: string;
  poNumber: string;
  item: SelectedItem;
  quantityOrdered: number;
  orderDate: string;
  expectedDate: string;
  receiptLines: ReceiptLinePlan[];
  lineClose?: LineClosePlan;
};

export type SeedReceiptsOptions = {
  pool: Pool;
  pack: string;
  tenantSlug: string;
  receiptMode: SeedReceiptMode;
  apiBaseUrl: string;
  adminEmail: string;
  adminPassword: string;
};

export type SeedReceiptsResult = {
  receiptMode: SeedReceiptMode;
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
  checksumLines: string[];
};

type ReceiptArtifactCounts = {
  receipts: number;
  movements: number;
  costLayers: number;
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeItemKey(value: string): string {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeUom(value: string | null | undefined): string {
  return normalizeWhitespace(String(value ?? '')).toLowerCase();
}

function toStableNumber(value: number): string {
  const fixed = value.toFixed(12);
  return fixed.replace(/\.?0+$/, '');
}

function toCurrency(value: number): string {
  return value.toFixed(2);
}

function toDateOnly(value: string): string {
  return value.slice(0, 10);
}

function buildPoNumber(tenantSlug: string, vendorReference: string): string {
  const compact = tenantSlug
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 18);
  const hash = createHash('sha256').update(`${tenantSlug}:${vendorReference}`).digest('hex').slice(0, 16).toUpperCase();
  return `SEED-${compact || 'SIAMAYA'}-${hash}`.slice(0, 64);
}

function buildVendorCode(tenantSlug: string): string {
  const compact = tenantSlug
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 42);
  return `SEED-${compact || 'SIAMAYA'}-FACTORY`.slice(0, 64);
}

function buildReceiptKey(
  pack: string,
  tenantSlug: string,
  itemNormKey: string,
  layerIndex: number,
  mode: SeedReceiptMode
): string {
  const cleanBase = `seed:${pack}:receipt:${tenantSlug}:FACTORY:${itemNormKey}:${layerIndex}`;
  const modeSuffix =
    mode === 'clean'
      ? ''
      : mode === 'partial_then_close_short'
        ? ':partial-close-short'
        : ':partial';
  const base = `${cleanBase}${modeSuffix}`;
  if (base.length <= 255) {
    return base;
  }

  const hash = createHash('sha256').update(base).digest('hex').slice(0, 12);
  const suffix =
    mode === 'clean'
      ? `:${layerIndex}:${hash}`
      : mode === 'partial_then_close_short'
        ? `:${layerIndex}:partial-close-short:${hash}`
        : `:${layerIndex}:partial:${hash}`;
  const prefix = `seed:${pack}:receipt:${tenantSlug}:FACTORY:`;
  const maxKeyLen = 255 - prefix.length - suffix.length;
  const truncatedKey = itemNormKey.slice(0, Math.max(8, maxKeyLen));
  return `${prefix}${truncatedKey}${suffix}`;
}

function buildPoVendorReference(
  pack: string,
  itemNormKey: string,
  layerIndexOrPartial: number | 'partial',
  mode: SeedReceiptMode
): string {
  if (mode === 'partial_with_discrepancy') {
    return `seed:${pack}:po:FACTORY:${itemNormKey}:partial`;
  }
  if (mode === 'partial_then_close_short') {
    return `seed:${pack}:po:FACTORY:${itemNormKey}:partial-close-short`;
  }
  return `seed:${pack}:po:FACTORY:${itemNormKey}:${layerIndexOrPartial}`;
}

function buildLineCloseKey(pack: string, tenantSlug: string, itemNormKey: string, mode: SeedReceiptMode): string {
  const base = `seed:${pack}:po-line-close:${tenantSlug}:FACTORY:${itemNormKey}:${mode}`;
  if (base.length <= 255) {
    return base;
  }
  const hash = createHash('sha256').update(base).digest('hex').slice(0, 12);
  const prefix = `seed:${pack}:po-line-close:${tenantSlug}:FACTORY:`;
  const suffix = `:${mode}:${hash}`;
  const maxKeyLen = 255 - prefix.length - suffix.length;
  return `${prefix}${itemNormKey.slice(0, Math.max(8, maxKeyLen))}${suffix}`;
}

async function resolveTenantId(client: PoolClient, tenantSlug: string): Promise<string> {
  const result = await client.query<{ id: string }>('SELECT id FROM tenants WHERE slug = $1', [tenantSlug]);
  if ((result.rowCount ?? 0) === 0) {
    throw new Error(`SEED_RECEIPTS_TENANT_NOT_FOUND slug=${tenantSlug}`);
  }
  return result.rows[0].id;
}

async function findLocationByCode(client: PoolClient, tenantId: string, code: string): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `SELECT id
       FROM locations
      WHERE tenant_id = $1
        AND code = $2
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
    [tenantId, code]
  );
  if ((result.rowCount ?? 0) === 0) {
    return null;
  }
  return result.rows[0].id;
}

async function resolveFirstLocation(
  client: PoolClient,
  tenantId: string,
  codes: string[],
  errorCode: string
): Promise<string> {
  for (const code of codes) {
    const id = await findLocationByCode(client, tenantId, code);
    if (id) return id;
  }
  throw new Error(`${errorCode} tried=${codes.join(',')}`);
}

async function selectItemsForReceipts(
  client: PoolClient,
  tenantId: string,
  rawLocationId: string,
  packLocationId: string
): Promise<{ rawItems: SelectedItem[]; packItems: SelectedItem[] }> {
  const result = await client.query<{ id: string; name: string; default_uom: string | null }>(
    `SELECT id, name, default_uom
       FROM items
      WHERE tenant_id = $1
      ORDER BY lower(regexp_replace(trim(name), '\\s+', ' ', 'g')) ASC, id ASC`,
    [tenantId]
  );

  const rawCandidates: SelectedItem[] = [];
  const packCandidates: SelectedItem[] = [];
  const seenNormKeys = new Set<string>();

  for (const row of result.rows) {
    const uom = normalizeUom(row.default_uom);
    const itemNormKey = normalizeItemKey(row.name);
    if (!itemNormKey || seenNormKeys.has(itemNormKey)) {
      continue;
    }
    seenNormKeys.add(itemNormKey);

    if (uom === 'kg' || uom === 'g') {
      rawCandidates.push({
        itemId: row.id,
        itemNormKey,
        itemName: row.name,
        uom,
        category: 'raw',
        receivedToLocationId: rawLocationId
      });
      continue;
    }

    if (uom === 'piece' || uom === 'each') {
      packCandidates.push({
        itemId: row.id,
        itemNormKey,
        itemName: row.name,
        uom,
        category: 'pack',
        receivedToLocationId: packLocationId
      });
    }
  }

  const rawItems = rawCandidates.slice(0, 10);
  const packItems = packCandidates.slice(0, 5);
  if (rawItems.length === 0) {
    throw new Error('SEED_RECEIPTS_NO_RAW_ITEMS');
  }

  return { rawItems, packItems };
}

async function ensureVendor(httpClient: SeedHttpClient, vendorCode: string): Promise<{ id: string; created: boolean }> {
  const listResponse = await httpClient.get<{ data?: Array<{ id: string; code: string }> }>(
    '/vendors?active=true',
    { allowStatuses: [200] }
  );
  const existing = (listResponse.data?.data ?? []).find((vendor) => vendor.code === vendorCode);
  if (existing?.id) {
    return { id: existing.id, created: false };
  }

  const createResponse = await httpClient.post<{ id?: string }>('/vendors', {
    allowStatuses: [201, 409],
    body: {
      code: vendorCode,
      name: SEED_VENDOR_NAME
    }
  });
  if (createResponse.status === 201 && typeof createResponse.data?.id === 'string') {
    return { id: createResponse.data.id, created: true };
  }

  const refresh = await httpClient.get<{ data?: Array<{ id: string; code: string }> }>('/vendors?active=true', {
    allowStatuses: [200]
  });
  const vendor = (refresh.data?.data ?? []).find((entry) => entry.code === vendorCode);
  if (!vendor?.id) {
    throw new Error(`SEED_RECEIPTS_VENDOR_RESOLUTION_FAILED code=${vendorCode}`);
  }
  return { id: vendor.id, created: false };
}

async function findPurchaseOrderByExternalRef(
  httpClient: SeedHttpClient,
  externalRef: string
): Promise<{ id: string; vendorReference: string | null; status: string } | null> {
  const limit = 100;
  let offset = 0;
  const matches: Array<{ id: string; vendorReference: string | null; status: string }> = [];

  while (offset <= 5000) {
    const response = await httpClient.get<{ data?: Array<{ id: string; vendorReference?: string | null; status: string }> }>(
      `/purchase-orders?limit=${limit}&offset=${offset}`,
      { allowStatuses: [200] }
    );
    const rows = response.data?.data ?? [];
    for (const row of rows) {
      if ((row.vendorReference ?? null) === externalRef) {
        matches.push({
          id: row.id,
          vendorReference: row.vendorReference ?? null,
          status: row.status
        });
      }
    }
    if (rows.length < limit) {
      break;
    }
    offset += limit;
  }

  if (matches.length > 1) {
    throw new Error(
      `SEED_RECEIPTS_PO_EXTERNAL_REF_AMBIGUOUS externalRef=${externalRef} ids=${matches.map((row) => row.id).join(',')}`
    );
  }

  return matches[0] ?? null;
}

function mapPurchaseOrderSnapshot(data: unknown): PurchaseOrderSnapshot {
  const row = data as {
    id?: string;
    status?: string;
    vendorReference?: string | null;
    lines?: Array<{ id?: string; itemId?: string; uom?: string; quantityOrdered?: number; status?: string }>;
  };
  return {
    id: String(row.id ?? ''),
    status: String(row.status ?? ''),
    vendorReference: row.vendorReference ?? null,
    lines: Array.isArray(row.lines)
      ? row.lines.map((line) => ({
          id: String(line.id ?? ''),
        itemId: String(line.itemId ?? ''),
        uom: normalizeUom(line.uom),
        quantityOrdered: Number(line.quantityOrdered ?? 0),
        status: String(line.status ?? 'open')
      }))
      : []
  };
}

async function fetchPurchaseOrder(httpClient: SeedHttpClient, id: string): Promise<PurchaseOrderSnapshot> {
  const response = await httpClient.get(`/purchase-orders/${id}`, { allowStatuses: [200] });
  return mapPurchaseOrderSnapshot(response.data);
}

function assertPurchaseOrderMatchesPlan(
  purchaseOrder: PurchaseOrderSnapshot,
  plan: PurchaseOrderPlan
): { lineId: string; lineStatus: string } {
  if (purchaseOrder.vendorReference !== plan.vendorReference) {
    throw new Error(
      `SEED_RECEIPTS_PO_REFERENCE_MISMATCH expected=${plan.vendorReference} actual=${purchaseOrder.vendorReference ?? ''}`
    );
  }

  const line = purchaseOrder.lines.find((entry) => entry.itemId === plan.item.itemId);
  if (!line) {
    throw new Error(`SEED_RECEIPTS_PO_LINE_MISSING itemId=${plan.item.itemId} vendorReference=${plan.vendorReference}`);
  }
  if (line.uom !== plan.item.uom) {
    throw new Error(
      `SEED_RECEIPTS_PO_LINE_UOM_MISMATCH itemId=${plan.item.itemId} expected=${plan.item.uom} actual=${line.uom}`
    );
  }
  if (Math.abs(line.quantityOrdered - plan.quantityOrdered) > 1e-6) {
    throw new Error(
      `SEED_RECEIPTS_PO_LINE_QTY_MISMATCH itemId=${plan.item.itemId} expected=${plan.quantityOrdered} actual=${line.quantityOrdered}`
    );
  }
  return {
    lineId: line.id,
    lineStatus: String(line.status ?? 'open')
  };
}

async function ensurePurchaseOrderForPlan(
  httpClient: SeedHttpClient,
  args: {
    vendorId: string;
    shipToLocationId: string;
    receivingLocationId: string;
    plan: PurchaseOrderPlan;
    notes: string;
  }
): Promise<{ purchaseOrderId: string; purchaseOrderLineId: string; purchaseOrderLineStatus: string; created: boolean }> {
  const existing = await findPurchaseOrderByExternalRef(httpClient, args.plan.vendorReference);
  if (existing?.id) {
    const purchaseOrder = await fetchPurchaseOrder(httpClient, existing.id);
    const line = assertPurchaseOrderMatchesPlan(purchaseOrder, args.plan);
    return {
      purchaseOrderId: purchaseOrder.id,
      purchaseOrderLineId: line.lineId,
      purchaseOrderLineStatus: line.lineStatus,
      created: false
    };
  }

  const createResponse = await httpClient.post('/purchase-orders', {
    allowStatuses: [201, 409],
    body: {
      poNumber: args.plan.poNumber,
      vendorId: args.vendorId,
      status: 'approved',
      orderDate: args.plan.orderDate,
      expectedDate: args.plan.expectedDate,
      shipToLocationId: args.shipToLocationId,
      receivingLocationId: args.receivingLocationId,
      vendorReference: args.plan.vendorReference,
      notes: args.notes,
      lines: [
        {
          lineNumber: 1,
          itemId: args.plan.item.itemId,
          uom: args.plan.item.uom,
          quantityOrdered: args.plan.quantityOrdered
        }
      ]
    }
  });

  if (createResponse.status === 201) {
    const purchaseOrder = mapPurchaseOrderSnapshot(createResponse.data);
    const line = assertPurchaseOrderMatchesPlan(purchaseOrder, args.plan);
    return {
      purchaseOrderId: purchaseOrder.id,
      purchaseOrderLineId: line.lineId,
      purchaseOrderLineStatus: line.lineStatus,
      created: true
    };
  }

  const retryExisting = await findPurchaseOrderByExternalRef(httpClient, args.plan.vendorReference);
  if (!retryExisting?.id) {
    throw new Error(`SEED_RECEIPTS_PO_CREATE_CONFLICT vendorReference=${args.plan.vendorReference}`);
  }
  const purchaseOrder = await fetchPurchaseOrder(httpClient, retryExisting.id);
  const line = assertPurchaseOrderMatchesPlan(purchaseOrder, args.plan);
  return {
    purchaseOrderId: purchaseOrder.id,
    purchaseOrderLineId: line.lineId,
    purchaseOrderLineStatus: line.lineStatus,
    created: false
  };
}

function buildPurchaseOrderPlans(
  pack: string,
  tenantSlug: string,
  mode: SeedReceiptMode,
  rawItems: SelectedItem[],
  packItems: SelectedItem[]
): PurchaseOrderPlan[] {
  const plans: PurchaseOrderPlan[] = [];
  const byCategory = [
    { items: rawItems, layers: RAW_LAYER_SPECS },
    { items: packItems, layers: PACK_LAYER_SPECS }
  ] as const;

  for (const group of byCategory) {
    for (const item of group.items) {
      if (mode === 'clean') {
        for (const layer of group.layers) {
          const vendorReference = buildPoVendorReference(pack, item.itemNormKey, layer.layerIndex, mode);
          plans.push({
            vendorReference,
            poNumber: buildPoNumber(tenantSlug, vendorReference),
            item,
            quantityOrdered: layer.quantity,
            orderDate: toDateOnly(layer.receivedAt),
            expectedDate: toDateOnly(layer.receivedAt),
            receiptLines: [
              {
                idempotencyKey: buildReceiptKey(pack, tenantSlug, item.itemNormKey, layer.layerIndex, mode),
                externalRef: buildReceiptKey(pack, tenantSlug, item.itemNormKey, layer.layerIndex, mode),
                quantity: layer.quantity,
                unitCost: layer.unitCost,
                receivedAt: layer.receivedAt,
                includeDiscrepancyReason: false
              }
            ]
          });
        }
        continue;
      }

      const totalLayerQty = group.layers.reduce((sum, layer) => sum + layer.quantity, 0);
      const quantityOrdered =
        mode === 'partial_then_close_short'
          ? totalLayerQty + PARTIAL_SHORTFALL_BY_CATEGORY[item.category]
          : totalLayerQty;
      const vendorReference = buildPoVendorReference(pack, item.itemNormKey, 'partial', mode);
      const lineClosePlan =
        mode === 'partial_then_close_short'
          ? {
              idempotencyKey: buildLineCloseKey(pack, tenantSlug, item.itemNormKey, mode),
              closeAs: 'short' as const,
              reason: 'seed_partial_close_short',
              notes: `seed pack ${pack}`
            }
          : undefined;
      plans.push({
        vendorReference,
        poNumber: buildPoNumber(tenantSlug, vendorReference),
        item,
        quantityOrdered,
        orderDate: '2026-01-01',
        expectedDate: '2026-02-10',
        receiptLines: group.layers.map((layer) => ({
          idempotencyKey: buildReceiptKey(pack, tenantSlug, item.itemNormKey, layer.layerIndex, mode),
          externalRef: buildReceiptKey(pack, tenantSlug, item.itemNormKey, layer.layerIndex, mode),
          quantity: layer.quantity,
          unitCost: layer.unitCost,
          receivedAt: layer.receivedAt,
          includeDiscrepancyReason: mode === 'partial_with_discrepancy'
        })),
        lineClose: lineClosePlan
      });
    }
  }

  return plans.sort((left, right) => left.vendorReference.localeCompare(right.vendorReference));
}

async function countReceiptArtifacts(
  client: PoolClient,
  tenantId: string,
  idempotencyKeys: string[]
): Promise<ReceiptArtifactCounts> {
  if (idempotencyKeys.length === 0) {
    return { receipts: 0, movements: 0, costLayers: 0 };
  }

  const receiptRes = await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM purchase_order_receipts
      WHERE tenant_id = $1
        AND idempotency_key = ANY($2::text[])`,
    [tenantId, idempotencyKeys]
  );

  const movementRes = await client.query<{ count: number }>(
    `SELECT COUNT(DISTINCT por.inventory_movement_id)::int AS count
       FROM purchase_order_receipts por
      WHERE por.tenant_id = $1
        AND por.idempotency_key = ANY($2::text[])
        AND por.inventory_movement_id IS NOT NULL`,
    [tenantId, idempotencyKeys]
  );

  const costLayerRes = await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM inventory_cost_layers icl
      WHERE icl.tenant_id = $1
        AND icl.source_type = 'receipt'
        AND icl.source_document_id IN (
          SELECT porl.id
            FROM purchase_order_receipt_lines porl
            JOIN purchase_order_receipts por
              ON por.id = porl.purchase_order_receipt_id
             AND por.tenant_id = porl.tenant_id
           WHERE por.tenant_id = $1
             AND por.idempotency_key = ANY($2::text[])
        )`,
    [tenantId, idempotencyKeys]
  );

  return {
    receipts: Number(receiptRes.rows[0]?.count ?? 0),
    movements: Number(movementRes.rows[0]?.count ?? 0),
    costLayers: Number(costLayerRes.rows[0]?.count ?? 0)
  };
}

async function assertRawLayerDepth(
  client: PoolClient,
  tenantId: string,
  factoryWarehouseId: string,
  rawItemIds: string[],
  idempotencyKeys: string[]
): Promise<void> {
  const result = await client.query<{ max_layers: number | null }>(
    `WITH seeded_receipts AS (
       SELECT id
         FROM purchase_order_receipts
        WHERE tenant_id = $1
          AND idempotency_key = ANY($4::text[])
     ),
     item_layers AS (
       SELECT pol.item_id, COUNT(*)::int AS layer_count
         FROM seeded_receipts sr
         JOIN purchase_order_receipt_lines porl
           ON porl.purchase_order_receipt_id = sr.id
          AND porl.tenant_id = $1
         JOIN purchase_order_lines pol
           ON pol.id = porl.purchase_order_line_id
          AND pol.tenant_id = porl.tenant_id
         JOIN inventory_cost_layers icl
           ON icl.source_document_id = porl.id
          AND icl.tenant_id = porl.tenant_id
          AND icl.source_type = 'receipt'
         JOIN locations loc
           ON loc.id = icl.location_id
          AND loc.tenant_id = icl.tenant_id
        WHERE pol.item_id = ANY($3::uuid[])
          AND loc.warehouse_id = $2
        GROUP BY pol.item_id
     )
     SELECT COALESCE(MAX(layer_count), 0)::int AS max_layers
       FROM item_layers`,
    [tenantId, factoryWarehouseId, rawItemIds, idempotencyKeys]
  );

  const maxLayers = Number(result.rows[0]?.max_layers ?? 0);
  if (maxLayers < 3) {
    throw new Error(`SEED_RECEIPTS_LAYER_DEPTH_INSUFFICIENT maxLayers=${maxLayers}`);
  }
}

async function assertFactoryWarehouseIsolation(
  client: PoolClient,
  tenantId: string,
  factoryWarehouseId: string,
  idempotencyKeys: string[]
): Promise<void> {
  const bad = await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM purchase_order_receipts por
       JOIN inventory_movement_lines iml
         ON iml.tenant_id = por.tenant_id
        AND iml.movement_id = por.inventory_movement_id
       JOIN locations loc
         ON loc.tenant_id = iml.tenant_id
        AND loc.id = iml.location_id
      WHERE por.tenant_id = $1
        AND por.idempotency_key = ANY($2::text[])
        AND loc.warehouse_id IS DISTINCT FROM $3`,
    [tenantId, idempotencyKeys, factoryWarehouseId]
  );
  if (Number(bad.rows[0]?.count ?? 0) > 0) {
    throw new Error('SEED_RECEIPTS_WAREHOUSE_ISOLATION_VIOLATION');
  }
}

function buildChecksumLines(args: {
  mode: SeedReceiptMode;
  tenantSlug: string;
  pack: string;
  plans: PurchaseOrderPlan[];
}): string[] {
  const lines: string[] = [];
  lines.push(`receipt_scope:${args.tenantSlug}|${args.pack}|${FACTORY_CODE}`);
  lines.push(`receipt_mode:${args.mode}`);

  for (const plan of [...args.plans].sort((left, right) => left.vendorReference.localeCompare(right.vendorReference))) {
    lines.push(`po:${plan.vendorReference}|${plan.poNumber}`);
    lines.push(
      `po_line:${plan.vendorReference}|${plan.item.itemNormKey}|${toStableNumber(plan.quantityOrdered)}|${plan.item.uom}`
    );
    for (const receipt of [...plan.receiptLines].sort((left, right) => left.idempotencyKey.localeCompare(right.idempotencyKey))) {
      lines.push(
        `receipt:${receipt.idempotencyKey}|${toStableNumber(receipt.quantity)}|${plan.item.uom}|${toCurrency(receipt.unitCost)}|${receipt.receivedAt}`
      );
    }
    if (plan.lineClose) {
      lines.push(
        `line_close:${plan.lineClose.idempotencyKey}|${plan.lineClose.closeAs}|${plan.lineClose.reason}`
      );
    }
  }

  return lines;
}

export async function seedPurchaseOrdersAndReceiptsViaApi(options: SeedReceiptsOptions): Promise<SeedReceiptsResult> {
  const client = await options.pool.connect();
  try {
    const tenantId = await resolveTenantId(client, options.tenantSlug);
    const factoryWarehouseId = await resolveFirstLocation(client, tenantId, [FACTORY_CODE], 'SEED_RECEIPTS_FACTORY_MISSING');
    const sellableLocationId = await resolveFirstLocation(
      client,
      tenantId,
      ['FACTORY_SELLABLE', FACTORY_CODE],
      'SEED_RECEIPTS_SELLABLE_MISSING'
    );
    const rawLocationId = await resolveFirstLocation(
      client,
      tenantId,
      ['FACTORY_RAW', 'FACTORY_SELLABLE', 'FACTORY_QA', FACTORY_CODE],
      'SEED_RECEIPTS_RAW_LOCATION_MISSING'
    );
    const packLocationId = await resolveFirstLocation(
      client,
      tenantId,
      ['FACTORY_PACK', 'FACTORY_SELLABLE', FACTORY_CODE],
      'SEED_RECEIPTS_PACK_LOCATION_MISSING'
    );

    const { rawItems, packItems } = await selectItemsForReceipts(client, tenantId, rawLocationId, packLocationId);
    const plans = buildPurchaseOrderPlans(options.pack, options.tenantSlug, options.receiptMode, rawItems, packItems);

    const httpClient = new SeedHttpClient({ baseUrl: options.apiBaseUrl });
    await httpClient.login(options.adminEmail, options.adminPassword, options.tenantSlug);

    const vendor = await ensureVendor(httpClient, buildVendorCode(options.tenantSlug));
    const receiptKeys = plans.flatMap((plan) => plan.receiptLines.map((line) => line.idempotencyKey));
    const beforeArtifacts = await countReceiptArtifacts(client, tenantId, receiptKeys);

    let purchaseOrdersCreated = 0;
    let purchaseOrdersReused = 0;
    let purchaseOrderLinesCreated = 0;
    let purchaseOrderLinesReused = 0;
    let receiptsCreated = 0;
    let receiptsReplayed = 0;
    let receiptLinesAttempted = 0;
    let lineClosuresAttempted = 0;
    let lineClosuresApplied = 0;
    let lineClosuresReplayed = 0;

    for (const plan of plans) {
      const ensured = await ensurePurchaseOrderForPlan(httpClient, {
        vendorId: vendor.id,
        shipToLocationId: factoryWarehouseId,
        receivingLocationId: sellableLocationId,
        plan,
        notes: `seed pack ${options.pack}`
      });

      if (ensured.created) {
        purchaseOrdersCreated += 1;
        purchaseOrderLinesCreated += 1;
      } else {
        purchaseOrdersReused += 1;
        purchaseOrderLinesReused += 1;
      }

      for (const receiptLine of plan.receiptLines) {
        receiptLinesAttempted += 1;
        const linePayload: Record<string, unknown> = {
          purchaseOrderLineId: ensured.purchaseOrderLineId,
          uom: plan.item.uom,
          quantityReceived: receiptLine.quantity,
          unitCost: receiptLine.unitCost
        };
        if (receiptLine.includeDiscrepancyReason) {
          linePayload.discrepancyReason = 'short';
          linePayload.discrepancyNotes = `seed split receipt ${receiptLine.idempotencyKey}`;
        }

        const response = await httpClient.post('/purchase-order-receipts', {
          allowStatuses: [200, 201],
          headers: {
            'Idempotency-Key': receiptLine.idempotencyKey
          },
          body: {
            purchaseOrderId: ensured.purchaseOrderId,
            receivedAt: receiptLine.receivedAt,
            receivedToLocationId: plan.item.receivedToLocationId,
            externalRef: receiptLine.externalRef,
            notes: `seed pack ${options.pack}`,
            idempotencyKey: receiptLine.idempotencyKey,
            lines: [linePayload]
          }
        });

        if (response.status === 201) {
          receiptsCreated += 1;
        } else {
          receiptsReplayed += 1;
        }
      }

      if (plan.lineClose) {
        lineClosuresAttempted += 1;
        const lineBeforeStatus = String(ensured.purchaseOrderLineStatus ?? 'open');
        const closeResponse = await httpClient.post<{ line?: { status?: string } }>(
          `/purchase-order-lines/${ensured.purchaseOrderLineId}/close`,
          {
          allowStatuses: [200],
          headers: {
            'Idempotency-Key': plan.lineClose.idempotencyKey
          },
          body: {
            closeAs: plan.lineClose.closeAs,
            reason: plan.lineClose.reason,
            notes: plan.lineClose.notes,
            idempotencyKey: plan.lineClose.idempotencyKey
          }
          }
        );

        const resultLineStatus = String(closeResponse.data?.line?.status ?? lineBeforeStatus);
        if (resultLineStatus !== 'closed_short') {
          throw new Error(`SEED_RECEIPTS_LINE_CLOSE_FAILED lineId=${ensured.purchaseOrderLineId} status=${resultLineStatus}`);
        }
        if (lineBeforeStatus === 'open') {
          lineClosuresApplied += 1;
        } else {
          lineClosuresReplayed += 1;
        }
      }
    }

    const afterArtifacts = await countReceiptArtifacts(client, tenantId, receiptKeys);
    const receiptMovementsCreated = Math.max(afterArtifacts.movements - beforeArtifacts.movements, 0);
    const costLayersCreatedEstimate = Math.max(afterArtifacts.costLayers - beforeArtifacts.costLayers, 0);

    if (receiptsCreated > 0 && receiptMovementsCreated === 0) {
      throw new Error('SEED_RECEIPTS_MOVEMENTS_NOT_CREATED');
    }

    await assertRawLayerDepth(
      client,
      tenantId,
      factoryWarehouseId,
      rawItems.map((item) => item.itemId),
      receiptKeys
    );
    await assertFactoryWarehouseIsolation(client, tenantId, factoryWarehouseId, receiptKeys);

    return {
      receiptMode: options.receiptMode,
      purchaseOrdersCreated,
      purchaseOrdersReused,
      purchaseOrderLinesCreated,
      purchaseOrderLinesReused,
      receiptsAttempted: receiptKeys.length,
      receiptsCreated,
      receiptsReplayed,
      receiptLinesAttempted,
      lineClosuresAttempted,
      lineClosuresApplied,
      lineClosuresReplayed,
      receiptMovementsCreated,
      costLayersCreatedEstimate,
      checksumLines: buildChecksumLines({
        mode: options.receiptMode,
        tenantSlug: options.tenantSlug,
        pack: options.pack,
        plans
      })
    };
  } finally {
    client.release();
  }
}

import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { query } from '../db';
import { parseCsv, normalizeHeader } from '../lib/csv';
import { createItem, createLocation } from './masterData.service';
import { getUserBaseCurrency } from './users.service';
import { convertToCanonical } from './uomCanonical.service';
import { createInventoryCount, postInventoryCount } from './counts.service';
import { recordAuditLog } from '../lib/audit';
import { ItemLifecycleStatus } from '../types/item';

export type ImportType = 'items' | 'locations' | 'on_hand';

export type ImportJobRow = {
  rowNumber: number;
  status: 'valid' | 'error' | 'applied' | 'skipped' | 'pending';
  raw: Record<string, string>;
  normalized?: Record<string, unknown>;
  errorCode?: string | null;
  errorDetail?: string | null;
};

export type ImportJobSummary = {
  id: string;
  tenantId: string;
  type: ImportType;
  status: string;
  fileName: string | null;
  totalRows: number;
  validRows: number;
  errorRows: number;
  mapping: Record<string, string> | null;
  countedAt: string | null;
  errorSummary: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

const MAX_ROWS = Number(process.env.IMPORT_MAX_ROWS ?? 50000);
const MAX_BYTES = Number(process.env.IMPORT_MAX_BYTES ?? 10 * 1024 * 1024);

const IMPORT_FIELDS: Record<ImportType, { required: string[]; optional: string[] }> = {
  items: {
    required: ['sku', 'name', 'uomDimension', 'canonicalUom', 'stockingUom'],
    optional: [
      'description',
      'type',
      'lifecycleStatus',
      'defaultUom',
      'defaultLocationCode',
      'requiresLot',
      'requiresSerial',
      'requiresQc',
      'standardCost',
      'standardCostCurrency',
      'listPrice',
      'priceCurrency',
      'isPhantom'
    ]
  },
  locations: {
    required: ['code', 'name', 'type'],
    optional: ['active', 'parentLocationCode', 'zone', 'maxWeight', 'maxVolume']
  },
  on_hand: {
    required: ['sku', 'locationCode', 'uom', 'quantity'],
    optional: []
  }
};

const ITEM_TYPES = new Set(['raw', 'wip', 'finished', 'packaging']);
const LOCATION_TYPES = new Set(['warehouse', 'bin', 'store', 'customer', 'vendor', 'scrap', 'virtual']);
const UOM_DIMENSIONS = new Set(['mass', 'volume', 'count', 'length', 'area', 'time']);
const LIFECYCLE_VALUES = new Map<string, ItemLifecycleStatus>([
  ['active', ItemLifecycleStatus.ACTIVE],
  ['in-development', ItemLifecycleStatus.IN_DEVELOPMENT],
  ['indev', ItemLifecycleStatus.IN_DEVELOPMENT],
  ['obsolete', ItemLifecycleStatus.OBSOLETE],
  ['phase-out', ItemLifecycleStatus.PHASE_OUT],
  ['phaseout', ItemLifecycleStatus.PHASE_OUT]
]);

const HEADER_SYNONYMS: Record<string, string[]> = {
  sku: ['sku', 'itemsku', 'item'],
  name: ['name', 'itemname', 'descriptionname'],
  uomDimension: ['uomdimension', 'dimension'],
  canonicalUom: ['canonicaluom', 'canonicaluomcode'],
  stockingUom: ['stockinguom', 'stockuom'],
  description: ['description', 'desc'],
  type: ['type', 'itemtype'],
  lifecycleStatus: ['lifecyclestatus', 'status'],
  defaultUom: ['defaultuom', 'uom'],
  defaultLocationCode: ['defaultlocation', 'defaultlocationcode'],
  requiresLot: ['requireslot', 'lotrequired'],
  requiresSerial: ['requiressrl', 'requiressrial', 'requiressserial', 'requiressn', 'serialrequired', 'requireserial'],
  requiresQc: ['requiresqc', 'qcrequired'],
  standardCost: ['standardcost', 'cost'],
  standardCostCurrency: ['standardcostcurrency', 'costcurrency'],
  listPrice: ['listprice', 'price'],
  priceCurrency: ['pricecurrency'],
  isPhantom: ['isphantom', 'phantom'],
  code: ['code', 'locationcode'],
  parentLocationCode: ['parentlocation', 'parentlocationcode'],
  locationCode: ['location', 'locationcode'],
  uom: ['uom', 'unit', 'unitofmeasure'],
  quantity: ['qty', 'quantity', 'onhand', 'onhandqty']
};

const FORBIDDEN_HEADERS = ['lot', 'lotnumber', 'serial', 'serialnumber', 'lot_id', 'serial_id'];

function mapHeaders(headers: string[]) {
  const normalized = headers.map((header) => normalizeHeader(header));
  return new Map<string, string>(normalized.map((key, idx) => [key, headers[idx]]));
}

function suggestMapping(headers: string[], fields: string[]) {
  const headerMap = mapHeaders(headers);
  const mapping: Record<string, string> = {};

  fields.forEach((field) => {
    const synonyms = HEADER_SYNONYMS[field] ?? [field];
    for (const candidate of synonyms) {
      const header = headerMap.get(normalizeHeader(candidate));
      if (header) {
        mapping[field] = header;
        break;
      }
    }
  });

  return mapping;
}

function parseBoolean(value?: string) {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (['true', 'yes', '1', 'y'].includes(normalized)) return true;
  if (['false', 'no', '0', 'n'].includes(normalized)) return false;
  return null;
}

function parseNumber(value?: string): number | null {
  if (value == null || value.trim() === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeLifecycleStatus(value?: string) {
  if (!value) return ItemLifecycleStatus.ACTIVE;
  const key = value.trim().toLowerCase();
  return LIFECYCLE_VALUES.get(key) ?? ItemLifecycleStatus.ACTIVE;
}

function pickValue(raw: Record<string, string>, header?: string) {
  if (!header) return undefined;
  return raw[header]?.trim() ?? '';
}

export async function createImportJobFromUpload(params: {
  tenantId: string;
  userId: string;
  type: ImportType;
  fileName?: string | null;
  csvText: string;
}) {
  const byteLength = Buffer.byteLength(params.csvText, 'utf8');
  if (byteLength > MAX_BYTES) {
    throw new Error('IMPORT_FILE_TOO_LARGE');
  }

  const { headers, rows, truncated } = parseCsv(params.csvText, MAX_ROWS + 1);
  if (headers.length === 0) {
    throw new Error('IMPORT_NO_HEADERS');
  }
  if (truncated || rows.length > MAX_ROWS) {
    throw new Error('IMPORT_ROW_LIMIT');
  }

  const normalizedHeaders = headers.map(normalizeHeader);
  const forbidden = normalizedHeaders.find((header) => FORBIDDEN_HEADERS.includes(header));
  if (params.type === 'on_hand' && forbidden) {
    throw new Error('IMPORT_FORBIDDEN_COLUMN');
  }

  const mapping = suggestMapping(headers, [
    ...IMPORT_FIELDS[params.type].required,
    ...IMPORT_FIELDS[params.type].optional
  ]);

  const id = uuidv4();
  const now = new Date();
  await query(
    `INSERT INTO import_jobs (
        id, tenant_id, type, status, file_name, source_csv, total_rows, created_by, created_at, updated_at
     ) VALUES ($1,$2,$3,'uploaded',$4,$5,$6,$7,$8,$8)`,
    [id, params.tenantId, params.type, params.fileName ?? null, params.csvText, rows.length, params.userId, now]
  );

  const sampleRows = rows.slice(0, 20).map((row) =>
    headers.reduce<Record<string, string>>((acc, header, idx) => {
      acc[header] = row[idx] ?? '';
      return acc;
    }, {})
  );

  return {
    jobId: id,
    headers,
    sampleRows,
    suggestedMapping: mapping,
    totalRows: rows.length
  };
}

export async function getImportJob(tenantId: string, id: string): Promise<ImportJobSummary | null> {
  const res = await query(
    `SELECT id, tenant_id, type, status, file_name, total_rows, valid_rows, error_rows,
            mapping, counted_at, error_summary, created_by, created_at, updated_at, started_at, finished_at
       FROM import_jobs
      WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  );
  if (res.rowCount === 0) return null;
  const row = res.rows[0];
  return {
    id: row.id,
    tenantId: row.tenant_id,
    type: row.type,
    status: row.status,
    fileName: row.file_name,
    totalRows: Number(row.total_rows),
    validRows: Number(row.valid_rows),
    errorRows: Number(row.error_rows),
    mapping: row.mapping ?? null,
    countedAt: row.counted_at ?? null,
    errorSummary: row.error_summary ?? null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  };
}

export async function validateImportJob(params: {
  tenantId: string;
  userId: string;
  jobId: string;
  mapping: Record<string, string>;
  countedAt?: string | null;
}) {
  const jobRes = await query(
    `SELECT id, tenant_id, type, source_csv, status
       FROM import_jobs
      WHERE id = $1 AND tenant_id = $2`,
    [params.jobId, params.tenantId]
  );
  if (jobRes.rowCount === 0) {
    throw new Error('IMPORT_JOB_NOT_FOUND');
  }
  const job = jobRes.rows[0];
  if (!job.source_csv) {
    throw new Error('IMPORT_MISSING_SOURCE');
  }

  const { headers, rows, truncated } = parseCsv(job.source_csv as string, MAX_ROWS + 1);
  if (truncated || rows.length > MAX_ROWS) {
    throw new Error('IMPORT_ROW_LIMIT');
  }

  const headerSet = new Set(headers);
  Object.entries(params.mapping).forEach(([field, header]) => {
    if (!header) return;
    if (!headerSet.has(header)) {
      throw new Error(`IMPORT_MAPPING_INVALID:${field}`);
    }
  });

  const normalizedHeaders = headers.map(normalizeHeader);
  const forbidden = normalizedHeaders.find((header) => FORBIDDEN_HEADERS.includes(header));
  if (job.type === 'on_hand' && forbidden) {
    throw new Error('IMPORT_FORBIDDEN_COLUMN');
  }

  const requiredFields = IMPORT_FIELDS[job.type].required;
  for (const field of requiredFields) {
    if (!params.mapping[field]) {
      throw new Error(`IMPORT_MAPPING_MISSING:${field}`);
    }
  }

  const dataRows = rows.map((row) =>
    headers.reduce<Record<string, string>>((acc, header, idx) => {
      acc[header] = row[idx] ?? '';
      return acc;
    }, {})
  );

  const existingItemSkus = new Set<string>();
  const existingLocationCodes = new Set<string>();
  if (job.type === 'items' || job.type === 'on_hand') {
    const itemsRes = await query('SELECT sku, id, canonical_uom FROM items WHERE tenant_id = $1', [params.tenantId]);
    itemsRes.rows.forEach((row: any) => existingItemSkus.add(row.sku.trim().toLowerCase()));
  }
  if (job.type === 'locations' || job.type === 'on_hand' || params.mapping.defaultLocationCode) {
    const locRes = await query('SELECT code FROM locations WHERE tenant_id = $1', [params.tenantId]);
    locRes.rows.forEach((row: any) => existingLocationCodes.add(row.code.trim().toLowerCase()));
  }

  await query('DELETE FROM import_job_rows WHERE job_id = $1 AND tenant_id = $2', [params.jobId, params.tenantId]);

  let validRows = 0;
  let errorRows = 0;
  const errorSamples: ImportJobRow[] = [];

  const skuSeen = new Set<string>();
  const locationSeen = new Set<string>();
  const onHandKeys = new Set<string>();

  for (let idx = 0; idx < dataRows.length; idx += 1) {
    const rowNumber = idx + 2; // header line is 1
    const raw = dataRows[idx];
    let status: ImportJobRow['status'] = 'valid';
    let errorCode: string | null = null;
    let errorDetail: string | null = null;
    let normalized: Record<string, unknown> | null = null;

    try {
      if (job.type === 'items') {
        const sku = pickValue(raw, params.mapping.sku);
        const name = pickValue(raw, params.mapping.name);
        const uomDimension = pickValue(raw, params.mapping.uomDimension);
        const canonicalUom = pickValue(raw, params.mapping.canonicalUom);
        const stockingUom = pickValue(raw, params.mapping.stockingUom);
        if (!sku || !name || !uomDimension || !canonicalUom || !stockingUom) {
          throw new Error('IMPORT_REQUIRED_FIELDS');
        }
        if (!UOM_DIMENSIONS.has(uomDimension.toLowerCase())) {
          throw new Error('IMPORT_INVALID_UOM_DIMENSION');
        }
        const skuKey = sku.toLowerCase();
        if (skuSeen.has(skuKey) || existingItemSkus.has(skuKey)) {
          throw new Error('IMPORT_DUPLICATE_SKU');
        }
        skuSeen.add(skuKey);

        const lifecycleStatus = normalizeLifecycleStatus(pickValue(raw, params.mapping.lifecycleStatus));
        const type = (pickValue(raw, params.mapping.type) || 'raw').toLowerCase();
        if (!ITEM_TYPES.has(type)) {
          throw new Error('IMPORT_INVALID_ITEM_TYPE');
        }
        const defaultLocationCode = pickValue(raw, params.mapping.defaultLocationCode);
        if (defaultLocationCode && !existingLocationCodes.has(defaultLocationCode.toLowerCase())) {
          throw new Error('IMPORT_UNKNOWN_LOCATION');
        }

        normalized = {
          sku,
          name,
          description: pickValue(raw, params.mapping.description) || null,
          lifecycleStatus,
          type,
          defaultUom: pickValue(raw, params.mapping.defaultUom) || null,
          uomDimension: uomDimension.toLowerCase(),
          canonicalUom,
          stockingUom,
          defaultLocationCode: defaultLocationCode || null,
          requiresLot: parseBoolean(pickValue(raw, params.mapping.requiresLot)) ?? false,
          requiresSerial: parseBoolean(pickValue(raw, params.mapping.requiresSerial)) ?? false,
          requiresQc: parseBoolean(pickValue(raw, params.mapping.requiresQc)) ?? false,
          standardCost: parseNumber(pickValue(raw, params.mapping.standardCost)) ?? null,
          standardCostCurrency: pickValue(raw, params.mapping.standardCostCurrency) || null,
          listPrice: parseNumber(pickValue(raw, params.mapping.listPrice)) ?? null,
          priceCurrency: pickValue(raw, params.mapping.priceCurrency) || null,
          isPhantom: parseBoolean(pickValue(raw, params.mapping.isPhantom)) ?? false
        };
      }

      if (job.type === 'locations') {
        const code = pickValue(raw, params.mapping.code);
        const name = pickValue(raw, params.mapping.name);
        const type = pickValue(raw, params.mapping.type);
        if (!code || !name || !type) {
          throw new Error('IMPORT_REQUIRED_FIELDS');
        }
        if (!LOCATION_TYPES.has(type.toLowerCase())) {
          throw new Error('IMPORT_INVALID_LOCATION_TYPE');
        }
        const codeKey = code.toLowerCase();
        if (locationSeen.has(codeKey) || existingLocationCodes.has(codeKey)) {
          throw new Error('IMPORT_DUPLICATE_LOCATION');
        }
        locationSeen.add(codeKey);

        const parentLocationCode = pickValue(raw, params.mapping.parentLocationCode);
        if (parentLocationCode && !existingLocationCodes.has(parentLocationCode.toLowerCase())) {
          throw new Error('IMPORT_UNKNOWN_LOCATION');
        }

        normalized = {
          code,
          name,
          type: type.toLowerCase(),
          active: parseBoolean(pickValue(raw, params.mapping.active)) ?? true,
          parentLocationCode: parentLocationCode || null,
          zone: pickValue(raw, params.mapping.zone) || null,
          maxWeight: parseNumber(pickValue(raw, params.mapping.maxWeight)) ?? null,
          maxVolume: parseNumber(pickValue(raw, params.mapping.maxVolume)) ?? null
        };
      }

      if (job.type === 'on_hand') {
        const sku = pickValue(raw, params.mapping.sku);
        const locationCode = pickValue(raw, params.mapping.locationCode);
        const uom = pickValue(raw, params.mapping.uom);
        const quantityRaw = pickValue(raw, params.mapping.quantity);
        const quantity = parseNumber(quantityRaw ?? '') ?? null;
        if (!sku || !locationCode || !uom || quantity === null) {
          throw new Error('IMPORT_REQUIRED_FIELDS');
        }
        if (quantity < 0) {
          throw new Error('IMPORT_NEGATIVE_QUANTITY');
        }
        const skuKey = sku.toLowerCase();
        if (!existingItemSkus.has(skuKey)) {
          throw new Error('IMPORT_UNKNOWN_ITEM');
        }
        const locationKey = locationCode.toLowerCase();
        if (!existingLocationCodes.has(locationKey)) {
          throw new Error('IMPORT_UNKNOWN_LOCATION');
        }
        const compositeKey = `${skuKey}:${locationKey}:${uom.toLowerCase()}`;
        if (onHandKeys.has(compositeKey)) {
          throw new Error('IMPORT_DUPLICATE_ON_HAND');
        }
        onHandKeys.add(compositeKey);

        normalized = {
          sku,
          locationCode,
          uom,
          quantity
        };
      }
    } catch (err: any) {
      if (err instanceof Error && err.message === 'IMPORT_DUPLICATE_SKU') {
        status = 'skipped';
        errorCode = 'IMPORT_DUPLICATE_SKU';
        errorDetail = 'SKU already exists.';
      } else {
        status = 'error';
        errorCode = err instanceof Error ? err.message : 'IMPORT_INVALID_ROW';
        errorDetail = err instanceof Error ? err.message : 'Invalid row.';
      }
    }

    if (status === 'valid') {
      validRows += 1;
    } else if (status === 'error') {
      errorRows += 1;
      if (errorSamples.length < 50) {
        errorSamples.push({ rowNumber, status, raw, errorCode, errorDetail });
      }
    }

    await query(
      `INSERT INTO import_job_rows (
          id, tenant_id, job_id, row_number, raw, normalized, status, error_code, error_detail
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        uuidv4(),
        params.tenantId,
        params.jobId,
        rowNumber,
        raw,
        normalized,
        status,
        errorCode,
        errorDetail
      ]
    );
  }

  const status = errorRows > 0 ? 'validated' : 'validated';
  await query(
    `UPDATE import_jobs
        SET status = $1,
            mapping = $2,
            total_rows = $3,
            valid_rows = $4,
            error_rows = $5,
            counted_at = $6,
            updated_at = now()
      WHERE id = $7 AND tenant_id = $8`,
    [status, params.mapping, dataRows.length, validRows, errorRows, params.countedAt ?? null, params.jobId, params.tenantId]
  );

  return {
    totalRows: dataRows.length,
    validRows,
    errorRows,
    errorSamples
  };
}

export async function applyImportJob(params: {
  tenantId: string;
  userId: string;
  jobId: string;
}) {
  const job = await getImportJob(params.tenantId, params.jobId);
  if (!job) {
    throw new Error('IMPORT_JOB_NOT_FOUND');
  }
  if (job.errorRows > 0) {
    throw new Error('IMPORT_HAS_ERRORS');
  }

  await query(
    `UPDATE import_jobs SET status = 'queued', started_at = now(), updated_at = now()
     WHERE id = $1 AND tenant_id = $2`,
    [params.jobId, params.tenantId]
  );

  void processImportJob(params.jobId, params.tenantId, params.userId);

  return await getImportJob(params.tenantId, params.jobId);
}

async function processImportJob(jobId: string, tenantId: string, userId: string) {
  await query(
    `UPDATE import_jobs SET status = 'processing', updated_at = now() WHERE id = $1 AND tenant_id = $2`,
    [jobId, tenantId]
  );

  try {
    const jobRes = await query(
      `SELECT id, type, mapping, counted_at
         FROM import_jobs
        WHERE id = $1 AND tenant_id = $2`,
      [jobId, tenantId]
    );
    if (jobRes.rowCount === 0) {
      throw new Error('IMPORT_JOB_NOT_FOUND');
    }
    const job = jobRes.rows[0];

    const rowsRes = await query(
      `SELECT id, row_number, normalized, status
         FROM import_job_rows
        WHERE job_id = $1 AND tenant_id = $2 AND status = 'valid'
        ORDER BY row_number ASC`,
      [jobId, tenantId]
    );

    if (job.type === 'items') {
      const baseCurrency = await getUserBaseCurrency(userId);
      for (const row of rowsRes.rows) {
        const normalized = row.normalized as Record<string, any>;
        const defaultLocationCode = normalized.defaultLocationCode as string | null;
        let defaultLocationId: string | null = null;
        if (defaultLocationCode) {
          const locationRes = await query(
            'SELECT id FROM locations WHERE tenant_id = $1 AND code = $2',
            [tenantId, defaultLocationCode]
          );
          defaultLocationId = locationRes.rows[0]?.id ?? null;
        }

        await createItem(tenantId, {
          sku: normalized.sku,
          name: normalized.name,
          description: normalized.description ?? undefined,
          lifecycleStatus: normalized.lifecycleStatus,
          type: normalized.type,
          isPhantom: normalized.isPhantom,
          defaultUom: normalized.defaultUom ?? undefined,
          uomDimension: normalized.uomDimension,
          canonicalUom: normalized.canonicalUom,
          stockingUom: normalized.stockingUom,
          defaultLocationId,
          requiresLot: normalized.requiresLot,
          requiresSerial: normalized.requiresSerial,
          requiresQc: normalized.requiresQc,
          standardCost: normalized.standardCost ?? undefined,
          standardCostCurrency: normalized.standardCostCurrency ?? undefined,
          listPrice: normalized.listPrice ?? undefined,
          priceCurrency: normalized.priceCurrency ?? undefined
        }, baseCurrency);

        await query(
          `UPDATE import_job_rows SET status = 'applied' WHERE id = $1 AND tenant_id = $2`,
          [row.id, tenantId]
        );
      }
    }

    if (job.type === 'locations') {
      for (const row of rowsRes.rows) {
        const normalized = row.normalized as Record<string, any>;
        let parentLocationId: string | null = null;
        if (normalized.parentLocationCode) {
          const locationRes = await query(
            'SELECT id FROM locations WHERE tenant_id = $1 AND code = $2',
            [tenantId, normalized.parentLocationCode]
          );
          parentLocationId = locationRes.rows[0]?.id ?? null;
        }
        await createLocation(tenantId, {
          code: normalized.code,
          name: normalized.name,
          type: normalized.type,
          active: normalized.active,
          parentLocationId,
          zone: normalized.zone ?? undefined,
          maxWeight: normalized.maxWeight ?? undefined,
          maxVolume: normalized.maxVolume ?? undefined
        });
        await query(
          `UPDATE import_job_rows SET status = 'applied' WHERE id = $1 AND tenant_id = $2`,
          [row.id, tenantId]
        );
      }
    }

    if (job.type === 'on_hand') {
      const itemsRes = await query(
        'SELECT id, sku FROM items WHERE tenant_id = $1',
        [tenantId]
      );
      const itemMap = new Map<string, string>(
        itemsRes.rows.map((row: any) => [row.sku.trim().toLowerCase(), row.id])
      );
      const locationsRes = await query(
        'SELECT id, code FROM locations WHERE tenant_id = $1',
        [tenantId]
      );
      const locationMap = new Map<string, string>(
        locationsRes.rows.map((row: any) => [row.code.trim().toLowerCase(), row.id])
      );

      const byLocation = new Map<string, any[]>();

      for (const row of rowsRes.rows) {
        const normalized = row.normalized as Record<string, any>;
        const itemId = itemMap.get(String(normalized.sku).trim().toLowerCase());
        const locationId = locationMap.get(String(normalized.locationCode).trim().toLowerCase());
        if (!itemId || !locationId) {
          throw new Error('IMPORT_REFERENCE_MISSING');
        }
        const canonical = await convertToCanonical(tenantId, itemId, normalized.quantity, normalized.uom);
        const lines = byLocation.get(locationId) ?? [];
        lines.push({
          itemId,
          uom: canonical.canonicalUom,
          countedQuantity: canonical.quantity,
          reasonCode: 'import_snapshot'
        });
        byLocation.set(locationId, lines);
      }

      for (const [locationId, lines] of byLocation.entries()) {
        const count = await createInventoryCount(
          tenantId,
          {
            countedAt: job.counted_at ?? new Date().toISOString(),
            locationId,
            notes: `Imported on-hand snapshot (${jobId})`,
            lines
          },
          { idempotencyKey: `import:${jobId}:${locationId}` }
        );
        await postInventoryCount(tenantId, count.id, {
          actor: { type: 'user', id: userId, role: 'admin' }
        });
      }

      await query(
        `UPDATE import_job_rows SET status = 'applied' WHERE job_id = $1 AND tenant_id = $2 AND status = 'valid'`,
        [jobId, tenantId]
      );
    }

    await recordAuditLog({
      tenantId,
      actorType: 'user',
      actorId: userId,
      action: 'import',
      entityType: 'import_job',
      entityId: jobId,
      occurredAt: new Date(),
      metadata: { type: job.type }
    });

    await query(
      `UPDATE import_jobs
          SET status = 'completed', finished_at = now(), updated_at = now()
        WHERE id = $1 AND tenant_id = $2`,
      [jobId, tenantId]
    );
  } catch (error: any) {
    await query(
      `UPDATE import_jobs
          SET status = 'failed', error_summary = $3, finished_at = now(), updated_at = now()
        WHERE id = $1 AND tenant_id = $2`,
      [jobId, tenantId, error instanceof Error ? error.message : 'Import failed']
    );
  }
}

import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../db';
import { parseCsv, normalizeHeader } from '../lib/csv';
import { createItem, createLocation } from './masterData.service';
import { getUserBaseCurrency } from './users.service';
import { convertToCanonical } from './uomCanonical.service';
import { createInventoryCount, postInventoryCount } from './counts.service';
import { recordAuditLog } from '../lib/audit';
import { ItemLifecycleStatus } from '../types/item';
import { resolveWarehouseIdForLocation } from './warehouseDefaults.service';
import {
  assertTracedInventoryRequirements,
  TRACKED_INVENTORY_TRACE_ERROR
} from '../domains/inventory';

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
    optional: ['lotNumber', 'serialNumber']
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
  quantity: ['qty', 'quantity', 'onhand', 'onhandqty'],
  lotNumber: ['lot', 'lotnumber', 'lotcode', 'lotno'],
  serialNumber: ['serial', 'serialnumber', 'serialno', 'sn']
};

const FORBIDDEN_HEADERS = ['lot_id', 'serial_id'];
const IMPORT_SERIAL_UNIQUE_INDEX = 'idx_import_job_rows_tenant_sku_serial_normalized_unique';
const LOT_NORMALIZED_UNIQUE_INDEX = 'idx_lots_tenant_item_lot_code_normalized_unique';

function normalizeTraceKey(value: string) {
  return value.trim().toLowerCase();
}

function isConstraintViolation(error: unknown, constraintNames: string[]) {
  const candidate = error as { code?: string; constraint?: string } | null;
  return (
    candidate?.code === '23505'
    && !!candidate.constraint
    && constraintNames.includes(candidate.constraint)
  );
}

type ImportValidationFieldError = {
  rowNumber: number;
  sku: string | null;
  field: string;
  message: string;
};

type ImportValidationGroupedError = {
  sku: string;
  rowNumbers: number[];
  messages: string[];
  fieldErrors: Array<{
    rowNumber: number;
    field: string;
    message: string;
  }>;
};

class ImportRowValidationError extends Error {
  fieldErrors: ImportValidationFieldError[];

  constructor(message: string, fieldErrors: ImportValidationFieldError[]) {
    super(message);
    this.fieldErrors = fieldErrors;
  }
}

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

function buildOnHandImportTraceNote(normalized: Record<string, any>) {
  const lotNumber = String(normalized.lotNumber ?? '').trim();
  const serialNumber = String(normalized.serialNumber ?? '').trim();
  if (!lotNumber && !serialNumber) return null;
  return JSON.stringify({
    importTrace: {
      lotNumber: lotNumber || null,
      serialNumber: serialNumber || null
    }
  });
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
  const jobRes = await query<{
    id: string;
    tenant_id: string;
    type: ImportType;
    source_csv: string | null;
    status: string;
  }>(
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
  const itemBySku = new Map<string, {
    id: string;
    sku: string;
    canonicalUom: string;
    requiresLot: boolean;
    requiresSerial: boolean;
  }>();
  const existingLocationCodes = new Set<string>();
  if (job.type === 'items' || job.type === 'on_hand') {
    const itemsRes = await query(
      'SELECT sku, id, canonical_uom, requires_lot, requires_serial FROM items WHERE tenant_id = $1',
      [params.tenantId]
    );
    itemsRes.rows.forEach((row: any) => {
      const skuKey = row.sku.trim().toLowerCase();
      existingItemSkus.add(skuKey);
      itemBySku.set(skuKey, {
        id: row.id,
        sku: row.sku,
        canonicalUom: row.canonical_uom,
        requiresLot: !!row.requires_lot,
        requiresSerial: !!row.requires_serial
      });
    });
  }
  if (job.type === 'locations' || job.type === 'on_hand' || params.mapping.defaultLocationCode) {
    const locRes = await query('SELECT code FROM locations WHERE tenant_id = $1', [params.tenantId]);
    locRes.rows.forEach((row: any) => existingLocationCodes.add(row.code.trim().toLowerCase()));
  }

  // Preload existing lot/serial codes for serial-tracked items (system-level serial uniqueness)
  const existingSerialsByItemId = new Map<string, Set<string>>();
  if (job.type === 'on_hand') {
    const serialItemIds = Array.from(itemBySku.values())
      .filter((i) => i.requiresSerial)
      .map((i) => i.id);
    if (serialItemIds.length > 0) {
      const lotsRes = await query(
        `SELECT item_id, lot_code FROM lots WHERE tenant_id = $1 AND item_id = ANY($2)`,
        [params.tenantId, serialItemIds]
      );
      lotsRes.rows.forEach((row: any) => {
        const set = existingSerialsByItemId.get(row.item_id) ?? new Set<string>();
        set.add(row.lot_code.trim().toLowerCase());
        existingSerialsByItemId.set(row.item_id, set);
      });
    }
  }

  // Phase 1: validate all rows in memory — no writes until all rows are checked
  let validRows = 0;
  let errorRows = 0;
  let invalidTrackedRowsCount = 0;
  const errorSamples: ImportJobRow[] = [];
  const fieldErrors: ImportValidationFieldError[] = [];
  const errorsBySku = new Map<string, ImportValidationGroupedError>();

  const skuSeen = new Set<string>();
  const locationSeen = new Set<string>();
  const onHandKeys = new Set<string>();
  // Track intra-import serial uniqueness per item (regardless of location)
  const serialsSeen = new Map<string, Set<string>>();

  type PendingRowInsert = {
    id: string;
    rowNumber: number;
    raw: Record<string, string>;
    normalized: Record<string, unknown> | null;
    status: ImportJobRow['status'];
    errorCode: string | null;
    errorDetail: string | null;
    lotNumber: string | null;
    serialNumber: string | null;
  };
  const pendingRows: PendingRowInsert[] = [];

  for (let idx = 0; idx < dataRows.length; idx += 1) {
    const rowNumber = idx + 2; // header line is 1
    const raw = dataRows[idx];
    let status: ImportJobRow['status'] = 'valid';
    let errorCode: string | null = null;
    let errorDetail: string | null = null;
    let normalized: Record<string, unknown> | null = null;
    let rowFieldErrors: ImportValidationFieldError[] = [];
    let rowLotNumber: string | null = null;
    let rowSerialNumber: string | null = null;

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
        const skuKey = normalizeTraceKey(sku);
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
        const itemInfo = itemBySku.get(skuKey);
        if (!itemInfo) {
          throw new Error('IMPORT_UNKNOWN_ITEM');
        }
        const locationKey = normalizeTraceKey(locationCode);
        if (!existingLocationCodes.has(locationKey)) {
          throw new Error('IMPORT_UNKNOWN_LOCATION');
        }
        const lotNumber = pickValue(raw, params.mapping.lotNumber) || '';
        const serialNumber = pickValue(raw, params.mapping.serialNumber) || '';

        // Centralized invariant: trace data required for tracked items
        if (itemInfo.requiresLot && !lotNumber) {
          rowFieldErrors.push({
            rowNumber,
            sku,
            field: 'lotNumber',
            message: TRACKED_INVENTORY_TRACE_ERROR
          });
        }
        if (itemInfo.requiresSerial && !serialNumber) {
          rowFieldErrors.push({
            rowNumber,
            sku,
            field: 'serialNumber',
            message: TRACKED_INVENTORY_TRACE_ERROR
          });
        }
        if (rowFieldErrors.length > 0) {
          throw new ImportRowValidationError(TRACKED_INVENTORY_TRACE_ERROR, rowFieldErrors);
        }
        if (itemInfo.requiresSerial && quantity !== 1) {
          throw new Error('IMPORT_SERIAL_QUANTITY_MUST_BE_ONE');
        }

        // Serial uniqueness: check within this import
        if (itemInfo.requiresSerial && serialNumber) {
          const serialKey = normalizeTraceKey(serialNumber);
          const itemSerials = serialsSeen.get(itemInfo.id) ?? new Set<string>();
          if (itemSerials.has(serialKey)) {
            throw new Error('IMPORT_DUPLICATE_SERIAL');
          }
          // Serial uniqueness: check against existing system records
          const existingSystemSerials = existingSerialsByItemId.get(itemInfo.id);
          if (existingSystemSerials?.has(serialKey)) {
            throw new Error('IMPORT_SERIAL_ALREADY_EXISTS');
          }
          itemSerials.add(serialKey);
          serialsSeen.set(itemInfo.id, itemSerials);
        }

        const compositeKey = [
          skuKey,
          locationKey,
          normalizeTraceKey(uom),
          normalizeTraceKey(lotNumber),
          normalizeTraceKey(serialNumber)
        ].join(':');
        if (onHandKeys.has(compositeKey)) {
          throw new Error('IMPORT_DUPLICATE_ON_HAND');
        }
        onHandKeys.add(compositeKey);

        rowLotNumber = lotNumber || null;
        rowSerialNumber = serialNumber || null;
        normalized = {
          sku,
          locationCode,
          uom,
          quantity,
          lotNumber: lotNumber || null,
          serialNumber: serialNumber || null,
          requiresLot: itemInfo.requiresLot,
          requiresSerial: itemInfo.requiresSerial
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
        if (err instanceof ImportRowValidationError) {
          rowFieldErrors = err.fieldErrors;
        }
      }
    }

    if (status === 'valid') {
      validRows += 1;
    } else if (status === 'error') {
      errorRows += 1;
      if (rowFieldErrors.length > 0) {
        invalidTrackedRowsCount += 1;
        fieldErrors.push(...rowFieldErrors);
        const skuKey = rowFieldErrors[0]?.sku?.trim() || 'UNKNOWN';
        const grouped = errorsBySku.get(skuKey) ?? {
          sku: skuKey,
          rowNumbers: [],
          messages: [],
          fieldErrors: []
        };
        if (!grouped.rowNumbers.includes(rowNumber)) {
          grouped.rowNumbers.push(rowNumber);
        }
        if (!grouped.messages.includes(TRACKED_INVENTORY_TRACE_ERROR)) {
          grouped.messages.push(TRACKED_INVENTORY_TRACE_ERROR);
        }
        grouped.fieldErrors.push(
          ...rowFieldErrors.map((fieldError) => ({
            rowNumber: fieldError.rowNumber,
            field: fieldError.field,
            message: fieldError.message
          }))
        );
        errorsBySku.set(skuKey, grouped);
      }
      if (errorSamples.length < 50) {
        errorSamples.push({ rowNumber, status, raw, errorCode, errorDetail });
      }
    }

    pendingRows.push({
      id: uuidv4(),
      rowNumber,
      raw,
      normalized,
      status,
      errorCode,
      errorDetail,
      lotNumber: rowLotNumber,
      serialNumber: rowSerialNumber
    });
  }

  // Phase 2: atomic write — DELETE old rows + INSERT all new rows + UPDATE job status
  // No partial state is possible: either all rows are written or none.
  try {
    await withTransaction(async (client) => {
      await client.query(
        'DELETE FROM import_job_rows WHERE job_id = $1 AND tenant_id = $2',
        [params.jobId, params.tenantId]
      );

      for (const pending of pendingRows) {
        await client.query(
          `INSERT INTO import_job_rows (
              id, tenant_id, job_id, row_number, raw, normalized, status,
              error_code, error_detail, lot_number, serial_number
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            pending.id,
            params.tenantId,
            params.jobId,
            pending.rowNumber,
            pending.raw,
            pending.normalized,
            pending.status,
            pending.errorCode,
            pending.errorDetail,
            pending.lotNumber,
            pending.serialNumber
          ]
        );
      }

      await client.query(
        `UPDATE import_jobs
            SET status = 'validated',
                mapping = $1,
                total_rows = $2,
                valid_rows = $3,
                error_rows = $4,
                counted_at = $5,
                updated_at = now()
          WHERE id = $6 AND tenant_id = $7`,
        [
          params.mapping,
          dataRows.length,
          validRows,
          errorRows,
          params.countedAt ?? null,
          params.jobId,
          params.tenantId
        ]
      );
    });
  } catch (error) {
    if (isConstraintViolation(error, [IMPORT_SERIAL_UNIQUE_INDEX])) {
      throw new Error('IMPORT_DUPLICATE_SERIAL');
    }
    throw error;
  }

  return {
    totalRows: dataRows.length,
    validRows,
    errorRows,
    invalidTrackedRowsCount,
    errorsBySku: Array.from(errorsBySku.values()).sort((a, b) => a.sku.localeCompare(b.sku)),
    fieldErrors,
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
  if (['queued', 'processing', 'completed'].includes(job.status)) {
    return job;
  }
  if (job.status !== 'validated') {
    throw new Error('IMPORT_NOT_VALIDATED');
  }

  // Apply-time revalidation: recompute constraints from raw row data.
  // Do NOT rely on job.errorRows or job.status — stale or tampered jobs must not bypass validation.
  const revalidationRes = await query<{
    total_rows: string;
    error_rows: string;
    tracked_violation_rows: string;
  }>(
    `SELECT COUNT(*)                                              AS total_rows,
            COUNT(*) FILTER (WHERE status = 'error')             AS error_rows,
            COUNT(*) FILTER (
              WHERE (
                ((normalized->>'requiresLot')::boolean = true
                  AND COALESCE(TRIM(normalized->>'lotNumber'), '') = '')
                OR
                ((normalized->>'requiresSerial')::boolean = true
                  AND COALESCE(TRIM(normalized->>'serialNumber'), '') = '')
              )
            )                                                     AS tracked_violation_rows
       FROM import_job_rows
      WHERE job_id = $1 AND tenant_id = $2`,
    [params.jobId, params.tenantId]
  );
  const revalidatedTotalRows = Number(revalidationRes.rows[0]?.total_rows ?? 0);
  const revalidatedErrorRows = Number(revalidationRes.rows[0]?.error_rows ?? 0);
  // tracked_violation_rows is only meaningful for on_hand imports: items imports have
  // requiresLot in normalized (item configuration) but never have lotNumber, so the
  // FILTER would falsely match every lot-tracked item row for non-on_hand imports.
  const revalidatedTrackedViolations =
    job.type === 'on_hand'
      ? Number(revalidationRes.rows[0]?.tracked_violation_rows ?? 0)
      : 0;

  if (revalidatedTotalRows === 0) {
    throw new Error('IMPORT_NOT_VALIDATED');
  }
  if (revalidatedErrorRows > 0 || revalidatedTrackedViolations > 0) {
    throw new Error('IMPORT_HAS_ERRORS');
  }

  const queued = await query(
    `UPDATE import_jobs
        SET status = 'queued',
            started_at = COALESCE(started_at, now()),
            updated_at = now()
      WHERE id = $1
        AND tenant_id = $2
        AND status = 'validated'
      RETURNING id`,
    [params.jobId, params.tenantId]
  );
  if ((queued.rowCount ?? 0) === 0) {
    const current = await getImportJob(params.tenantId, params.jobId);
    if (current && ['queued', 'processing', 'completed'].includes(current.status)) {
      return current;
    }
    throw new Error('IMPORT_NOT_VALIDATED');
  }

  void processImportJob(params.jobId, params.tenantId, params.userId);

  return await getImportJob(params.tenantId, params.jobId);
}

async function resolveOrCreateLotForImport(
  tenantId: string,
  itemId: string,
  lotCode: string,
  options?: { rejectExisting?: boolean }
): Promise<string> {
  const existing = await query<{ id: string }>(
    `SELECT id
       FROM lots
      WHERE tenant_id = $1
        AND item_id = $2
        AND lower(btrim(lot_code)) = lower(btrim($3))
      LIMIT 1`,
    [tenantId, itemId, lotCode]
  );
  if (existing.rows[0]) {
    if (options?.rejectExisting) {
      throw new Error('IMPORT_SERIAL_ALREADY_EXISTS');
    }
    return existing.rows[0].id;
  }
  const lotId = uuidv4();
  const now = new Date();
  try {
    await query(
      `INSERT INTO lots (id, tenant_id, item_id, lot_code, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'active', $5, $5)`,
      [lotId, tenantId, itemId, lotCode, now]
    );
    return lotId;
  } catch (error: any) {
    if (isConstraintViolation(error, ['idx_lots_item_code', LOT_NORMALIZED_UNIQUE_INDEX]) || error?.code === '23505') {
      if (options?.rejectExisting) {
        throw new Error('IMPORT_SERIAL_ALREADY_EXISTS');
      }
      const raceResult = await query<{ id: string }>(
        `SELECT id
           FROM lots
          WHERE tenant_id = $1
            AND item_id = $2
            AND lower(btrim(lot_code)) = lower(btrim($3))
          LIMIT 1`,
        [tenantId, itemId, lotCode]
      );
      if (raceResult.rows[0]) {
        return raceResult.rows[0].id;
      }
    }
    throw error;
  }
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
      // Apply-time defense: recompute trace constraints from raw normalized data.
      // Do NOT rely solely on stored validation state.
      for (const row of rowsRes.rows) {
        const normalized = row.normalized as Record<string, any>;
        assertTracedInventoryRequirements({
          requiresLot: !!normalized.requiresLot,
          requiresSerial: !!normalized.requiresSerial,
          lotNumber: String(normalized.lotNumber ?? '').trim() || null,
          serialNumber: String(normalized.serialNumber ?? '').trim() || null
        });
      }

      const itemsRes = await query(
        'SELECT id, sku, standard_cost FROM items WHERE tenant_id = $1',
        [tenantId]
      );
      const itemMap = new Map<string, string>(
        itemsRes.rows.map((row: any) => [row.sku.trim().toLowerCase(), row.id])
      );
      const itemCostMap = new Map<string, number | null>(
        itemsRes.rows.map((row: any) => [row.id, row.standard_cost != null ? Number(row.standard_cost) : null])
      );
      const locationsRes = await query(
        'SELECT id, code FROM locations WHERE tenant_id = $1',
        [tenantId]
      );
      const locationMap = new Map<string, string>(
        locationsRes.rows.map((row: any) => [row.code.trim().toLowerCase(), row.id])
      );

      type OnHandLineWithTrace = {
        itemId: string;
        uom: string;
        countedQuantity: number;
        unitCostForPositiveAdjustment?: number;
        reasonCode: string;
        notes: string | null;
        lotNumber: string | null;
        serialNumber: string | null;
        requiresLot: boolean;
        requiresSerial: boolean;
        resolvedLotId: string | null;
      };
      const byLocation = new Map<string, OnHandLineWithTrace[]>();

      for (const row of rowsRes.rows) {
        const normalized = row.normalized as Record<string, any>;
        const itemId = itemMap.get(String(normalized.sku).trim().toLowerCase());
        const locationId = locationMap.get(String(normalized.locationCode).trim().toLowerCase());
        if (!itemId || !locationId) {
          throw new Error('IMPORT_REFERENCE_MISSING');
        }
        const canonical = await convertToCanonical(tenantId, itemId, normalized.quantity, normalized.uom);
        const lotNumber = String(normalized.lotNumber ?? '').trim() || null;
        const serialNumber = String(normalized.serialNumber ?? '').trim() || null;
        const unitCostForPositiveAdjustment = itemCostMap.get(itemId) ?? undefined;
        const lines = byLocation.get(locationId) ?? [];
        lines.push({
          itemId,
          uom: canonical.canonicalUom,
          countedQuantity: canonical.quantity,
          ...(unitCostForPositiveAdjustment !== undefined
            ? { unitCostForPositiveAdjustment }
            : {}),
          reasonCode: 'import_snapshot',
          notes: buildOnHandImportTraceNote(normalized),
          lotNumber,
          serialNumber,
          requiresLot: !!normalized.requiresLot,
          requiresSerial: !!normalized.requiresSerial,
          resolvedLotId: null
        });
        byLocation.set(locationId, lines);
      }

      for (const linesWithTrace of byLocation.values()) {
        for (const traceData of linesWithTrace) {
          if (!traceData.requiresSerial || !traceData.serialNumber) continue;
          traceData.resolvedLotId = await resolveOrCreateLotForImport(
            tenantId,
            traceData.itemId,
            traceData.serialNumber,
            { rejectExisting: true }
          );
        }
      }

      for (const [locationId, linesWithTrace] of byLocation.entries()) {
        const warehouseId = await resolveWarehouseIdForLocation(tenantId, locationId);
        if (!warehouseId) {
          throw new Error('WAREHOUSE_SCOPE_REQUIRED');
        }
        const count = await createInventoryCount(
          tenantId,
          {
            countedAt: job.counted_at ?? new Date().toISOString(),
            warehouseId,
            locationId,
            notes: `Imported on-hand snapshot (${jobId})`,
            lines: linesWithTrace.map((line) => ({
              itemId: line.itemId,
              locationId,
              uom: line.uom,
              countedQuantity: line.countedQuantity,
              ...(line.unitCostForPositiveAdjustment !== undefined
                ? { unitCostForPositiveAdjustment: line.unitCostForPositiveAdjustment }
                : {}),
              reasonCode: line.reasonCode,
              notes: line.notes ?? undefined
            }))
          },
          { idempotencyKey: `import:${jobId}:${locationId}` }
        );
        await postInventoryCount(tenantId, count.id, `import-post:${jobId}:${locationId}`, {
          actor: { type: 'user', id: userId, role: 'admin' }
        });

        // Structural trace persistence: create lots records and inventory_movement_lots links.
        // This makes lot/serial data queryable and usable by traceability, recall, and FEFO systems.
        const postedCountRes = await query<{ inventory_movement_id: string | null }>(
          'SELECT inventory_movement_id FROM cycle_counts WHERE id = $1 AND tenant_id = $2',
          [count.id, tenantId]
        );
        const movementId = postedCountRes.rows[0]?.inventory_movement_id ?? null;
        if (movementId) {
          // Map cycle count line IDs → line number so we can resolve trace data
          const countLinesRes = await query<{ id: string; line_number: number }>(
            'SELECT id, line_number FROM cycle_count_lines WHERE cycle_count_id = $1 AND tenant_id = $2',
            [count.id, tenantId]
          );
          const lineNumberById = new Map(countLinesRes.rows.map((r) => [r.id, r.line_number]));

          // Retrieve movement lines for this movement
          const movLinesRes = await query<{
            id: string;
            source_line_id: string;
            item_id: string;
            uom: string;
            quantity_delta: string;
          }>(
            'SELECT id, source_line_id, item_id, uom, quantity_delta FROM inventory_movement_lines WHERE movement_id = $1 AND tenant_id = $2',
            [movementId, tenantId]
          );

          for (const movLine of movLinesRes.rows) {
            const lineNumber = lineNumberById.get(movLine.source_line_id);
            if (lineNumber == null) continue;
            const traceData = linesWithTrace[lineNumber - 1];
            if (!traceData) continue;

            // Resolve lot code: for lot-tracked items use lotNumber; for serial-tracked items use serialNumber as lot code.
            // Optional trace columns on untracked rows are import notes only, not structural lot/serial identity.
            const lotCode = traceData.requiresLot
              ? traceData.lotNumber
              : traceData.requiresSerial
                ? traceData.serialNumber
                : null;
            if (!lotCode) continue;

            const lotId = traceData.resolvedLotId ?? await resolveOrCreateLotForImport(
              tenantId,
              movLine.item_id,
              lotCode,
              { rejectExisting: traceData.requiresSerial }
            );
            const quantityDelta = Number(movLine.quantity_delta);
            if (quantityDelta === 0) continue;

            await query(
              `INSERT INTO inventory_movement_lots
                  (id, tenant_id, inventory_movement_line_id, lot_id, uom, quantity_delta, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, now())
               ON CONFLICT (tenant_id, inventory_movement_line_id, lot_id) DO NOTHING`,
              [uuidv4(), tenantId, movLine.id, lotId, movLine.uom, quantityDelta]
            );
          }
        }
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
    const errorSummary =
      isConstraintViolation(error, [IMPORT_SERIAL_UNIQUE_INDEX])
        ? 'IMPORT_DUPLICATE_SERIAL'
        : isConstraintViolation(error, [LOT_NORMALIZED_UNIQUE_INDEX])
          ? 'IMPORT_SERIAL_ALREADY_EXISTS'
          : error instanceof Error
            ? error.message
            : 'Import failed';
    await query(
      `UPDATE import_jobs
          SET status = 'failed', error_summary = $3, finished_at = now(), updated_at = now()
        WHERE id = $1 AND tenant_id = $2`,
      [jobId, tenantId, errorSummary]
    );
  }
}

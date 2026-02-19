import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CANONICAL_WAREHOUSE_CODES = Object.freeze([
  'FACTORY',
  'STORE_FACTORY',
  'STORE_THAPAE',
  'STORE_AIRPORT',
  'STORE_ONENIMMAN'
]);

export const REQUIRED_DEFAULT_ROLES = Object.freeze(['SELLABLE', 'QA', 'HOLD', 'REJECT']);
const ALLOWED_ROLES = new Set(['SELLABLE', 'QA', 'HOLD', 'REJECT', 'SCRAP']);

const thisFile = fileURLToPath(import.meta.url);
const scriptsDir = path.dirname(path.dirname(thisFile));
export const DEFAULT_TOPOLOGY_DIR = path.join(path.dirname(scriptsDir), 'seeds', 'topology');

function parseBoolean(raw, fieldName, source) {
  const normalized = String(raw ?? '').trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  throw new Error(`TOPOLOGY_PARSE_INVALID_BOOLEAN field=${fieldName} value=${raw} source=${source}`);
}

function normalizeCell(value) {
  return String(value ?? '').trim();
}

async function parseTsv(filePath, requiredHeaders) {
  const text = await fs.readFile(filePath, 'utf8');
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  if (lines.length === 0) {
    throw new Error(`TOPOLOGY_PARSE_EMPTY_FILE file=${filePath}`);
  }

  const headers = lines[0].split('\t').map((column) => column.trim());
  const missing = requiredHeaders.filter((header) => !headers.includes(header));
  if (missing.length > 0) {
    throw new Error(`TOPOLOGY_PARSE_MISSING_HEADERS file=${filePath} missing=${missing.join(',')}`);
  }

  const rows = [];
  for (let index = 1; index < lines.length; index += 1) {
    const values = lines[index].split('\t');
    const row = {};
    for (let columnIndex = 0; columnIndex < headers.length; columnIndex += 1) {
      row[headers[columnIndex]] = normalizeCell(values[columnIndex]);
    }
    rows.push(row);
  }

  return rows;
}

export async function loadWarehouseTopology(options = {}) {
  const topologyDir = options.topologyDir ?? DEFAULT_TOPOLOGY_DIR;
  const warehousesPath = path.join(topologyDir, 'warehouses.tsv');
  const locationsPath = path.join(topologyDir, 'locations.tsv');
  const defaultsPath = path.join(topologyDir, 'warehouse_defaults.tsv');

  const [warehouseRows, locationRows, defaultRows] = await Promise.all([
    parseTsv(warehousesPath, ['code', 'name', 'category', 'active']),
    parseTsv(locationsPath, ['warehouse_code', 'local_code', 'code', 'name', 'type', 'role', 'is_sellable', 'active']),
    parseTsv(defaultsPath, ['warehouse_code', 'role', 'local_code'])
  ]);

  const warehouses = warehouseRows.map((row) => ({
    code: row.code,
    name: row.name,
    category: row.category,
    active: parseBoolean(row.active, 'active', warehousesPath)
  }));

  const warehousesByCode = new Map();
  for (const warehouse of warehouses) {
    if (!warehouse.code) throw new Error(`TOPOLOGY_INVALID_WAREHOUSE_CODE code=${warehouse.code}`);
    if (warehousesByCode.has(warehouse.code)) {
      throw new Error(`TOPOLOGY_DUPLICATE_WAREHOUSE_CODE code=${warehouse.code}`);
    }
    warehousesByCode.set(warehouse.code, warehouse);
  }

  const canonicalMissing = CANONICAL_WAREHOUSE_CODES.filter((code) => !warehousesByCode.has(code));
  if (canonicalMissing.length > 0) {
    throw new Error(`TOPOLOGY_MISSING_CANONICAL_WAREHOUSES missing=${canonicalMissing.join(',')}`);
  }

  const unexpectedWarehouses = Array.from(warehousesByCode.keys()).filter(
    (code) => !CANONICAL_WAREHOUSE_CODES.includes(code)
  );
  if (unexpectedWarehouses.length > 0) {
    throw new Error(`TOPOLOGY_UNEXPECTED_WAREHOUSES codes=${unexpectedWarehouses.join(',')}`);
  }

  const locations = locationRows.map((row) => {
    const role = row.role || null;
    if (role !== null && !ALLOWED_ROLES.has(role)) {
      throw new Error(`TOPOLOGY_INVALID_LOCATION_ROLE warehouse=${row.warehouse_code} code=${row.code} role=${row.role}`);
    }
    return {
      warehouseCode: row.warehouse_code,
      localCode: row.local_code,
      code: row.code,
      name: row.name,
      type: row.type,
      role,
      isSellable: parseBoolean(row.is_sellable, 'is_sellable', locationsPath),
      active: parseBoolean(row.active, 'active', locationsPath)
    };
  });

  const locationKeySet = new Set();
  const globalLocationCodes = new Set();
  for (const location of locations) {
    if (!warehousesByCode.has(location.warehouseCode)) {
      throw new Error(`TOPOLOGY_LOCATION_UNKNOWN_WAREHOUSE warehouse=${location.warehouseCode} code=${location.code}`);
    }
    if (!location.localCode) {
      throw new Error(`TOPOLOGY_LOCATION_LOCAL_CODE_REQUIRED warehouse=${location.warehouseCode} code=${location.code}`);
    }
    if (!location.code) {
      throw new Error(`TOPOLOGY_LOCATION_CODE_REQUIRED warehouse=${location.warehouseCode} local_code=${location.localCode}`);
    }
    const key = `${location.warehouseCode}:${location.localCode}`;
    if (locationKeySet.has(key)) {
      throw new Error(`TOPOLOGY_DUPLICATE_LOCATION_LOCAL_CODE key=${key}`);
    }
    locationKeySet.add(key);
    if (globalLocationCodes.has(location.code)) {
      throw new Error(`TOPOLOGY_DUPLICATE_LOCATION_CODE code=${location.code}`);
    }
    globalLocationCodes.add(location.code);
    if (location.role === 'SELLABLE' && !location.isSellable) {
      throw new Error(`TOPOLOGY_SELLABLE_ROLE_MISMATCH code=${location.code}`);
    }
    if (location.role !== 'SELLABLE' && location.isSellable) {
      throw new Error(`TOPOLOGY_NON_SELLABLE_ROLE_MISMATCH code=${location.code} role=${location.role}`);
    }
  }

  const defaults = defaultRows.map((row) => ({
    warehouseCode: row.warehouse_code,
    role: row.role,
    localCode: row.local_code
  }));

  const defaultKeySet = new Set();
  for (const entry of defaults) {
    if (!warehousesByCode.has(entry.warehouseCode)) {
      throw new Error(`TOPOLOGY_DEFAULT_UNKNOWN_WAREHOUSE warehouse=${entry.warehouseCode}`);
    }
    if (!ALLOWED_ROLES.has(entry.role)) {
      throw new Error(`TOPOLOGY_DEFAULT_INVALID_ROLE warehouse=${entry.warehouseCode} role=${entry.role}`);
    }
    if (!entry.localCode) {
      throw new Error(`TOPOLOGY_DEFAULT_LOCAL_CODE_REQUIRED warehouse=${entry.warehouseCode} role=${entry.role}`);
    }
    const key = `${entry.warehouseCode}:${entry.role}`;
    if (defaultKeySet.has(key)) {
      throw new Error(`TOPOLOGY_DUPLICATE_DEFAULT_ROLE key=${key}`);
    }
    defaultKeySet.add(key);
    if (!locationKeySet.has(`${entry.warehouseCode}:${entry.localCode}`)) {
      throw new Error(
        `TOPOLOGY_DEFAULT_LOCATION_MISSING warehouse=${entry.warehouseCode} role=${entry.role} local_code=${entry.localCode}`
      );
    }
  }

  for (const warehouseCode of CANONICAL_WAREHOUSE_CODES) {
    for (const role of REQUIRED_DEFAULT_ROLES) {
      const key = `${warehouseCode}:${role}`;
      if (!defaultKeySet.has(key)) {
        throw new Error(`TOPOLOGY_REQUIRED_DEFAULT_MISSING key=${key}`);
      }
    }
  }

  warehouses.sort((left, right) => left.code.localeCompare(right.code));
  locations.sort((left, right) => {
    const warehouseCompare = left.warehouseCode.localeCompare(right.warehouseCode);
    if (warehouseCompare !== 0) return warehouseCompare;
    return left.localCode.localeCompare(right.localCode);
  });
  defaults.sort((left, right) => {
    const warehouseCompare = left.warehouseCode.localeCompare(right.warehouseCode);
    if (warehouseCompare !== 0) return warehouseCompare;
    return left.role.localeCompare(right.role);
  });

  return {
    topologyDir,
    warehouses,
    locations,
    defaults
  };
}

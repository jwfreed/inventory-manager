import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
  type ImportedItem,
  UOM_ALIASES
} from '../siamaya/import_bom_from_xlsx';
import { parseCsv } from '../../../src/lib/csv';

const ID_NAMESPACE = '85fc700f-6f58-4d79-a7db-7af0951374fd';
const REQUIRED_ROLES = ['SELLABLE', 'QA', 'HOLD'] as const;
const DEFAULT_BOM_JSON_PATH = path.resolve(process.cwd(), 'scripts/seed/siamaya/siamaya-bom-production.json');
const DEFAULT_INITIAL_STOCK_SPEC_PATH = path.resolve(process.cwd(), 'scripts/seed/siamaya/initial-stock-spec.json');
const DEFAULT_REVIEW_REPORT_PATH = path.resolve(process.cwd(), 'scripts/seed/siamaya/seed_review_required.csv');
const DEFAULT_LOYVERSE_ITEMS_CSV_CANDIDATES = [
  '/mnt/data/Siamaya items_cleaned.import.csv',
  '/Users/jonathanfreed/Downloads/Siamaya items_cleaned.import.csv',
  path.resolve(process.cwd(), 'docs/Siamaya items_cleaned.import.csv')
] as const;
const DEFAULT_SIAMAYA_BOM_XLSX_CANDIDATES = [
  '/mnt/data/-Siamaya- 6. BOM (mrp.routing.workcenter)_old.xlsx',
  path.resolve(process.cwd(), 'docs/-Siamaya- 6. BOM (mrp.routing.workcenter)_old.xlsx')
] as const;
const DEFAULT_BOM_OUTPUT_MAPPING_REPORT_CANDIDATES = [
  '/mnt/data/bom_output_item_mapping_report.csv',
  '/Users/jonathanfreed/Downloads/bom_output_item_mapping_report.csv'
] as const;
const DEFAULT_BOM_COMPONENT_MAPPING_REPORT_CANDIDATES = [
  '/mnt/data/bom_unmatched_components_report.csv',
  '/Users/jonathanfreed/Downloads/bom_unmatched_components_report.csv'
] as const;
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
    { code: 'STORE_1', name: 'Thapae Store' },
    { code: 'STORE_2', name: 'Factory Store' },
    { code: 'STORE_3', name: 'CNX Airport Store' }
  ]
} as const;

export type SiamayaPackOptions = {
  pack?: string;
  tenantSlug?: string;
  tenantName?: string;
  adminEmail?: string;
  adminPassword?: string;
  itemsCsvPath?: string;
  bomFilePath?: string;
  bomSheetName?: string;
  bomOutputMappingReportPath?: string;
  bomUnmatchedComponentReportPath?: string;
  reviewReportPath?: string;
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
  sku?: string;
  useProduction?: boolean;
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

type SuggestedMatchReports = {
  outputSuggestByKey: Map<string, string>;
  componentSuggestByKey: Map<string, string>;
};

type RealDataReviewRow = {
  kind: 'output' | 'component' | 'validation';
  outputName: string;
  componentName?: string;
  reason: string;
  suggested?: string;
  rawValue?: string;
  rowNumber?: number;
};

type ParsedManualBomComponent = {
  name: string;
  quantity: number;
  uom: string;
  note: string | null;
  rowNumber: number;
};

type ParsedManualBom = {
  outputName: string;
  outputQuantity: number;
  outputUom: string;
  components: ParsedManualBomComponent[];
};

type ParsedManualBomDataset = {
  boms: ParsedManualBom[];
  unknownUoms: string[];
  validationIssues: RealDataReviewRow[];
};

const PLACEHOLDER_ITEM_SKU_REGEX = /^(EXP|RES|WO-ITEM)-/i;
const PLACEHOLDER_ITEM_NAME_REGEX = /^Item\s+(EXP|RES|WO-ITEM)-/i;
const MATCH_SUFFIX_REGEX = /\s*-\s*(UNWRAPPED|FLOW WRAP|GOLD FOIL|SILVER FOIL|FOIL|MAHABHIROM|ANANTARA)\b/gi;
const PAREN_UOM_REGEX = /\([^)]*\)/g;

function resolveFirstExistingPath(primary: string | undefined, candidates: readonly string[]): string | null {
  if (primary) {
    const resolved = path.resolve(primary);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function toCsvRows(filePath: string): Array<Record<string, string>> {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = parseCsv(raw);
  return parsed.rows.map((row) => {
    const record: Record<string, string> = {};
    for (let index = 0; index < parsed.headers.length; index += 1) {
      const header = parsed.headers[index];
      if (!header) continue;
      record[header] = String(row[index] ?? '');
    }
    return record;
  });
}

function parseNumber(value: string): number | null {
  const normalized = normalizeWhitespace(value).replace(/,/g, '');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeForBomMapping(value: string): string {
  const base = normalizeWhitespace(value)
    .toLowerCase()
    .replace(PAREN_UOM_REGEX, ' ')
    .replace(MATCH_SUFFIX_REGEX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return base;
}

function normalizeUomStrict(raw: string, unknownUoms: Set<string>): string {
  const normalized = normalizeWhitespace(raw);
  if (!normalized) {
    return 'piece';
  }
  const key = normalized.toLowerCase();
  const mapped = UOM_ALIASES[key];
  if (mapped) {
    return mapped;
  }
  unknownUoms.add(normalized);
  return key;
}

function isPackagingKeyword(name: string): boolean {
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
    || lower.includes('jar')
    || lower.includes('cap')
    || lower.includes('lid')
    || lower.includes('foil')
    || lower.includes('wrap')
  );
}

function inferTypeWithSets(
  item: ImportedItem,
  outputKeys: Set<string>,
  componentKeys: Set<string>
): 'raw' | 'wip' | 'finished' | 'packaging' {
  if (isPackagingKeyword(item.name)) {
    return 'packaging';
  }
  if (outputKeys.has(item.key)) {
    if (isWipName(item.name) || /\b(base|mix|paste|ganache)\b/i.test(item.name)) {
      return 'wip';
    }
    return 'finished';
  }
  if (componentKeys.has(item.key)) {
    return 'raw';
  }
  return 'raw';
}

function writeReviewCsv(filePath: string, rows: RealDataReviewRow[]): void {
  const sorted = [...rows].sort((left, right) => {
    const kindCompare = left.kind.localeCompare(right.kind);
    if (kindCompare !== 0) return kindCompare;
    const outputCompare = left.outputName.localeCompare(right.outputName);
    if (outputCompare !== 0) return outputCompare;
    const componentCompare = (left.componentName ?? '').localeCompare(right.componentName ?? '');
    if (componentCompare !== 0) return componentCompare;
    return left.reason.localeCompare(right.reason);
  });

  const escaped = (value: string): string => `"${value.replace(/"/g, '""')}"`;
  const header = [
    'kind',
    'output_name',
    'component_name',
    'reason',
    'suggested',
    'raw_value',
    'row_number'
  ];
  const lines = [header.join(',')];
  for (const row of sorted) {
    lines.push(
      [
        row.kind,
        row.outputName,
        row.componentName ?? '',
        row.reason,
        row.suggested ?? '',
        row.rawValue ?? '',
        row.rowNumber ? String(row.rowNumber) : ''
      ]
        .map((value) => escaped(value))
        .join(',')
    );
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function parseLoyverseItems(args: {
  itemsCsvPath: string;
  tenantSlug: string;
}): {
  items: ImportedItem[];
  itemSkuByKey: Map<string, string>;
  initialStock: InitialStockSpec;
  unknownUoms: string[];
} {
  const rows = toCsvRows(args.itemsCsvPath);
  const unknownUoms = new Set<string>();
  const byKey = new Map<string, ImportedItem>();
  const itemSkuByKey = new Map<string, string>();
  const stockLines: StockSpecLine[] = [];

  for (const row of rows) {
    const name = normalizeWhitespace(row.Name ?? row.item_name ?? '');
    if (!name) continue;
    const key = normalizeItemKey(name);
    const sku = normalizeWhitespace(row.SKU ?? '');
    const qtyFactory = parseNumber(row['In stock [Factory]'] ?? '');
    const costValue = parseNumber(row.Cost ?? '') ?? parseNumber(row['Purchase cost'] ?? '');
    const stockingUomRaw = row.stockingUom ?? row.uomDenomination ?? row.canonicalUom ?? '';
    const baseUom = normalizeUomStrict(stockingUomRaw, unknownUoms);
    if (qtyFactory !== null && qtyFactory > 0 && (costValue === null || costValue < 0)) {
      throw new Error(`SEED_REAL_DATA_COST_REQUIRED_FOR_STOCK item=${name} sku=${sku || '__missing__'}`);
    }
    const imported: ImportedItem = {
      key,
      name,
      baseUom,
      appearsAsOutput: false,
      appearsAsComponent: false
    };
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, imported);
      if (sku) {
        itemSkuByKey.set(key, sku);
      }
    }
    if (qtyFactory !== null && qtyFactory > 0) {
      stockLines.push({
        itemKey: key,
        quantity: qtyFactory,
        uom: baseUom,
        unitCost: costValue ?? 0,
        locationCode: 'FACTORY_SELLABLE'
      });
    }
  }

  const initialStock: InitialStockSpec = {
    version: Number.parseInt(createHash('sha256').update(fs.readFileSync(args.itemsCsvPath, 'utf8')).digest('hex').slice(0, 8), 16),
    stockDate: '2026-01-01T00:00:00.000Z',
    items: stockLines.sort((left, right) => left.itemKey.localeCompare(right.itemKey))
  };
  return {
    items: Array.from(byKey.values()).sort((left, right) => left.key.localeCompare(right.key)),
    itemSkuByKey,
    initialStock,
    unknownUoms: Array.from(unknownUoms).sort((left, right) => left.localeCompare(right))
  };
}

function loadSuggestedMatchReports(args: {
  outputReportPath: string | null;
  componentReportPath: string | null;
}): SuggestedMatchReports {
  const outputSuggestByKey = new Map<string, string>();
  const componentSuggestByKey = new Map<string, string>();

  if (args.outputReportPath && fs.existsSync(args.outputReportPath)) {
    for (const row of toCsvRows(args.outputReportPath)) {
      const outputName = normalizeWhitespace(row.bom_output_name ?? '');
      const suggestion = normalizeWhitespace(row.suggest_1 ?? '');
      if (outputName && suggestion) {
        outputSuggestByKey.set(normalizeItemKey(outputName), suggestion);
      }
    }
  }

  if (args.componentReportPath && fs.existsSync(args.componentReportPath)) {
    for (const row of toCsvRows(args.componentReportPath)) {
      const componentName = normalizeWhitespace(row.component_name ?? '');
      const suggestion = normalizeWhitespace(row.suggest_1 ?? '');
      if (componentName && suggestion) {
        componentSuggestByKey.set(normalizeItemKey(componentName), suggestion);
      }
    }
  }

  return { outputSuggestByKey, componentSuggestByKey };
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attrValue(fragment: string, name: string): string | null {
  const regex = new RegExp(`${name}="([^"]*)"`);
  const match = fragment.match(regex);
  return match ? decodeXml(match[1]) : null;
}

function columnToIndex(cellRef: string): number {
  const letters = cellRef.replace(/\d+/g, '').toUpperCase();
  let index = 0;
  for (const ch of letters) {
    index = index * 26 + (ch.charCodeAt(0) - 64);
  }
  return Math.max(index - 1, 0);
}

function readZipEntry(filePath: string, entryPath: string): string {
  try {
    return execFileSync('unzip', ['-p', filePath, entryPath], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024
    });
  } catch {
    return '';
  }
}

function parseSharedStrings(sharedStringsXml: string): string[] {
  if (!sharedStringsXml) {
    return [];
  }
  const strings: string[] = [];
  const siRegex = /<si[^>]*>([\s\S]*?)<\/si>/g;
  for (const match of sharedStringsXml.matchAll(siRegex)) {
    const body = match[1];
    const pieces: string[] = [];
    const tRegex = /<t(?:\s+xml:space="preserve")?[^>]*>([\s\S]*?)<\/t>/g;
    for (const textMatch of body.matchAll(tRegex)) {
      pieces.push(decodeXml(textMatch[1]));
    }
    strings.push(normalizeWhitespace(pieces.join('')));
  }
  return strings;
}

function resolveWorksheetPath(workbookXml: string, relsXml: string, sheetName: string): string {
  const sheets = Array.from(workbookXml.matchAll(/<sheet\b([^>]*)\/>/g));
  const targetSheet = sheets.find((sheet) => attrValue(sheet[1], 'name') === sheetName);
  if (!targetSheet) {
    throw new Error(`SEED_BOM_SHEET_NOT_FOUND sheet=${sheetName}`);
  }
  const relationshipId = attrValue(targetSheet[1], 'r:id');
  if (!relationshipId) {
    throw new Error(`SEED_BOM_SHEET_RELATIONSHIP_MISSING sheet=${sheetName}`);
  }
  for (const relationship of relsXml.matchAll(/<Relationship\b([^>]*)\/>/g)) {
    const attrs = relationship[1];
    if (attrValue(attrs, 'Id') !== relationshipId) continue;
    const target = attrValue(attrs, 'Target');
    if (!target) break;
    if (target.startsWith('/xl/')) return target.slice(4);
    if (target.startsWith('xl/')) return target.slice(3);
    return target.startsWith('/') ? target.slice(1) : target;
  }
  throw new Error(`SEED_BOM_SHEET_TARGET_MISSING sheet=${sheetName} relationship=${relationshipId}`);
}

function readWorksheetGrid(filePath: string, sheetName: string): Array<Map<number, string | number | null>> {
  const workbookXml = readZipEntry(filePath, 'xl/workbook.xml');
  const relsXml = readZipEntry(filePath, 'xl/_rels/workbook.xml.rels');
  if (!workbookXml || !relsXml) {
    throw new Error(`SEED_BOM_XLSX_PARSE_FAILED file=${filePath}`);
  }
  const worksheetPath = resolveWorksheetPath(workbookXml, relsXml, sheetName);
  const worksheetXml = readZipEntry(filePath, `xl/${worksheetPath}`);
  if (!worksheetXml) {
    throw new Error(`SEED_BOM_WORKSHEET_READ_FAILED file=${filePath} sheet=${sheetName}`);
  }
  const sharedStrings = parseSharedStrings(readZipEntry(filePath, 'xl/sharedStrings.xml'));
  const rows: Array<Map<number, string | number | null>> = [];
  const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  for (const rowMatch of worksheetXml.matchAll(rowRegex)) {
    const rowBody = rowMatch[1];
    const cellMap = new Map<number, string | number | null>();
    const cellRegex = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
    for (const cellMatch of rowBody.matchAll(cellRegex)) {
      const attrs = cellMatch[1] ?? cellMatch[3] ?? '';
      const cellBody = cellMatch[2] ?? '';
      const cellRef = attrValue(attrs, 'r');
      if (!cellRef) continue;
      const type = attrValue(attrs, 't');
      const index = columnToIndex(cellRef);
      let value: string | number | null = null;

      if (type === 'inlineStr') {
        const inlineMatch = cellBody.match(/<is[^>]*>([\s\S]*?)<\/is>/);
        if (inlineMatch) {
          const textMatches = Array.from(inlineMatch[1].matchAll(/<t(?:\s+xml:space="preserve")?[^>]*>([\s\S]*?)<\/t>/g));
          value = normalizeWhitespace(textMatches.map((textMatch) => decodeXml(textMatch[1])).join(''));
        }
      } else {
        const valueMatch = cellBody.match(/<v[^>]*>([\s\S]*?)<\/v>/);
        if (valueMatch) {
          const raw = decodeXml(valueMatch[1]);
          if (type === 's') {
            const sharedIndex = Number(raw);
            value = Number.isFinite(sharedIndex) ? sharedStrings[sharedIndex] ?? null : null;
          } else {
            const numeric = Number(raw);
            value = Number.isFinite(numeric) ? numeric : normalizeWhitespace(raw);
          }
        }
      }
      cellMap.set(index, value);
    }
    rows.push(cellMap);
  }
  return rows;
}

function isWrapperLikeName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes('wrapper')
    || lower.includes('sticker')
    || lower.includes('label')
    || lower.includes('sleeve')
    || lower.includes('foil')
    || lower.includes('box')
    || lower.includes('bag')
    || lower.includes('bottle')
    || lower.includes('tin')
  );
}

function parseManualBomsFromXlsx(filePath: string, sheetName: string): ParsedManualBomDataset {
  const unknownUoms = new Set<string>();
  const validationIssues: RealDataReviewRow[] = [];
  const rows = readWorksheetGrid(filePath, sheetName);
  const headerIndex = rows.findIndex((row) => normalizeWhitespace(String(row.get(0) ?? '')).toLowerCase() === 'finished goods');
  if (headerIndex < 0) {
    throw new Error('SEED_BOM_MANUAL_SECTION_NOT_FOUND marker=Finished Goods');
  }

  const boms = new Map<string, ParsedManualBom>();
  let currentOutput: ParsedManualBom | null = null;

  for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const rawCol0 = normalizeWhitespace(String(row.get(0) ?? ''));
    const outputName = /^[0-9]+(?:\.0+)?$/.test(rawCol0) ? '' : rawCol0;
    const componentNameRaw = normalizeWhitespace(String(row.get(3) ?? ''));
    const outputQty = typeof row.get(1) === 'number' ? Number(row.get(1)) : parseNumber(String(row.get(1) ?? ''));
    const outputUomRaw = normalizeWhitespace(String(row.get(2) ?? ''));
    const outputUom = normalizeUomStrict(outputUomRaw, unknownUoms);

    if (outputName) {
      if (outputQty === null || outputQty <= 0) {
        if (componentNameRaw) {
          validationIssues.push({
            kind: 'validation',
            outputName,
            reason: 'INVALID_OUTPUT_QUANTITY',
            rawValue: String(row.get(1) ?? ''),
            rowNumber: rowIndex + 1
          });
        }
      } else if (!outputUomRaw) {
        if (componentNameRaw) {
          validationIssues.push({
            kind: 'validation',
            outputName,
            reason: 'MISSING_OUTPUT_UOM',
            rowNumber: rowIndex + 1
          });
        }
      } else if (/ test$/i.test(outputName)) {
        currentOutput = null;
      } else {
        const bomKey = normalizeItemKey(outputName);
        const existing = boms.get(bomKey);
        if (existing) {
          existing.outputName = outputName;
          existing.outputQuantity = outputQty;
          existing.outputUom = outputUom;
          currentOutput = existing;
        } else {
          const created: ParsedManualBom = {
            outputName,
            outputQuantity: outputQty,
            outputUom,
            components: []
          };
          boms.set(bomKey, created);
          currentOutput = created;
        }
      }
    }

    if (!currentOutput || !componentNameRaw) {
      continue;
    }
    let componentQty = typeof row.get(4) === 'number' ? Number(row.get(4)) : parseNumber(String(row.get(4) ?? ''));
    const componentUomRaw = normalizeWhitespace(String(row.get(5) ?? ''));
    let componentUom = componentUomRaw ? normalizeUomStrict(componentUomRaw, unknownUoms) : '';
    const operation = normalizeWhitespace(String(row.get(6) ?? ''));
    const workCenter = normalizeWhitespace(String(row.get(7) ?? ''));
    const noteText = normalizeWhitespace(String(row.get(8) ?? ''));
    const note = [operation, workCenter, noteText].filter(Boolean).join(' | ') || null;
    let componentName = componentNameRaw;

    if (componentQty === null && isWrapperLikeName(componentName)) {
      componentQty = 1;
      componentUom = componentUom || 'piece';
    }

    if (
      /\bthai tea\b/i.test(currentOutput.outputName)
      && /\(8g\)/i.test(currentOutput.outputName)
      && /^base - /i.test(componentName)
      && componentQty !== null
      && componentQty > 20
    ) {
      componentQty = 7.905;
    }

    if (currentOutput.outputName === 'Mooncake Milk Chocolate (75g)' && componentName === currentOutput.outputName) {
      componentName = `${currentOutput.outputName} - FLOW WRAP`;
    }

    if (normalizeItemKey(currentOutput.outputName) === normalizeItemKey(componentName)) {
      validationIssues.push({
        kind: 'validation',
        outputName: currentOutput.outputName,
        componentName,
        reason: 'SELF_REFERENCE_SKIPPED',
        rowNumber: rowIndex + 1
      });
      continue;
    }

    if (componentQty === null || componentQty <= 0) {
      validationIssues.push({
        kind: 'validation',
        outputName: currentOutput.outputName,
        componentName,
        reason: 'INVALID_COMPONENT_QUANTITY',
        rawValue: String(row.get(4) ?? ''),
        rowNumber: rowIndex + 1
      });
      continue;
    }
    if (!componentUom) {
      validationIssues.push({
        kind: 'validation',
        outputName: currentOutput.outputName,
        componentName,
        reason: 'MISSING_COMPONENT_UOM',
        rawValue: String(row.get(5) ?? ''),
        rowNumber: rowIndex + 1
      });
      continue;
    }

    currentOutput.components.push({
      name: componentName,
      quantity: componentQty,
      uom: componentUom,
      note,
      rowNumber: rowIndex + 1
    });
  }

  return {
    boms: Array.from(boms.values()).sort((left, right) => normalizeItemKey(left.outputName).localeCompare(normalizeItemKey(right.outputName))),
    unknownUoms: Array.from(unknownUoms).sort((left, right) => left.localeCompare(right)),
    validationIssues
  };
}

function mapManualBomsToItems(args: {
  manual: ParsedManualBomDataset;
  loyverseItems: ImportedItem[];
  reports: SuggestedMatchReports;
}): { items: ImportedItem[]; boms: ImportedBom[]; reviewRows: RealDataReviewRow[] } {
  const reviewRows: RealDataReviewRow[] = [...args.manual.validationIssues];
  const loyverseByNorm = new Map<string, ImportedItem[]>();
  for (const item of args.loyverseItems) {
    const norm = normalizeForBomMapping(item.name);
    const existing = loyverseByNorm.get(norm) ?? [];
    existing.push(item);
    loyverseByNorm.set(norm, existing);
  }
  for (const candidates of loyverseByNorm.values()) {
    candidates.sort((left, right) => {
      const nameCompare = left.name.localeCompare(right.name);
      if (nameCompare !== 0) return nameCompare;
      return left.key.localeCompare(right.key);
    });
  }

  const resolveLoyverseItem = (rawName: string): ImportedItem | null => {
    const normalizedRaw = normalizeWhitespace(rawName).toLowerCase();
    const candidates = loyverseByNorm.get(normalizeForBomMapping(rawName));
    if (!candidates || candidates.length === 0) return null;
    const exact = candidates.find((candidate) => normalizeWhitespace(candidate.name).toLowerCase() === normalizedRaw);
    if (exact) return exact;
    return candidates[0];
  };

  const outputKeys = new Set<string>();
  const componentKeys = new Set<string>();
  const boms: ImportedBom[] = [];

  for (const manualBom of args.manual.boms) {
    let outputItem = resolveLoyverseItem(manualBom.outputName);
    if (!outputItem) {
      const suggested = args.reports.outputSuggestByKey.get(normalizeItemKey(manualBom.outputName));
      if (suggested) {
        outputItem = resolveLoyverseItem(suggested);
      }
      if (!outputItem) {
        reviewRows.push({
          kind: 'output',
          outputName: manualBom.outputName,
          reason: 'OUTPUT_UNMAPPED_NO_SUGGESTION',
          suggested: suggested ?? undefined
        });
        continue;
      }
    }

    const mappedComponents: ImportedBom['components'] = [];
    for (const component of manualBom.components) {
      let componentItem = resolveLoyverseItem(component.name);
      if (!componentItem) {
        const suggested = args.reports.componentSuggestByKey.get(normalizeItemKey(component.name));
        if (suggested) {
          componentItem = resolveLoyverseItem(suggested);
        }
        if (!componentItem) {
          reviewRows.push({
            kind: 'component',
            outputName: manualBom.outputName,
            componentName: component.name,
            reason: 'COMPONENT_UNMAPPED_NO_SUGGESTION',
            suggested: suggested ?? undefined,
            rowNumber: component.rowNumber
          });
          continue;
        }
      }

      if (componentItem.key === outputItem.key) {
        reviewRows.push({
          kind: 'component',
          outputName: manualBom.outputName,
          componentName: component.name,
          reason: 'COMPONENT_SELF_REFERENCE_AFTER_MAPPING',
          rowNumber: component.rowNumber
        });
        continue;
      }

      if (!(component.quantity > 0) || !component.uom) {
        reviewRows.push({
          kind: 'validation',
          outputName: manualBom.outputName,
          componentName: component.name,
          reason: 'COMPONENT_INVALID_QTY_OR_UOM',
          rawValue: `${component.quantity}|${component.uom}`,
          rowNumber: component.rowNumber
        });
        continue;
      }

      componentKeys.add(componentItem.key);
      mappedComponents.push({
        componentKey: componentItem.key,
        componentName: componentItem.name,
        quantity: component.quantity,
        uom: component.uom,
        note: component.note,
        sequence: component.rowNumber
      });
    }

    if (mappedComponents.length === 0) {
      reviewRows.push({
        kind: 'output',
        outputName: manualBom.outputName,
        reason: 'OUTPUT_SKIPPED_NO_MAPPED_COMPONENTS'
      });
      continue;
    }

    outputKeys.add(outputItem.key);
    boms.push({
      outputKey: outputItem.key,
      outputName: outputItem.name,
      outputQuantity: manualBom.outputQuantity,
      outputUom: manualBom.outputUom,
      components: mappedComponents.sort((left, right) => {
        if (left.sequence !== right.sequence) return left.sequence - right.sequence;
        return left.componentKey.localeCompare(right.componentKey);
      })
    });
  }

  const items = args.loyverseItems.map((item) => ({
    ...item,
    appearsAsOutput: outputKeys.has(item.key),
    appearsAsComponent: componentKeys.has(item.key)
  }));

  return {
    items: items.sort((left, right) => left.key.localeCompare(right.key)),
    boms: boms.sort((left, right) => left.outputKey.localeCompare(right.outputKey)),
    reviewRows
  };
}

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

function assertCanonicalSeedItemNames(items: CanonicalItem[]): void {
  const offenders = items.filter(
    (item) => PLACEHOLDER_ITEM_SKU_REGEX.test(item.name) || PLACEHOLDER_ITEM_NAME_REGEX.test(item.name)
  );
  if (offenders.length > 0) {
    const sample = offenders
      .slice(0, 5)
      .map((item) => item.name)
      .join(',');
    throw new Error(`SEED_BOM_PLACEHOLDER_ITEM_NAMES_DETECTED count=${offenders.length} sample=${sample}`);
  }
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
  args: {
    tenantId: string;
    warehouseId: string;
    warehouseCode: string;
    warehouseName: string;
    role: typeof REQUIRED_ROLES[number];
  }
): Promise<{ id: string; code: string; created: boolean }> {
  const code = `${args.warehouseCode}_${args.role}`;
  const name = `${args.warehouseName} / ${args.role}`;
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

async function hasItemsUseProductionColumn(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'items'
          AND column_name = 'use_production'
     ) AS exists`
  );
  return result.rows[0]?.exists === true;
}

async function upsertItems(
  client: PoolClient,
  args: { tenantId: string; tenantSlug: string; items: CanonicalItem[] }
): Promise<{ idByItemKey: Map<string, string>; createdCount: number; updatedCount: number }> {
  const existingByNormalizedName = await loadExistingItemsByNormalizedName(client, args.tenantId);
  const supportsUseProduction = await hasItemsUseProductionColumn(client);
  const idByItemKey = new Map<string, string>();
  let createdCount = 0;
  let updatedCount = 0;

  for (const item of args.items) {
    const canonical = canonicalUomFields(item.baseUom);
    const existing = existingByNormalizedName.get(item.key);
    if (existing) {
      if (supportsUseProduction) {
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
                  use_production = $9,
                  active = true,
                  lifecycle_status = 'Active',
                  updated_at = now()
            WHERE id = $10
              AND tenant_id = $11`,
          [
            item.name,
            'Seeded by siamaya_factory',
            item.type,
            canonical.defaultUom,
            canonical.uomDimension,
            canonical.canonicalUom,
            canonical.stockingUom,
            LOT_TRACKED_ITEM_KEYS.has(item.key),
            item.useProduction === true,
            existing.id,
            args.tenantId
          ]
        );
      } else {
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
      }
      idByItemKey.set(item.key, existing.id);
      updatedCount += 1;
      continue;
    }

    const itemId = deterministicId('item', args.tenantId, item.key);
    const sku = item.sku ? normalizeWhitespace(item.sku) : deterministicSku(args.tenantSlug, item.key);
    if (supportsUseProduction) {
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
            use_production,
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
            $12,
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
          LOT_TRACKED_ITEM_KEYS.has(item.key),
          item.useProduction === true
        ]
      );
    } else {
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
    }
    idByItemKey.set(item.key, itemId);
    createdCount += 1;
  }

  return { idByItemKey, createdCount, updatedCount };
}

async function deactivateLegacyPlaceholderItems(
  client: PoolClient,
  args: { tenantId: string; canonicalItems: CanonicalItem[] }
): Promise<number> {
  const canonicalKeys = args.canonicalItems.map((item) => item.key);
  const res = await client.query<{ id: string }>(
    `WITH candidates AS (
       SELECT i.id
         FROM items i
        WHERE i.tenant_id = $1
          AND i.active = true
          AND (
            i.sku ~* '^(EXP|RES|WO-ITEM)-'
            OR i.name ~* '^Item\\s+(EXP|RES|WO-ITEM)-'
          )
          AND NOT (lower(regexp_replace(trim(i.name), '\\s+', ' ', 'g')) = ANY($2::text[]))
          AND NOT EXISTS (
            SELECT 1
              FROM inventory_movement_lines iml
             WHERE iml.tenant_id = i.tenant_id
               AND iml.item_id = i.id
          )
          AND NOT EXISTS (
            SELECT 1
              FROM bom_version_lines bvl
             WHERE bvl.tenant_id = i.tenant_id
               AND bvl.component_item_id = i.id
          )
          AND NOT EXISTS (
            SELECT 1
              FROM boms b
             WHERE b.tenant_id = i.tenant_id
               AND b.output_item_id = i.id
          )
     )
     UPDATE items i
        SET active = false,
            updated_at = now()
       FROM candidates c
      WHERE i.id = c.id
      RETURNING i.id`,
    [args.tenantId, canonicalKeys]
  );
  return res.rowCount ?? 0;
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
): Promise<{ bomId: string; versionId: string; bomCreated: boolean; versionCreated: boolean }> {
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
  let bomCreated = false;
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
    bomCreated = true;
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
  let versionCreated = false;
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
    versionCreated = true;
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

  return { bomId, versionId, bomCreated, versionCreated };
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

function toCanonicalItems(items: ImportedItem[], boms: CanonicalBom[]): CanonicalItem[] {
  const outputKeys = new Set<string>(boms.map((bom) => bom.outputKey));
  const componentKeys = new Set<string>();
  for (const bom of boms) {
    for (const component of bom.components) {
      componentKeys.add(component.componentKey);
    }
  }

  return items
    .map((item) => {
      const type = inferTypeWithSets(item, outputKeys, componentKeys);
      return {
        ...item,
        type,
        useProduction: outputKeys.has(item.key)
      };
    })
    .sort((left, right) => left.key.localeCompare(right.key));
}

export async function runSiamayaFactoryPack(client: PoolClient, options: SiamayaPackOptions = {}): Promise<SeedSummary> {
  const pack = options.pack ?? DEFAULT_OPTIONS.pack;
  const tenantSlug = normalizeTenantSlug(options.tenantSlug ?? DEFAULT_OPTIONS.tenantSlug);
  const tenantName = normalizeWhitespace(options.tenantName ?? DEFAULT_OPTIONS.tenantName);
  const adminEmail = normalizeEmail(options.adminEmail ?? DEFAULT_OPTIONS.adminEmail);
  const adminPassword = options.adminPassword ?? DEFAULT_OPTIONS.adminPassword;
  const warehouseSpecs = options.warehouses ?? DEFAULT_OPTIONS.warehouses;
  const explicitBomPath = options.bomFilePath ? path.resolve(options.bomFilePath) : undefined;
  const resolvedItemsCsvPath = resolveFirstExistingPath(options.itemsCsvPath, DEFAULT_LOYVERSE_ITEMS_CSV_CANDIDATES);
  const resolvedBomWorkbookPath = resolveFirstExistingPath(
    explicitBomPath && explicitBomPath.toLowerCase().endsWith('.xlsx') ? explicitBomPath : undefined,
    DEFAULT_SIAMAYA_BOM_XLSX_CANDIDATES
  );
  const resolvedOutputReportPath = resolveFirstExistingPath(
    options.bomOutputMappingReportPath,
    DEFAULT_BOM_OUTPUT_MAPPING_REPORT_CANDIDATES
  );
  const resolvedComponentReportPath = resolveFirstExistingPath(
    options.bomUnmatchedComponentReportPath,
    DEFAULT_BOM_COMPONENT_MAPPING_REPORT_CANDIDATES
  );
  const reviewReportPath = path.resolve(options.reviewReportPath ?? DEFAULT_REVIEW_REPORT_PATH);

  const useRealDataImport =
    !options.datasetOverride
    && !!resolvedItemsCsvPath
    && !!resolvedBomWorkbookPath
    && (!explicitBomPath || explicitBomPath.toLowerCase().endsWith('.xlsx'));

  let initialStockSpec = loadInitialStockSpec(options.initialStockSpecPath ?? DEFAULT_INITIAL_STOCK_SPEC_PATH);
  let realDataReviewRows: RealDataReviewRow[] = [];
  let skuByItemKey = new Map<string, string>();

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
    : useRealDataImport
      ? (() => {
          const loyverse = parseLoyverseItems({
            itemsCsvPath: resolvedItemsCsvPath,
            tenantSlug
          });
          const manual = parseManualBomsFromXlsx(resolvedBomWorkbookPath, options.bomSheetName ?? '3. bom');
          const reports = loadSuggestedMatchReports({
            outputReportPath: resolvedOutputReportPath,
            componentReportPath: resolvedComponentReportPath
          });
          const mapped = mapManualBomsToItems({
            manual,
            loyverseItems: loyverse.items,
            reports
          });
          realDataReviewRows = mapped.reviewRows;
          initialStockSpec = loyverse.initialStock;
          skuByItemKey = loyverse.itemSkuByKey;

          writeReviewCsv(reviewReportPath, realDataReviewRows);
          const fatalValidationRows = realDataReviewRows.filter(
            (row) =>
              row.kind === 'validation'
              && (row.reason === 'INVALID_COMPONENT_QUANTITY'
                || row.reason === 'MISSING_COMPONENT_UOM'
                || row.reason === 'INVALID_OUTPUT_QUANTITY'
                || row.reason === 'MISSING_OUTPUT_UOM')
          );
          if (fatalValidationRows.length > 0) {
            throw new Error(
              `SEED_REAL_DATA_VALIDATION_FAILED count=${fatalValidationRows.length} review=${reviewReportPath}`
            );
          }

          console.log(
            JSON.stringify({
              code: 'SEED_REAL_DATA_IMPORT_SUMMARY',
              itemsCsvPath: resolvedItemsCsvPath,
              bomWorkbookPath: resolvedBomWorkbookPath,
              bomOutputReportPath: resolvedOutputReportPath,
              bomComponentReportPath: resolvedComponentReportPath,
              reviewReportPath,
              totalLoyverseItems: loyverse.items.length,
              totalManualBomsParsed: manual.boms.length,
              totalMappedBoms: mapped.boms.length,
              totalReviewRows: realDataReviewRows.length
            })
          );

          return {
            sourcePath: resolvedBomWorkbookPath,
            sourceKind: 'xlsx' as const,
            sheetName: options.bomSheetName ?? '3. bom',
            rowCount: manual.boms.length,
            items: mapped.items,
            boms: mapped.boms,
            unknownUoms: Array.from(new Set([...manual.unknownUoms, ...loyverse.unknownUoms])).sort((left, right) =>
              left.localeCompare(right)
            )
          };
        })()
      : await importBomDatasetFromFile({
          filePath: explicitBomPath ?? DEFAULT_BOM_JSON_PATH,
          sheetName: options.bomSheetName
        });
  if (bomDataset.boms.length === 0) {
    throw new Error(`SEED_BOM_EMPTY source=${bomDataset.sourcePath}`);
  }

  const canonicalBoms = bomDataset.boms;
  const canonicalItems = toCanonicalItems(bomDataset.items, canonicalBoms).map((item) => ({
    ...item,
    sku: skuByItemKey.get(item.key)
  }));
  assertCanonicalSeedItemNames(canonicalItems);
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
        warehouseName,
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

  const upsertedItems = await upsertItems(client, {
    tenantId,
    tenantSlug,
    items: canonicalItems
  });
  const itemIdByKey = upsertedItems.idByItemKey;
  await deactivateLegacyPlaceholderItems(client, {
    tenantId,
    canonicalItems
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
    strictMissingItems:
      useRealDataImport
      || (!options.datasetOverride && (!options.bomFilePath || path.resolve(options.bomFilePath) === DEFAULT_BOM_JSON_PATH))
  });

  let bomLinesUpserted = 0;
  let bomsCreated = 0;
  let bomVersionsCreated = 0;
  for (const bom of canonicalBoms) {
    const outputItemId = itemIdByKey.get(bom.outputKey);
    if (!outputItemId) {
      throw new Error(`SEED_BOM_OUTPUT_ITEM_MISSING key=${bom.outputKey}`);
    }
    const { versionId, bomCreated, versionCreated } = await upsertBomAndVersion(client, {
      tenantId,
      tenantSlug,
      bom,
      outputItemId
    });
    if (bomCreated) bomsCreated += 1;
    if (versionCreated) bomVersionsCreated += 1;
    bomLinesUpserted += await replaceBomVersionLines(client, {
      tenantId,
      versionId,
      bom,
      itemIdByKey
    });
  }

  if (useRealDataImport) {
    const outputSkipped = realDataReviewRows.filter((row) => row.kind === 'output').length;
    const componentSkipped = realDataReviewRows.filter((row) => row.kind === 'component').length;
    const validationIssueCount = realDataReviewRows.filter((row) => row.kind === 'validation').length;
    console.log(
      JSON.stringify({
        code: 'SEED_REAL_DATA_APPLY_SUMMARY',
        totalBomsParsed: bomDataset.rowCount,
        bomsCreated,
        bomsUpserted: canonicalBoms.length,
        bomsSkipped: outputSkipped,
        componentLinesCreated: bomLinesUpserted,
        componentLinesSkipped: componentSkipped,
        validationIssues: validationIssueCount,
        internalItemsCreated: upsertedItems.createdCount,
        itemsUpdated: upsertedItems.updatedCount,
        reviewReportPath
      })
    );
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

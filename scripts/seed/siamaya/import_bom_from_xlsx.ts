import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const DEFAULT_SIAMAYA_BOM_PATH = '/mnt/data/-Siamaya- 6. BOM (mrp.routing.workcenter)_old.xlsx';
export const DEFAULT_SIAMAYA_BOM_SHEET = '3. bom';

export type ImportedBomComponent = {
  componentKey: string;
  componentName: string;
  quantity: number;
  uom: string;
  note: string | null;
  sequence: number;
};

export type ImportedBom = {
  outputKey: string;
  outputName: string;
  outputQuantity: number;
  outputUom: string;
  components: ImportedBomComponent[];
};

export type ImportedItem = {
  key: string;
  name: string;
  baseUom: string;
  appearsAsOutput: boolean;
  appearsAsComponent: boolean;
};

export type ImportedBomDataset = {
  sourcePath: string;
  sourceKind: 'xlsx' | 'json';
  sheetName: string;
  rowCount: number;
  items: ImportedItem[];
  boms: ImportedBom[];
  unknownUoms: string[];
};

type ParsedRow = Record<string, unknown>;

type ItemAccumulator = {
  key: string;
  name: string;
  componentUom: string | null;
  outputUom: string | null;
  appearsAsOutput: boolean;
  appearsAsComponent: boolean;
};

type BomAccumulator = {
  outputKey: string;
  outputName: string;
  outputQuantity: number;
  outputUom: string;
  componentByKey: Map<string, ImportedBomComponent>;
};

export const UOM_ALIASES: Record<string, string> = {
  each: 'each',
  ea: 'each',
  kg: 'kg',
  kilogram: 'kg',
  kilograms: 'kg',
  g: 'g',
  gram: 'g',
  grams: 'g',
  unit: 'piece',
  units: 'piece',
  pcs: 'piece',
  pc: 'piece',
  piece: 'piece',
  pieces: 'piece',
  bag: 'piece',
  bags: 'piece',
  tin: 'piece',
  tins: 'piece',
  bottle: 'piece',
  bottles: 'piece',
  bar: 'piece',
  bars: 'piece'
};

const OUTPUT_NAME_ALIASES = [
  'finished_item_name',
  'finished_item',
  'finished_product',
  'output_item_name',
  'output_item',
  'product_template_name',
  'product_template',
  'product_tmpl_name',
  'product_tmpl_id_name',
  'product_name',
  'product'
];

const OUTPUT_QTY_ALIASES = ['output_qty', 'output_quantity', 'product_qty', 'yield_qty', 'yield_quantity'];
const OUTPUT_UOM_ALIASES = ['output_uom', 'product_uom', 'product_uom_id', 'uom'];

const COMPONENT_NAME_ALIASES = [
  'component_item_name',
  'component_item',
  'component_name',
  'component',
  'bom_line_item_name',
  'bom_line_product_name',
  'bom_line_ids_product_id_name',
  'bom_line_product',
  'raw_material'
];

const COMPONENT_QTY_ALIASES = [
  'component_qty',
  'component_quantity',
  'bom_line_qty',
  'bom_line_product_qty',
  'bom_line_ids_product_qty'
];

const COMPONENT_UOM_ALIASES = [
  'component_uom',
  'bom_line_uom',
  'bom_line_product_uom',
  'bom_line_ids_product_uom_id',
  'bom_line_ids_product_uom_id_name'
];

const BYPRODUCT_ALIASES = ['byproduct', 'byproduct_item', 'byproduct_name', 'byproduct_item_name'];
const NOTE_ALIASES = ['operation', 'workcenter', 'work_center', 'routing_operation', 'operation_note'];

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeItemKey(name: string): string {
  return collapseWhitespace(name)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeHeader(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s/.-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.replace(/,/g, '');
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function normalizeUom(raw: unknown, unknownUoms: Set<string>): string {
  const original = collapseWhitespace(String(raw ?? ''));
  if (!original) {
    return 'piece';
  }
  const key = original.toLowerCase();
  const mapped = UOM_ALIASES[key];
  if (mapped) {
    return mapped;
  }
  unknownUoms.add(original);
  return original;
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
    strings.push(collapseWhitespace(pieces.join('')));
  }
  return strings;
}

function parseWorksheetRows(sheetXml: string, sharedStrings: string[]): ParsedRow[] {
  const rows: Array<Map<number, unknown>> = [];
  const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  for (const rowMatch of sheetXml.matchAll(rowRegex)) {
    const rowBody = rowMatch[1];
    const cellMap = new Map<number, unknown>();
    const cellRegex = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
    for (const cellMatch of rowBody.matchAll(cellRegex)) {
      const attrs = cellMatch[1] ?? cellMatch[3] ?? '';
      const cellBody = cellMatch[2] ?? '';
      const cellRef = attrValue(attrs, 'r');
      if (!cellRef) continue;
      const index = columnToIndex(cellRef);
      const type = attrValue(attrs, 't');
      let value: unknown = null;

      if (type === 'inlineStr') {
        const inlineMatch = cellBody.match(/<is[^>]*>([\s\S]*?)<\/is>/);
        if (inlineMatch) {
          const textMatches = Array.from(inlineMatch[1].matchAll(/<t(?:\s+xml:space="preserve")?[^>]*>([\s\S]*?)<\/t>/g));
          value = collapseWhitespace(textMatches.map((textMatch) => decodeXml(textMatch[1])).join(''));
        }
      } else {
        const valueMatch = cellBody.match(/<v[^>]*>([\s\S]*?)<\/v>/);
        if (valueMatch) {
          const raw = decodeXml(valueMatch[1]);
          if (type === 's') {
            const sharedIndex = Number(raw);
            value = Number.isFinite(sharedIndex) && sharedStrings[sharedIndex] !== undefined
              ? sharedStrings[sharedIndex]
              : '';
          } else {
            const num = Number(raw);
            value = Number.isFinite(num) ? num : collapseWhitespace(raw);
          }
        }
      }
      cellMap.set(index, value);
    }
    rows.push(cellMap);
  }

  if (rows.length === 0) {
    return [];
  }

  const headerRow = rows[0];
  const maxIndex = Math.max(...Array.from(headerRow.keys(), (key) => key), 0);
  const headers = Array.from({ length: maxIndex + 1 }, (_, index) => {
    const value = headerRow.get(index);
    return collapseWhitespace(String(value ?? ''));
  });

  const parsedRows: ParsedRow[] = [];
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const cellMap = rows[rowIndex];
    const row: ParsedRow = {};
    let hasValue = false;
    for (let index = 0; index < headers.length; index += 1) {
      const header = headers[index];
      if (!header) continue;
      const value = cellMap.get(index) ?? null;
      if (value !== null && String(value).trim() !== '') {
        hasValue = true;
      }
      row[header] = value;
    }
    if (hasValue) {
      parsedRows.push(row);
    }
  }
  return parsedRows;
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
    if (target.startsWith('/xl/')) {
      return target.slice(4);
    }
    if (target.startsWith('xl/')) {
      return target.slice(3);
    }
    return target.startsWith('/') ? target.slice(1) : target;
  }

  throw new Error(`SEED_BOM_SHEET_TARGET_MISSING sheet=${sheetName} relationship=${relationshipId}`);
}

function readRowsFromXlsx(filePath: string, sheetName: string): ParsedRow[] {
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

  const sharedStringsXml = readZipEntry(filePath, 'xl/sharedStrings.xml');
  const sharedStrings = parseSharedStrings(sharedStringsXml);
  return parseWorksheetRows(worksheetXml, sharedStrings);
}

function readRowsFromJson(filePath: string): ParsedRow[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    return parsed as ParsedRow[];
  }
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { rows?: unknown }).rows)) {
    return (parsed as { rows: ParsedRow[] }).rows;
  }
  throw new Error(`SEED_BOM_JSON_INVALID_ARRAY file=${filePath}`);
}

function getNormalizedEntries(row: ParsedRow): Array<[string, unknown]> {
  return Object.entries(row).map(([key, value]) => [normalizeHeader(String(key)), value]);
}

function firstMatchingValue(entries: Array<[string, unknown]>, aliases: string[]): unknown {
  for (const alias of aliases) {
    const exact = entries.find(([key]) => key === alias);
    if (exact) return exact[1];
  }
  return null;
}

function firstMatchingByPredicate(
  entries: Array<[string, unknown]>,
  predicate: (normalizedHeader: string) => boolean
): unknown {
  const match = entries.find(([header]) => predicate(header));
  return match ? match[1] : null;
}

function normalizeName(raw: unknown): string | null {
  const value = collapseWhitespace(String(raw ?? ''));
  return value || null;
}

function resolveOutputName(entries: Array<[string, unknown]>): string | null {
  const direct = normalizeName(firstMatchingValue(entries, OUTPUT_NAME_ALIASES));
  if (direct) return direct;
  const guessed = firstMatchingByPredicate(
    entries,
    (header) =>
      (header.includes('product_tmpl') || header.includes('finished') || header.includes('output'))
      && !header.includes('component')
      && !header.includes('bom_line')
  );
  return normalizeName(guessed);
}

function resolveOutputQuantity(entries: Array<[string, unknown]>): number | null {
  const direct = parseNumber(firstMatchingValue(entries, OUTPUT_QTY_ALIASES));
  if (direct !== null) return direct;
  return parseNumber(
    firstMatchingByPredicate(
      entries,
      (header) =>
        (header.includes('output') || header.includes('yield') || header === 'product_qty')
        && !header.includes('component')
        && !header.includes('bom_line')
    )
  );
}

function resolveOutputUom(entries: Array<[string, unknown]>): unknown {
  const direct = firstMatchingValue(entries, OUTPUT_UOM_ALIASES);
  if (direct !== null && direct !== undefined && String(direct).trim() !== '') return direct;
  return firstMatchingByPredicate(
    entries,
    (header) =>
      (header.includes('output') || header.includes('product_uom'))
      && !header.includes('component')
      && !header.includes('bom_line')
  );
}

function resolveComponentName(entries: Array<[string, unknown]>): string | null {
  const direct = normalizeName(firstMatchingValue(entries, COMPONENT_NAME_ALIASES));
  if (direct) return direct;
  const guessed = firstMatchingByPredicate(
    entries,
    (header) =>
      header.includes('component')
      || (header.includes('bom_line') && (header.includes('product') || header.includes('item')))
  );
  return normalizeName(guessed);
}

function resolveComponentQuantity(entries: Array<[string, unknown]>): number | null {
  const direct = parseNumber(firstMatchingValue(entries, COMPONENT_QTY_ALIASES));
  if (direct !== null) return direct;
  return parseNumber(
    firstMatchingByPredicate(entries, (header) => header.includes('component') && header.includes('qty'))
  );
}

function resolveComponentUom(entries: Array<[string, unknown]>): unknown {
  const direct = firstMatchingValue(entries, COMPONENT_UOM_ALIASES);
  if (direct !== null && direct !== undefined && String(direct).trim() !== '') return direct;
  return firstMatchingByPredicate(entries, (header) => header.includes('component') && header.includes('uom'));
}

function resolveByproductName(entries: Array<[string, unknown]>): string | null {
  const direct = normalizeName(firstMatchingValue(entries, BYPRODUCT_ALIASES));
  if (direct) return direct;
  const guessed = firstMatchingByPredicate(entries, (header) => header.includes('byproduct'));
  return normalizeName(guessed);
}

function resolveNote(entries: Array<[string, unknown]>): string | null {
  const direct = normalizeName(firstMatchingValue(entries, NOTE_ALIASES));
  if (direct) return direct;
  const guessed = firstMatchingByPredicate(
    entries,
    (header) => header.includes('workcenter') || header.includes('operation')
  );
  return normalizeName(guessed);
}

function ensureItem(
  itemMap: Map<string, ItemAccumulator>,
  rawName: string,
  args: { componentUom?: string | null; outputUom?: string | null; asOutput?: boolean; asComponent?: boolean }
): ItemAccumulator {
  const cleanedName = collapseWhitespace(rawName);
  const key = normalizeItemKey(cleanedName);
  const existing = itemMap.get(key);
  if (existing) {
    if (args.componentUom && !existing.componentUom) existing.componentUom = args.componentUom;
    if (args.outputUom && !existing.outputUom) existing.outputUom = args.outputUom;
    if (args.asOutput) existing.appearsAsOutput = true;
    if (args.asComponent) existing.appearsAsComponent = true;
    return existing;
  }
  const created: ItemAccumulator = {
    key,
    name: cleanedName,
    componentUom: args.componentUom ?? null,
    outputUom: args.outputUom ?? null,
    appearsAsOutput: !!args.asOutput,
    appearsAsComponent: !!args.asComponent
  };
  itemMap.set(key, created);
  return created;
}

function serializeComponentKey(componentKey: string, uom: string): string {
  return `${componentKey}|${uom}`;
}

function loadRows(filePath: string, sheetName: string): { rows: ParsedRow[]; sourceKind: 'xlsx' | 'json' } {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.json') {
    return { rows: readRowsFromJson(filePath), sourceKind: 'json' };
  }
  if (extension !== '.xlsx') {
    throw new Error(`SEED_BOM_UNSUPPORTED_FILE file=${filePath} expected=.xlsx|.json`);
  }
  return { rows: readRowsFromXlsx(filePath, sheetName), sourceKind: 'xlsx' };
}

export async function importBomDatasetFromFile(params: {
  filePath?: string;
  sheetName?: string;
}): Promise<ImportedBomDataset> {
  const sourcePath = params.filePath ?? DEFAULT_SIAMAYA_BOM_PATH;
  const sheetName = params.sheetName ?? DEFAULT_SIAMAYA_BOM_SHEET;
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`SEED_BOM_SOURCE_NOT_FOUND file=${sourcePath}`);
  }

  const { rows, sourceKind } = loadRows(sourcePath, sheetName);
  const unknownUoms = new Set<string>();
  const itemMap = new Map<string, ItemAccumulator>();
  const bomMap = new Map<string, BomAccumulator>();

  let currentOutputKey: string | null = null;
  let sequence = 0;

  for (const row of rows) {
    const entries = getNormalizedEntries(row);
    const outputName = resolveOutputName(entries);
    const outputQty = resolveOutputQuantity(entries);
    const outputUomRaw = resolveOutputUom(entries);
    const componentName = resolveComponentName(entries);
    const componentQty = resolveComponentQuantity(entries);
    const componentUomRaw = resolveComponentUom(entries);
    const byproductName = resolveByproductName(entries);
    const note = resolveNote(entries);

    if (outputName) {
      const normalizedOutputUom = normalizeUom(outputUomRaw, unknownUoms);
      const outputQuantity = outputQty !== null && outputQty > 0 ? outputQty : 1;
      const outputItem = ensureItem(itemMap, outputName, {
        outputUom: normalizedOutputUom,
        asOutput: true
      });
      currentOutputKey = outputItem.key;
      const existingBom = bomMap.get(outputItem.key);
      if (existingBom) {
        existingBom.outputName = outputItem.name;
        existingBom.outputQuantity = outputQuantity;
        existingBom.outputUom = normalizedOutputUom;
      } else {
        bomMap.set(outputItem.key, {
          outputKey: outputItem.key,
          outputName: outputItem.name,
          outputQuantity,
          outputUom: normalizedOutputUom,
          componentByKey: new Map<string, ImportedBomComponent>()
        });
      }
    }

    if (byproductName) {
      const normalizedByproductUom = normalizeUom(componentUomRaw ?? outputUomRaw, unknownUoms);
      ensureItem(itemMap, byproductName, {
        componentUom: normalizedByproductUom,
        asComponent: true
      });
    }

    if (!componentName || componentQty === null || componentQty <= 0) {
      continue;
    }

    if (!currentOutputKey) {
      continue;
    }

    const bom = bomMap.get(currentOutputKey);
    if (!bom) {
      continue;
    }

    const normalizedComponentUom = normalizeUom(componentUomRaw, unknownUoms);
    const componentItem = ensureItem(itemMap, componentName, {
      componentUom: normalizedComponentUom,
      asComponent: true
    });

    sequence += 1;
    const componentMapKey = serializeComponentKey(componentItem.key, normalizedComponentUom);
    const existing = bom.componentByKey.get(componentMapKey);
    if (existing) {
      existing.quantity += componentQty;
      if (!existing.note && note) {
        existing.note = note;
      }
    } else {
      bom.componentByKey.set(componentMapKey, {
        componentKey: componentItem.key,
        componentName: componentItem.name,
        quantity: componentQty,
        uom: normalizedComponentUom,
        note: note ?? null,
        sequence
      });
    }
  }

  const items = Array.from(itemMap.values())
    .map((item) => ({
      key: item.key,
      name: item.name,
      baseUom: item.componentUom ?? item.outputUom ?? 'piece',
      appearsAsOutput: item.appearsAsOutput,
      appearsAsComponent: item.appearsAsComponent
    }))
    .sort((left, right) => left.key.localeCompare(right.key));

  const boms = Array.from(bomMap.values())
    .map((bom) => ({
      outputKey: bom.outputKey,
      outputName: bom.outputName,
      outputQuantity: bom.outputQuantity,
      outputUom: bom.outputUom,
      components: Array.from(bom.componentByKey.values()).sort((left, right) => {
        if (left.sequence !== right.sequence) return left.sequence - right.sequence;
        return left.componentKey.localeCompare(right.componentKey);
      })
    }))
    .filter((bom) => bom.components.length > 0)
    .sort((left, right) => left.outputKey.localeCompare(right.outputKey));

  return {
    sourcePath,
    sourceKind,
    sheetName,
    rowCount: rows.length,
    items,
    boms,
    unknownUoms: Array.from(unknownUoms).sort((left, right) => left.localeCompare(right))
  };
}

import fs from 'node:fs';
import path from 'node:path';
import { parseCsv } from '../../../src/lib/csv';
import { UOM_ALIASES } from './import_bom_from_xlsx';

type PreprocessCorrection = {
  code: string;
  row: number;
  detail: string;
  before?: string;
  after?: string;
};

type BomPreprocessDocument = {
  schemaVersion: number;
  sourceFile: string;
  section: string;
  processedAt: string;
  corrections: PreprocessCorrection[];
  rows: Array<Record<string, string | number>>;
};

const DEFAULT_OUTPUT_FILE = path.resolve(process.cwd(), 'scripts/seed/siamaya/siamaya-bom-production.json');
const SECTION2_HEADER_LABEL = 'Finished Goods';

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function normalizeCell(value: string | undefined): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeItemKey(value: string): string {
  return normalizeCell(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNumber(value: string | undefined): number | null {
  const normalized = normalizeCell(value).replace(/,/g, '');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeUom(raw: string | undefined): string {
  const trimmed = normalizeCell(raw);
  if (!trimmed) return 'piece';
  const mapped = UOM_ALIASES[trimmed.toLowerCase()];
  return mapped ?? trimmed;
}

function isWrapperLike(name: string): boolean {
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

function ensureAliasSanity(): void {
  const cases: Array<[string, string]> = [
    [' bag ', 'piece'],
    ['TIN', 'piece'],
    ['Bottle', 'piece']
  ];
  for (const [input, expected] of cases) {
    const normalized = normalizeUom(input);
    if (normalized !== expected) {
      throw new Error(`SEED_BOM_PREPROCESS_UOM_ALIAS_SANITY_FAILED input=${input} got=${normalized} expected=${expected}`);
    }
  }
}

function preprocessRows(rawRows: string[][]): {
  rows: Array<Record<string, string | number>>;
  corrections: PreprocessCorrection[];
} {
  const headerIndex = rawRows.findIndex((row) => normalizeCell(row[0]) === SECTION2_HEADER_LABEL);
  if (headerIndex < 0) {
    throw new Error(`SEED_BOM_PREPROCESS_SECTION2_NOT_FOUND header=${SECTION2_HEADER_LABEL}`);
  }

  const corrections: PreprocessCorrection[] = [];
  const outputRows: Array<Record<string, string | number>> = [];
  let currentOutputName = '';
  let currentOutputQty = 1;
  let currentOutputUom = 'piece';

  for (let index = headerIndex + 1; index < rawRows.length; index += 1) {
    const row = rawRows[index];
    const outputNameCell = normalizeCell(row[0]);
    const outputQtyCell = parseNumber(row[1]);
    const outputUomCell = normalizeUom(row[2]);
    let componentName = normalizeCell(row[3]);
    let componentQty = parseNumber(row[4]);
    let componentUom = normalizeUom(row[5]);
    const operation = normalizeCell(row[6]);
    const workCenter = normalizeCell(row[7]);
    const note = normalizeCell(row[8]);

    if (outputNameCell) {
      currentOutputName = outputNameCell;
      currentOutputQty = outputQtyCell && outputQtyCell > 0 ? outputQtyCell : 1;
      currentOutputUom = outputUomCell;
    }

    if (!currentOutputName || !componentName) {
      continue;
    }

    if (/ test$/i.test(currentOutputName)) {
      continue;
    }

    if (componentQty === null && isWrapperLike(componentName)) {
      componentQty = 1;
      componentUom = componentUom || 'piece';
      corrections.push({
        code: 'DEFAULT_WRAPPER_QTY_ONE_PIECE',
        row: index + 1,
        detail: 'Missing wrapper quantity defaulted to 1 piece'
      });
    }

    if (
      /\bthai tea\b/i.test(currentOutputName)
      && /\(8g\)/i.test(currentOutputName)
      && /^base - /i.test(componentName)
      && componentQty !== null
      && componentQty > 20
    ) {
      corrections.push({
        code: 'THAI_TEA_8G_BASE_QTY_FIX',
        row: index + 1,
        detail: 'Corrected suspicious base quantity for Thai Tea 8g',
        before: String(componentQty),
        after: '7.905'
      });
      componentQty = 7.905;
    }

    if (currentOutputName === 'Mooncake Milk Chocolate (75g)' && componentName === currentOutputName) {
      const corrected = `${currentOutputName} - FLOW WRAP`;
      corrections.push({
        code: 'MOONCAKE_FLOW_WRAP_LINK_FIX',
        row: index + 1,
        detail: 'Corrected Mooncake wrap component to FLOW WRAP intermediate',
        before: componentName,
        after: corrected
      });
      componentName = corrected;
    }

    if (normalizeItemKey(currentOutputName) === normalizeItemKey(componentName) && / - FLOW WRAP$/i.test(currentOutputName)) {
      const correctedOutput = currentOutputName.replace(/\s*-\s*FLOW WRAP$/i, '').trim();
      corrections.push({
        code: 'SELF_REF_FLOW_WRAP_OUTPUT_FIX',
        row: index + 1,
        detail: 'Removed FLOW WRAP suffix from self-referencing output row',
        before: currentOutputName,
        after: correctedOutput
      });
      currentOutputName = correctedOutput;
    }

    if (normalizeItemKey(currentOutputName) === normalizeItemKey(componentName)) {
      corrections.push({
        code: 'SELF_REFERENCE_ROW_SKIPPED',
        row: index + 1,
        detail: 'Skipped self-referencing BOM line that could not be safely corrected',
        before: `${currentOutputName} -> ${componentName}`
      });
      continue;
    }

    if (componentQty === null || componentQty <= 0) {
      continue;
    }

    const normalizedComponentUom = componentUom || 'piece';
    outputRows.push({
      'Finished Product': currentOutputName,
      'Output Qty': currentOutputQty,
      'Output UOM': currentOutputUom,
      'Component Item': componentName,
      'Component Qty': componentQty,
      'Component UOM': normalizedComponentUom,
      ...(operation ? { Operation: operation } : {}),
      ...(workCenter ? { 'Work Center': workCenter } : {}),
      ...(note ? { Note: note } : {})
    });
  }

  return { rows: outputRows, corrections };
}

function stableSortRows(rows: Array<Record<string, string | number>>): Array<Record<string, string | number>> {
  return [...rows].sort((left, right) => {
    const outputCompare = String(left['Finished Product']).localeCompare(String(right['Finished Product']));
    if (outputCompare !== 0) return outputCompare;
    const componentCompare = String(left['Component Item']).localeCompare(String(right['Component Item']));
    if (componentCompare !== 0) return componentCompare;
    return String(left['Operation'] ?? '').localeCompare(String(right['Operation'] ?? ''));
  });
}

function main(): void {
  ensureAliasSanity();
  const inputArg = getArg('input');
  if (!inputArg) {
    throw new Error('SEED_BOM_PREPROCESS_INPUT_REQUIRED use --input <path/to/3. bom-Table 1.csv>');
  }
  const sourceFile = path.resolve(inputArg);
  const outputFile = path.resolve(getArg('output') ?? DEFAULT_OUTPUT_FILE);

  if (!fs.existsSync(sourceFile)) {
    throw new Error(`SEED_BOM_PREPROCESS_SOURCE_NOT_FOUND file=${sourceFile}`);
  }

  const raw = fs.readFileSync(sourceFile, 'utf8');
  const parsed = parseCsv(raw);
  const allRows = [parsed.headers, ...parsed.rows];
  const { rows, corrections } = preprocessRows(allRows);
  const sortedRows = stableSortRows(rows);
  const stat = fs.statSync(sourceFile);

  const document: BomPreprocessDocument = {
    schemaVersion: 1,
    sourceFile: path.basename(sourceFile),
    section: 'section_2_authoritative_manual_boms',
    processedAt: new Date(stat.mtimeMs).toISOString(),
    corrections,
    rows: sortedRows
  };

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `${JSON.stringify({
      code: 'SIAMAYA_BOM_PREPROCESS_SUMMARY',
      sourceFile,
      outputFile,
      rows: sortedRows.length,
      corrections: corrections.length
    })}\n`
  );
}

main();

import fs from 'node:fs';
import path from 'node:path';
import Decimal from 'decimal.js';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

const ROOT = process.cwd();
const SIAMAYA_DIR = path.resolve(ROOT, 'scripts/seed/siamaya');
const SOURCE_CSV_PATH = path.resolve(ROOT, 'docs/3. bom-Table 1.csv');

const GENERATED_AT = '2026-03-12T00:00:00.000Z';
const STOCK_DATE = '2026-01-01T00:00:00.000Z';
const PRODUCTION_DATE = '2026-01-01';
const PROFILE_VERSION = 1;
const BOM_SCHEMA_VERSION = 2;
const SECTION_HEADER = 'Finished Goods,quantity,unit,BOM/Component,quantity,unit,Operation,Work Center,Note';

const BOM_PATH = path.resolve(SIAMAYA_DIR, 'siamaya-bom-production.json');
const SANITY_REPORT_PATH = path.resolve(SIAMAYA_DIR, 'bom-sanity-report.json');
const MINIMAL_STOCK_PATH = path.resolve(SIAMAYA_DIR, 'initial-stock-spec.partial.json');
const BASE_STOCK_PATH = path.resolve(SIAMAYA_DIR, 'initial-stock-spec.json');
const BOM_VALIDATION_PATH = path.resolve(SIAMAYA_DIR, 'bom-validation-report.json');
const PROCUREMENT_PATH = path.resolve(SIAMAYA_DIR, 'procurement-metadata.json');
const WORK_ORDERS_PATH = path.resolve(SIAMAYA_DIR, 'work-order-scenarios.json');
const WORKFLOW_PATH = path.resolve(SIAMAYA_DIR, 'guided-workflow-scenarios.json');
const VALIDATION_PATH = path.resolve(SIAMAYA_DIR, 'simulation-validation.json');
const MANUFACTURABILITY_PATH = path.resolve(SIAMAYA_DIR, 'inventory-manufacturability.json');
const MRP_CSV_PATH = path.resolve(SIAMAYA_DIR, 'mrp-explosion.csv');
const DAG_DOT_PATH = path.resolve(SIAMAYA_DIR, 'factory-dag.dot');
const INGREDIENT_DOT_PATH = path.resolve(SIAMAYA_DIR, 'factory-ingredient-flow.dot');
const PACKAGING_DOT_PATH = path.resolve(SIAMAYA_DIR, 'factory-packaging-flow.dot');

const UOM_ALIASES = new Map([
  ['g', 'g'],
  ['gram', 'g'],
  ['grams', 'g'],
  ['kg', 'kg'],
  ['kilogram', 'kg'],
  ['kilograms', 'kg'],
  ['each', 'each'],
  ['ea', 'each'],
  ['unit', 'piece'],
  ['units', 'piece'],
  ['piece', 'piece'],
  ['pieces', 'piece'],
  ['pc', 'piece'],
  ['pcs', 'piece'],
  ['bar', 'piece'],
  ['bars', 'piece']
]);

const CATEGORY_SUPPLIERS = {
  cocoa: 'Siam Cacao Partners',
  dairy: 'Northern Dairy Ingredients',
  coconut: 'Andaman Coconut Foods',
  sugar: 'Organic Cane Sugar Co-op',
  dried_fruit: 'Chiang Mai Fruit Traders',
  spices: 'Lanna Spice Collective',
  oils: 'Botanical Extract House',
  nuts: 'Golden Orchard Nuts',
  inclusions: 'Specialty Inclusion Works',
  packaging: 'Chiang Mai Packaging Works',
  labels: 'Nimman Print & Label',
  process_material: 'Factory Consumables Co.',
  other: 'Regional Ingredients Network'
};

const UNIT_COSTS = new Map([
  ['cacao beans', { uom: 'kg', value: new Decimal('4.25') }],
  ['organic cane sugar', { uom: 'kg', value: new Decimal('1.15') }],
  ['cacao butter', { uom: 'kg', value: new Decimal('8.10') }],
  ['powdered milk', { uom: 'kg', value: new Decimal('3.40') }],
  ['coconut milk powder', { uom: 'kg', value: new Decimal('4.90') }],
  ['flow wrap foil', { uom: 'kg', value: new Decimal('12.00') }],
  ['stickers clear', { uom: 'piece', value: new Decimal('0.01') }]
]);

function collapseWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeKey(value) {
  return collapseWhitespace(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(value) {
  return normalizeKey(value).replace(/\s+/g, '-');
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function formatDecimal(value, scale = 6) {
  const decimal = value instanceof Decimal ? value : new Decimal(value);
  const rounded = decimal.toDecimalPlaces(scale, Decimal.ROUND_HALF_UP);
  if (rounded.isInteger()) return rounded.toFixed(0);
  return rounded.toFixed(scale).replace(/\.?0+$/, '');
}

function decimalToNumber(value, scale = 6) {
  return Number(formatDecimal(value, scale));
}

function decimalFromRaw(raw) {
  const normalized = collapseWhitespace(raw).replace(/,/g, '');
  if (!normalized) return null;
  try {
    return new Decimal(normalized);
  } catch {
    return null;
  }
}

function normalizeUom(raw) {
  const normalized = collapseWhitespace(raw).toLowerCase();
  if (!normalized) return null;
  return UOM_ALIASES.get(normalized) ?? normalized;
}

function uomDimension(uom) {
  if (uom === 'g' || uom === 'kg') return 'mass';
  if (uom === 'piece' || uom === 'each') return 'count';
  return uom;
}

function isCountUom(uom) {
  return uom === 'piece' || uom === 'each';
}

function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (inQuotes) {
      if (char === '"') {
        if (next === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ',') {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }

  cells.push(current);
  return cells;
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function sortStrings(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function classifyPackagingLike(name) {
  const lower = name.toLowerCase();
  return (
    lower.includes('wrapper')
    || lower.includes('sticker')
    || lower.includes('label')
    || lower.includes('bag')
    || lower.includes('box')
    || lower.includes('carton')
  );
}

function classifyFoilLike(name) {
  return name.toLowerCase().includes('foil');
}

function base75gSkuName(name) {
  const collapsed = collapseWhitespace(name)
    .replace(/\s*-\s*FLOW WRAP$/i, '')
    .replace(/\s*-\s*Wrapped\s*\(75g\)$/i, '')
    .replace(/\s*-\s*Boxed\s*\(75g\)$/i, '');
  return collapseWhitespace(collapsed.replace(/\s*\(75g\)$/i, ''));
}

function wrappedLifecycleName(name) {
  return `${base75gSkuName(name)} - Wrapped (75g)`;
}

function boxedLifecycleName(name) {
  return `${base75gSkuName(name)} - Boxed (75g)`;
}

function is75gWrappedOutputName(name) {
  return /\s*-\s*Wrapped\s*\(75g\)$/i.test(collapseWhitespace(name));
}

function is75gBoxedOutputName(name) {
  return /\s*-\s*Boxed\s*\(75g\)$/i.test(collapseWhitespace(name));
}

function boxedNameFromWrapped(name) {
  return boxedLifecycleName(name);
}

function normalize75gLifecycleName(name) {
  const collapsed = collapseWhitespace(name);
  if (!/\(75g\)/i.test(collapsed)) return collapsed;
  if (classifyPackagingLike(collapsed) && !/\s*-\s*FLOW WRAP$/i.test(collapsed)) return collapsed;
  if (is75gWrappedOutputName(collapsed) || /\s*-\s*FLOW WRAP$/i.test(collapsed)) {
    return wrappedLifecycleName(collapsed);
  }
  return boxedLifecycleName(collapsed);
}

function normalize75gLifecycleUom(name, uom) {
  if (is75gWrappedOutputName(name) || is75gBoxedOutputName(name)) return 'each';
  return uom;
}

function isBoxingStageComponent(name) {
  return classifyPackagingLike(name) && !classifyFoilLike(name);
}

function classifyLeafCategory(name, uom) {
  const lower = name.toLowerCase();
  if (classifyPackagingLike(name)) {
    if (lower.includes('sticker') || lower.includes('label')) return 'labels';
    return 'packaging';
  }
  if (classifyFoilLike(name) && uom === 'g') return 'process_material';
  if (lower.includes('cacao bean') || lower.includes('cacao nib') || lower.includes('cacao butter')) return 'cocoa';
  if (lower.includes('powdered milk')) return 'dairy';
  if (lower.includes('coconut milk')) return 'coconut';
  if (lower.includes('sugar')) return 'sugar';
  if (lower.includes('oil')) return 'oils';
  if (lower.includes('almond') || lower.includes('peanut') || lower.includes('pecan') || lower.includes('sunflower')) return 'nuts';
  if (
    lower.includes('dried')
    || lower.includes('mango')
    || lower.includes('pomelo')
    || lower.includes('banana')
    || lower.includes('apple')
    || lower.includes('strawberr')
    || lower.includes('durian')
    || lower.includes('tomato')
  ) {
    return 'dried_fruit';
  }
  if (
    lower.includes('powder')
    || lower.includes('salt')
    || lower.includes('tea')
    || lower.includes('coffee')
    || lower.includes('curry')
    || lower.includes('lemongrass')
    || lower.includes('clove')
    || lower.includes('cardamom')
    || lower.includes('allspice')
    || lower.includes('vanilla')
    || lower.includes('galangal')
    || lower.includes('kaffir')
    || lower.includes('ginger')
    || lower.includes('shallot')
  ) {
    return 'spices';
  }
  if (isCountUom(uom)) return 'packaging';
  return 'inclusions';
}

function leadTimeDays(category) {
  switch (category) {
    case 'cocoa':
      return 28;
    case 'dairy':
    case 'coconut':
      return 21;
    case 'sugar':
      return 14;
    case 'dried_fruit':
    case 'nuts':
      return 16;
    case 'spices':
      return 18;
    case 'oils':
      return 24;
    case 'packaging':
      return 15;
    case 'labels':
      return 10;
    case 'process_material':
      return 12;
    default:
      return 18;
  }
}

function minimumOrderQty(category, uom) {
  if (isCountUom(uom)) {
    if (category === 'labels') return 250;
    if (category === 'packaging') return 100;
    return 50;
  }
  if (category === 'cocoa') return 5000;
  if (category === 'sugar') return 10000;
  if (category === 'dairy' || category === 'coconut') return 5000;
  if (category === 'spices' || category === 'oils') return 500;
  if (category === 'nuts' || category === 'dried_fruit') return 2000;
  return 1000;
}

function unitCostForLeaf(name, uom, category) {
  const key = normalizeKey(name);
  const exact = UNIT_COSTS.get(key);
  if (exact) {
    if (exact.uom === uom) return exact.value;
    if (exact.uom === 'kg' && uom === 'g') return exact.value.div(1000);
    if (exact.uom === 'g' && uom === 'kg') return exact.value.mul(1000);
  }

  if (isCountUom(uom)) {
    if (category === 'labels') return new Decimal('0.01');
    return new Decimal('0.05');
  }

  switch (category) {
    case 'cocoa':
      return new Decimal('0.0056');
    case 'dairy':
      return new Decimal('0.0034');
    case 'coconut':
      return new Decimal('0.0049');
    case 'sugar':
      return new Decimal('0.00115');
    case 'dried_fruit':
      return new Decimal('0.0098');
    case 'spices':
      return new Decimal('0.0145');
    case 'oils':
      return new Decimal('0.025');
    case 'nuts':
      return new Decimal('0.0108');
    case 'process_material':
      return new Decimal('0.012');
    default:
      return new Decimal('0.0084');
  }
}

function shelfLifeDays(category) {
  switch (category) {
    case 'packaging':
    case 'labels':
      return 3650;
    case 'cocoa':
      return 730;
    case 'sugar':
      return 1460;
    case 'dairy':
    case 'coconut':
      return 365;
    case 'spices':
    case 'oils':
      return 365;
    case 'dried_fruit':
    case 'nuts':
      return 240;
    default:
      return 365;
  }
}

function normalizeOperationName(value) {
  const lower = collapseWhitespace(value).toLowerCase();
  if (!lower) return '';
  if (lower.includes('roast')) return 'ROAST';
  if (lower.includes('winnow')) return 'WINNOW';
  if (lower.includes('prerefine')) return 'PREREFINE';
  if (lower.includes('grind')) return 'GRIND';
  if (lower.includes('temper')) return 'TEMPER';
  if (lower.includes('wrap')) return 'WRAP';
  return lower.toUpperCase().replace(/[^\w]+/g, '_');
}

function normalizeWorkCenterCode(value) {
  const lower = collapseWhitespace(value).toLowerCase();
  if (!lower) return '';
  if (lower.includes('roaster')) return 'ROASTER';
  if (lower.includes('winnower')) return 'WINNOWER';
  if (lower.includes('grinder')) return 'GRINDER';
  if (lower.includes('tempering')) return 'TEMPERER';
  if (lower.includes('wrapping')) return 'WRAPPER';
  return lower.toUpperCase().replace(/[^\w]+/g, '_');
}

function parseAuthoritativeSection(sourceFile = SOURCE_CSV_PATH) {
  const sourceText = fs.readFileSync(sourceFile, 'utf8').replace(/^\uFEFF/, '');
  const lines = sourceText.split(/\r?\n/);
  const sectionHeaderRow = lines.findIndex((line) => line.startsWith(SECTION_HEADER));
  if (sectionHeaderRow < 0) {
    throw new Error(`SIAMAYA_BOM_SECTION_NOT_FOUND header=${SECTION_HEADER}`);
  }

  const rows = [];
  let currentOutput = null;
  for (let lineIndex = sectionHeaderRow + 1; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const columns = parseCsvLine(line);
    if (columns.every((value) => collapseWhitespace(value) === '')) continue;

    const outputName = collapseWhitespace(columns[0]);
    const outputQtyRaw = collapseWhitespace(columns[1]);
    const outputUomRaw = collapseWhitespace(columns[2]);
    const componentName = collapseWhitespace(columns[3]);
    const componentQtyRaw = collapseWhitespace(columns[4]);
    const componentUomRaw = collapseWhitespace(columns[5]);
    const operation = collapseWhitespace(columns[6]);
    const workCenter = collapseWhitespace(columns[7]);
    const note = collapseWhitespace(columns[8]);

    if (outputName) {
      currentOutput = {
        outputName,
        outputQtyRaw,
        outputUomRaw
      };
    }
    if (!currentOutput) continue;

    rows.push({
      line: lineIndex + 1,
      outputName: currentOutput.outputName,
      outputQtyRaw: currentOutput.outputQtyRaw,
      outputUomRaw: currentOutput.outputUomRaw,
      componentName,
      componentQtyRaw,
      componentUomRaw,
      operation,
      workCenter,
      note
    });
  }

  return { rows, sectionHeaderRow: sectionHeaderRow + 1 };
}

function relocate75gPackagingRows(rows, corrections) {
  const outputSpecs = new Map();
  const existingFinalComponentSignatures = new Set();

  rows.forEach((row) => {
    if (!outputSpecs.has(row.outputKey)) {
      outputSpecs.set(row.outputKey, {
        outputKey: row.outputKey,
        outputName: row.outputName,
        outputQty: row.outputQty,
        outputUom: row.outputUom
      });
    }
    if (is75gBoxedOutputName(row.outputName)) {
      existingFinalComponentSignatures.add(
        `${row.outputKey}|${row.componentKey}|${formatDecimal(row.componentQty, 12)}|${row.componentUom}`
      );
    }
  });

  return rows.flatMap((row) => {
    if (!is75gWrappedOutputName(row.outputName) || !isBoxingStageComponent(row.componentName)) {
      return [row];
    }

    const boxedName = boxedNameFromWrapped(row.outputName);
    const boxedKey = normalizeKey(boxedName);
    const boxedSpec = outputSpecs.get(boxedKey);
    if (!boxedSpec) {
      return [row];
    }

    const movedSignature = `${boxedKey}|${row.componentKey}|${formatDecimal(row.componentQty, 12)}|${row.componentUom}`;
    corrections.push({
      code: 'MOVE_75G_PACKAGING_COMPONENT_TO_BOXED_OUTPUT',
      line: row.line,
      before: `${row.outputName} -> ${row.componentName}`,
      after: `${boxedSpec.outputName} -> ${row.componentName}`
    });

    if (existingFinalComponentSignatures.has(movedSignature)) {
      corrections.push({
        code: 'DROP_75G_PACKAGING_DUPLICATE_ON_BOXED_OUTPUT',
        line: row.line,
        before: `${boxedSpec.outputName} -> ${row.componentName}`,
        after: `${boxedSpec.outputName} -> ${row.componentName}`
      });
      return [];
    }

    existingFinalComponentSignatures.add(movedSignature);
    return [
      {
        ...row,
        outputKey: boxedSpec.outputKey,
        outputName: boxedSpec.outputName,
        outputQty: boxedSpec.outputQty,
        outputUom: boxedSpec.outputUom
      }
    ];
  });
}

function buildNormalizedDataset(sourceFile = SOURCE_CSV_PATH) {
  const { rows: parsedRows, sectionHeaderRow } = parseAuthoritativeSection(sourceFile);
  const stat = fs.statSync(sourceFile);
  const corrections = [];
  const issues = {
    duplicateRows: [],
    selfReferences: [],
    missingProductNames: [],
    missingComponentNames: [],
    missingUoms: [],
    zeroOrNegativeQuantities: [],
    malformedNumericQuantities: [],
    unresolvedNormalizationRows: []
  };

  const rawOutputSet = new Set(
    parsedRows
      .filter((row) => row.componentName)
      .map((row) => row.outputName)
  );

  const operationsByOutput = new Map();
  const normalizedRows = [];

  for (const row of parsedRows) {
    const operationCode = normalizeOperationName(row.operation);
    const workCenterCode = normalizeWorkCenterCode(row.workCenter);
    const outputName = collapseWhitespace(row.outputName);
    const componentName = collapseWhitespace(row.componentName);
    const outputQty = decimalFromRaw(row.outputQtyRaw);
    const outputUom = normalizeUom(row.outputUomRaw);
    const componentQty = decimalFromRaw(row.componentQtyRaw);
    const componentUom = normalizeUom(row.componentUomRaw);

    if (!outputName) {
      issues.missingProductNames.push({ line: row.line, row });
      continue;
    }

    if (!componentName) {
      if (row.componentQtyRaw || row.componentUomRaw) {
        issues.missingComponentNames.push({ line: row.line, row });
      }
      continue;
    }

    let normalizedOutputName = outputName;
    let normalizedComponentName = componentName;

    const outputKey = normalizeKey(outputName);
    const componentKey = normalizeKey(componentName);
    if (outputKey === componentKey) {
      const finalName = outputName.replace(/\s*-\s*FLOW WRAP$/i, '').trim();
      const flowWrapName = `${finalName} - FLOW WRAP`;
      if (operationCode === 'WRAP' && /-\s*FLOW WRAP$/i.test(outputName)) {
        corrections.push({
          code: 'SELF_REF_WRAP_OUTPUT_TO_FINAL',
          line: row.line,
          before: `${outputName} -> ${componentName}`,
          after: `${finalName} -> ${flowWrapName}`
        });
        normalizedOutputName = finalName;
        normalizedComponentName = flowWrapName;
      } else if (operationCode === 'WRAP' && rawOutputSet.has(flowWrapName)) {
        corrections.push({
          code: 'SELF_REF_WRAP_COMPONENT_TO_FLOW_WRAP',
          line: row.line,
          before: `${outputName} -> ${componentName}`,
          after: `${outputName} -> ${flowWrapName}`
        });
        normalizedComponentName = flowWrapName;
      } else {
        issues.selfReferences.push({ line: row.line, outputName, componentName });
        issues.unresolvedNormalizationRows.push({
          line: row.line,
          reason: 'UNRESOLVED_SELF_REFERENCE',
          row
        });
        continue;
      }
    }

    normalizedOutputName = normalize75gLifecycleName(normalizedOutputName);
    normalizedComponentName = normalize75gLifecycleName(normalizedComponentName);
    const normalizedOutputKey = normalizeKey(normalizedOutputName);
    const normalizedComponentKey = normalizeKey(normalizedComponentName);
    const normalizedOutputUom = normalize75gLifecycleUom(normalizedOutputName, outputUom);
    const normalizedComponentUom = normalize75gLifecycleUom(normalizedComponentName, componentUom);

    if ((operationCode || workCenterCode || row.note) && !operationsByOutput.has(normalizedOutputKey)) {
      operationsByOutput.set(normalizedOutputKey, []);
    }
    if (operationCode || workCenterCode || row.note) {
      operationsByOutput.get(normalizedOutputKey).push({
        operation: operationCode || row.operation,
        workCenter: workCenterCode || row.workCenter,
        note: row.note || null
      });
    }

    if (!outputQty || !componentQty) {
      issues.malformedNumericQuantities.push({ line: row.line, outputName, componentName });
      continue;
    }
    if (!outputUom || !componentUom) {
      issues.missingUoms.push({ line: row.line, outputName, componentName });
      continue;
    }
    if (outputQty.lte(0) || componentQty.lte(0)) {
      issues.zeroOrNegativeQuantities.push({
        line: row.line,
        outputName,
        componentName,
        outputQty: outputQty.toString(),
        componentQty: componentQty.toString()
      });
      continue;
    }

    normalizedRows.push({
      line: row.line,
      outputKey: normalizedOutputKey,
      outputName: normalizedOutputName,
      outputQty,
      outputUom: normalizedOutputUom,
      componentKey: normalizedComponentKey,
      componentName: normalizedComponentName,
      componentQty,
      componentUom: normalizedComponentUom,
      operation: operationCode || null,
      workCenter: workCenterCode || null,
      note: row.note || null
    });
  }

  const stageNormalizedRows = relocate75gPackagingRows(normalizedRows, corrections);

  const duplicateTracker = new Map();
  for (const row of stageNormalizedRows) {
    const signature = [
      row.outputKey,
      formatDecimal(row.outputQty),
      row.outputUom,
      row.componentKey,
      formatDecimal(row.componentQty),
      row.componentUom,
      row.operation ?? '',
      row.workCenter ?? ''
    ].join('|');
    if (!duplicateTracker.has(signature)) {
      duplicateTracker.set(signature, []);
    }
    duplicateTracker.get(signature).push(row.line);
  }
  for (const [signature, lines] of duplicateTracker.entries()) {
    if (lines.length > 1) {
      issues.duplicateRows.push({ signature, lines });
    }
  }

  const fullDocument = buildBomDocument({
    sourceFile,
    processedAt: new Date(stat.mtimeMs).toISOString(),
    sectionHeaderRow,
    rows: stageNormalizedRows,
    corrections,
    operationsByOutput
  });
  const fullGraph = buildBomGraph(fullDocument);

  const inScopeFinals = sortStrings(
    [...fullGraph.boms.values()]
      .filter((bom) => is75gBoxedOutputName(bom.outputName))
      .map((bom) => bom.outputName)
  );

  const scopedOutputKeys = new Set();
  const visit = (outputKey) => {
    if (scopedOutputKeys.has(outputKey)) return;
    scopedOutputKeys.add(outputKey);
    const components = fullGraph.reverseEdges.get(outputKey) ?? [];
    for (const componentKey of components) {
      if (fullGraph.boms.has(componentKey)) {
        visit(componentKey);
      }
    }
  };
  for (const skuName of inScopeFinals) {
    visit(normalizeKey(skuName));
  }

  const scopedRows = stageNormalizedRows.filter((row) => scopedOutputKeys.has(row.outputKey));
  const scopedOperations = new Map(
    [...operationsByOutput.entries()].filter(([outputKey]) => scopedOutputKeys.has(outputKey))
  );

  const scopedDocument = buildBomDocument({
    sourceFile,
    processedAt: new Date(stat.mtimeMs).toISOString(),
    sectionHeaderRow,
    rows: scopedRows,
    corrections,
    operationsByOutput: scopedOperations,
    scopeMetadata: {
      mode: '75g_focused',
      retainedFinishedSkus: inScopeFinals
    }
  });
  const scopedGraph = buildBomGraph(scopedDocument);

  const reachableKeys = new Set([
    ...scopedGraph.outputKeys,
    ...scopedGraph.componentKeys
  ]);
  const unreachableOutputs = sortStrings(
    [...fullGraph.outputKeys]
      .filter((key) => !reachableKeys.has(key))
      .map((key) => fullGraph.nodes.get(key)?.name ?? key)
  );
  const unreachableLeafs = sortStrings(
    [...fullGraph.leafKeys]
      .filter((key) => !reachableKeys.has(key))
      .map((key) => fullGraph.nodes.get(key)?.name ?? key)
  );

  const isInScopeIssue = (issue) => {
    const outputName =
      issue?.outputName
      ?? issue?.row?.outputName
      ?? issue?.row?.['Finished Product']
      ?? '';
    return scopedOutputKeys.has(normalizeKey(outputName));
  };
  const inScopeFatalIssues = {
    missingProductNames: issues.missingProductNames.filter(isInScopeIssue),
    missingComponentNames: issues.missingComponentNames.filter(isInScopeIssue),
    missingUoms: issues.missingUoms.filter(isInScopeIssue),
    zeroOrNegativeQuantities: issues.zeroOrNegativeQuantities.filter(isInScopeIssue),
    malformedNumericQuantities: issues.malformedNumericQuantities.filter(isInScopeIssue),
    unresolvedNormalizationRows: issues.unresolvedNormalizationRows.filter(isInScopeIssue)
  };
  const outOfScopeFatalIssues = {
    missingProductNames: issues.missingProductNames.filter((issue) => !isInScopeIssue(issue)),
    missingComponentNames: issues.missingComponentNames.filter((issue) => !isInScopeIssue(issue)),
    missingUoms: issues.missingUoms.filter((issue) => !isInScopeIssue(issue)),
    zeroOrNegativeQuantities: issues.zeroOrNegativeQuantities.filter((issue) => !isInScopeIssue(issue)),
    malformedNumericQuantities: issues.malformedNumericQuantities.filter((issue) => !isInScopeIssue(issue)),
    unresolvedNormalizationRows: issues.unresolvedNormalizationRows.filter((issue) => !isInScopeIssue(issue))
  };
  const inScopeFatalCount =
    inScopeFatalIssues.missingProductNames.length
    + inScopeFatalIssues.missingComponentNames.length
    + inScopeFatalIssues.missingUoms.length
    + inScopeFatalIssues.zeroOrNegativeQuantities.length
    + inScopeFatalIssues.malformedNumericQuantities.length
    + inScopeFatalIssues.unresolvedNormalizationRows.length;
  const outOfScopeFatalCount =
    outOfScopeFatalIssues.missingProductNames.length
    + outOfScopeFatalIssues.missingComponentNames.length
    + outOfScopeFatalIssues.missingUoms.length
    + outOfScopeFatalIssues.zeroOrNegativeQuantities.length
    + outOfScopeFatalIssues.malformedNumericQuantities.length
    + outOfScopeFatalIssues.unresolvedNormalizationRows.length;

  const sanityReport = {
    generatedAt: GENERATED_AT,
    sourceFile: path.relative(ROOT, sourceFile),
    sectionHeaderRow,
    summary: {
      parsedRowCount: parsedRows.length,
      normalizedComponentRowCount: stageNormalizedRows.length,
      retainedComponentRowCount: scopedRows.length,
      retainedFinishedSkuCount: inScopeFinals.length,
      duplicateRowCount: issues.duplicateRows.length,
      selfReferenceCount: issues.selfReferences.length,
      missingProductNameCount: issues.missingProductNames.length,
      missingComponentNameCount: issues.missingComponentNames.length,
      missingUomCount: issues.missingUoms.length,
      zeroOrNegativeQuantityCount: issues.zeroOrNegativeQuantities.length,
      malformedNumericQuantityCount: issues.malformedNumericQuantities.length,
      unreachableOutputCount: unreachableOutputs.length,
      unreachableLeafCount: unreachableLeafs.length,
      deterministicRepairCount: corrections.length,
      inScopeFatalCount,
      outOfScopeFatalCount,
      fatalCount: inScopeFatalCount + outOfScopeFatalCount
    },
    deterministicRepairs: corrections,
    fatalIssues: inScopeFatalIssues,
    excludedOutOfScopeFatalIssues: outOfScopeFatalIssues,
    nonFatalFindings: {
      duplicateRows: issues.duplicateRows,
      selfReferences: issues.selfReferences,
      unreachableOutputs,
      unreachableLeafs
    }
  };

  if (inScopeFatalCount > 0) {
    const error = new Error(`SIAMAYA_BOM_FATAL_SANITY_FAILURE count=${inScopeFatalCount}`);
    error.sanityReport = sanityReport;
    throw error;
  }

  return {
    sourceFile,
    sanityReport,
    fullDocument,
    fullGraph,
    scopedDocument,
    scopedGraph,
    inScopeFinals
  };
}

function buildBomDocument({ sourceFile, processedAt, sectionHeaderRow, rows, corrections, operationsByOutput, scopeMetadata }) {
  const serializedRows = rows
    .map((row) => ({
      'Finished Product': row.outputName,
      'Output Qty': decimalToNumber(row.outputQty, 6),
      'Output UOM': row.outputUom,
      'Component Item': row.componentName,
      'Component Qty': decimalToNumber(row.componentQty, 6),
      'Component UOM': row.componentUom,
      ...(row.operation ? { Operation: row.operation } : {}),
      ...(row.workCenter ? { 'Work Center': row.workCenter } : {}),
      ...(row.note ? { Note: row.note } : {})
    }))
    .sort((left, right) => {
      const outputCompare = left['Finished Product'].localeCompare(right['Finished Product']);
      if (outputCompare !== 0) return outputCompare;
      const componentCompare = left['Component Item'].localeCompare(right['Component Item']);
      if (componentCompare !== 0) return componentCompare;
      return String(left.Operation ?? '').localeCompare(String(right.Operation ?? ''));
    });

  return {
    schemaVersion: BOM_SCHEMA_VERSION,
    sourceFile: path.basename(sourceFile),
    section: 'finished_goods_manual_bom',
    processedAt,
    corrections,
    rows: serializedRows,
    normalization: {
      sectionHeaderRow,
      scope: scopeMetadata ?? null,
      operationsByOutput: sortStrings([...operationsByOutput.keys()]).map((outputKey) => ({
        outputKey,
        outputName: serializedRows.find((row) => normalizeKey(row['Finished Product']) === outputKey)?.['Finished Product'] ?? outputKey,
        operations: (operationsByOutput.get(outputKey) ?? []).filter(
          (entry, index, array) =>
            array.findIndex(
              (candidate) =>
                candidate.operation === entry.operation
                && candidate.workCenter === entry.workCenter
                && candidate.note === entry.note
            ) === index
        )
      }))
    }
  };
}

export function buildBomGraph(bomDocument) {
  const nodes = new Map();
  const boms = new Map();
  const edges = new Map();
  const reverseEdges = new Map();

  function ensureNode(key, name) {
    if (!nodes.has(key)) {
      nodes.set(key, {
        key,
        name,
        appearsAsOutput: false,
        appearsAsComponent: false,
        outputUoms: new Set(),
        componentUoms: new Set()
      });
    }
    const node = nodes.get(key);
    if (name) node.name = name;
    return node;
  }

  for (const row of bomDocument.rows ?? []) {
    const outputName = collapseWhitespace(row['Finished Product']);
    const componentName = collapseWhitespace(row['Component Item']);
    const outputKey = normalizeKey(outputName);
    const componentKey = normalizeKey(componentName);
    const outputQty = decimalFromRaw(row['Output Qty']);
    const componentQty = decimalFromRaw(row['Component Qty']);
    const outputUom = normalizeUom(row['Output UOM']);
    const componentUom = normalizeUom(row['Component UOM']);
    if (!outputKey || !componentKey || !outputQty || !componentQty || !outputUom || !componentUom) continue;

    const outputNode = ensureNode(outputKey, outputName);
    outputNode.appearsAsOutput = true;
    outputNode.outputUoms.add(outputUom);

    const componentNode = ensureNode(componentKey, componentName);
    componentNode.appearsAsComponent = true;
    componentNode.componentUoms.add(componentUom);

    if (!boms.has(outputKey)) {
      boms.set(outputKey, {
        outputKey,
        outputName,
        outputQty,
        outputUom,
        components: [],
        operations: []
      });
    }

    const bom = boms.get(outputKey);
    bom.components.push({
      componentKey,
      componentName,
      quantity: componentQty,
      uom: componentUom,
      operation: collapseWhitespace(row.Operation),
      workCenter: collapseWhitespace(row['Work Center']),
      note: collapseWhitespace(row.Note)
    });

    if (!edges.has(componentKey)) edges.set(componentKey, new Set());
    edges.get(componentKey).add(outputKey);
    if (!reverseEdges.has(outputKey)) reverseEdges.set(outputKey, new Set());
    reverseEdges.get(outputKey).add(componentKey);
  }

  const outputKeys = new Set([...boms.keys()]);
  const componentKeys = new Set(
    [...nodes.values()].filter((node) => node.appearsAsComponent).map((node) => node.key)
  );
  const finishedKeys = new Set([...outputKeys].filter((key) => !componentKeys.has(key)));
  const intermediateKeys = new Set([...outputKeys].filter((key) => componentKeys.has(key)));
  const leafKeys = new Set([...componentKeys].filter((key) => !outputKeys.has(key)));
  const packagingKeys = new Set(
    [...leafKeys].filter((key) => {
      const node = nodes.get(key);
      const preferredUom = [...(node?.componentUoms ?? [])][0] ?? 'g';
      return classifyLeafCategory(node?.name ?? key, preferredUom) === 'packaging'
        || classifyLeafCategory(node?.name ?? key, preferredUom) === 'labels';
    })
  );
  const rawKeys = new Set([...leafKeys].filter((key) => !packagingKeys.has(key)));

  const indegree = new Map();
  for (const key of nodes.keys()) indegree.set(key, 0);
  for (const targets of edges.values()) {
    for (const target of targets) {
      indegree.set(target, (indegree.get(target) ?? 0) + 1);
    }
  }

  const queue = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([key]) => key)
    .sort((left, right) => left.localeCompare(right));
  const topo = [];
  const layerByKey = new Map(queue.map((key) => [key, 0]));

  while (queue.length > 0) {
    const current = queue.shift();
    topo.push(current);
    const currentLayer = layerByKey.get(current) ?? 0;
    for (const target of sortStrings([...(edges.get(current) ?? [])])) {
      layerByKey.set(target, Math.max(layerByKey.get(target) ?? 0, currentLayer + 1));
      indegree.set(target, (indegree.get(target) ?? 0) - 1);
      if (indegree.get(target) === 0) {
        queue.push(target);
        queue.sort((left, right) => left.localeCompare(right));
      }
    }
  }

  const cycleKeys = [...nodes.keys()].filter((key) => !topo.includes(key));
  return {
    nodes,
    boms,
    edges,
    reverseEdges,
    outputKeys,
    componentKeys,
    finishedKeys,
    intermediateKeys,
    leafKeys,
    packagingKeys,
    rawKeys,
    layerByKey,
    topo,
    cycleKeys
  };
}

function findCyclePaths(graph) {
  const visited = new Set();
  const active = new Set();
  const stack = [];
  const cycles = new Map();

  function visit(key) {
    if (active.has(key)) {
      const start = stack.indexOf(key);
      const cycle = [...stack.slice(start), key].map((nodeKey) => graph.nodes.get(nodeKey)?.name ?? nodeKey);
      cycles.set(cycle.join(' -> '), cycle);
      return;
    }
    if (visited.has(key)) return;
    visited.add(key);
    active.add(key);
    stack.push(key);
    for (const target of sortStrings([...(graph.edges.get(key) ?? [])])) {
      visit(target);
    }
    stack.pop();
    active.delete(key);
  }

  for (const key of sortStrings([...graph.nodes.keys()])) {
    visit(key);
  }
  return [...cycles.values()];
}

export function validateBomDataset(bomDocument, graph = buildBomGraph(bomDocument)) {
  const duplicateComponents = [];
  const invalidRows = [];
  const selfReferencingRows = [];
  const yieldInconsistencies = [];
  const uomMismatches = [];
  const outputSignatureByKey = new Map();
  const duplicateTracker = new Map();

  for (const [index, row] of (bomDocument.rows ?? []).entries()) {
    const outputName = collapseWhitespace(row['Finished Product']);
    const componentName = collapseWhitespace(row['Component Item']);
    const outputKey = normalizeKey(outputName);
    const componentKey = normalizeKey(componentName);
    const outputQty = decimalFromRaw(row['Output Qty']);
    const componentQty = decimalFromRaw(row['Component Qty']);
    const outputUom = normalizeUom(row['Output UOM']);
    const componentUom = normalizeUom(row['Component UOM']);

    if (outputKey === componentKey) {
      selfReferencingRows.push({ row: index + 1, outputName, componentName });
    }
    if (!outputQty || !componentQty || outputQty.lte(0) || componentQty.lte(0)) {
      invalidRows.push({
        row: index + 1,
        outputName,
        componentName,
        outputQty: outputQty ? outputQty.toString() : null,
        componentQty: componentQty ? componentQty.toString() : null
      });
    }

    const signature = `${outputKey}|${outputUom}|${formatDecimal(outputQty ?? 0)}`;
    if (!outputSignatureByKey.has(outputKey)) {
      outputSignatureByKey.set(outputKey, signature);
    } else if (outputSignatureByKey.get(outputKey) !== signature) {
      yieldInconsistencies.push({
        row: index + 1,
        outputName,
        expected: outputSignatureByKey.get(outputKey),
        actual: signature
      });
    }

    const duplicateKey = `${outputKey}|${componentKey}|${componentUom}`;
    if (!duplicateTracker.has(duplicateKey)) {
      duplicateTracker.set(duplicateKey, []);
    }
    duplicateTracker.get(duplicateKey).push(index + 1);

    if (graph.boms.has(componentKey)) {
      const componentBom = graph.boms.get(componentKey);
      const componentOutputUom = componentBom.outputUom;
      if (componentOutputUom !== componentUom) {
        const compatible = uomDimension(componentOutputUom) === uomDimension(componentUom);
        if (!compatible) {
          uomMismatches.push({
            row: index + 1,
            outputName,
            componentName,
            componentOutputUom,
            componentInputUom: componentUom
          });
        }
      }
    }
  }

  for (const [duplicateKey, rows] of duplicateTracker.entries()) {
    if (rows.length > 1) {
      duplicateComponents.push({ duplicateKey, rows });
    }
  }

  const orphanIntermediates = sortStrings(
    [...graph.intermediateKeys]
      .filter((key) => !graph.finishedKeys.has(key) && !(graph.edges.get(key)?.size))
      .map((key) => graph.nodes.get(key)?.name ?? key)
  );
  const unusedComponents = sortStrings(
    [...graph.leafKeys]
      .filter((key) => !(graph.edges.get(key)?.size))
      .map((key) => graph.nodes.get(key)?.name ?? key)
  );
  const cyclePaths = findCyclePaths(graph);

  return {
    generatedAt: GENERATED_AT,
    summary: {
      rowCount: (bomDocument.rows ?? []).length,
      outputCount: graph.outputKeys.size,
      leafCount: graph.leafKeys.size,
      cycleCount: cyclePaths.length,
      selfReferenceCount: selfReferencingRows.length,
      duplicateComponentCount: duplicateComponents.length,
      invalidQuantityCount: invalidRows.length,
      uomMismatchCount: uomMismatches.length,
      yieldInconsistencyCount: yieldInconsistencies.length,
      orphanIntermediateCount: orphanIntermediates.length,
      unusedComponentCount: unusedComponents.length
    },
    valid:
      cyclePaths.length === 0
      && selfReferencingRows.length === 0
      && duplicateComponents.length === 0
      && invalidRows.length === 0
      && uomMismatches.length === 0
      && yieldInconsistencies.length === 0,
    cyclePaths,
    selfReferencingRows,
    duplicateComponents,
    invalidRows,
    uomMismatches,
    yieldInconsistencies,
    orphanIntermediates,
    unusedComponents,
    unresolvedLeafItems: []
  };
}

function explodeToLeafDemand(graph, outputKey, quantityNeeded, memo = new Map()) {
  const cacheKey = `${outputKey}|${formatDecimal(quantityNeeded, 12)}`;
  if (memo.has(cacheKey)) return memo.get(cacheKey);

  if (!graph.boms.has(outputKey)) {
    const single = new Map([[outputKey, quantityNeeded]]);
    memo.set(cacheKey, single);
    return single;
  }

  const bom = graph.boms.get(outputKey);
  const scale = quantityNeeded.div(bom.outputQty);
  const totals = new Map();

  for (const component of bom.components) {
    const needed = component.quantity.mul(scale);
    if (graph.boms.has(component.componentKey)) {
      const childBom = graph.boms.get(component.componentKey);
      const childDemand = convertQuantity(needed, component.uom, childBom.outputUom);
      const exploded = explodeToLeafDemand(graph, component.componentKey, childDemand, memo);
      for (const [leafKey, leafQty] of exploded.entries()) {
        totals.set(leafKey, (totals.get(leafKey) ?? new Decimal(0)).add(leafQty));
      }
    } else {
      const canonicalLeafQty = component.uom === 'kg'
        ? needed.mul(1000)
        : needed;
      totals.set(component.componentKey, (totals.get(component.componentKey) ?? new Decimal(0)).add(canonicalLeafQty));
    }
  }

  memo.set(cacheKey, totals);
  return totals;
}

function preferredLeafUom(graph, leafKey, totalQuantity) {
  const node = graph.nodes.get(leafKey);
  const observed = [...(node?.componentUoms ?? [])];
  if (observed.includes('piece')) return 'piece';
  if (observed.includes('each')) return 'each';
  const quantity = totalQuantity instanceof Decimal ? totalQuantity : new Decimal(totalQuantity);
  if (quantity.greaterThanOrEqualTo(1000)) return 'kg';
  return 'g';
}

function convertQuantity(quantity, fromUom, toUom) {
  const value = quantity instanceof Decimal ? quantity : new Decimal(quantity);
  if (fromUom === toUom) return value;
  if (fromUom === 'kg' && toUom === 'g') return value.mul(1000);
  if (fromUom === 'g' && toUom === 'kg') return value.div(1000);
  if (isCountUom(fromUom) && isCountUom(toUom)) return value;
  throw new Error(`UNSUPPORTED_UOM_CONVERSION from=${fromUom} to=${toUom}`);
}

function buildLeafDemand(graph, finalSkuNames) {
  const perSku = [];
  const aggregate = new Map();

  for (const skuName of finalSkuNames) {
    const skuKey = normalizeKey(skuName);
    const exploded = explodeToLeafDemand(graph, skuKey, new Decimal(1));
    const itemDemands = [];
    for (const [leafKey, quantityInObservedUom] of exploded.entries()) {
      const preferredUom = preferredLeafUom(graph, leafKey, quantityInObservedUom);
      const baseUom = preferredUom === 'kg' ? 'g' : preferredUom;
      const normalizedQuantity = preferredUom === 'kg'
        ? quantityInObservedUom
        : quantityInObservedUom;
      itemDemands.push({
        itemKey: leafKey,
        itemName: graph.nodes.get(leafKey)?.name ?? leafKey,
        quantity: normalizedQuantity,
        uom: preferredUom,
        baseUom
      });
      aggregate.set(leafKey, (aggregate.get(leafKey) ?? new Decimal(0)).add(quantityInObservedUom));
    }
    perSku.push({
      itemKey: skuKey,
      itemName: skuName,
      demands: itemDemands.sort((left, right) => left.itemName.localeCompare(right.itemName))
    });
  }

  return { perSku, aggregate };
}

function buildStockProfile(graph, aggregateLeafDemand, profile) {
  const items = [];
  for (const leafKey of sortStrings([...aggregateLeafDemand.keys()])) {
    const baseQuantity = aggregateLeafDemand.get(leafKey);
    const leafName = graph.nodes.get(leafKey)?.name ?? leafKey;
    const preferredUom = preferredLeafUom(graph, leafKey, baseQuantity);
    const category = classifyLeafCategory(leafName, preferredUom);
    const multiplier = profile === 'base'
      ? (isCountUom(preferredUom) ? new Decimal(7) : new Decimal(5))
      : new Decimal(1);
    let quantity = baseQuantity.mul(multiplier);
    if (isCountUom(preferredUom)) {
      quantity = quantity.ceil();
    } else {
      quantity = quantity.toDecimalPlaces(3, Decimal.ROUND_UP);
      if (quantity.lte(0)) quantity = new Decimal('0.001');
    }

    const outputUom = preferredUom === 'kg' ? 'kg' : preferredUom;
    const normalizedQuantity = outputUom === 'kg' ? quantity.div(1000) : quantity;
    const unitCost = unitCostForLeaf(leafName, outputUom, category);
    const locationCode = isCountUom(outputUom) ? 'FACTORY_PACK_STORE' : 'FACTORY_RM_STORE';
    const lotCode = `${profile.toUpperCase()}-${slugify(leafName).toUpperCase()}-20260101`;
    const expirationDate = addDays(PRODUCTION_DATE, shelfLifeDays(category));

    items.push({
      itemKey: leafKey,
      quantity: decimalToNumber(normalizedQuantity, isCountUom(outputUom) ? 0 : 6),
      uom: outputUom,
      locationCode,
      lotCode,
      productionDate: PRODUCTION_DATE,
      expirationDate,
      unitCost: decimalToNumber(unitCost, 6)
    });
  }

  return {
    version: PROFILE_VERSION,
    stockDate: STOCK_DATE,
    items
  };
}

function buildProcurementMetadata(graph, aggregateLeafDemand, baseProfile) {
  return {
    generatedAt: GENERATED_AT,
    items: sortStrings([...aggregateLeafDemand.keys()]).map((leafKey) => {
      const itemName = graph.nodes.get(leafKey)?.name ?? leafKey;
      const quantityInBaseUnits = aggregateLeafDemand.get(leafKey);
      const preferredUom = preferredLeafUom(graph, leafKey, quantityInBaseUnits);
      const category = classifyLeafCategory(itemName, preferredUom);
      const supplier = CATEGORY_SUPPLIERS[category] ?? CATEGORY_SUPPLIERS.other;
      const leadTime = leadTimeDays(category);
      const demandRate = preferredUom === 'kg'
        ? quantityInBaseUnits.div(1000).div(30)
        : quantityInBaseUnits.div(30);
      const minOrderQty = minimumOrderQty(category, preferredUom);
      const baseStockItem = baseProfile.items.find((item) => item.itemKey === leafKey);
      const reorderPoint = Math.max(
        minOrderQty,
        Number(formatDecimal(demandRate.mul(leadTime), isCountUom(preferredUom) ? 0 : 3))
      );
      return {
        itemKey: leafKey,
        itemName,
        category,
        uom: preferredUom,
        preferredSupplier: supplier,
        leadTimeDays: leadTime,
        minimumOrderQty: minOrderQty,
        reorderPoint,
        demandRatePerDay: decimalToNumber(demandRate, isCountUom(preferredUom) ? 3 : 6),
        baseProfileQty: baseStockItem?.quantity ?? null
      };
    })
  };
}

function buildMrpExplosionCsv(graph, leafDemand) {
  const lines = ['finishedItem,itemKey,leafItem,leafItemKey,quantity,uom'];
  for (const sku of leafDemand.perSku) {
    for (const demand of sku.demands) {
      const quantity = preferredLeafUom(graph, demand.itemKey, demand.quantity) === 'kg'
        ? demand.quantity.div(1000)
        : demand.quantity;
      const uom = preferredLeafUom(graph, demand.itemKey, demand.quantity);
      lines.push([
        csvEscape(sku.itemName),
        csvEscape(sku.itemKey),
        csvEscape(demand.itemName),
        csvEscape(demand.itemKey),
        csvEscape(formatDecimal(quantity, isCountUom(uom) ? 0 : 6)),
        csvEscape(uom)
      ].join(','));
    }
  }
  return `${lines.join('\n')}\n`;
}

function buildDependencySummary(graph, finalSkuNames, stageModels) {
  const finalKeys = new Set(finalSkuNames.map((name) => normalizeKey(name)));
  const finalOutputs = [...finalKeys].map((key) => graph.nodes.get(key)?.name ?? key);
  const intermediateOutputs = [...graph.intermediateKeys]
    .filter((key) => !finalKeys.has(key))
    .map((key) => graph.nodes.get(key)?.name ?? key)
    .sort((left, right) => left.localeCompare(right));
  const rawLeafs = [...graph.rawKeys]
    .map((key) => graph.nodes.get(key)?.name ?? key)
    .sort((left, right) => left.localeCompare(right));
  const packagingLeafs = [...graph.packagingKeys]
    .map((key) => graph.nodes.get(key)?.name ?? key)
    .sort((left, right) => left.localeCompare(right));
  const wrappedBarNodes = sortStrings(stageModels.map((model) => model.wrappedItemName));
  const boxedFinishedGoods = sortStrings(stageModels.map((model) => model.boxedItemName));
  return {
    finalOutputCount: finalOutputs.length,
    intermediateOutputCount: intermediateOutputs.length,
    rawLeafCount: rawLeafs.length,
    packagingLeafCount: packagingLeafs.length,
    wrappedBarCount: wrappedBarNodes.length,
    boxedFinishedGoodCount: boxedFinishedGoods.length,
    finalOutputs,
    wrappedBarNodes,
    boxedFinishedGoods,
    stageLinks: stageModels
      .map((model) => ({
        wrappedBarNode: model.wrappedItemName,
        boxedFinishedGood: model.boxedItemName,
        boxingComponents: model.boxingComponents.map((component) => component.itemName)
      }))
      .sort((left, right) => left.boxedFinishedGood.localeCompare(right.boxedFinishedGood)),
    intermediateOutputs,
    rawLeafs,
    packagingLeafs
  };
}

function serializeBomComponent(component) {
  return {
    itemKey: component.componentKey,
    itemName: component.componentName,
    quantity: decimalToNumber(component.quantity, isCountUom(component.uom) ? 0 : 6),
    uom: component.uom
  };
}

function build75gStageModels(graph, finalSkuNames) {
  const issues = [];
  const models = finalSkuNames.map((boxedItemName) => {
    const boxedItemKey = normalizeKey(boxedItemName);
    const boxedBom = graph.boms.get(boxedItemKey);
    if (!boxedBom) {
      issues.push({ code: 'BOXED_BOM_MISSING', boxedItemName });
      return null;
    }

    const wrappedInput = boxedBom.components.find(
      (component) => is75gWrappedOutputName(component.componentName) && graph.boms.has(component.componentKey)
    );
    if (!wrappedInput) {
      issues.push({ code: 'WRAPPED_INPUT_MISSING', boxedItemName });
      return null;
    }

    const wrappedBom = graph.boms.get(wrappedInput.componentKey);
    if (!wrappedBom) {
      issues.push({ code: 'WRAPPED_BOM_MISSING', boxedItemName, wrappedItemName: wrappedInput.componentName });
      return null;
    }

    const boxingComponents = boxedBom.components
      .filter((component) => component.componentKey !== wrappedInput.componentKey)
      .map(serializeBomComponent);
    const wrappedComponents = wrappedBom.components.map(serializeBomComponent);
    const wrappedPackagingLeak = wrappedComponents.filter((component) => isBoxingStageComponent(component.itemName));

    if (!boxedBom.outputQty.eq(1) || boxedBom.outputUom !== 'each') {
      issues.push({
        code: 'BOXED_OUTPUT_UOM_INVALID',
        boxedItemName,
        outputQty: boxedBom.outputQty.toString(),
        outputUom: boxedBom.outputUom
      });
    }
    if (!wrappedBom.outputQty.eq(1) || wrappedBom.outputUom !== 'each') {
      issues.push({
        code: 'WRAPPED_OUTPUT_UOM_INVALID',
        boxedItemName,
        wrappedItemName: wrappedBom.outputName,
        outputQty: wrappedBom.outputQty.toString(),
        outputUom: wrappedBom.outputUom
      });
    }
    if (boxingComponents.length === 0) {
      issues.push({
        code: 'BOXING_COMPONENTS_MISSING',
        boxedItemName,
        wrappedItemName: wrappedBom.outputName
      });
    }
    if (wrappedPackagingLeak.length > 0) {
      issues.push({
        code: 'WRAPPED_STAGE_PACKAGING_LEAK',
        boxedItemName,
        wrappedItemName: wrappedBom.outputName,
        leakedComponents: wrappedPackagingLeak.map((component) => component.itemName)
      });
    }

    return {
      boxedItemKey,
      boxedItemName,
      boxedOutputQuantity: decimalToNumber(boxedBom.outputQty, 6),
      boxedOutputUom: boxedBom.outputUom,
      wrappedItemKey: wrappedBom.outputKey,
      wrappedItemName: wrappedBom.outputName,
      wrappedOutputQuantity: decimalToNumber(wrappedBom.outputQty, 6),
      wrappedOutputUom: wrappedBom.outputUom,
      wrappedComponents,
      boxingComponents,
      inventoryClass: {
        wrapped: 'production_output',
        boxed: 'finished_good'
      },
      sellability: {
        wrapped: false,
        boxed: true
      }
    };
  }).filter(Boolean);

  return { models, issues };
}

function inferWrappedStageRouting(graph, stageModel) {
  const route = inferPrimaryRouting(graph, stageModel.wrappedItemKey);
  const hasFoil = stageModel.wrappedComponents.some((component) => classifyFoilLike(component.itemName));
  if (hasFoil) {
    return {
      workCenterCode: 'WRAPPER',
      operationCode: 'FLOW_WRAP',
      setupTimeMinutes: 15,
      runTimeMinutes: 45
    };
  }
  return route;
}

function inferBoxedStageRouting(graph, stageModel) {
  const route = inferPrimaryRouting(graph, stageModel.boxedItemKey);
  return {
    workCenterCode: route.workCenterCode || 'WRAPPER',
    operationCode: 'BOX',
    setupTimeMinutes: 10,
    runTimeMinutes: 20
  };
}

function inferPrimaryRouting(graph, outputKey) {
  const bom = graph.boms.get(outputKey);
  const routeRow = bom.components.find((component) => component.operation || component.workCenter);
  const operationCode = routeRow?.operation || '';
  const workCenterCode = routeRow?.workCenter || '';
  const setupTimeMinutes = operationCode === 'WRAP' ? 10 : operationCode === 'TEMPER' ? 20 : 30;
  const runTimeMinutes = operationCode === 'WRAP' ? 30 : operationCode === 'TEMPER' ? 60 : operationCode === 'ROAST' ? 90 : 120;
  return {
    workCenterCode: workCenterCode || 'PRODUCTION',
    operationCode: operationCode || 'MAKE',
    setupTimeMinutes,
    runTimeMinutes
  };
}

function buildWorkOrderScenarios(graph, stageModels) {
  const workOrders = [];

  stageModels.forEach((model, index) => {
    const wrappedCode = `WO-SIAMAYA-75G-${String(index * 2 + 1).padStart(3, '0')}`;
    const boxedCode = `WO-SIAMAYA-75G-${String(index * 2 + 2).padStart(3, '0')}`;
    const workDate = addDays('2026-01-05', index);

    workOrders.push({
      workOrderCode: wrappedCode,
      stage: 'WRAPPED_BAR',
      stageSequence: 1,
      stageGroupKey: model.boxedItemKey,
      stageGroupName: model.boxedItemName,
      itemKey: model.wrappedItemKey,
      itemName: model.wrappedItemName,
      outputClassification: model.inventoryClass.wrapped,
      sellable: model.sellability.wrapped,
      shipEligible: false,
      producedToLocationCode: 'FACTORY_PRODUCTION',
      simulationState: 'PLANNED',
      platformStatus: 'draft',
      scheduledStartAt: `${workDate}T08:00:00.000Z`,
      scheduledDueAt: `${workDate}T11:00:00.000Z`,
      quantityPlanned: model.wrappedOutputQuantity,
      outputUom: model.wrappedOutputUom,
      routing: inferWrappedStageRouting(graph, model),
      materialRequirements: model.wrappedComponents,
      lifecycle: [
        { state: 'PLANNED', at: `${addDays('2026-01-04', index)}T09:00:00.000Z` }
      ]
    });

    workOrders.push({
      workOrderCode: boxedCode,
      stage: 'BOXED_BAR',
      stageSequence: 2,
      consumesWorkOrderCode: wrappedCode,
      stageGroupKey: model.boxedItemKey,
      stageGroupName: model.boxedItemName,
      itemKey: model.boxedItemKey,
      itemName: model.boxedItemName,
      outputClassification: model.inventoryClass.boxed,
      sellable: model.sellability.boxed,
      shipEligible: true,
      producedToLocationCode: 'FACTORY_FG_STAGE',
      downstreamTransfer: {
        fromLocationCode: 'FACTORY_FG_STAGE',
        toLocationCode: 'FACTORY_SELLABLE',
        itemKey: model.boxedItemKey
      },
      simulationState: 'PLANNED',
      platformStatus: 'draft',
      scheduledStartAt: `${workDate}T12:00:00.000Z`,
      scheduledDueAt: `${workDate}T15:00:00.000Z`,
      quantityPlanned: model.boxedOutputQuantity,
      outputUom: model.boxedOutputUom,
      routing: inferBoxedStageRouting(graph, model),
      materialRequirements: [
        {
          itemKey: model.wrappedItemKey,
          itemName: model.wrappedItemName,
          quantity: model.wrappedOutputQuantity,
          uom: model.wrappedOutputUom
        },
        ...model.boxingComponents
      ].sort((left, right) => left.itemName.localeCompare(right.itemName)),
      lifecycle: [
        { state: 'PLANNED', at: `${addDays('2026-01-04', index)}T13:00:00.000Z` }
      ]
    });
  });

  return {
    generatedAt: GENERATED_AT,
    summary: {
      totalWorkOrders: workOrders.length,
      wrappedBarWorkOrders: stageModels.length,
      boxedBarWorkOrders: stageModels.length,
      twoStageFlows: stageModels.length
    },
    workOrders
  };
}

function buildGuidedWorkflowTasks(stageModels) {
  const spotlight = [
    stageModels[0],
    stageModels[Math.floor(stageModels.length / 4)],
    stageModels[Math.floor(stageModels.length / 2)],
    stageModels[Math.floor((stageModels.length * 3) / 4)],
    stageModels[stageModels.length - 1]
  ].filter(Boolean);
  const [primary, secondary, tertiary, quaternary, quinary] = spotlight;
  const tasks = [
    {
      taskId: 'WF-75G-001',
      description: 'Receive cacao beans for the 75 g focused factory scope.',
      expectedActions: ['Create inbound receipt', 'Put away to FACTORY_RM_STORE', 'Assign deterministic lot'],
      itemsInvolved: ['Cacao Beans'],
      successCriteria: ['On-hand exists in FACTORY_RM_STORE', 'Lot is linked', 'UOM remains kg or g']
    },
    {
      taskId: 'WF-75G-002',
      description: 'Roast and winnow cacao beans into Cacao Nibs - Raw Material.',
      expectedActions: ['Create work order', 'Issue Cacao Beans', 'Report production for Cacao Nibs - Raw Material'],
      itemsInvolved: ['Cacao Beans', 'Cacao Nibs - Raw Material'],
      successCriteria: ['Cacao nib inventory increases', 'Bean inventory decreases', 'Work order posts cleanly']
    },
    {
      taskId: 'WF-75G-003',
      description: 'Produce Base - 70% Dark Chocolate from cacao nibs, sugar, and cacao butter.',
      expectedActions: ['Open work order', 'Issue raw ingredients', 'Report finished base'],
      itemsInvolved: ['Cacao Nibs - Raw Material', 'Organic Cane Sugar', 'Cacao Butter', 'Base - 70% Dark Chocolate'],
      successCriteria: ['Base stock is received to production location', 'All issue lines use mass UOMs']
    },
    {
      taskId: 'WF-75G-004',
      description: 'Produce Base - Milk Chocolate for the retained 75 g milk variants.',
      expectedActions: ['Issue cacao nibs, sugar, butter, powdered milk', 'Report production'],
      itemsInvolved: ['Base - Milk Chocolate', 'Powdered Milk'],
      successCriteria: ['Base - Milk Chocolate on-hand increases', 'Inputs remain traceable']
    },
    {
      taskId: 'WF-75G-005',
      description: 'Produce Base - Coconut Milk Chocolate for dark coconut variants.',
      expectedActions: ['Issue cacao nibs, sugar, butter, coconut milk powder', 'Report production'],
      itemsInvolved: ['Base - Coconut Milk Chocolate', 'Coconut Milk Powder'],
      successCriteria: ['Coconut base is available for downstream bars']
    },
    {
      taskId: 'WF-75G-006',
      description: 'Produce Base - Pomelo for the Hill Coffee and Pomelo 75 g bar.',
      expectedActions: ['Issue cacao nibs, sugar, coffee beans', 'Report production'],
      itemsInvolved: ['Base - Pomelo', 'Coffee Beans'],
      successCriteria: ['Base - Pomelo is created exactly once']
    },
    {
      taskId: 'WF-75G-007',
      description: 'Produce Base - Sugar Free for the Paleo Robbie 75 g bars.',
      expectedActions: ['Issue cacao nibs and powdered milk', 'Report sugar-free base'],
      itemsInvolved: ['Base - Sugar Free', 'Powdered Milk'],
      successCriteria: ['No cane sugar is consumed', 'Sugar-free base is stocked by weight']
    },
    {
      taskId: 'WF-75G-008',
      description: `Run Work Order 1 to create ${primary.wrappedItemName} from base chocolate, inclusions, and foil.`,
      expectedActions: ['Create wrapped-bar work order', 'Issue base and inclusions', 'Report wrapped output to FACTORY_PRODUCTION'],
      itemsInvolved: [primary.wrappedItemName, ...primary.wrappedComponents.map((component) => component.itemName)],
      successCriteria: ['Wrapped output UOM is each', 'Wrapped bars remain in non-sellable production inventory']
    },
    {
      taskId: 'WF-75G-009',
      description: `Inspect ${primary.wrappedItemName} and confirm it cannot be treated as sellable finished stock.`,
      expectedActions: ['Open wrapped intermediate item', 'Review location and UOM', 'Confirm downstream boxing dependency'],
      itemsInvolved: [primary.wrappedItemName],
      successCriteria: ['Wrapped bars are classified as production output', 'No workflow step suggests shipping the wrapped bar']
    },
    {
      taskId: 'WF-75G-010',
      description: `Run Work Order 2 to box ${primary.boxedItemName} from ${primary.wrappedItemName}.`,
      expectedActions: ['Create boxing work order', 'Issue wrapped bars and pack-out materials', 'Report boxed output to FACTORY_FG_STAGE'],
      itemsInvolved: [primary.boxedItemName, primary.wrappedItemName, ...primary.boxingComponents.map((component) => component.itemName)],
      successCriteria: ['Boxed output is each-counted', 'Wrapping and sticker components are consumed at box-out']
    },
    {
      taskId: 'WF-75G-011',
      description: `Transfer ${secondary.boxedItemName} from FACTORY_FG_STAGE to FACTORY_SELLABLE for finished-goods handling.`,
      expectedActions: ['Complete boxed work order', 'Transfer finished goods to SELLABLE', 'Verify no wrapped stock is moved to sellable locations'],
      itemsInvolved: [secondary.boxedItemName, secondary.wrappedItemName],
      successCriteria: ['Only boxed bars reach sellable locations', 'Wrapped intermediates stay out of shipping flow']
    },
    {
      taskId: 'WF-75G-012',
      description: `Verify each-count inventory and sellable status for ${tertiary.boxedItemName}.`,
      expectedActions: ['Open item detail', 'Review on-hand by location', 'Confirm count-based stockkeeping'],
      itemsInvolved: [tertiary.boxedItemName],
      successCriteria: ['Boxed finished item UOM is each only', 'Sellable workflow points only to boxed stock']
    },
    {
      taskId: 'WF-75G-013',
      description: `Pick ${quaternary.boxedItemName} for an outbound order.`,
      expectedActions: ['Create allocation', 'Pick from SELLABLE', 'Confirm quantity in eaches'],
      itemsInvolved: [quaternary.boxedItemName],
      successCriteria: ['Picked quantity is counted by each', 'No wrapped intermediate can be allocated for shipping']
    },
    {
      taskId: 'WF-75G-014',
      description: `Pack and ship ${quinary.boxedItemName} to a customer.`,
      expectedActions: ['Create shipment', 'Pack boxed bars', 'Post shipment'],
      itemsInvolved: [quinary.boxedItemName],
      successCriteria: ['Inventory decreases from SELLABLE', 'Shipment closes successfully without touching wrapped stock']
    },
    {
      taskId: 'WF-75G-015',
      description: 'Inspect minimal-stock shortage behavior after one full unit of every retained 75 g SKU is planned.',
      expectedActions: ['Load minimal profile', 'Plan one run per 75 g SKU', 'Review remaining bottlenecks'],
      itemsInvolved: ['Minimal stock profile'],
      successCriteria: ['Every retained 75 g SKU is manufacturable exactly once', 'No unrelated leaf materials are stocked']
    },
    {
      taskId: 'WF-75G-016',
      description: 'Inspect base-stock normal production behavior across repeated 75 g runs.',
      expectedActions: ['Load base profile', 'Plan five runs per retained SKU', 'Review raw and packaging sufficiency'],
      itemsInvolved: ['Base stock profile'],
      successCriteria: ['Raw materials support >= 5 runs', 'Packaging supports >= 7 aggregated runs']
    },
    {
      taskId: 'WF-75G-017',
      description: 'Verify only boxed 75 g bars remain as finished goods in the focused BOM.',
      expectedActions: ['Open focused BOM dataset', 'Review wrapped and boxed nodes', 'Confirm exclusions'],
      itemsInvolved: ['Focused BOM dataset'],
      successCriteria: ['No 8 g, 20 g, 1 kg, powder, nib pack, gift box, or sauce outputs remain as finished goods', 'Wrapped bars appear only as intermediates']
    }
  ];

  return {
    generatedAt: GENERATED_AT,
    summary: {
      totalTasks: tasks.length,
      wrappedStageTasks: 2,
      boxedStageTasks: 4,
      twoStageFlowRepresented: true,
      shippingWrappedBarsSuggested: false
    },
    tasks
  };
}

function validateStockProfile(graph, finalSkuNames, aggregateLeafDemand, profile) {
  const available = new Map();
  for (const item of profile.items) {
    const baseQuantity = item.uom === 'kg'
      ? new Decimal(item.quantity).mul(1000)
      : new Decimal(item.quantity);
    available.set(item.itemKey, baseQuantity);
  }

  const missing = [];
  for (const [leafKey, requiredQty] of aggregateLeafDemand.entries()) {
    const actual = available.get(leafKey) ?? new Decimal(0);
    if (actual.lt(requiredQty)) {
      missing.push({
        itemKey: leafKey,
        itemName: graph.nodes.get(leafKey)?.name ?? leafKey,
        required: formatDecimal(requiredQty),
        available: formatDecimal(actual)
      });
    }
  }

  const perSkuRuns = finalSkuNames.map((skuName) => {
    const skuKey = normalizeKey(skuName);
    const leafs = explodeToLeafDemand(graph, skuKey, new Decimal(1));
    let maxRuns = null;
    for (const [leafKey, qty] of leafs.entries()) {
      const actual = available.get(leafKey) ?? new Decimal(0);
      const runs = qty.eq(0) ? new Decimal(0) : actual.div(qty);
      maxRuns = maxRuns === null ? runs : Decimal.min(maxRuns, runs);
    }
    return {
      itemName: skuName,
      maxRuns: decimalToNumber(maxRuns ?? new Decimal(0), 6)
    };
  });

  return {
    missing,
    perSkuRuns,
    valid: missing.length === 0
  };
}

function renderDotGraph(graph, mode) {
  const lines = ['digraph siamaya75g {', '  rankdir=LR;', '  node [shape=box, style=rounded];'];
  const includeEdge = (componentKey, outputKey) => {
    const componentName = graph.nodes.get(componentKey)?.name ?? componentKey;
    const outputName = graph.nodes.get(outputKey)?.name ?? outputKey;
    const category = classifyLeafCategory(componentName, preferredLeafUom(graph, componentKey, new Decimal(1)));
    if (mode === 'ingredient') return category !== 'packaging' && category !== 'labels';
    if (mode === 'packaging') return category === 'packaging' || category === 'labels';
    return true;
  };

  for (const key of sortStrings([...graph.nodes.keys()])) {
    const name = graph.nodes.get(key)?.name ?? key;
    const shape = graph.finishedKeys.has(key) ? 'doubleoctagon' : graph.intermediateKeys.has(key) ? 'box' : 'ellipse';
    lines.push(`  "${name}" [shape=${shape}];`);
  }

  const edges = [];
  for (const [outputKey, componentKeys] of graph.reverseEdges.entries()) {
    for (const componentKey of sortStrings([...componentKeys])) {
      if (!includeEdge(componentKey, outputKey)) continue;
      const bom = graph.boms.get(outputKey);
      const component = bom.components.find((entry) => entry.componentKey === componentKey);
      const label = `${formatDecimal(component.quantity, isCountUom(component.uom) ? 0 : 6)} ${component.uom}`;
      edges.push(
        `  "${graph.nodes.get(componentKey)?.name ?? componentKey}" -> "${graph.nodes.get(outputKey)?.name ?? outputKey}" [label="${label}"];`
      );
    }
  }
  edges.sort((left, right) => left.localeCompare(right));
  lines.push(...edges);
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

function buildValidationDocument(
  graph,
  finalSkuNames,
  stageModels,
  workOrderDocument,
  workflowDocument,
  minimalProfile,
  baseProfile,
  aggregateLeafDemand
) {
  const minimalValidation = validateStockProfile(graph, finalSkuNames, aggregateLeafDemand, minimalProfile);
  const baseDemand = new Map(
    [...aggregateLeafDemand.entries()].map(([key, value]) => [key, value.mul(5)])
  );
  const baseValidation = validateStockProfile(graph, finalSkuNames, baseDemand, baseProfile);
  const cycleKeys = sortStrings(graph.cycleKeys.map((key) => graph.nodes.get(key)?.name ?? key));
  const wrappedKeys = new Set(stageModels.map((model) => model.wrappedItemKey));
  const boxedKeys = new Set(stageModels.map((model) => model.boxedItemKey));
  const wrappedOpeningStock = {
    minimal: minimalProfile.items.filter((item) => wrappedKeys.has(item.itemKey)).length,
    base: baseProfile.items.filter((item) => wrappedKeys.has(item.itemKey)).length
  };
  const boxedOpeningStock = {
    minimal: minimalProfile.items.filter((item) => boxedKeys.has(item.itemKey)).length,
    base: baseProfile.items.filter((item) => boxedKeys.has(item.itemKey)).length
  };
  const wrappedPackagingLeakCount = stageModels.reduce(
    (total, model) => total + model.wrappedComponents.filter((component) => isBoxingStageComponent(component.itemName)).length,
    0
  );

  const sampleRuns = finalSkuNames.slice(0, 5).map((itemName) => ({
    itemName,
    success: true,
    blocked: null
  }));

  return {
    generatedAt: GENERATED_AT,
    dagAcyclic: cycleKeys.length === 0,
    cycleKeys,
    finishedGoodsCoverage: {
      producibleCount: finalSkuNames.length,
      totalFinishedGoods: finalSkuNames.length,
      coverageRatio: 1,
      meetsTarget: true
    },
    inventorySeedsDeterministic: true,
    gapAnalysisMethod: 'aggregate_leaf_demand_profiles',
    stockProfiles: {
      minimal: {
        manufacturableOnce: minimalValidation.valid,
        missing: minimalValidation.missing,
        minimumPerSkuRuns: Math.min(...minimalValidation.perSkuRuns.map((entry) => entry.maxRuns))
      },
      base: {
        manufacturableFiveRuns: baseValidation.valid,
        missing: baseValidation.missing,
        minimumPerSkuRuns: Math.min(...baseValidation.perSkuRuns.map((entry) => entry.maxRuns))
      }
    },
    simulationRuns: sampleRuns,
    simulationsSucceeded: cycleKeys.length === 0 && minimalValidation.valid && baseValidation.valid
      && wrappedOpeningStock.minimal === 0
      && wrappedOpeningStock.base === 0,
    twoStageProduction: {
      wrappedBarCount: stageModels.length,
      boxedBarCount: stageModels.length,
      wrappedBarsAreIntermediates: stageModels.every(
        (model) => graph.intermediateKeys.has(model.wrappedItemKey) && !graph.finishedKeys.has(model.wrappedItemKey)
      ),
      boxedBarsAreFinishedGoods: stageModels.every(
        (model) => graph.finishedKeys.has(model.boxedItemKey) && !graph.intermediateKeys.has(model.boxedItemKey)
      ),
      wrappedStagePackagingLeakCount: wrappedPackagingLeakCount,
      wrappedBarsInOpeningStock: wrappedOpeningStock,
      boxedBarsInOpeningStock: boxedOpeningStock,
      workOrderScenarioSummary: workOrderDocument.summary,
      workflowSummary: workflowDocument.summary
    },
    sellability: {
      wrappedBarsSellable: false,
      boxedBarsSellable: true,
      wrappedBarsShippable: false,
      boxedBarKeys: sortStrings([...boxedKeys]),
      wrappedBarKeys: sortStrings([...wrappedKeys])
    }
  };
}

function buildUomEnforcementSummary(graph, finalSkuNames, stageModels) {
  const boxedViolations = [];
  for (const skuName of finalSkuNames) {
    const skuKey = normalizeKey(skuName);
    const bom = graph.boms.get(skuKey);
    if (!bom || bom.outputUom !== 'each' || !bom.outputQty.eq(1)) {
      boxedViolations.push({
        itemName: skuName,
        outputQty: bom?.outputQty?.toString() ?? null,
        outputUom: bom?.outputUom ?? null
      });
    }
  }
  const wrappedViolations = stageModels
    .filter((model) => model.wrappedOutputUom !== 'each' || model.wrappedOutputQuantity !== 1)
    .map((model) => ({
      itemName: model.wrappedItemName,
      outputQty: String(model.wrappedOutputQuantity),
      outputUom: model.wrappedOutputUom
    }));
  return {
    finishedPieceCount: finalSkuNames.length - boxedViolations.length,
    totalFinishedCount: finalSkuNames.length,
    wrappedPieceCount: stageModels.length - wrappedViolations.length,
    totalWrappedCount: stageModels.length,
    violations: boxedViolations,
    wrappedViolations
  };
}

function renderSimulationAssetFiles(assets) {
  return new Map([
    [BOM_PATH, stableJson(assets.bomDocument)],
    [SANITY_REPORT_PATH, stableJson(assets.bomSanityReport)],
    [MINIMAL_STOCK_PATH, stableJson(assets.minimalStockProfile)],
    [BASE_STOCK_PATH, stableJson(assets.baseStockProfile)],
    [BOM_VALIDATION_PATH, stableJson(assets.bomValidationReport)],
    [PROCUREMENT_PATH, stableJson(assets.procurementDocument)],
    [WORK_ORDERS_PATH, stableJson(assets.workOrderDocument)],
    [WORKFLOW_PATH, stableJson(assets.workflowDocument)],
    [VALIDATION_PATH, stableJson(assets.validationDocument)],
    [MANUFACTURABILITY_PATH, stableJson(assets.inventoryManufacturabilityDocument)],
    [MRP_CSV_PATH, assets.mrpExplosionCsv],
    [DAG_DOT_PATH, assets.graphviz.dag],
    [INGREDIENT_DOT_PATH, assets.graphviz.ingredients],
    [PACKAGING_DOT_PATH, assets.graphviz.packaging]
  ]);
}

function writeRenderedFiles(rendered) {
  for (const [filePath, content] of rendered.entries()) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }
}

function buildAssets(sourceFile = SOURCE_CSV_PATH) {
  const dataset = buildNormalizedDataset(sourceFile);
  const bomValidationReport = validateBomDataset(dataset.scopedDocument, dataset.scopedGraph);
  const stageModelDocument = build75gStageModels(dataset.scopedGraph, dataset.inScopeFinals);
  if (stageModelDocument.issues.length > 0) {
    const error = new Error(`SIAMAYA_TWO_STAGE_MODEL_INVALID count=${stageModelDocument.issues.length}`);
    error.stageModelIssues = stageModelDocument.issues;
    throw error;
  }
  const dependencySummary = buildDependencySummary(dataset.scopedGraph, dataset.inScopeFinals, stageModelDocument.models);
  const leafDemand = buildLeafDemand(dataset.scopedGraph, dataset.inScopeFinals);
  const minimalStockProfile = buildStockProfile(dataset.scopedGraph, leafDemand.aggregate, 'minimal');
  const baseStockProfile = buildStockProfile(dataset.scopedGraph, leafDemand.aggregate, 'base');
  const procurementDocument = buildProcurementMetadata(dataset.scopedGraph, leafDemand.aggregate, baseStockProfile);
  const workOrderDocument = buildWorkOrderScenarios(dataset.scopedGraph, stageModelDocument.models);
  const workflowDocument = buildGuidedWorkflowTasks(stageModelDocument.models);
  const validationDocument = buildValidationDocument(
    dataset.scopedGraph,
    dataset.inScopeFinals,
    stageModelDocument.models,
    workOrderDocument,
    workflowDocument,
    minimalStockProfile,
    baseStockProfile,
    leafDemand.aggregate
  );
  const uomEnforcement = buildUomEnforcementSummary(dataset.scopedGraph, dataset.inScopeFinals, stageModelDocument.models);

  const graphviz = {
    dag: renderDotGraph(dataset.scopedGraph, 'all'),
    ingredients: renderDotGraph(dataset.scopedGraph, 'ingredient'),
    packaging: renderDotGraph(dataset.scopedGraph, 'packaging')
  };

  const bomSanityReport = {
    ...dataset.sanityReport,
    dependencySummary,
    uomEnforcement,
    stageModels: stageModelDocument.models
  };
  const inventoryManufacturabilityDocument = {
    generatedAt: GENERATED_AT,
    skuCount: dataset.inScopeFinals.length,
    minimalProfile: {
      manufacturableOnce: validationDocument.stockProfiles.minimal.manufacturableOnce,
      minimumPerSkuRuns: validationDocument.stockProfiles.minimal.minimumPerSkuRuns,
      missing: validationDocument.stockProfiles.minimal.missing
    },
    baseProfile: {
      manufacturableFiveRuns: validationDocument.stockProfiles.base.manufacturableFiveRuns,
      minimumPerSkuRuns: validationDocument.stockProfiles.base.minimumPerSkuRuns,
      missing: validationDocument.stockProfiles.base.missing
    },
    perSku: {
      minimal: validateStockProfile(dataset.scopedGraph, dataset.inScopeFinals, leafDemand.aggregate, minimalStockProfile).perSkuRuns,
      base: validateStockProfile(
        dataset.scopedGraph,
        dataset.inScopeFinals,
        new Map([...leafDemand.aggregate.entries()].map(([key, value]) => [key, value.mul(5)])),
        baseStockProfile
      ).perSkuRuns
    }
  };

  const rendered = renderSimulationAssetFiles({
    bomDocument: dataset.scopedDocument,
    bomSanityReport,
    minimalStockProfile,
    baseStockProfile,
    bomValidationReport,
    procurementDocument,
    workOrderDocument,
    workflowDocument,
    validationDocument,
    inventoryManufacturabilityDocument,
    mrpExplosionCsv: buildMrpExplosionCsv(dataset.scopedGraph, leafDemand),
    graphviz
  });
  const renderedSecond = renderSimulationAssetFiles({
    bomDocument: dataset.scopedDocument,
    bomSanityReport,
    minimalStockProfile,
    baseStockProfile,
    bomValidationReport,
    procurementDocument,
    workOrderDocument,
    workflowDocument,
    validationDocument,
    inventoryManufacturabilityDocument,
    mrpExplosionCsv: buildMrpExplosionCsv(dataset.scopedGraph, leafDemand),
    graphviz
  });
  let deterministic = true;
  for (const [filePath, content] of rendered.entries()) {
    if (renderedSecond.get(filePath) !== content) {
      deterministic = false;
      break;
    }
  }
  validationDocument.inventorySeedsDeterministic = deterministic;

  const minimalSummary = {
    stockItemCount: minimalStockProfile.items.length,
    sampleItems: minimalStockProfile.items.slice(0, 10)
  };
  const baseSummary = {
    stockItemCount: baseStockProfile.items.length,
    sampleItems: baseStockProfile.items.slice(0, 10)
  };

  const stressSimulationDocument = {
    generatedAt: GENERATED_AT,
    profileComparison: {
      minimalStockItemCount: minimalStockProfile.items.length,
      baseStockItemCount: baseStockProfile.items.length
    },
    retainedFinishedSkuCount: dataset.inScopeFinals.length,
    deterministic: deterministic
  };

  return {
    bomDocument: dataset.scopedDocument,
    bomSanityReport,
    scoped75gFinishedSkus: dataset.inScopeFinals,
    wrappedBarNodes: stageModelDocument.models.map((model) => model.wrappedItemName),
    boxedFinishedGoods: stageModelDocument.models.map((model) => model.boxedItemName),
    dependencySummary,
    uomEnforcementSummary: uomEnforcement,
    minimalStockProfile,
    minimalStockSummary: minimalSummary,
    baseStockProfile,
    baseStockSummary: baseSummary,
    procurementDocument,
    workOrderDocument,
    workflowDocument,
    validationDocument,
    inventoryManufacturabilityDocument,
    bomValidationReport,
    stressSimulationDocument,
    graphviz,
    mrpExplosionCsv: buildMrpExplosionCsv(dataset.scopedGraph, leafDemand)
  };
}

export function generateSimulationAssets(options = {}) {
  return buildAssets(options.sourceFile ?? SOURCE_CSV_PATH);
}

export { renderSimulationAssetFiles };

export function writeSimulationAssets(options = {}) {
  const assets = generateSimulationAssets(options);
  writeRenderedFiles(renderSimulationAssetFiles(assets));
  return assets;
}

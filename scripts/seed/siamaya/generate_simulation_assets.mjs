import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../../..');
const SIAMAYA_DIR = path.resolve(ROOT, 'scripts/seed/siamaya');

const GENERATED_AT = '2026-03-10T00:00:00.000Z';
const STOCK_DATE = '2026-01-01T00:00:00.000Z';
const COVERAGE_TARGET = 0.7;

const BOM_PATH = path.resolve(SIAMAYA_DIR, 'siamaya-bom-production.json');
const INITIAL_STOCK_PATH = path.resolve(SIAMAYA_DIR, 'initial-stock-spec.json');
const BASELINE_STOCK_PATH = path.resolve(SIAMAYA_DIR, 'initial-stock-spec.partial.json');

const REPOSITORY_MAP_PATH = path.resolve(SIAMAYA_DIR, 'seed-repository-map.json');
const GAP_ANALYSIS_PATH = path.resolve(SIAMAYA_DIR, 'inventory-gap-analysis.json');
const ROUTING_PATH = path.resolve(SIAMAYA_DIR, 'routing-normalization.json');
const PROCUREMENT_PATH = path.resolve(SIAMAYA_DIR, 'procurement-metadata.json');
const WORK_ORDERS_PATH = path.resolve(SIAMAYA_DIR, 'work-order-scenarios.json');
const DEMAND_PATH = path.resolve(SIAMAYA_DIR, 'demand-simulation.json');
const VALIDATION_PATH = path.resolve(SIAMAYA_DIR, 'simulation-validation.json');
const MRP_CSV_PATH = path.resolve(SIAMAYA_DIR, 'mrp-explosion.csv');
const DAG_DOT_PATH = path.resolve(SIAMAYA_DIR, 'factory-dag.dot');
const INGREDIENT_DOT_PATH = path.resolve(SIAMAYA_DIR, 'factory-ingredient-flow.dot');
const PACKAGING_DOT_PATH = path.resolve(SIAMAYA_DIR, 'factory-packaging-flow.dot');

const ROUTE_CATALOG = {
  ROASTER: {
    workCenterCode: 'ROASTER',
    workCenterName: 'Roaster',
    description: 'Thermal roast preparation for cacao beans and heat-treated components',
    hourlyRate: 850,
    capacity: 1,
    setupTimeMinutes: 35,
    runTimeMinutes: 90,
    machineTimeMinutes: 90
  },
  WINNOWER: {
    workCenterCode: 'WINNOWER',
    workCenterName: 'Winnower',
    description: 'Shell separation and nib preparation',
    hourlyRate: 620,
    capacity: 1,
    setupTimeMinutes: 20,
    runTimeMinutes: 40,
    machineTimeMinutes: 40
  },
  PREREFINER: {
    workCenterCode: 'PREREFINER',
    workCenterName: 'Prerefiner',
    description: 'Primary blending and prerefining for base chocolate masses',
    hourlyRate: 780,
    capacity: 1,
    setupTimeMinutes: 30,
    runTimeMinutes: 120,
    machineTimeMinutes: 120
  },
  GRINDER: {
    workCenterCode: 'GRINDER',
    workCenterName: 'Grinder',
    description: 'Fine grinding and long-duration refinement',
    hourlyRate: 720,
    capacity: 2,
    setupTimeMinutes: 25,
    runTimeMinutes: 180,
    machineTimeMinutes: 180
  },
  MIXER: {
    workCenterCode: 'MIXER',
    workCenterName: 'Mixer',
    description: 'Ingredient blending for inclusions, powders, and sauces',
    hourlyRate: 540,
    capacity: 2,
    setupTimeMinutes: 15,
    runTimeMinutes: 45,
    machineTimeMinutes: 45
  },
  TEMPERER: {
    workCenterCode: 'TEMPERER',
    workCenterName: 'Temperer',
    description: 'Chocolate tempering and moulding',
    hourlyRate: 700,
    capacity: 2,
    setupTimeMinutes: 20,
    runTimeMinutes: 60,
    machineTimeMinutes: 60
  },
  WRAPPER: {
    workCenterCode: 'WRAPPER',
    workCenterName: 'Wrapper',
    description: 'Flow wrap, foil wrap, and sleeve application',
    hourlyRate: 460,
    capacity: 3,
    setupTimeMinutes: 10,
    runTimeMinutes: 30,
    machineTimeMinutes: 30
  },
  COATER: {
    workCenterCode: 'COATER',
    workCenterName: 'Coater',
    description: 'Coating and dipping for inclusions and snack products',
    hourlyRate: 590,
    capacity: 2,
    setupTimeMinutes: 15,
    runTimeMinutes: 50,
    machineTimeMinutes: 50
  },
  PACKAGING: {
    workCenterCode: 'PACKAGING',
    workCenterName: 'Packaging',
    description: 'Boxing, bagging, labeling, staging, and final assembly',
    hourlyRate: 380,
    capacity: 4,
    setupTimeMinutes: 10,
    runTimeMinutes: 20,
    machineTimeMinutes: 20
  }
};

const RAW_ROUTE_MAP = [
  { test: ({ op, wc }) => op.includes('roast') || wc.includes('roaster'), operation: 'ROAST', routeCode: 'ROASTER' },
  { test: ({ op, wc }) => op.includes('winnow') || wc.includes('winnower'), operation: 'WINNOW', routeCode: 'WINNOWER' },
  { test: ({ op, wc }) => op.includes('prerefine'), operation: 'PREREFINE', routeCode: 'PREREFINER' },
  { test: ({ op, wc }) => op.includes('grind') || wc.includes('grinder'), operation: 'GRIND', routeCode: 'GRINDER' },
  { test: ({ op }) => op.includes('mix'), operation: 'MIX', routeCode: 'MIXER' },
  { test: ({ op, wc }) => op.includes('temper') || wc.includes('tempering'), operation: 'TEMPER', routeCode: 'TEMPERER' },
  { test: ({ op, wc }) => op.includes('wrap') || wc.includes('wrapping'), operation: 'WRAP', routeCode: 'WRAPPER' },
  { test: ({ op, wc }) => op.includes('coat') || op.includes('dip') || wc.includes('coating'), operation: 'COAT', routeCode: 'COATER' },
  { test: ({ op }) => op.includes('pack') || op.includes('assemble'), operation: 'PACK', routeCode: 'PACKAGING' }
];

const CATEGORY_SUPPLIERS = {
  cocoa: 'Siam Cacao Partners',
  dairy: 'Northern Dairy Ingredients',
  coconut: 'Andaman Coconut Foods',
  sugar: 'Organic Cane Sugar Co-op',
  driedFruit: 'Chiang Mai Fruit Traders',
  spices: 'Lanna Spice Collective',
  oils: 'Botanical Extract House',
  nuts: 'Golden Orchard Nuts',
  inclusions: 'Specialty Inclusion Works',
  packaging: 'Chiang Mai Packaging Works',
  labels: 'Nimman Print & Label',
  wholesale: 'Factory Bulk Supply',
  other: 'Regional Ingredients Network'
};

const EXISTING_COSTS = new Map([
  ['cacao beans', { unitCost: 4.25, uom: 'kg' }],
  ['cacao butter', { unitCost: 0.0081, uom: 'g' }],
  ['powdered milk', { unitCost: 0.0034, uom: 'g' }],
  ['coconut milk powder', { unitCost: 0.0049, uom: 'g' }],
  ['organic cane sugar', { unitCost: 0.00115, uom: 'g' }],
  ['flow wrap foil', { unitCost: 0.012, uom: 'g' }],
  ['vacuum pack bags', { unitCost: 0.04, uom: 'piece' }],
  ['stickers clear', { unitCost: 0.01, uom: 'piece' }]
]);

const LOCATION_BY_CLASS = {
  raw: 'FACTORY_RM_STORE',
  packaging: 'FACTORY_PACK_STORE',
  finished: 'FACTORY_FG_STAGE',
  intermediate: 'FACTORY_PRODUCTION'
};

function collapseWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeItemKey(name) {
  return collapseWhitespace(name)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeUom(raw) {
  const value = collapseWhitespace(raw).toLowerCase();
  if (!value) return 'piece';
  if (['piece', 'pieces', 'pc', 'pcs', 'each', 'unit', 'units'].includes(value)) return 'piece';
  if (['g', 'gram', 'grams'].includes(value)) return 'g';
  if (['kg', 'kilogram', 'kilograms'].includes(value)) return 'kg';
  return value;
}

function uomDimension(uom) {
  const normalized = normalizeUom(uom);
  if (normalized === 'g' || normalized === 'kg') return 'mass';
  if (normalized === 'piece') return 'count';
  return normalized;
}

function toBaseQuantity(quantity, uom) {
  const normalized = normalizeUom(uom);
  if (normalized === 'kg') return { quantity: quantity * 1000, uom: 'g' };
  if (normalized === 'piece') return { quantity, uom: 'piece' };
  return { quantity, uom: normalized };
}

function convertQuantity(quantity, fromUom, toUom) {
  const from = normalizeUom(fromUom);
  const to = normalizeUom(toUom);
  if (from === to) return quantity;
  if (uomDimension(from) !== uomDimension(to)) return null;
  if (uomDimension(from) === 'mass') {
    const grams = from === 'kg' ? quantity * 1000 : quantity;
    return to === 'kg' ? grams / 1000 : grams;
  }
  if (uomDimension(from) === 'count') return quantity;
  return null;
}

function roundUp(quantity, step) {
  return Math.ceil(quantity / step) * step;
}

function formatNumber(value) {
  if (Math.abs(value - Math.round(value)) < 1e-9) return String(Math.round(value));
  return Number(value.toFixed(6)).toString();
}

function slugify(value) {
  return normalizeItemKey(value).replace(/\s+/g, '-');
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeTextFile(filePath, text) {
  fs.writeFileSync(filePath, text, 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function isPackagingName(name) {
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
    || lower.includes('paper')
    || lower.includes('shrink film')
  );
}

function categorizeLeaf(name, uom) {
  const lower = name.toLowerCase();
  if (isPackagingName(name)) {
    if (lower.includes('sticker') || lower.includes('label')) return 'labels';
    return 'packaging';
  }
  if (lower.includes('cacao bean') || lower.includes('cacao nib') || lower.includes('cacao butter') || lower.includes('cacao powder')) {
    return 'cocoa';
  }
  if (lower.includes('milk')) return lower.includes('coconut') ? 'coconut' : 'dairy';
  if (lower.includes('sugar')) return 'sugar';
  if (lower.includes('almond') || lower.includes('cashew') || lower.includes('pecan') || lower.includes('peanut') || lower.includes('pumpkin seed') || lower.includes('sunflower seed')) return 'nuts';
  if (lower.includes('oil')) return 'oils';
  if (
    lower.includes('dried')
    || lower.includes('banana')
    || lower.includes('apple')
    || lower.includes('pineapple')
    || lower.includes('mango')
    || lower.includes('pomelo')
    || lower.includes('orange')
    || lower.includes('durian')
    || lower.includes('strawberr')
  ) {
    return 'driedFruit';
  }
  if (
    lower.includes('powder')
    || lower.includes('salt')
    || lower.includes('tea')
    || lower.includes('coffee')
    || lower.includes('chili')
    || lower.includes('curry')
    || lower.includes('masala')
    || lower.includes('tom yum')
    || lower.includes('kaffir')
    || lower.includes('lemongrass')
    || lower.includes('cardamom')
    || lower.includes('clove')
    || lower.includes('star anise')
    || lower.includes('allspice')
    || lower.includes('vanilla')
    || lower.includes('galangal')
    || lower.includes('shallot')
  ) {
    return 'spices';
  }
  if (uom === 'piece') return 'packaging';
  return 'inclusions';
}

function leafBaseUom(graph, key) {
  const node = graph.nodes.get(key);
  const uoms = node ? [...node.componentUoms] : [];
  if (uoms.includes('piece')) return 'piece';
  if (uoms.includes('kg')) return 'kg';
  if (uoms.includes('g')) return 'g';
  return graph.packagingKeys.has(key) ? 'piece' : 'g';
}

function leadTimeForCategory(category) {
  switch (category) {
    case 'cocoa':
      return 28;
    case 'dairy':
      return 21;
    case 'coconut':
      return 18;
    case 'sugar':
      return 14;
    case 'driedFruit':
      return 16;
    case 'spices':
      return 21;
    case 'oils':
      return 24;
    case 'nuts':
      return 14;
    case 'packaging':
      return 15;
    case 'labels':
      return 10;
    default:
      return 18;
  }
}

function minOrderQtyFor(category, uom) {
  if (uom === 'piece') {
    if (category === 'labels') return 250;
    if (category === 'packaging') return 100;
    return 50;
  }
  if (category === 'cocoa') return 5000;
  if (category === 'sugar') return 10000;
  if (category === 'dairy' || category === 'coconut') return 5000;
  if (category === 'spices' || category === 'oils') return 500;
  if (category === 'nuts' || category === 'driedFruit') return 2000;
  return 1000;
}

function costForLeaf(name, uom, category) {
  const key = normalizeItemKey(name);
  const existing = EXISTING_COSTS.get(key);
  if (existing) {
    const converted = convertQuantity(existing.unitCost, existing.uom, uom);
    if (converted !== null) return Number(converted.toFixed(6));
  }

  if (uom === 'piece') {
    if (category === 'labels') return 0.015;
    if (name.toLowerCase().includes('box')) return 0.22;
    if (name.toLowerCase().includes('tin')) return 0.34;
    if (name.toLowerCase().includes('bag')) return 0.05;
    if (name.toLowerCase().includes('sleeve')) return 0.07;
    if (name.toLowerCase().includes('wrapper')) return 0.03;
    return 0.025;
  }

  switch (category) {
    case 'cocoa':
      return name.toLowerCase().includes('butter') ? 0.0081 : 0.0056;
    case 'dairy':
      return 0.0035;
    case 'coconut':
      return 0.0049;
    case 'sugar':
      return 0.00115;
    case 'driedFruit':
      return 0.0098;
    case 'spices':
      return 0.0145;
    case 'oils':
      return 0.025;
    case 'nuts':
      return 0.0108;
    case 'inclusions':
      return 0.0084;
    default:
      return 0.006;
  }
}

function shelfLifeDaysFor(category, name) {
  const lower = name.toLowerCase();
  if (category === 'labels' || category === 'packaging') return 3650;
  if (category === 'cocoa') return lower.includes('bean') ? 730 : 540;
  if (category === 'dairy' || category === 'coconut') return 365;
  if (category === 'sugar') return 1460;
  if (category === 'spices') return 365;
  if (category === 'oils') return 270;
  if (category === 'driedFruit' || category === 'nuts') return 240;
  return 365;
}

function seasonalMultiplier(finishedName, month) {
  const lower = finishedName.toLowerCase();
  if (lower.includes('halloween')) return month === 10 ? 2.8 : month === 9 ? 1.6 : 0.2;
  if (lower.includes('christmas')) return month >= 11 ? 2.4 : month === 10 ? 1.2 : 0.2;
  if (lower.includes('loi kratong')) return month === 11 ? 2.6 : month === 10 ? 1.1 : 0.25;
  if (lower.includes('collection') || lower.includes('tasting box')) return month >= 10 ? 1.9 : 0.75;
  if (lower.includes('sample cubes')) return month >= 10 ? 1.25 : 1;
  return 1;
}

function demandProfileForFinished(name) {
  const lower = name.toLowerCase();
  if (lower.includes('collection') || lower.includes('tasting box')) return { monthlyBase: 10, channel: 'gift', priority: 'normal' };
  if (lower.includes('sample cubes')) return { monthlyBase: 16, channel: 'sampling', priority: 'normal' };
  if (lower.includes('couverture') || lower.includes('cacao mass') || lower.includes('ceremonial') || lower.includes('drinking chocolate')) {
    return { monthlyBase: 12, channel: 'wholesale', priority: 'normal' };
  }
  if (lower.includes('cacao nibs') || lower.includes('cacao powder')) return { monthlyBase: 8, channel: 'retail', priority: 'normal' };
  if (lower.includes('(8g)')) return { monthlyBase: 18, channel: 'hospitality', priority: 'high' };
  if (lower.includes('paleo robbie')) return { monthlyBase: 11, channel: 'retail', priority: 'normal' };
  if (lower.includes('(75g)')) return { monthlyBase: 14, channel: 'retail', priority: 'normal' };
  if (lower.includes('(20g)')) return { monthlyBase: 13, channel: 'retail', priority: 'normal' };
  return { monthlyBase: 6, channel: 'retail', priority: 'normal' };
}

function customerCodeForChannel(channel, month, ordinal) {
  const prefix = channel === 'hospitality'
    ? 'HOTEL'
    : channel === 'wholesale'
      ? 'WHOLESALE'
      : channel === 'gift'
        ? 'CORPORATE'
        : channel === 'sampling'
          ? 'EVENT'
          : 'RETAIL';
  return `${prefix}-${String(month).padStart(2, '0')}-${String(ordinal).padStart(2, '0')}`;
}

function sortByName(values) {
  return [...values].sort((left, right) => String(left).localeCompare(String(right)));
}

function buildSeedRepositoryMap() {
  return {
    generatedAt: GENERATED_AT,
    datasets: [
      { kind: 'bom', path: 'scripts/seed/siamaya/siamaya-bom-production.json', role: 'authoritative normalized BOM seed' },
      { kind: 'inventory', path: 'scripts/seed/siamaya/initial-stock-spec.json', role: 'expanded opening inventory seed' },
      { kind: 'inventory', path: 'scripts/seed/siamaya/initial-stock-spec.partial.json', role: 'preserved baseline partial opening inventory seed' },
      { kind: 'pipeline', path: 'scripts/seed/siamaya/import_bom_from_xlsx.ts', role: 'BOM import from workbook/json' },
      { kind: 'pipeline', path: 'scripts/seed/siamaya/preprocess_bom_csv.ts', role: 'manual BOM preprocess and correction rules' },
      { kind: 'routing', path: 'scripts/seed/siamaya/routing-normalization.json', role: 'canonical routing and work-center metadata' },
      { kind: 'procurement', path: 'scripts/seed/siamaya/procurement-metadata.json', role: 'procurement planning attributes for leaf items' },
      { kind: 'work_orders', path: 'scripts/seed/siamaya/work-order-scenarios.json', role: 'representative manufacturing lifecycle scenarios' },
      { kind: 'demand', path: 'scripts/seed/siamaya/demand-simulation.json', role: 'timestamped demand stream for finished SKUs' },
      { kind: 'graphviz', path: 'scripts/seed/siamaya/factory-dag.dot', role: 'complete product DAG' },
      { kind: 'graphviz', path: 'scripts/seed/siamaya/factory-ingredient-flow.dot', role: 'ingredient-only production flow' },
      { kind: 'graphviz', path: 'scripts/seed/siamaya/factory-packaging-flow.dot', role: 'packaging assembly flow' },
      { kind: 'report', path: 'scripts/seed/siamaya/mrp-explosion.csv', role: 'full MRP leaf explosion table' },
      { kind: 'report', path: 'scripts/seed/siamaya/inventory-gap-analysis.json', role: 'coverage and gap analysis summary' },
      { kind: 'report', path: 'scripts/seed/siamaya/simulation-validation.json', role: 'coverage, acyclic, and simulation validation report' }
    ],
    warehouseSeeds: [
      'seeds/topology/warehouses.tsv',
      'seeds/topology/warehouse_defaults.tsv',
      'seeds/topology/locations.tsv'
    ],
    packEntrypoints: [
      'scripts/seed/packs/siamaya_factory.ts',
      'scripts/seed/run.ts'
    ]
  };
}

function inferFallbackRoute(outputName, components) {
  const lower = outputName.toLowerCase();
  const hasPackaging = components.some((component) => isPackagingName(component.name));
  if (lower.includes('collection') || lower.includes('box') || lower.includes('tasting')) {
    return { operation: 'PACK', routeCode: 'PACKAGING' };
  }
  if (lower.includes('foil') || lower.includes('flow wrap') || lower.includes('unwrapped') || lower.includes('wrapper')) {
    return { operation: 'WRAP', routeCode: 'WRAPPER' };
  }
  if (lower.startsWith('base -')) {
    return { operation: 'PREREFINE', routeCode: 'PREREFINER' };
  }
  if (lower.includes('nibs') || lower.includes('powder') || lower.includes('drinking chocolate')) {
    return { operation: 'PACK', routeCode: 'PACKAGING' };
  }
  if (hasPackaging) {
    return { operation: 'PACK', routeCode: 'PACKAGING' };
  }
  return { operation: 'TEMPER', routeCode: 'TEMPERER' };
}

function resolveRoutingForRow(row, outputName, components) {
  const op = collapseWhitespace(row.Operation).toLowerCase();
  const wc = collapseWhitespace(row['Work Center']).toLowerCase();
  for (const entry of RAW_ROUTE_MAP) {
    if (entry.test({ op, wc, outputName: outputName.toLowerCase() })) {
      return { operation: entry.operation, routeCode: entry.routeCode };
    }
  }
  return inferFallbackRoute(outputName, components);
}

function buildBomGraph(bomDocument) {
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

  for (const row of bomDocument.rows) {
    const outputName = collapseWhitespace(row['Finished Product']);
    const componentName = collapseWhitespace(row['Component Item']);
    const outputKey = normalizeItemKey(outputName);
    const componentKey = normalizeItemKey(componentName);
    const outputQty = Number(row['Output Qty']);
    const outputUom = normalizeUom(row['Output UOM']);
    const componentQty = Number(row['Component Qty']);
    const componentUom = normalizeUom(row['Component UOM']);

    if (!outputKey || !componentKey || !Number.isFinite(outputQty) || !Number.isFinite(componentQty)) {
      continue;
    }

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
        rows: [],
        components: [],
        routeCode: null,
        routeOperation: null
      });
    }

    const bom = boms.get(outputKey);
    bom.rows.push(row);
    bom.components.push({
      key: componentKey,
      name: componentName,
      qty: componentQty,
      uom: componentUom
    });

    if (!edges.has(componentKey)) edges.set(componentKey, new Set());
    edges.get(componentKey).add(outputKey);
    if (!reverseEdges.has(outputKey)) reverseEdges.set(outputKey, new Set());
    reverseEdges.get(outputKey).add(componentKey);
  }

  const outputKeys = new Set([...boms.keys()]);
  const componentKeys = new Set([...nodes.values()].filter((node) => node.appearsAsComponent).map((node) => node.key));
  const finishedKeys = new Set([...outputKeys].filter((key) => !componentKeys.has(key)));
  const intermediateKeys = new Set([...outputKeys].filter((key) => componentKeys.has(key)));
  const leafKeys = new Set([...componentKeys].filter((key) => !outputKeys.has(key)));
  const packagingKeys = new Set([...leafKeys].filter((key) => isPackagingName(nodes.get(key)?.name ?? key)));
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
    .sort();
  const topo = [];
  const layerByKey = new Map();
  for (const key of queue) layerByKey.set(key, 0);

  while (queue.length > 0) {
    const current = queue.shift();
    topo.push(current);
    const layer = layerByKey.get(current) ?? 0;
    for (const target of sortByName(edges.get(current) ?? [])) {
      layerByKey.set(target, Math.max(layerByKey.get(target) ?? 0, layer + 1));
      indegree.set(target, (indegree.get(target) ?? 0) - 1);
      if (indegree.get(target) === 0) {
        queue.push(target);
        queue.sort();
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
    cycleKeys
  };
}

function normalizeBomDocument(bomDocument, graph) {
  const outputRoute = new Map();
  for (const bom of graph.boms.values()) {
    const resolved = bom.rows
      .map((row) => resolveRoutingForRow(row, bom.outputName, bom.components))
      .find(Boolean) ?? inferFallbackRoute(bom.outputName, bom.components);
    outputRoute.set(bom.outputKey, resolved);
  }

  const normalizedRows = bomDocument.rows.map((row) => {
    const outputName = collapseWhitespace(row['Finished Product']);
    const outputKey = normalizeItemKey(outputName);
    const route = outputRoute.get(outputKey);
    return {
      ...row,
      Operation: route.operation,
      'Work Center': route.routeCode
    };
  });

  const normalizedDocument = {
    ...bomDocument,
    processedAt: GENERATED_AT,
    normalization: {
      routeCatalogVersion: 1,
      normalizedAt: GENERATED_AT
    },
    rows: normalizedRows
  };

  const routingItems = [...graph.boms.values()]
    .map((bom) => {
      const route = outputRoute.get(bom.outputKey);
      const catalog = ROUTE_CATALOG[route.routeCode];
      return {
        itemKey: bom.outputKey,
        itemName: bom.outputName,
        outputQty: bom.outputQty,
        outputUom: bom.outputUom,
        operationCode: route.operation,
        workCenterCode: route.routeCode,
        workCenterName: catalog.workCenterName,
        description: catalog.description,
        setupTimeMinutes: catalog.setupTimeMinutes,
        runTimeMinutes: catalog.runTimeMinutes,
        machineTimeMinutes: catalog.machineTimeMinutes
      };
    })
    .sort((left, right) => left.itemName.localeCompare(right.itemName));

  return {
    normalizedDocument,
    routingDocument: {
      generatedAt: GENERATED_AT,
      canonicalWorkCenters: Object.values(ROUTE_CATALOG)
        .map((entry) => ({
          code: entry.workCenterCode,
          name: entry.workCenterName,
          description: entry.description,
          hourlyRate: entry.hourlyRate,
          capacity: entry.capacity
        }))
        .sort((left, right) => left.code.localeCompare(right.code)),
      routings: routingItems
    }
  };
}

function expandLeaves(graph, itemKey, quantity, uom, trail = []) {
  if (trail.includes(itemKey)) {
    return { ok: false, cycle: [...trail, itemKey] };
  }
  const bom = graph.boms.get(itemKey);
  if (!bom) {
    const base = toBaseQuantity(quantity, uom);
    return {
      ok: true,
      leaves: new Map([[`${itemKey}__${base.uom}`, { key: itemKey, name: graph.nodes.get(itemKey)?.name ?? itemKey, quantity: base.quantity, uom: base.uom }]]),
      expanded: new Set(),
      pathCount: 1
    };
  }

  const requestedQty = convertQuantity(quantity, uom, bom.outputUom);
  if (requestedQty === null) {
    return { ok: false, mismatch: { itemKey, quantity, uom, outputUom: bom.outputUom } };
  }
  const multiplier = requestedQty / bom.outputQty;
  const leaves = new Map();
  const expanded = new Set([itemKey]);
  let pathCount = 0;

  for (const component of bom.components) {
    const nested = expandLeaves(graph, component.key, component.qty * multiplier, component.uom, [...trail, itemKey]);
    if (!nested.ok) return nested;
    for (const [signature, leaf] of nested.leaves.entries()) {
      if (leaves.has(signature)) {
        leaves.get(signature).quantity += leaf.quantity;
      } else {
        leaves.set(signature, { ...leaf });
      }
    }
    for (const expandedKey of nested.expanded) expanded.add(expandedKey);
    pathCount += nested.pathCount;
  }

  return { ok: true, leaves, expanded, pathCount };
}

function computeDependentFinishedCounts(graph) {
  const memo = new Map();
  function visit(key) {
    if (memo.has(key)) return memo.get(key);
    const dependentFinished = new Set();
    for (const child of graph.edges.get(key) ?? []) {
      if (graph.finishedKeys.has(child)) dependentFinished.add(child);
      for (const nested of visit(child)) dependentFinished.add(nested);
    }
    memo.set(key, dependentFinished);
    return dependentFinished;
  }
  const counts = [];
  for (const key of graph.nodes.keys()) {
    counts.push({
      itemKey: key,
      itemName: graph.nodes.get(key)?.name ?? key,
      dependentFinishedGoods: visit(key).size,
      directOutputs: (graph.edges.get(key) ?? new Set()).size
    });
  }
  return counts.sort((left, right) => right.dependentFinishedGoods - left.dependentFinishedGoods || left.itemName.localeCompare(right.itemName));
}

function buildDemandDataset(graph) {
  const orders = [];
  let lineCounter = 1;
  const finishedBoms = [...graph.finishedKeys]
    .map((key) => graph.boms.get(key))
    .filter(Boolean)
    .sort((left, right) => left.outputName.localeCompare(right.outputName));

  for (const bom of finishedBoms) {
    const profile = demandProfileForFinished(bom.outputName);
    const skuBias = (bom.outputName.length % 4) * 0.12 + 0.88;
    for (let month = 1; month <= 12; month += 1) {
      const multiplier = seasonalMultiplier(bom.outputName, month);
      const rawQty = profile.monthlyBase * multiplier * skuBias;
      const orderQty = Math.max(0, Math.round(rawQty));
      if (orderQty === 0) continue;
      const orderedAt = `2026-${String(month).padStart(2, '0')}-${String(((lineCounter - 1) % 24) + 1).padStart(2, '0')}T09:00:00.000Z`;
      const requestedShipDate = `2026-${String(month).padStart(2, '0')}-${String(Math.min((((lineCounter - 1) % 24) + 5), 28)).padStart(2, '0')}T00:00:00.000Z`;
      orders.push({
        orderId: `SO-SIAMAYA-2026-${String(lineCounter).padStart(4, '0')}`,
        customerCode: customerCodeForChannel(profile.channel, month, lineCounter),
        orderedAt,
        requestedShipDate,
        channel: profile.channel,
        priority: profile.priority,
        finishedItemKey: bom.outputKey,
        finishedItemName: bom.outputName,
        quantity: orderQty * bom.outputQty,
        uom: bom.outputUom
      });
      lineCounter += 1;
    }
  }

  return {
    generatedAt: GENERATED_AT,
    horizonStart: '2026-01-01T00:00:00.000Z',
    horizonEnd: '2026-12-31T23:59:59.999Z',
    orders
  };
}

function aggregateDemandLeafRequirements(graph, demandDataset) {
  const leafDemand = new Map();
  const finishedDemand = new Map();

  for (const order of demandDataset.orders) {
    const expansion = expandLeaves(graph, order.finishedItemKey, order.quantity, order.uom);
    if (!expansion.ok) {
      throw new Error(`Demand expansion failed for ${order.finishedItemName}`);
    }
    finishedDemand.set(order.finishedItemKey, (finishedDemand.get(order.finishedItemKey) ?? 0) + order.quantity);
    for (const leaf of expansion.leaves.values()) {
      const signature = `${leaf.key}__${leaf.uom}`;
      if (leafDemand.has(signature)) {
        leafDemand.get(signature).quantity += leaf.quantity;
      } else {
        leafDemand.set(signature, { ...leaf });
      }
    }
  }

  return { leafDemand, finishedDemand };
}

function buildProcurementMetadata(graph, demandAggregation) {
  const metadata = [];
  const days = 365;
  for (const key of sortByName(graph.leafKeys)) {
    const node = graph.nodes.get(key);
    const name = node?.name ?? key;
    const baseUom = leafBaseUom(graph, key);
    const category = categorizeLeaf(name, baseUom);
    const leadTimeDays = leadTimeForCategory(category);
    const demandEntry = [...demandAggregation.leafDemand.values()].find((leaf) => leaf.key === key);
    const annualDemand = demandEntry ? convertQuantity(demandEntry.quantity, demandEntry.uom, baseUom) ?? 0 : 0;
    const demandRatePerDay = annualDemand / days;
    const minimumOrderQty = minOrderQtyFor(category, baseUom);
    const reorderPoint = baseUom === 'piece'
      ? Math.max(minimumOrderQty, Math.ceil(demandRatePerDay * (leadTimeDays + 7)))
      : roundUp(Math.max(minimumOrderQty, demandRatePerDay * (leadTimeDays + 10)), minimumOrderQty >= 5000 ? 500 : 50);

    metadata.push({
      itemKey: key,
      itemName: name,
      category,
      uom: baseUom,
      preferredSupplier: CATEGORY_SUPPLIERS[category] ?? CATEGORY_SUPPLIERS.other,
      leadTimeDays,
      minimumOrderQty,
      reorderPoint,
      demandRatePerDay: Number(demandRatePerDay.toFixed(baseUom === 'piece' ? 2 : 4))
    });
  }

  return {
    generatedAt: GENERATED_AT,
    items: metadata.sort((left, right) => left.itemName.localeCompare(right.itemName))
  };
}

function groupExistingStockEntries(initialStockDocument) {
  const grouped = new Map();
  for (const line of initialStockDocument.items) {
    const key = normalizeItemKey(line.itemKey);
    const base = toBaseQuantity(Number(line.quantity), line.uom);
    if (!grouped.has(key)) {
      grouped.set(key, { quantity: 0, uom: base.uom });
    }
    const current = grouped.get(key);
    current.quantity += convertQuantity(base.quantity, base.uom, current.uom) ?? 0;
  }
  return grouped;
}

function buildExpandedOpeningInventory(graph, demandAggregation, procurementMetadata, existingStock) {
  const procurementByKey = new Map(procurementMetadata.items.map((item) => [item.itemKey, item]));
  const items = [];

  for (const key of sortByName(graph.leafKeys)) {
    const node = graph.nodes.get(key);
    const name = node?.name ?? key;
    const procurement = procurementByKey.get(key);
    const demandEntry = [...demandAggregation.leafDemand.values()].find((leaf) => leaf.key === key);
    const category = procurement.category;
    const baseUom = procurement.uom;
    const annualDemand = demandEntry ? convertQuantity(demandEntry.quantity, demandEntry.uom, baseUom) ?? 0 : 0;
    const safetyStock = baseUom === 'piece'
      ? Math.max(procurement.minimumOrderQty * 0.4, Math.ceil(annualDemand / 24))
      : Math.max(procurement.minimumOrderQty * 0.35, annualDemand / 20);
    const leadCoverage = annualDemand / 365 * (procurement.leadTimeDays + 14);
    const existing = existingStock.get(key);
    const existingQty = existing ? convertQuantity(existing.quantity, existing.uom, baseUom) ?? 0 : 0;
    let targetQty = Math.max(existingQty, leadCoverage + safetyStock);

    if (baseUom === 'piece') {
      targetQty = roundUp(Math.max(targetQty, procurement.minimumOrderQty), 25);
    } else if (category === 'cocoa' || category === 'sugar') {
      targetQty = roundUp(Math.max(targetQty, procurement.minimumOrderQty), 500);
    } else if (category === 'dairy' || category === 'coconut' || category === 'nuts' || category === 'driedFruit') {
      targetQty = roundUp(Math.max(targetQty, procurement.minimumOrderQty), 250);
    } else if (category === 'spices' || category === 'oils') {
      targetQty = roundUp(Math.max(targetQty, procurement.minimumOrderQty), 50);
    } else {
      targetQty = roundUp(Math.max(targetQty, procurement.minimumOrderQty), 100);
    }

    const locationCode = category === 'packaging' || category === 'labels' ? LOCATION_BY_CLASS.packaging : LOCATION_BY_CLASS.raw;
    const unitCost = costForLeaf(name, baseUom, category);
    const shelfLifeDays = shelfLifeDaysFor(category, name);
    const lotCount = baseUom === 'piece'
      ? 1
      : category === 'cocoa' || category === 'dairy' || category === 'coconut'
        ? 3
        : targetQty >= procurement.minimumOrderQty * 2
          ? 2
          : 1;

    const split = [];
    let remaining = targetQty;
    for (let index = 0; index < lotCount; index += 1) {
      const divisor = lotCount - index;
      const qty = index === lotCount - 1
        ? remaining
        : baseUom === 'piece'
          ? roundUp(remaining / divisor, 5)
          : Number((remaining / divisor).toFixed(3));
      remaining -= qty;
      split.push(qty);
    }

    split.forEach((quantity, index) => {
      const productionDate = new Date(STOCK_DATE);
      productionDate.setUTCDate(productionDate.getUTCDate() - ((index + 1) * Math.max(7, Math.floor(shelfLifeDays / (lotCount + 3)))));
      const expirationDate = new Date(productionDate);
      expirationDate.setUTCDate(expirationDate.getUTCDate() + shelfLifeDays);

      const item = {
        itemKey: key,
        quantity: Number(quantity.toFixed(baseUom === 'piece' ? 0 : 3)),
        uom: baseUom,
        unitCost,
        locationCode,
        lotCode: baseUom === 'piece' ? undefined : `LOT-${slugify(key).toUpperCase()}-2026-${String(index + 1).padStart(2, '0')}`,
        productionDate: baseUom === 'piece' ? undefined : productionDate.toISOString(),
        expirationDate: baseUom === 'piece' ? undefined : expirationDate.toISOString()
      };
      items.push(item);
    });
  }

  const fgSamples = [
    { itemKey: 'sample cubes 70 dark chocolate', name: 'Sample Cubes - 70% Dark Chocolate', quantity: 60, uom: 'piece', unitCost: 0.42 },
    { itemKey: 'sample cubes 85 dark chocolate', name: 'Sample Cubes - 85% Dark Chocolate', quantity: 40, uom: 'piece', unitCost: 0.45 },
    { itemKey: 'cacao nibs 250g', name: 'Cacao Nibs 250g', quantity: 24, uom: 'piece', unitCost: 2.8 },
    { itemKey: 'couverture 70 dark chocolate 1kg', name: 'Couverture 70% Dark Chocolate (1kg)', quantity: 18, uom: 'piece', unitCost: 7.9 }
  ];
  fgSamples.forEach((sample, index) => {
    items.push({
      itemKey: sample.itemKey,
      quantity: sample.quantity,
      uom: sample.uom,
      unitCost: sample.unitCost,
      locationCode: LOCATION_BY_CLASS.finished,
      lotCode: `LOT-FG-${String(index + 1).padStart(2, '0')}`,
      productionDate: '2025-12-20T00:00:00.000Z',
      expirationDate: '2026-12-20T00:00:00.000Z'
    });
  });

  return {
    version: 1,
    stockDate: STOCK_DATE,
    items: items
      .sort((left, right) => {
        const itemCompare = left.itemKey.localeCompare(right.itemKey);
        if (itemCompare !== 0) return itemCompare;
        return String(left.lotCode ?? '').localeCompare(String(right.lotCode ?? ''));
      })
  };
}

function buildFinishedRequirements(graph) {
  const rows = [];
  const summary = [];
  for (const key of sortByName(graph.finishedKeys)) {
    const bom = graph.boms.get(key);
    const expansion = expandLeaves(graph, key, bom.outputQty, bom.outputUom);
    if (!expansion.ok) {
      throw new Error(`MRP expansion failed for ${bom.outputName}`);
    }
    const leaves = [...expansion.leaves.values()].sort((left, right) => left.name.localeCompare(right.name));
    summary.push({
      finishedItemKey: key,
      finishedItemName: bom.outputName,
      perBatchQty: bom.outputQty,
      perBatchUom: bom.outputUom,
      leafCount: leaves.length
    });
    for (const leaf of leaves) {
      rows.push({
        finishedItemKey: key,
        finishedItemName: bom.outputName,
        outputQty: bom.outputQty,
        outputUom: bom.outputUom,
        leafItemKey: leaf.key,
        leafItemName: leaf.name,
        leafType: graph.packagingKeys.has(leaf.key) ? 'packaging' : 'raw',
        leafQty: leaf.quantity,
        leafUom: leaf.uom
      });
    }
  }
  return { rows, summary };
}

function stockMapFromSpec(spec) {
  const stock = new Map();
  for (const line of spec.items) {
    const key = normalizeItemKey(line.itemKey);
    const base = toBaseQuantity(Number(line.quantity), line.uom);
    if (!stock.has(key)) {
      stock.set(key, { quantity: 0, uom: base.uom });
    }
    const current = stock.get(key);
    current.quantity += convertQuantity(base.quantity, base.uom, current.uom) ?? 0;
  }
  return stock;
}

function computeCoverage(graph, stockSpec) {
  const stock = stockMapFromSpec(stockSpec);
  const finished = [];
  const shortagesByLeaf = new Map();

  for (const key of sortByName(graph.finishedKeys)) {
    const bom = graph.boms.get(key);
    const expansion = expandLeaves(graph, key, bom.outputQty, bom.outputUom);
    if (!expansion.ok) throw new Error(`Coverage expansion failed for ${bom.outputName}`);

    const shortages = [];
    for (const leaf of expansion.leaves.values()) {
      const available = stock.get(leaf.key);
      const availableQty = available ? convertQuantity(available.quantity, available.uom, leaf.uom) ?? 0 : 0;
      if (availableQty + 1e-9 < leaf.quantity) {
        shortages.push({
          itemKey: leaf.key,
          itemName: leaf.name,
          requiredQty: leaf.quantity,
          availableQty,
          uom: leaf.uom
        });
        shortagesByLeaf.set(leaf.key, (shortagesByLeaf.get(leaf.key) ?? 0) + 1);
      }
    }

    finished.push({
      itemKey: key,
      itemName: bom.outputName,
      producible: shortages.length === 0,
      shortageCount: shortages.length,
      shortages
    });
  }

  const producibleCount = finished.filter((item) => item.producible).length;
  return {
    producibleCount,
    blockedCount: finished.length - producibleCount,
    coverageRatio: finished.length === 0 ? 0 : producibleCount / finished.length,
    finished
  };
}

function buildGapAnalysis(graph, originalStockSpec) {
  const baseCoverage = computeCoverage(graph, originalStockSpec);
  const targetCount = Math.ceil(graph.finishedKeys.size * COVERAGE_TARGET);
  const baseStockKeys = new Set(originalStockSpec.items.map((line) => normalizeItemKey(line.itemKey)));

  const missingSets = [];
  for (const finished of baseCoverage.finished.filter((entry) => !entry.producible)) {
    missingSets.push({
      itemKey: finished.itemKey,
      itemName: finished.itemName,
      missingLeafKeys: finished.shortages.map((shortage) => shortage.itemKey).sort(),
      missingLeafNames: finished.shortages.map((shortage) => shortage.itemName).sort()
    });
  }

  const selected = new Set();
  const unlocked = new Set(baseCoverage.finished.filter((entry) => entry.producible).map((entry) => entry.itemKey));

  while (unlocked.size < targetCount) {
    let best = null;
    const candidates = new Set();
    for (const missing of missingSets) {
      if (unlocked.has(missing.itemKey)) continue;
      for (const leafKey of missing.missingLeafKeys) {
        if (!baseStockKeys.has(leafKey) && !selected.has(leafKey)) candidates.add(leafKey);
      }
    }

    for (const candidate of candidates) {
      const prospective = new Set([...selected, candidate]);
      const newlyUnlocked = [];
      for (const missing of missingSets) {
        if (unlocked.has(missing.itemKey)) continue;
        if (missing.missingLeafKeys.every((leafKey) => baseStockKeys.has(leafKey) || prospective.has(leafKey))) {
          newlyUnlocked.push(missing.itemKey);
        }
      }
      if (!best || newlyUnlocked.length > best.unlockCount || (newlyUnlocked.length === best.unlockCount && candidate.localeCompare(best.leafKey) < 0)) {
        best = { leafKey: candidate, unlockCount: newlyUnlocked.length, newlyUnlocked };
      }
    }

    if (!best) break;
    selected.add(best.leafKey);
    for (const itemKey of best.newlyUnlocked) unlocked.add(itemKey);
  }

  const recommendedLeafs = [...selected]
    .map((leafKey) => {
      const shortages = missingSets
        .filter((missing) => missing.missingLeafKeys.includes(leafKey))
        .map((missing) => missing.itemName);
      return {
        leafItemKey: leafKey,
        leafItemName: graph.nodes.get(leafKey)?.name ?? leafKey,
        unlocksFinishedGoods: shortages.length,
        sampleFinishedGoods: shortages.slice(0, 8)
      };
    })
    .sort((left, right) => right.unlocksFinishedGoods - left.unlocksFinishedGoods || left.leafItemName.localeCompare(right.leafItemName));

  return {
    generatedAt: GENERATED_AT,
    targetCoverageRatio: COVERAGE_TARGET,
    targetFinishedGoods: targetCount,
    baseCoverage: {
      producibleCount: baseCoverage.producibleCount,
      blockedCount: baseCoverage.blockedCount,
      coverageRatio: Number(baseCoverage.coverageRatio.toFixed(4))
    },
    greedyExpansion: {
      addedLeafItemCount: recommendedLeafs.length,
      unlockedFinishedGoods: unlocked.size,
      coverageRatio: Number((unlocked.size / graph.finishedKeys.size).toFixed(4)),
      addedLeafItems: recommendedLeafs
    },
    method: 'deterministic_greedy_leaf_coverage'
  };
}

function buildGraphMetrics(graph) {
  const dependentCounts = computeDependentFinishedCounts(graph);
  const edgeCount = [...graph.edges.values()].reduce((sum, targets) => sum + targets.size, 0);
  const maxDepth = Math.max(...graph.layerByKey.values());
  return {
    generatedAt: GENERATED_AT,
    nodeCount: graph.nodes.size,
    edgeCount,
    dependencyDepth: maxDepth,
    rawMaterials: graph.rawKeys.size,
    intermediates: graph.intermediateKeys.size,
    finishedGoods: graph.finishedKeys.size,
    packagingComponents: graph.packagingKeys.size,
    topCentrality: dependentCounts.slice(0, 20)
  };
}

function selectRepresentativeWorkOrders(graph, routingDocument) {
  const routeByItemKey = new Map(routingDocument.routings.map((item) => [item.itemKey, item]));
  const picks = [
    'couverture 70 dark chocolate 1kg',
    'banana crunch milk chocolate 75g',
    'tasting box',
    'cacao nibs 250g',
    'thai tea milk chocolate 20g',
    'paleo robbie banana bites 100g'
  ];
  const statuses = ['PLANNED', 'RELEASED', 'ALLOCATED', 'IN_PROCESS', 'COMPLETED', 'CLOSED'];
  const workOrders = [];

  picks.forEach((key, index) => {
    const bom = graph.boms.get(key);
    if (!bom) return;
    const route = routeByItemKey.get(key);
    const expansion = expandLeaves(graph, key, bom.outputQty * (index + 1), bom.outputUom);
    if (!expansion.ok) return;
    const state = statuses[index % statuses.length];
    workOrders.push({
      workOrderCode: `WO-SIAMAYA-${String(index + 1).padStart(3, '0')}`,
      itemKey: bom.outputKey,
      itemName: bom.outputName,
      simulationState: state,
      platformStatus: state === 'PLANNED' ? 'draft' : state === 'RELEASED' || state === 'ALLOCATED' ? 'released' : state === 'IN_PROCESS' ? 'in_progress' : 'completed',
      scheduledStartAt: `2026-01-${String(5 + index * 2).padStart(2, '0')}T08:00:00.000Z`,
      scheduledDueAt: `2026-01-${String(6 + index * 2).padStart(2, '0')}T16:00:00.000Z`,
      quantityPlanned: bom.outputQty * (index + 1),
      outputUom: bom.outputUom,
      routing: route ? {
        workCenterCode: route.workCenterCode,
        operationCode: route.operationCode,
        setupTimeMinutes: route.setupTimeMinutes,
        runTimeMinutes: route.runTimeMinutes
      } : null,
      materialRequirements: [...expansion.leaves.values()]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((leaf) => ({
          itemKey: leaf.key,
          itemName: leaf.name,
          quantity: Number(leaf.quantity.toFixed(6)),
          uom: leaf.uom
        })),
      lifecycle: [
        { state: 'PLANNED', at: `2026-01-${String(4 + index * 2).padStart(2, '0')}T09:00:00.000Z` },
        ...(state === 'PLANNED' ? [] : [{ state: 'RELEASED', at: `2026-01-${String(5 + index * 2).padStart(2, '0')}T08:00:00.000Z` }]),
        ...(['ALLOCATED', 'IN_PROCESS', 'COMPLETED', 'CLOSED'].includes(state)
          ? [{ state: 'ALLOCATED', at: `2026-01-${String(5 + index * 2).padStart(2, '0')}T10:00:00.000Z` }]
          : []),
        ...(['IN_PROCESS', 'COMPLETED', 'CLOSED'].includes(state)
          ? [{ state: 'IN_PROCESS', at: `2026-01-${String(5 + index * 2).padStart(2, '0')}T13:00:00.000Z` }]
          : []),
        ...(['COMPLETED', 'CLOSED'].includes(state)
          ? [{ state: 'COMPLETED', at: `2026-01-${String(6 + index * 2).padStart(2, '0')}T15:00:00.000Z` }]
          : []),
        ...(state === 'CLOSED' ? [{ state: 'CLOSED', at: `2026-01-${String(7 + index * 2).padStart(2, '0')}T10:00:00.000Z` }] : [])
      ]
    });
  });

  return {
    generatedAt: GENERATED_AT,
    workOrders
  };
}

function simulateProduction(graph, stockSpec, itemKey, quantityMultiplier = 1) {
  const stock = stockMapFromSpec(stockSpec);
  const bom = graph.boms.get(itemKey);
  const steps = [];
  let blocked = null;

  function consumeLeaf(key, name, quantity, uom, trail) {
    const available = stock.get(key);
    const availableQty = available ? convertQuantity(available.quantity, available.uom, uom) ?? 0 : 0;
    if (availableQty + 1e-9 < quantity) {
      blocked = { itemKey: key, itemName: name, requiredQty: quantity, availableQty, uom, trail };
      steps.push({ type: 'shortage', itemName: name, quantity: Number(quantity.toFixed(6)), uom, trail });
      return false;
    }
    const base = toBaseQuantity(quantity, uom);
    available.quantity -= convertQuantity(base.quantity, base.uom, available.uom) ?? 0;
    steps.push({ type: 'consume', itemName: name, quantity: Number(base.quantity.toFixed(6)), uom: base.uom, trail });
    return true;
  }

  function recurse(currentKey, quantity, uom, trail) {
    if (blocked) return false;
    const currentBom = graph.boms.get(currentKey);
    if (!currentBom) {
      return consumeLeaf(currentKey, graph.nodes.get(currentKey)?.name ?? currentKey, quantity, uom, trail);
    }
    const requestedQty = convertQuantity(quantity, uom, currentBom.outputUom);
    if (requestedQty === null) {
      blocked = { itemKey: currentKey, itemName: currentBom.outputName, requiredQty: quantity, availableQty: 0, uom, trail };
      return false;
    }
    const multiplier = requestedQty / currentBom.outputQty;
    for (const component of currentBom.components) {
      if (!recurse(component.key, component.qty * multiplier, component.uom, [...trail, currentBom.outputName])) return false;
    }
    steps.push({ type: 'produce', itemName: currentBom.outputName, quantity: Number(requestedQty.toFixed(6)), uom: currentBom.outputUom, trail });
    return true;
  }

  recurse(itemKey, bom.outputQty * quantityMultiplier, bom.outputUom, []);
  return {
    itemKey,
    itemName: bom.outputName,
    quantity: bom.outputQty * quantityMultiplier,
    uom: bom.outputUom,
    success: !blocked,
    blocked,
    steps
  };
}

function buildValidationDocument(graph, expandedStock, gapAnalysis, workOrdersDocument) {
  const coverage = computeCoverage(graph, expandedStock);
  const representative = workOrdersDocument.workOrders.slice(0, 4).map((workOrder, index) =>
    simulateProduction(graph, expandedStock, workOrder.itemKey, index < 2 ? 1 : 2)
  );
  return {
    generatedAt: GENERATED_AT,
    dagAcyclic: graph.cycleKeys.length === 0,
    cycleKeys: graph.cycleKeys.map((key) => graph.nodes.get(key)?.name ?? key),
    finishedGoodsCoverage: {
      producibleCount: coverage.producibleCount,
      totalFinishedGoods: graph.finishedKeys.size,
      coverageRatio: Number(coverage.coverageRatio.toFixed(4)),
      meetsTarget: coverage.coverageRatio >= COVERAGE_TARGET
    },
    inventorySeedsDeterministic: true,
    gapAnalysisMethod: gapAnalysis.method,
    simulationRuns: representative.map((result) => ({
      itemName: result.itemName,
      success: result.success,
      blocked: result.blocked ? { itemName: result.blocked.itemName, requiredQty: result.blocked.requiredQty, availableQty: result.blocked.availableQty, uom: result.blocked.uom } : null
    })),
    simulationsSucceeded: representative.every((result) => result.success)
  };
}

function renderMrpCsv(mrpRows) {
  const headers = [
    'finishedItemKey',
    'finishedItemName',
    'outputQty',
    'outputUom',
    'leafItemKey',
    'leafItemName',
    'leafType',
    'leafQty',
    'leafUom'
  ];
  const lines = [headers.join(',')];
  for (const row of mrpRows) {
    lines.push([
      row.finishedItemKey,
      row.finishedItemName,
      formatNumber(row.outputQty),
      row.outputUom,
      row.leafItemKey,
      row.leafItemName,
      row.leafType,
      formatNumber(row.leafQty),
      row.leafUom
    ].map(csvEscape).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function quoteDot(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function renderDot(graph, mode) {
  const lines = ['digraph SiamayaFactory {', '  rankdir=LR;', '  graph [fontsize=10 fontname="Helvetica"];', '  node [fontname="Helvetica" fontsize=9 shape=box style=filled];', '  edge [fontname="Helvetica" fontsize=8 color="#666666"];'];

  const layerBuckets = new Map();
  for (const [key, layer] of graph.layerByKey.entries()) {
    if (!layerBuckets.has(layer)) layerBuckets.set(layer, []);
    layerBuckets.get(layer).push(key);
  }

  const keys = sortByName(graph.nodes.keys());
  for (const key of keys) {
    const name = graph.nodes.get(key)?.name ?? key;
    const isPackaging = graph.packagingKeys.has(key);
    const isRaw = graph.rawKeys.has(key);
    const isFinished = graph.finishedKeys.has(key);
    const isIntermediate = graph.intermediateKeys.has(key);
    if (mode === 'ingredient' && isPackaging) continue;
    if (mode === 'packaging' && !(isPackaging || isIntermediate || isFinished)) continue;
    const fill = isPackaging ? '#fde68a' : isRaw ? '#bfdbfe' : isIntermediate ? '#fecaca' : isFinished ? '#bbf7d0' : '#e5e7eb';
    lines.push(`  ${quoteDot(key)} [label=${quoteDot(name)} fillcolor=${quoteDot(fill)}];`);
  }

  for (const layer of [...layerBuckets.keys()].sort((left, right) => left - right)) {
    const keysInLayer = layerBuckets.get(layer)
      .filter((key) => {
        if (mode === 'ingredient' && graph.packagingKeys.has(key)) return false;
        if (mode === 'packaging' && !(graph.packagingKeys.has(key) || graph.intermediateKeys.has(key) || graph.finishedKeys.has(key))) return false;
        return true;
      });
    if (keysInLayer.length === 0) continue;
    lines.push(`  { rank=same; ${keysInLayer.map((key) => quoteDot(key)).join(' ')} }`);
  }

  for (const [from, targets] of graph.edges.entries()) {
    for (const to of sortByName(targets)) {
      const fromPackaging = graph.packagingKeys.has(from);
      if (mode === 'ingredient' && fromPackaging) continue;
      if (mode === 'packaging' && !fromPackaging && !graph.intermediateKeys.has(from) && !graph.finishedKeys.has(from)) continue;
      lines.push(`  ${quoteDot(from)} -> ${quoteDot(to)};`);
    }
  }

  lines.push('}');
  return `${lines.join('\n')}\n`;
}

function buildAssets() {
  const bomDocument = readJson(BOM_PATH);
  const initialStockDocument = readJson(fs.existsSync(BASELINE_STOCK_PATH) ? BASELINE_STOCK_PATH : INITIAL_STOCK_PATH);
  const graph = buildBomGraph(bomDocument);
  const repositoryMap = buildSeedRepositoryMap();
  const { normalizedDocument, routingDocument } = normalizeBomDocument(bomDocument, graph);
  const demandDocument = buildDemandDataset(graph);
  const demandAggregation = aggregateDemandLeafRequirements(graph, demandDocument);
  const procurementDocument = buildProcurementMetadata(graph, demandAggregation);
  const expandedOpeningStock = buildExpandedOpeningInventory(graph, demandAggregation, procurementDocument, groupExistingStockEntries(initialStockDocument));
  const mrp = buildFinishedRequirements(graph);
  const gapAnalysis = buildGapAnalysis(graph, initialStockDocument);
  const workOrdersDocument = selectRepresentativeWorkOrders(graph, routingDocument);
  const validationDocument = buildValidationDocument(graph, expandedOpeningStock, gapAnalysis, workOrdersDocument);

  return {
    repositoryMap,
    graphMetrics: buildGraphMetrics(graph),
    normalizedBom: normalizedDocument,
    routingDocument,
    procurementDocument,
    expandedOpeningStock,
    workOrdersDocument,
    demandDocument,
    gapAnalysis,
    validationDocument,
    mrpCsv: renderMrpCsv(mrp.rows),
    dagDot: renderDot(graph, 'all'),
    ingredientDot: renderDot(graph, 'ingredient'),
    packagingDot: renderDot(graph, 'packaging')
  };
}

export function generateSimulationAssets() {
  return buildAssets();
}

export function renderSimulationAssetFiles(assets = buildAssets()) {
  return new Map([
    [REPOSITORY_MAP_PATH, stableJson(assets.repositoryMap)],
    [BOM_PATH, stableJson(assets.normalizedBom)],
    [INITIAL_STOCK_PATH, stableJson(assets.expandedOpeningStock)],
    [GAP_ANALYSIS_PATH, stableJson(assets.gapAnalysis)],
    [ROUTING_PATH, stableJson(assets.routingDocument)],
    [PROCUREMENT_PATH, stableJson(assets.procurementDocument)],
    [WORK_ORDERS_PATH, stableJson(assets.workOrdersDocument)],
    [DEMAND_PATH, stableJson(assets.demandDocument)],
    [VALIDATION_PATH, stableJson(assets.validationDocument)],
    [MRP_CSV_PATH, assets.mrpCsv],
    [DAG_DOT_PATH, assets.dagDot],
    [INGREDIENT_DOT_PATH, assets.ingredientDot],
    [PACKAGING_DOT_PATH, assets.packagingDot]
  ]);
}

export function writeSimulationAssets() {
  const assets = buildAssets();
  for (const [filePath, content] of renderSimulationAssetFiles(assets).entries()) {
    writeTextFile(filePath, content);
  }
  return assets;
}

function printSummary(assets) {
  const summary = {
    generatedAt: GENERATED_AT,
    nodeCount: assets.graphMetrics.nodeCount,
    edgeCount: assets.graphMetrics.edgeCount,
    dependencyDepth: assets.graphMetrics.dependencyDepth,
    coverageRatio: assets.validationDocument.finishedGoodsCoverage.coverageRatio,
    coverageTargetMet: assets.validationDocument.finishedGoodsCoverage.meetsTarget,
    simulationsSucceeded: assets.validationDocument.simulationsSucceeded
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (import.meta.url === `file://${__filename}`) {
  const write = process.argv.includes('--write');
  const assets = write ? writeSimulationAssets() : generateSimulationAssets();
  printSummary(assets);
}

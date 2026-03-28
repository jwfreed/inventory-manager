import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const {
  computeCoverageSection,
  computeDemandVolatilitySection,
  computeForecastAccuracySection,
  formatNumber,
  formatPercent,
  formatDays
} = require('../../src/services/helpers/inventorySignalsSections.ts');

function metricByKey(section, key) {
  return section.metrics.find((metric) => metric.key === key);
}

test('formatNumber applies grouping and rounding with configurable precision', () => {
  assert.equal(formatNumber(1234.567, 2), '1,234.57');
  assert.equal(formatNumber(1.25, 1), '1.3');
  assert.equal(formatNumber(12, 0), '12');
  assert.equal(formatNumber(0), '0');
});

test('formatPercent formats finite percentages and rejects non-measurable inputs', () => {
  assert.equal(formatPercent(0.1234), '12.3%');
  assert.equal(formatPercent(-0.125, 2), '-12.5%');
  assert.equal(formatPercent(0), '0%');
  assert.equal(formatPercent(null), 'Not measurable');
  assert.equal(formatPercent(Number.NaN), 'Not measurable');
});

test('formatDays formats measurable values and rejects non-measurable inputs', () => {
  assert.equal(formatDays(7.25), '7.3 days');
  assert.equal(formatDays(0), '0 days');
  assert.equal(formatDays(null), 'No demand signal');
  assert.equal(formatDays(Number.POSITIVE_INFINITY), 'No demand signal');
});

test('computeCoverageSection preserves a minimal stable contract for a representative fixture', () => {
  const section = computeCoverageSection({
    coverageRows: [
      { itemId: 'low-1', itemLabel: 'A-100 - Low', daysOfSupply: 6.4, bucket: 'low', drilldownTo: '/items/low-1' },
      { itemId: 'healthy-1', itemLabel: 'B-200 - Healthy', daysOfSupply: 55, bucket: 'healthy', drilldownTo: '/items/healthy-1' },
      { itemId: 'excess-1', itemLabel: 'C-300 - Excess', daysOfSupply: 121.2, bucket: 'excess', drilldownTo: '/items/excess-1' },
      { itemId: 'nodemand-1', itemLabel: 'D-400 - Dormant', daysOfSupply: null, bucket: 'no_demand', drilldownTo: '/items/nodemand-1' }
    ]
  });

  assert.equal(section.key, 'inventoryCoverage');
  assert.equal(section.title, 'Inventory coverage');
  assert.deepEqual(
    section.metrics.map((metric) => ({
      key: metric.key,
      value: metric.value,
      count: metric.count,
      severity: metric.severity
    })),
    [
      { key: 'low-coverage-items', value: '1', count: 1, severity: 'action' },
      { key: 'healthy-coverage-items', value: '1', count: 1, severity: 'info' },
      { key: 'excess-coverage-items', value: '1', count: 1, severity: 'watch' },
      { key: 'no-demand-items', value: '1', count: 1, severity: 'watch' }
    ]
  );
  assert.deepEqual(section.rows, [
    {
      id: 'low-1',
      label: 'A-100 - Low',
      value: '6.4 days',
      severity: 'action',
      drilldownTo: '/items/low-1'
    }
  ]);
});

// TEST INVARIANT: metric counts partition the input rows, low rows are the only surfaced rows, and the top-N cap is enforced.
test('computeCoverageSection preserves inputs and keeps bucket counts aligned to the source rows', () => {
  const params = {
    coverageRows: Array.from({ length: 12 }, (_, index) => ({
      itemId: `low-${index + 1}`,
      itemLabel: `Low ${index + 1}`,
      daysOfSupply: 6.01 + index / 100,
      bucket: 'low',
      drilldownTo: `/items/low-${index + 1}`
    })).concat([
      { itemId: 'healthy-1', itemLabel: 'Healthy 1', daysOfSupply: 20, bucket: 'healthy', drilldownTo: '/items/healthy-1' },
      { itemId: 'excess-1', itemLabel: 'Excess 1', daysOfSupply: 130, bucket: 'excess', drilldownTo: '/items/excess-1' },
      { itemId: 'nodemand-1', itemLabel: 'Dormant 1', daysOfSupply: null, bucket: 'no_demand', drilldownTo: '/items/nodemand-1' }
    ])
  };
  const snapshot = structuredClone(params);

  const section = computeCoverageSection(params);
  const counts = section.metrics.map((metric) => metric.count ?? 0);
  const totalCount = counts.reduce((sum, count) => sum + count, 0);

  assert.deepEqual(params, snapshot);
  assert.equal(metricByKey(section, 'low-coverage-items')?.count, 12);
  assert.equal(metricByKey(section, 'healthy-coverage-items')?.count, 1);
  assert.equal(metricByKey(section, 'excess-coverage-items')?.count, 1);
  assert.equal(metricByKey(section, 'no-demand-items')?.count, 1);
  assert.equal(totalCount, params.coverageRows.length);
  assert.ok(section.rows.length <= 10);
  assert.equal(section.rows.length, 10);
  assert.ok(section.rows.every((row) => row.severity === 'action'));
  assert.deepEqual(
    section.rows.map((row) => row.id),
    params.coverageRows.filter((row) => row.bucket === 'low').slice(0, 10).map((row) => row.itemId)
  );
});

// TEST INVARIANT: coverage bucket boundaries map to low, healthy, excess, and no-demand exactly at the documented thresholds.
test('computeCoverageSection preserves explicit coverage bucket boundaries', () => {
  const coverageRows = [
    { itemId: 'low-edge', itemLabel: 'Low Edge', daysOfSupply: 6.999, bucket: 'low', drilldownTo: '/items/low-edge' },
    { itemId: 'healthy-start', itemLabel: 'Healthy Start', daysOfSupply: 7, bucket: 'healthy', drilldownTo: '/items/healthy-start' },
    { itemId: 'healthy-end', itemLabel: 'Healthy End', daysOfSupply: 120, bucket: 'healthy', drilldownTo: '/items/healthy-end' },
    { itemId: 'excess-edge', itemLabel: 'Excess Edge', daysOfSupply: 120.01, bucket: 'excess', drilldownTo: '/items/excess-edge' },
    { itemId: 'nodemand-edge', itemLabel: 'No Demand Edge', daysOfSupply: null, bucket: 'no_demand', drilldownTo: '/items/nodemand-edge' }
  ];

  const section = computeCoverageSection({ coverageRows });

  assert.equal(metricByKey(section, 'low-coverage-items')?.count, 1);
  assert.equal(metricByKey(section, 'healthy-coverage-items')?.count, 2);
  assert.equal(metricByKey(section, 'excess-coverage-items')?.count, 1);
  assert.equal(metricByKey(section, 'no-demand-items')?.count, 1);
  assert.deepEqual(section.rows.map((row) => row.id), ['low-edge']);
  assert.deepEqual(section.rows.map((row) => row.value), ['7 days']);
});

// TEST INVARIANT: empty input produces zero counts, no surfaced rows, and no escalated severities.
test('computeCoverageSection returns empty-state counts without drilldown rows', () => {
  const section = computeCoverageSection({ coverageRows: [] });

  assert.equal(section.metrics.every((metric) => metric.value === '0'), true);
  assert.equal(section.metrics.every((metric) => metric.count === 0), true);
  assert.equal(section.rows.length, 0);
  assert.equal(section.metrics.every((metric) => metric.severity === 'info'), true);
});

test('computeDemandVolatilitySection preserves a minimal stable contract for a representative fixture', () => {
  const section = computeDemandVolatilitySection({
    demandStats: new Map([
      ['item-a', { itemId: 'item-a', avgDailyDemand: 2, coefficientOfVariation: 1.5, recent28Demand: 28, previous28Demand: 14 }],
      ['item-b', { itemId: 'item-b', avgDailyDemand: 1, coefficientOfVariation: 0.5, recent28Demand: 14, previous28Demand: 14 }],
      ['item-c', { itemId: 'item-c', avgDailyDemand: 0, coefficientOfVariation: 8, recent28Demand: 0, previous28Demand: 0 }]
    ]),
    items: [
      { id: 'item-a', sku: 'A-100', name: 'Alpha' },
      { id: 'item-b', sku: 'B-200', name: null }
    ]
  });

  assert.equal(section.key, 'demandVolatility');
  assert.equal(section.title, 'Demand volatility');
  assert.deepEqual(
    section.metrics.map((metric) => ({
      key: metric.key,
      value: metric.value,
      count: metric.count ?? null,
      severity: metric.severity
    })),
    [
      { key: 'volatility-index', value: '1', count: null, severity: 'info' },
      { key: 'volatile-items', value: '1', count: 1, severity: 'watch' },
      { key: 'demand-trend', value: '50%', count: null, severity: 'watch' },
      { key: 'seasonality-index', value: '1.5', count: null, severity: 'info' }
    ]
  );
  assert.deepEqual(section.rows, [
    {
      id: 'item-a',
      label: 'A-100 - Alpha',
      value: '1.5',
      severity: 'watch',
      drilldownTo: '/items/item-a'
    }
  ]);
});

// TEST INVARIANT: zero-demand items are excluded, volatile rows are sorted descending by CV, and the volatile count matches the CV threshold.
test('computeDemandVolatilitySection enforces measurable-demand filtering and stable ranking invariants', () => {
  const demandStats = new Map([
    ['item-1', { itemId: 'item-1', avgDailyDemand: 3, coefficientOfVariation: 2.2, recent28Demand: 40, previous28Demand: 20 }],
    ['item-2', { itemId: 'item-2', avgDailyDemand: 2, coefficientOfVariation: 1.1, recent28Demand: 15, previous28Demand: 10 }],
    ['item-3', { itemId: 'item-3', avgDailyDemand: 1, coefficientOfVariation: 0.8, recent28Demand: 10, previous28Demand: 10 }],
    ['item-4', { itemId: 'item-4', avgDailyDemand: 0, coefficientOfVariation: 9.9, recent28Demand: 0, previous28Demand: 0 }]
  ]);
  const section = computeDemandVolatilitySection({
    demandStats,
    items: [
      { id: 'item-1', sku: 'SKU-1', name: 'One' },
      { id: 'item-2', sku: 'SKU-2', name: 'Two' },
      { id: 'item-3', sku: 'SKU-3', name: 'Three' }
    ]
  });
  const measurableRows = Array.from(demandStats.values()).filter((row) => row.avgDailyDemand > 0);
  const volatileRows = measurableRows.filter((row) => row.coefficientOfVariation > 1);
  const expectedAverageCov = measurableRows.reduce((sum, row) => sum + row.coefficientOfVariation, 0) / measurableRows.length;
  const expectedTrend = (40 + 15 + 10 - (20 + 10 + 10)) / (20 + 10 + 10);
  const expectedSeasonality =
    measurableRows.reduce((sum, row) => {
      const numerator = Math.max(row.recent28Demand, row.previous28Demand);
      const denominator = Math.max(1, Math.min(row.recent28Demand, row.previous28Demand));
      return sum + numerator / denominator;
    }, 0) / measurableRows.length;

  assert.equal(metricByKey(section, 'volatile-items')?.count, volatileRows.length);
  assert.deepEqual(section.rows.map((row) => row.id), volatileRows.map((row) => row.itemId));
  assert.equal(section.rows.every((row) => row.severity === 'watch'), true);
  assert.ok(
    measurableRows.every(
      (row) => row.avgDailyDemand > 0 && (section.rows.some((sectionRow) => sectionRow.id === row.itemId) === (row.coefficientOfVariation > 1))
    )
  );
  assert.equal(metricByKey(section, 'volatility-index')?.value, formatNumber(expectedAverageCov, 2));
  assert.equal(metricByKey(section, 'demand-trend')?.value, formatPercent(expectedTrend));
  assert.equal(metricByKey(section, 'seasonality-index')?.value, formatNumber(expectedSeasonality, 2));
});

// TEST INVARIANT: empty input produces no volatile rows, no measurable volatility, and neutral aggregate trend/seasonality outputs.
test('computeDemandVolatilitySection handles empty input without synthetic volatility', () => {
  const section = computeDemandVolatilitySection({
    demandStats: new Map(),
    items: []
  });

  assert.equal(metricByKey(section, 'volatility-index')?.value, 'Not measurable');
  assert.equal(metricByKey(section, 'volatile-items')?.count, 0);
  assert.equal(metricByKey(section, 'demand-trend')?.value, '0%');
  assert.equal(metricByKey(section, 'seasonality-index')?.value, '0');
  assert.deepEqual(section.rows, []);
});

test('computeForecastAccuracySection returns the expected dashboard section for representative forecast inputs', () => {
  const section = computeForecastAccuracySection({
    forecast: { forecastQty: 120, actualQty: 100, mape: 0.2, bias: 0.1 }
  });

  assert.deepEqual(section, {
    key: 'forecastAccuracy',
    title: 'Forecast accuracy',
    description: 'Planning-quality metrics comparing forecasted demand against actual sales-order demand.',
    metrics: [
      {
        key: 'forecast-accuracy',
        label: 'Forecast accuracy',
        severity: 'info',
        value: '80%',
        helper: 'Inverse of MAPE across forecast periods with available actual demand.',
        formula: 'ForecastAccuracy = 1 - MAPE.',
        queryHint: 'Derived from MPS demand inputs vs actual sales-order demand by period.',
        drilldownTo: '/dashboard',
        sources: ['/api/dashboard/forecast-accuracy'],
        investigativeAction: { label: 'Review forecast quality', href: '/dashboard' },
        correctiveAction: { label: 'Refine forecast inputs', href: '/planning/mps' }
      },
      {
        key: 'mape',
        label: 'MAPE',
        severity: 'info',
        value: '20%',
        helper: 'Mean absolute percentage error across forecast periods.',
        formula: 'MAPE = avg(|forecast - actual| / actual).',
        queryHint: 'Derived from MPS demand inputs vs actual sales-order demand.',
        drilldownTo: '/dashboard',
        sources: ['/api/dashboard/forecast-accuracy'],
        investigativeAction: { label: 'Review error', href: '/dashboard' },
        correctiveAction: { label: 'Tune forecast', href: '/planning/mps' }
      },
      {
        key: 'forecast-bias',
        label: 'Forecast bias',
        severity: 'info',
        value: '10%',
        helper: 'Positive values indicate over-forecasting; negative values indicate under-forecasting.',
        formula: 'Bias = avg((forecast - actual) / actual).',
        queryHint: 'Derived from MPS demand inputs vs actual sales-order demand.',
        drilldownTo: '/dashboard',
        sources: ['/api/dashboard/forecast-accuracy'],
        investigativeAction: { label: 'Review forecast bias', href: '/dashboard' },
        correctiveAction: { label: 'Adjust planning inputs', href: '/planning/mps' }
      },
      {
        key: 'forecast-stability',
        label: 'Forecast stability',
        severity: 'info',
        value: '90%',
        helper: 'Stability proxy derived from forecast bias magnitude.',
        formula: 'ForecastStability = max(0, 1 - |bias|).',
        queryHint: 'Derived from forecast bias.',
        drilldownTo: '/dashboard',
        sources: ['/api/dashboard/forecast-accuracy'],
        investigativeAction: { label: 'Review planning stability', href: '/dashboard' },
        correctiveAction: { label: 'Smooth plan inputs', href: '/planning/mps' }
      }
    ],
    rows: []
  });
});

// TEST INVARIANT: zero actual demand with zero MAPE yields zero accuracy, neutral bias, and full stability.
test('computeForecastAccuracySection handles zero-actual and zero-error inputs consistently', () => {
  const section = computeForecastAccuracySection({
    forecast: { forecastQty: 0, actualQty: 0, mape: 0, bias: 0 }
  });

  assert.equal(metricByKey(section, 'forecast-accuracy')?.value, '0%');
  assert.equal(metricByKey(section, 'forecast-accuracy')?.severity, 'watch');
  assert.equal(metricByKey(section, 'mape')?.value, '0%');
  assert.equal(metricByKey(section, 'forecast-bias')?.value, '0%');
  assert.equal(metricByKey(section, 'forecast-stability')?.value, '100%');
});

// TEST INVARIANT: forecast accuracy equals 1 - MAPE and forecast stability equals 1 - |bias|, independent of bias sign.
test('computeForecastAccuracySection enforces accuracy and stability relationships', () => {
  const positiveBias = computeForecastAccuracySection({
    forecast: { forecastQty: 110, actualQty: 100, mape: 0.1, bias: 0.2 }
  });
  const negativeBias = computeForecastAccuracySection({
    forecast: { forecastQty: 90, actualQty: 100, mape: 0.1, bias: -0.2 }
  });

  assert.equal(metricByKey(positiveBias, 'forecast-accuracy')?.value, formatPercent(1 - 0.1));
  assert.equal(metricByKey(positiveBias, 'mape')?.value, formatPercent(0.1));
  assert.equal(metricByKey(positiveBias, 'forecast-stability')?.value, formatPercent(1 - Math.abs(0.2)));
  assert.equal(
    metricByKey(positiveBias, 'forecast-stability')?.value,
    metricByKey(negativeBias, 'forecast-stability')?.value
  );
  assert.equal(metricByKey(positiveBias, 'forecast-bias')?.value, formatPercent(0.2));
  assert.equal(metricByKey(negativeBias, 'forecast-bias')?.value, formatPercent(-0.2));
});

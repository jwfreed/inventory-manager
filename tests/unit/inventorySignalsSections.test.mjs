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

test('computeCoverageSection returns the expected dashboard section for a stable fixture', () => {
  const section = computeCoverageSection({
    coverageRows: [
      { itemId: 'low-1', itemLabel: 'A-100 - Low', daysOfSupply: 6.4, bucket: 'low', drilldownTo: '/items/low-1' },
      { itemId: 'healthy-1', itemLabel: 'B-200 - Healthy', daysOfSupply: 55, bucket: 'healthy', drilldownTo: '/items/healthy-1' },
      { itemId: 'excess-1', itemLabel: 'C-300 - Excess', daysOfSupply: 121.2, bucket: 'excess', drilldownTo: '/items/excess-1' },
      { itemId: 'nodemand-1', itemLabel: 'D-400 - Dormant', daysOfSupply: null, bucket: 'no_demand', drilldownTo: '/items/nodemand-1' }
    ]
  });

  assert.deepEqual(section, {
    key: 'inventoryCoverage',
    title: 'Inventory coverage',
    description: 'Days-of-supply coverage buckets that show which items are exposed, healthy, or overstocked.',
    metrics: [
      {
        key: 'low-coverage-items',
        label: 'Low coverage items',
        severity: 'action',
        value: '1',
        count: 1,
        helper: 'Items below seven days of supply.',
        formula: 'Count of items where DaysOfSupply < 7.',
        queryHint: 'Derived from available inventory and average daily demand.',
        drilldownTo: '/dashboard',
        sources: ['/api/dashboard/inventory-coverage'],
        investigativeAction: { label: 'Review low coverage', href: '/dashboard' },
        correctiveAction: { label: 'Replenish stock', href: '/purchase-orders/new' }
      },
      {
        key: 'healthy-coverage-items',
        label: 'Healthy coverage items',
        severity: 'info',
        value: '1',
        count: 1,
        helper: 'Items with measurable demand and healthy coverage.',
        formula: 'Count of items where 7 <= DaysOfSupply <= 120.',
        queryHint: 'Derived from coverage buckets.',
        drilldownTo: '/dashboard',
        sources: ['/api/dashboard/inventory-coverage'],
        investigativeAction: { label: 'Review coverage', href: '/dashboard' },
        correctiveAction: { label: 'Maintain policy', href: '/items' }
      },
      {
        key: 'excess-coverage-items',
        label: 'Excess coverage items',
        severity: 'watch',
        value: '1',
        count: 1,
        helper: 'Items with more than 120 days of supply.',
        formula: 'Count of items where DaysOfSupply > 120.',
        queryHint: 'Derived from coverage buckets.',
        drilldownTo: '/dashboard',
        sources: ['/api/dashboard/inventory-coverage'],
        investigativeAction: { label: 'Review excess stock', href: '/dashboard' },
        correctiveAction: { label: 'Reduce buys', href: '/items' }
      },
      {
        key: 'no-demand-items',
        label: 'No-demand items',
        severity: 'watch',
        value: '1',
        count: 1,
        helper: 'Items with no measurable recent demand signal.',
        formula: 'Count of items where averageDailyDemand = 0.',
        queryHint: 'Derived from sales order history.',
        drilldownTo: '/dashboard',
        sources: ['/api/dashboard/inventory-coverage'],
        investigativeAction: { label: 'Review dormant items', href: '/dashboard' },
        correctiveAction: { label: 'Validate forecast', href: '/items' }
      }
    ],
    rows: [
      {
        id: 'low-1',
        label: 'A-100 - Low',
        value: '6.4 days',
        severity: 'action',
        drilldownTo: '/items/low-1'
      }
    ]
  });
});

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

  assert.deepEqual(params, snapshot);
  assert.equal(section.metrics.find((metric) => metric.key === 'low-coverage-items')?.count, 12);
  assert.equal(section.metrics.find((metric) => metric.key === 'healthy-coverage-items')?.count, 1);
  assert.equal(section.metrics.find((metric) => metric.key === 'excess-coverage-items')?.count, 1);
  assert.equal(section.metrics.find((metric) => metric.key === 'no-demand-items')?.count, 1);
  assert.equal(section.rows.length, 10);
  assert.ok(section.rows.every((row) => row.severity === 'action'));
  assert.deepEqual(
    section.rows.map((row) => row.id),
    params.coverageRows.slice(0, 10).map((row) => row.itemId)
  );
});

test('computeCoverageSection returns empty-state counts without drilldown rows', () => {
  const section = computeCoverageSection({ coverageRows: [] });

  assert.equal(section.metrics.every((metric) => metric.value === '0'), true);
  assert.equal(section.metrics.every((metric) => metric.count === 0), true);
  assert.equal(section.rows.length, 0);
  assert.equal(section.metrics.every((metric) => metric.severity === 'info'), true);
});

test('computeDemandVolatilitySection returns the expected dashboard section for a stable fixture', () => {
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

  assert.deepEqual(section, {
    key: 'demandVolatility',
    title: 'Demand volatility',
    description: 'Demand instability indicators used to decide when replenishment and safety-stock logic needs intervention.',
    metrics: [
      {
        key: 'volatility-index',
        label: 'Demand volatility index',
        severity: 'info',
        value: '1',
        helper: 'Average coefficient of variation across items with measurable demand.',
        formula: 'VolatilityIndex = avg(stddev(demand) / avg(demand)).',
        queryHint: 'Derived from daily sales-order demand history.',
        drilldownTo: '/dashboard',
        sources: ['/api/dashboard/demand-volatility'],
        investigativeAction: { label: 'Review volatile demand', href: '/dashboard' },
        correctiveAction: { label: 'Tune safety stock', href: '/items' }
      },
      {
        key: 'volatile-items',
        label: 'High-CV items',
        severity: 'watch',
        value: '1',
        count: 1,
        helper: 'Items where coefficient of variation exceeds 1.0.',
        formula: 'Count of items where CV > 1.0.',
        queryHint: 'Derived from daily sales-order demand history.',
        drilldownTo: '/dashboard',
        sources: ['/api/dashboard/demand-volatility'],
        investigativeAction: { label: 'Review top volatile items', href: '/dashboard' },
        correctiveAction: { label: 'Adjust policies', href: '/items' }
      },
      {
        key: 'demand-trend',
        label: 'Demand trend',
        severity: 'watch',
        value: '50%',
        helper: 'Aggregate 28-day demand trend versus the prior 28-day baseline.',
        formula: 'Trend = (recent28 - previous28) / previous28.',
        queryHint: 'Derived from daily sales-order demand history.',
        drilldownTo: '/dashboard',
        sources: ['/api/dashboard/demand-volatility'],
        investigativeAction: { label: 'Review trend change', href: '/dashboard' },
        correctiveAction: { label: 'Rebalance supply plan', href: '/items' }
      },
      {
        key: 'seasonality-index',
        label: 'Demand seasonality',
        severity: 'info',
        value: '1.5',
        helper: 'Crude seasonality ratio comparing recent and prior 28-day demand windows.',
        formula: 'Average(max(recent28, previous28) / min(recent28, previous28)).',
        queryHint: 'Derived from rolling demand windows.',
        drilldownTo: '/dashboard',
        sources: ['/api/dashboard/demand-volatility'],
        investigativeAction: { label: 'Inspect seasonality', href: '/dashboard' },
        correctiveAction: { label: 'Adjust forecast cadence', href: '/dashboard' }
      }
    ],
    rows: [
      {
        id: 'item-a',
        label: 'A-100 - Alpha',
        value: '1.5',
        severity: 'watch',
        drilldownTo: '/items/item-a'
      }
    ]
  });
});

test('computeDemandVolatilitySection enforces measurable-demand filtering and stable ranking invariants', () => {
  const section = computeDemandVolatilitySection({
    demandStats: new Map([
      ['item-1', { itemId: 'item-1', avgDailyDemand: 3, coefficientOfVariation: 2.2, recent28Demand: 40, previous28Demand: 20 }],
      ['item-2', { itemId: 'item-2', avgDailyDemand: 2, coefficientOfVariation: 1.1, recent28Demand: 15, previous28Demand: 10 }],
      ['item-3', { itemId: 'item-3', avgDailyDemand: 1, coefficientOfVariation: 0.8, recent28Demand: 10, previous28Demand: 10 }],
      ['item-4', { itemId: 'item-4', avgDailyDemand: 0, coefficientOfVariation: 9.9, recent28Demand: 0, previous28Demand: 0 }]
    ]),
    items: [
      { id: 'item-1', sku: 'SKU-1', name: 'One' },
      { id: 'item-2', sku: 'SKU-2', name: 'Two' },
      { id: 'item-3', sku: 'SKU-3', name: 'Three' }
    ]
  });

  assert.equal(section.metrics.find((metric) => metric.key === 'volatile-items')?.count, 2);
  assert.deepEqual(section.rows.map((row) => row.id), ['item-1', 'item-2']);
  assert.equal(section.rows.every((row) => row.severity === 'watch'), true);
  assert.equal(section.metrics.find((metric) => metric.key === 'volatility-index')?.value, '1.37');
  assert.equal(section.metrics.find((metric) => metric.key === 'demand-trend')?.value, '62.5%');
  assert.equal(section.metrics.find((metric) => metric.key === 'seasonality-index')?.value, '1.5');
});

test('computeDemandVolatilitySection handles empty input without synthetic volatility', () => {
  const section = computeDemandVolatilitySection({
    demandStats: new Map(),
    items: []
  });

  assert.equal(section.metrics.find((metric) => metric.key === 'volatility-index')?.value, 'Not measurable');
  assert.equal(section.metrics.find((metric) => metric.key === 'volatile-items')?.count, 0);
  assert.equal(section.metrics.find((metric) => metric.key === 'demand-trend')?.value, '0%');
  assert.equal(section.metrics.find((metric) => metric.key === 'seasonality-index')?.value, '0');
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

test('computeForecastAccuracySection handles zero-actual and zero-error inputs consistently', () => {
  const section = computeForecastAccuracySection({
    forecast: { forecastQty: 0, actualQty: 0, mape: 0, bias: 0 }
  });

  assert.equal(section.metrics.find((metric) => metric.key === 'forecast-accuracy')?.value, '0%');
  assert.equal(section.metrics.find((metric) => metric.key === 'forecast-accuracy')?.severity, 'watch');
  assert.equal(section.metrics.find((metric) => metric.key === 'mape')?.value, '0%');
  assert.equal(section.metrics.find((metric) => metric.key === 'forecast-bias')?.value, '0%');
  assert.equal(section.metrics.find((metric) => metric.key === 'forecast-stability')?.value, '100%');
});

test('computeForecastAccuracySection uses bias magnitude for stability regardless of sign', () => {
  const positiveBias = computeForecastAccuracySection({
    forecast: { forecastQty: 110, actualQty: 100, mape: 0.1, bias: 0.2 }
  });
  const negativeBias = computeForecastAccuracySection({
    forecast: { forecastQty: 90, actualQty: 100, mape: 0.1, bias: -0.2 }
  });

  assert.equal(
    positiveBias.metrics.find((metric) => metric.key === 'forecast-stability')?.value,
    negativeBias.metrics.find((metric) => metric.key === 'forecast-stability')?.value
  );
  assert.equal(positiveBias.metrics.find((metric) => metric.key === 'forecast-stability')?.value, '80%');
  assert.equal(positiveBias.metrics.find((metric) => metric.key === 'forecast-bias')?.value, '20%');
  assert.equal(negativeBias.metrics.find((metric) => metric.key === 'forecast-bias')?.value, '-20%');
});

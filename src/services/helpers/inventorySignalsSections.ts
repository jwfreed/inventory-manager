import { roundQuantity } from '../../lib/numbers';

type SignalSeverity = 'info' | 'watch' | 'action' | 'critical';

type InventorySignalAction = {
  label: string;
  href: string;
};

type InventorySignalMetric = {
  key: string;
  label: string;
  severity: SignalSeverity;
  value: string;
  count?: number;
  helper: string;
  formula: string;
  queryHint: string;
  drilldownTo: string;
  sources: string[];
  investigativeAction?: InventorySignalAction;
  correctiveAction?: InventorySignalAction;
};

type InventorySignalRow = {
  id: string;
  label: string;
  secondaryLabel?: string;
  value: string;
  severity: SignalSeverity;
  drilldownTo: string;
};

type DashboardSignalSection = {
  key:
    | 'inventoryIntegrity'
    | 'inventoryRisk'
    | 'inventoryCoverage'
    | 'flowReliability'
    | 'supplyReliability'
    | 'excessInventory'
    | 'performanceMetrics'
    | 'systemHealth'
    | 'demandVolatility'
    | 'forecastAccuracy';
  title: string;
  description: string;
  metrics: InventorySignalMetric[];
  rows: InventorySignalRow[];
};

type CoverageRow = {
  itemId: string;
  itemLabel: string;
  daysOfSupply: number | null;
  bucket: 'low' | 'healthy' | 'excess' | 'no_demand';
  drilldownTo: string;
};

type DemandStat = {
  itemId: string;
  avgDailyDemand: number;
  coefficientOfVariation: number;
  recent28Demand: number;
  previous28Demand: number;
};

type ItemRecord = {
  id: string;
  sku: string;
  name: string | null;
};

type ForecastMetrics = {
  forecastQty: number;
  actualQty: number;
  mape: number;
  bias: number;
};

export function formatNumber(value: number, maximumFractionDigits = 1): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits
  }).format(value);
}

export function formatPercent(value: number | null, fractionDigits = 1): string {
  if (value === null || !Number.isFinite(value)) return 'Not measurable';
  return `${formatNumber(value * 100, fractionDigits)}%`;
}

export function formatDays(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'No demand signal';
  return `${formatNumber(value, 1)} days`;
}

export function computeCoverageSection(params: { coverageRows: CoverageRow[] }): DashboardSignalSection {
  const lowCoverage = params.coverageRows.filter((row) => row.bucket === 'low');
  const excessCoverage = params.coverageRows.filter((row) => row.bucket === 'excess');
  const buckets = {
    low: lowCoverage.length,
    healthy: params.coverageRows.filter((row) => row.bucket === 'healthy').length,
    excess: excessCoverage.length,
    noDemand: params.coverageRows.filter((row) => row.bucket === 'no_demand').length
  };

  return {
    key: 'inventoryCoverage',
    title: 'Inventory coverage',
    description: 'Days-of-supply coverage buckets that show which items are exposed, healthy, or overstocked.',
    metrics: [
      {
        key: 'low-coverage-items',
        label: 'Low coverage items',
        severity: lowCoverage.length > 0 ? 'action' : 'info',
        value: String(lowCoverage.length),
        count: lowCoverage.length,
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
        value: String(buckets.healthy),
        count: buckets.healthy,
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
        severity: excessCoverage.length > 0 ? 'watch' : 'info',
        value: String(excessCoverage.length),
        count: excessCoverage.length,
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
        severity: buckets.noDemand > 0 ? 'watch' : 'info',
        value: String(buckets.noDemand),
        count: buckets.noDemand,
        helper: 'Items with no measurable recent demand signal.',
        formula: 'Count of items where averageDailyDemand = 0.',
        queryHint: 'Derived from sales order history.',
        drilldownTo: '/dashboard',
        sources: ['/api/dashboard/inventory-coverage'],
        investigativeAction: { label: 'Review dormant items', href: '/dashboard' },
        correctiveAction: { label: 'Validate forecast', href: '/items' }
      }
    ],
    rows: lowCoverage.slice(0, 10).map((row) => ({
      id: row.itemId,
      label: row.itemLabel,
      value: formatDays(row.daysOfSupply),
      severity: 'action',
      drilldownTo: row.drilldownTo
    }))
  };
}

export function computeDemandVolatilitySection(params: {
  demandStats: Map<string, DemandStat>;
  items: ItemRecord[];
}): DashboardSignalSection {
  const itemLookup = new Map(params.items.map((item) => [item.id, item]));
  const rows = Array.from(params.demandStats.values())
    .filter((row) => row.avgDailyDemand > 0)
    .sort((left, right) => right.coefficientOfVariation - left.coefficientOfVariation);
  const volatileRows = rows.filter((row) => row.coefficientOfVariation > 1);
  const averageCov = rows.length > 0 ? rows.reduce((sum, row) => sum + row.coefficientOfVariation, 0) / rows.length : null;
  const recentDemand = rows.reduce((sum, row) => sum + row.recent28Demand, 0);
  const priorDemand = rows.reduce((sum, row) => sum + row.previous28Demand, 0);
  const trend = priorDemand > 0 ? roundQuantity((recentDemand - priorDemand) / priorDemand) : 0;
  const seasonalityIndex =
    rows.length > 0
      ? roundQuantity(
          rows.reduce((sum, row) => {
            const numerator = Math.max(row.recent28Demand, row.previous28Demand);
            const denominator = Math.max(1, Math.min(row.recent28Demand, row.previous28Demand));
            return sum + numerator / denominator;
          }, 0) / rows.length
        )
      : 0;

  return {
    key: 'demandVolatility',
    title: 'Demand volatility',
    description: 'Demand instability indicators used to decide when replenishment and safety-stock logic needs intervention.',
    metrics: [
      {
        key: 'volatility-index',
        label: 'Demand volatility index',
        severity: averageCov !== null && averageCov > 1 ? 'watch' : 'info',
        value: averageCov !== null ? formatNumber(averageCov, 2) : 'Not measurable',
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
        severity: volatileRows.length > 0 ? 'watch' : 'info',
        value: String(volatileRows.length),
        count: volatileRows.length,
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
        severity: Math.abs(trend) > 0.15 ? 'watch' : 'info',
        value: formatPercent(trend),
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
        severity: seasonalityIndex > 1.5 ? 'watch' : 'info',
        value: formatNumber(seasonalityIndex, 2),
        helper: 'Crude seasonality ratio comparing recent and prior 28-day demand windows.',
        formula: 'Average(max(recent28, previous28) / min(recent28, previous28)).',
        queryHint: 'Derived from rolling demand windows.',
        drilldownTo: '/dashboard',
        sources: ['/api/dashboard/demand-volatility'],
        investigativeAction: { label: 'Inspect seasonality', href: '/dashboard' },
        correctiveAction: { label: 'Adjust forecast cadence', href: '/dashboard' }
      }
    ],
    rows: volatileRows.slice(0, 10).map((row) => {
      const item = itemLookup.get(row.itemId);
      return {
        id: row.itemId,
        label: item ? (item.name ? `${item.sku} - ${item.name}` : item.sku) : row.itemId,
        value: formatNumber(row.coefficientOfVariation, 2),
        severity: 'watch',
        drilldownTo: `/items/${row.itemId}`
      };
    })
  };
}

export function computeForecastAccuracySection(params: {
  forecast: ForecastMetrics;
}): DashboardSignalSection {
  const forecastAccuracy = params.forecast.mape > 0 ? Math.max(0, 1 - params.forecast.mape) : params.forecast.actualQty > 0 ? 1 : 0;
  const stability = Math.max(0, 1 - Math.abs(params.forecast.bias));

  return {
    key: 'forecastAccuracy',
    title: 'Forecast accuracy',
    description: 'Planning-quality metrics comparing forecasted demand against actual sales-order demand.',
    metrics: [
      {
        key: 'forecast-accuracy',
        label: 'Forecast accuracy',
        severity: forecastAccuracy < 0.8 ? 'watch' : 'info',
        value: formatPercent(forecastAccuracy),
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
        severity: params.forecast.mape > 0.2 ? 'watch' : 'info',
        value: formatPercent(params.forecast.mape),
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
        severity: Math.abs(params.forecast.bias) > 0.1 ? 'watch' : 'info',
        value: formatPercent(params.forecast.bias),
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
        severity: stability < 0.85 ? 'watch' : 'info',
        value: formatPercent(stability),
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
  };
}

import { query } from '../db';
import { cacheAdapter } from '../lib/redis';
import { roundQuantity } from '../lib/numbers';
import { computeInventoryHealth } from '../domains/inventory/health.service';
import { getInventorySnapshotSummaryDetailed, type InventorySnapshotRow, type InventoryUomInconsistency } from './inventorySnapshot.service';
import { getItemMetrics, type ItemMetrics } from './itemMetrics.service';
import { listReplenishmentPolicies, computeReplenishmentRecommendations, computeFulfillmentFillRate } from './planning.service';
import { MetricsService } from './metrics.service';
import { getSupplierScorecards } from './supplierScorecard.service';
import { getLeadTimeReliability, getVendorFillRate } from './supplierPerformance.service';
import { getProductionVolumeTrend } from './productionOverview.service';
import { getSalesOrderFillPerformance, getWorkOrderProgress } from './reports.service';

export type SignalSeverity = 'info' | 'watch' | 'action' | 'critical';

export type DashboardExceptionType =
  | 'availability_breach'
  | 'negative_on_hand'
  | 'allocation_integrity'
  | 'reorder_risk'
  | 'inbound_aging'
  | 'work_order_risk'
  | 'cycle_count_hygiene'
  | 'uom_inconsistent';

export type WarehouseScopeSummary = {
  ids: string[];
  label: string;
};

export type InventoryMonitoringCoverage = {
  hasInventoryRows: boolean;
  hasReplenishmentPolicies: boolean;
  hasDemandSignal: boolean;
  hasCycleCountProgram: boolean;
  hasShipmentsInWindow: boolean;
  inventoryMonitoringConfigured: boolean;
  replenishmentMonitoringConfigured: boolean;
  cycleCountMonitoringConfigured: boolean;
  reliabilityMeasurable: boolean;
};

export type InventorySignalAction = {
  label: string;
  href: string;
};

export type InventorySignalMetric = {
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

export type InventorySignalRow = {
  id: string;
  label: string;
  secondaryLabel?: string;
  value: string;
  severity: SignalSeverity;
  drilldownTo: string;
};

export type DashboardSignalSection = {
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

export type ResolutionQueueRow = {
  id: string;
  type: DashboardExceptionType;
  severity: SignalSeverity;
  itemLabel: string;
  itemId?: string;
  locationLabel: string;
  locationId?: string;
  warehouseId?: string;
  uom?: string;
  impactScore: number;
  occurredAt: string;
  recommendedAction: string;
  primaryLink: string;
};

export type DashboardSignal = {
  key: string;
  label: string;
  type: DashboardExceptionType | 'fulfillment_reliability';
  severity: SignalSeverity;
  value: string;
  helper: string;
  count: number;
  drilldownTo: string;
  formula: string;
  sources: string[];
  queryHint: string;
};

export type InventorySignalCoverageRow = {
  signal: string;
  implemented: boolean;
  dataSource: string[];
  accuracy: 'measured' | 'derived' | 'proxy';
  dashboardIntegration: 'live_api' | 'dashboard_section' | 'exception_queue';
};

export type InventoryIntelligenceOverview = {
  asOf: string;
  asOfLabel: string;
  warehouseScope: WarehouseScopeSummary;
  warehouses: Array<{ id: string; code: string | null; name: string | null }>;
  coverage: InventoryMonitoringCoverage;
  exceptions: ResolutionQueueRow[];
  signals: DashboardSignal[];
  uomNormalizationDiagnostics: InventoryUomInconsistency[];
  uomDiagnosticGroupBuckets: {
    actionGroups: number;
    watchGroups: number;
    totalGroups: number;
  };
  sections: Record<DashboardSignalSection['key'], DashboardSignalSection>;
  coverageMatrix: InventorySignalCoverageRow[];
};

type InventorySignalsOptions = {
  warehouseId?: string;
  windowDays?: number;
  forceRefresh?: boolean;
};

type ItemRecord = {
  id: string;
  sku: string;
  name: string | null;
  type: string | null;
  abcClass: string | null;
  canonicalUom: string | null;
  defaultLocationId: string | null;
};

type LocationRecord = {
  id: string;
  code: string | null;
  name: string | null;
  type: string | null;
  warehouseId: string | null;
  active: boolean | null;
};

type PurchaseOrderRecord = {
  id: string;
  poNumber: string;
  status: string;
  orderDate: string | null;
  expectedDate: string | null;
  createdAt: string | null;
  shipToLocationId: string | null;
  vendorId: string | null;
};

type ReplenishmentPolicyRecord = {
  itemId: string;
  siteLocationId: string | null;
  status: string;
};

type WorkOrderRecord = {
  id: string;
  number: string;
  status: string;
  outputItemId: string;
  quantityPlanned: number;
  quantityCompleted: number;
  scheduledDueAt: string | null;
  defaultProduceLocationId: string | null;
};

type DemandStat = {
  itemId: string;
  avgDailyDemand: number;
  stddevDailyDemand: number;
  coefficientOfVariation: number;
  recent7Demand: number;
  prior28Demand: number;
  recent28Demand: number;
  previous28Demand: number;
};

type CoverageRow = {
  itemId: string;
  itemLabel: string;
  onHand: number;
  available: number;
  backordered: number;
  avgDailyDemand: number;
  daysOfSupply: number | null;
  bucket: 'low' | 'healthy' | 'excess' | 'no_demand';
  drilldownTo: string;
};

const CACHE_TTL_SECONDS = 60;

function toFiniteNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function formatNumber(value: number, maximumFractionDigits = 1): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits
  }).format(value);
}

function formatPercent(value: number | null, fractionDigits = 1): string {
  if (value === null || !Number.isFinite(value)) return 'Not measurable';
  return `${formatNumber(value * 100, fractionDigits)}%`;
}

function formatDays(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'No demand signal';
  return `${formatNumber(value, 1)} days`;
}

function severityRank(severity: SignalSeverity): number {
  if (severity === 'critical') return 4;
  if (severity === 'action') return 3;
  if (severity === 'watch') return 2;
  return 1;
}

function compareSeverity(left: SignalSeverity, right: SignalSeverity): number {
  return severityRank(right) - severityRank(left);
}

function formatDateTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function daysSince(value?: string | null): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return Number.POSITIVE_INFINITY;
  return Math.floor((Date.now() - date.getTime()) / (24 * 60 * 60 * 1000));
}

function withQuery(basePath: string, params: Record<string, string | number | null | undefined>) {
  const search = new URLSearchParams();
  Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([key, value]) => {
      search.set(key, String(value));
    });
  const query = search.toString();
  return query ? `${basePath}?${query}` : basePath;
}

function bucketUomDiagnostics(entries: InventoryUomInconsistency[]) {
  const grouped = new Map<string, SignalSeverity>();
  entries.forEach((entry) => {
    const key = `${entry.itemId}:${entry.locationId}`;
    const severity = (entry.severity ?? 'action') as SignalSeverity;
    const previous = grouped.get(key);
    if (!previous || severityRank(severity) > severityRank(previous)) {
      grouped.set(key, severity);
    }
  });

  let actionGroups = 0;
  let watchGroups = 0;
  grouped.forEach((severity) => {
    if (severityRank(severity) >= severityRank('action')) {
      actionGroups += 1;
    } else if (severity === 'watch') {
      watchGroups += 1;
    }
  });

  return { actionGroups, watchGroups, totalGroups: grouped.size };
}

async function listWarehouseScope(tenantId: string, warehouseId?: string) {
  const params: unknown[] = [tenantId];
  const where = warehouseId ? 'AND id = $2' : '';
  if (warehouseId) params.push(warehouseId);
  const { rows } = await query<{ id: string; code: string | null; name: string | null }>(
    `SELECT id, code, name
       FROM locations
      WHERE tenant_id = $1
        AND type = 'warehouse'
        AND active = true
        ${where}
      ORDER BY code NULLS LAST, name NULLS LAST`,
    params
  );
  return rows;
}

async function loadLocations(tenantId: string) {
  const { rows } = await query(
    `SELECT id, code, name, type, warehouse_id AS "warehouseId", active
       FROM locations
      WHERE tenant_id = $1`,
    [tenantId]
  );
  return rows as LocationRecord[];
}

async function loadItems(tenantId: string) {
  const { rows } = await query(
    `SELECT id,
            sku,
            name,
            type,
            abc_class AS "abcClass",
            canonical_uom AS "canonicalUom",
            default_location_id AS "defaultLocationId"
       FROM items
      WHERE tenant_id = $1
      ORDER BY sku ASC`,
    [tenantId]
  );
  return rows as ItemRecord[];
}

async function loadPurchaseOrders(tenantId: string, windowDays: number) {
  const { rows } = await query(
    `SELECT id,
            po_number AS "poNumber",
            status,
            order_date::text AS "orderDate",
            expected_date::text AS "expectedDate",
            created_at::text AS "createdAt",
            ship_to_location_id AS "shipToLocationId",
            vendor_id AS "vendorId"
       FROM purchase_orders
      WHERE tenant_id = $1
        AND created_at >= NOW() - ($2::int || ' days')::interval
      ORDER BY created_at DESC`,
    [tenantId, Math.max(windowDays, 90)]
  );
  return rows as PurchaseOrderRecord[];
}

async function loadWorkOrders(tenantId: string, windowDays: number) {
  const { rows } = await query(
    `SELECT id,
            COALESCE(work_order_number, number) AS number,
            status,
            output_item_id AS "outputItemId",
            quantity_planned AS "quantityPlanned",
            COALESCE(quantity_completed, 0) AS "quantityCompleted",
            scheduled_due_at::text AS "scheduledDueAt",
            default_produce_location_id AS "defaultProduceLocationId"
       FROM work_orders
      WHERE tenant_id = $1
        AND created_at >= NOW() - ($2::int || ' days')::interval
      ORDER BY created_at DESC`,
    [tenantId, Math.max(windowDays, 90)]
  );
  return rows.map((row) => ({
    ...row,
    quantityPlanned: toFiniteNumber(row.quantityPlanned),
    quantityCompleted: toFiniteNumber(row.quantityCompleted)
  })) as WorkOrderRecord[];
}

async function loadDemandStats(tenantId: string, windowDays: number): Promise<Map<string, DemandStat>> {
  const { rows } = await query<{
    itemId: string;
    avgDailyDemand: string;
    stddevDailyDemand: string;
    coefficientOfVariation: string;
    recent7Demand: string;
    prior28Demand: string;
    recent28Demand: string;
    previous28Demand: string;
  }>(
    `WITH demand_daily AS (
       SELECT sol.item_id AS "itemId",
              so.order_date::date AS demand_date,
              SUM(sol.quantity_ordered) AS demand_qty
         FROM sales_order_lines sol
         JOIN sales_orders so
           ON so.id = sol.sales_order_id
          AND so.tenant_id = sol.tenant_id
        WHERE so.tenant_id = $1
          AND so.status NOT IN ('draft', 'canceled')
          AND so.order_date >= CURRENT_DATE - $2::int
        GROUP BY sol.item_id, so.order_date::date
     ),
     stats AS (
       SELECT "itemId",
              AVG(demand_qty) AS "avgDailyDemand",
              COALESCE(STDDEV_POP(demand_qty), 0) AS "stddevDailyDemand",
              SUM(CASE WHEN demand_date >= CURRENT_DATE - 7 THEN demand_qty ELSE 0 END) AS "recent7Demand",
              SUM(CASE WHEN demand_date >= CURRENT_DATE - 35 AND demand_date < CURRENT_DATE - 7 THEN demand_qty ELSE 0 END) AS "prior28Demand",
              SUM(CASE WHEN demand_date >= CURRENT_DATE - 28 THEN demand_qty ELSE 0 END) AS "recent28Demand",
              SUM(CASE WHEN demand_date >= CURRENT_DATE - 56 AND demand_date < CURRENT_DATE - 28 THEN demand_qty ELSE 0 END) AS "previous28Demand"
         FROM demand_daily
        GROUP BY "itemId"
     )
     SELECT "itemId",
            COALESCE("avgDailyDemand", 0)::text AS "avgDailyDemand",
            COALESCE("stddevDailyDemand", 0)::text AS "stddevDailyDemand",
            CASE
              WHEN COALESCE("avgDailyDemand", 0) > 0
                THEN COALESCE("stddevDailyDemand", 0) / "avgDailyDemand"
              ELSE 0
            END::text AS "coefficientOfVariation",
            COALESCE("recent7Demand", 0)::text AS "recent7Demand",
            COALESCE("prior28Demand", 0)::text AS "prior28Demand",
            COALESCE("recent28Demand", 0)::text AS "recent28Demand",
            COALESCE("previous28Demand", 0)::text AS "previous28Demand"
       FROM stats`,
    [tenantId, Math.max(windowDays, 56)]
  );

  return new Map(
    rows.map((row) => [
      row.itemId,
      {
        itemId: row.itemId,
        avgDailyDemand: roundQuantity(toFiniteNumber(row.avgDailyDemand)),
        stddevDailyDemand: roundQuantity(toFiniteNumber(row.stddevDailyDemand)),
        coefficientOfVariation: roundQuantity(toFiniteNumber(row.coefficientOfVariation)),
        recent7Demand: roundQuantity(toFiniteNumber(row.recent7Demand)),
        prior28Demand: roundQuantity(toFiniteNumber(row.prior28Demand)),
        recent28Demand: roundQuantity(toFiniteNumber(row.recent28Demand)),
        previous28Demand: roundQuantity(toFiniteNumber(row.previous28Demand))
      }
    ])
  );
}

async function loadForecastAccuracyMetrics(tenantId: string, windowDays: number) {
  const { rows } = await query<{
    forecastQty: string;
    actualQty: string;
    absErrorPct: string;
    biasPct: string;
  }>(
    `WITH forecast_inputs AS (
       SELECT mpi.item_id,
              mp.period_start::date AS period_start,
              mp.period_end::date AS period_end,
              SUM(mdi.quantity) AS forecast_qty
         FROM mps_demand_inputs mdi
         JOIN mps_plan_items mpi
           ON mpi.id = mdi.mps_plan_item_id
          AND mpi.tenant_id = mdi.tenant_id
         JOIN mps_periods mp
           ON mp.id = mdi.mps_period_id
          AND mp.tenant_id = mdi.tenant_id
        WHERE mdi.tenant_id = $1
          AND mdi.demand_type = 'forecast'
          AND mp.period_end >= CURRENT_DATE - $2::int
        GROUP BY mpi.item_id, mp.period_start::date, mp.period_end::date
     ),
     actual_orders AS (
       SELECT fi.item_id,
              fi.period_start,
              fi.period_end,
              SUM(sol.quantity_ordered) AS actual_qty
         FROM forecast_inputs fi
         LEFT JOIN sales_order_lines sol
           ON sol.item_id = fi.item_id
         LEFT JOIN sales_orders so
           ON so.id = sol.sales_order_id
          AND so.tenant_id = sol.tenant_id
          AND so.tenant_id = $1
          AND so.order_date >= fi.period_start
          AND so.order_date <= fi.period_end
          AND so.status NOT IN ('draft', 'canceled')
        GROUP BY fi.item_id, fi.period_start, fi.period_end
     ),
     paired AS (
       SELECT fi.item_id,
              fi.period_start,
              fi.period_end,
              COALESCE(fi.forecast_qty, 0) AS forecast_qty,
              COALESCE(ao.actual_qty, 0) AS actual_qty
         FROM forecast_inputs fi
         LEFT JOIN actual_orders ao
           ON ao.item_id = fi.item_id
          AND ao.period_start = fi.period_start
          AND ao.period_end = fi.period_end
     )
     SELECT COALESCE(SUM(forecast_qty), 0)::text AS "forecastQty",
            COALESCE(SUM(actual_qty), 0)::text AS "actualQty",
            COALESCE(AVG(CASE WHEN actual_qty > 0 THEN ABS(forecast_qty - actual_qty) / actual_qty ELSE NULL END), 0)::text AS "absErrorPct",
            COALESCE(AVG(CASE WHEN actual_qty > 0 THEN (forecast_qty - actual_qty) / actual_qty ELSE NULL END), 0)::text AS "biasPct"
       FROM paired`,
    [tenantId, Math.max(windowDays, 90)]
  );

  const row = rows[0] ?? {
    forecastQty: '0',
    actualQty: '0',
    absErrorPct: '0',
    biasPct: '0'
  };

  return {
    forecastQty: roundQuantity(toFiniteNumber(row.forecastQty)),
    actualQty: roundQuantity(toFiniteNumber(row.actualQty)),
    mape: roundQuantity(toFiniteNumber(row.absErrorPct)),
    bias: roundQuantity(toFiniteNumber(row.biasPct))
  };
}

function buildCoverageRows(params: {
  inventoryRows: InventorySnapshotRow[];
  items: ItemRecord[];
  demandStats: Map<string, DemandStat>;
}) {
  const itemLookup = new Map(params.items.map((item) => [item.id, item]));
  const aggregate = new Map<string, { onHand: number; available: number; backordered: number }>();

  params.inventoryRows.forEach((row) => {
    const current = aggregate.get(row.itemId) ?? { onHand: 0, available: 0, backordered: 0 };
    current.onHand = roundQuantity(current.onHand + toFiniteNumber(row.onHand));
    current.available = roundQuantity(current.available + toFiniteNumber(row.available));
    current.backordered = roundQuantity(current.backordered + toFiniteNumber(row.backordered));
    aggregate.set(row.itemId, current);
  });

  return Array.from(aggregate.entries()).map(([itemId, values]) => {
    const item = itemLookup.get(itemId);
    const demand = params.demandStats.get(itemId);
    const avgDailyDemand = demand?.avgDailyDemand ?? 0;
    const daysOfSupply = avgDailyDemand > 0 ? roundQuantity(values.available / avgDailyDemand) : null;
    const bucket: CoverageRow['bucket'] =
      avgDailyDemand <= 0
        ? 'no_demand'
        : daysOfSupply !== null && daysOfSupply < 7
          ? 'low'
          : daysOfSupply !== null && daysOfSupply > 120
            ? 'excess'
            : 'healthy';
    return {
      itemId,
      itemLabel: item ? (item.name ? `${item.sku} - ${item.name}` : item.sku) : itemId,
      onHand: values.onHand,
      available: values.available,
      backordered: values.backordered,
      avgDailyDemand,
      daysOfSupply,
      bucket,
      drilldownTo: `/items/${itemId}`
    };
  });
}

function resolveWarehouseId(locationId: string | undefined, lookup: Map<string, LocationRecord>) {
  if (!locationId) return null;
  const location = lookup.get(locationId);
  if (!location) return null;
  if (location.warehouseId) return location.warehouseId;
  if (location.type === 'warehouse') return location.id;
  return null;
}

function buildMonitoringCoverage(params: {
  inventoryRows: InventorySnapshotRow[];
  policies: ReplenishmentPolicyRecord[];
  items: ItemRecord[];
  itemMetrics: ItemMetrics[];
  fillRate: Awaited<ReturnType<typeof computeFulfillmentFillRate>>;
}) {
  const hasInventoryRows = params.inventoryRows.length > 0;
  const hasReplenishmentPolicies = params.policies.some((policy) => String(policy.status ?? '').toLowerCase() !== 'inactive');
  const hasDemandSignal = params.inventoryRows.some((row) => toFiniteNumber(row.reserved) > 0 || toFiniteNumber(row.backordered) > 0);
  const abcItemIds = params.items.filter((item) => item.abcClass === 'A').map((item) => item.id);
  const metricsIds = new Set(params.itemMetrics.map((metric) => metric.itemId));
  const hasCycleCountProgram = abcItemIds.some((itemId) => metricsIds.has(itemId));
  const hasShipmentsInWindow = params.fillRate.requestedQty > 0;

  return {
    hasInventoryRows,
    hasReplenishmentPolicies,
    hasDemandSignal,
    hasCycleCountProgram,
    hasShipmentsInWindow,
    inventoryMonitoringConfigured: hasInventoryRows,
    replenishmentMonitoringConfigured: hasInventoryRows && hasReplenishmentPolicies,
    cycleCountMonitoringConfigured: hasCycleCountProgram,
    reliabilityMeasurable: hasShipmentsInWindow
  };
}

function deriveInventoryState(row: InventorySnapshotRow) {
  const onHandQty = toFiniteNumber(row.onHand);
  const allocatedQty = toFiniteNumber(row.reserved);
  const qualityHoldQty = toFiniteNumber(row.held);
  const damagedHoldQty = toFiniteNumber(row.rejected);
  const availableQty = roundQuantity(onHandQty - allocatedQty - qualityHoldQty - damagedHoldQty);
  return {
    onHandQty,
    allocatedQty,
    qualityHoldQty,
    damagedHoldQty,
    availableQty,
    onOrderQty: toFiniteNumber(row.onOrder),
    inTransitQty: toFiniteNumber(row.inTransit),
    backorderQty: toFiniteNumber(row.backordered)
  };
}

function sortResolutionQueue(rows: ResolutionQueueRow[]) {
  return [...rows].sort((left, right) => {
    const severity = compareSeverity(left.severity, right.severity);
    if (severity !== 0) return severity;
    if (right.impactScore !== left.impactScore) return right.impactScore - left.impactScore;
    return new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime();
  });
}

function buildExceptionRows(params: {
  asOf: string;
  inventoryRows: InventorySnapshotRow[];
  uomInconsistencies: InventoryUomInconsistency[];
  recommendations: Awaited<ReturnType<typeof computeReplenishmentRecommendations>>;
  policyScopeSet: Set<string>;
  purchaseOrders: PurchaseOrderRecord[];
  workOrders: WorkOrderRecord[];
  items: ItemRecord[];
  locations: LocationRecord[];
  itemMetrics: ItemMetrics[];
}) {
  const itemLookup = new Map(params.items.map((item) => [item.id, item]));
  const locationLookup = new Map(params.locations.map((location) => [location.id, location]));
  const itemMetricsLookup = new Map(params.itemMetrics.map((metric) => [metric.itemId, metric]));
  const rows: ResolutionQueueRow[] = [];

  params.inventoryRows.forEach((row) => {
    const state = deriveInventoryState(row);
    const key = `${row.itemId}:${row.locationId}`;
    const activeDemand = state.allocatedQty > 0 || state.backorderQty > 0;
    const hasPolicy = params.policyScopeSet.has(key);
    const item = itemLookup.get(row.itemId);
    const location = locationLookup.get(row.locationId);
    const readableItem = item ? (item.name ? `${item.sku} - ${item.name}` : item.sku) : row.itemId;
    const readableLocation = location ? (location.name ? `${location.code} - ${location.name}` : location.code ?? row.locationId) : row.locationId;
    const warehouseId = resolveWarehouseId(row.locationId, locationLookup) ?? undefined;

    if (state.availableQty <= 0 && (activeDemand || hasPolicy)) {
      rows.push({
        id: `availability:${row.itemId}:${row.locationId}:${row.uom}`,
        type: 'availability_breach',
        severity: 'critical',
        itemLabel: readableItem,
        itemId: row.itemId,
        locationLabel: readableLocation,
        locationId: row.locationId,
        warehouseId,
        uom: row.uom,
        impactScore: Math.max(Math.abs(state.availableQty), state.backorderQty, state.allocatedQty),
        occurredAt: params.asOf,
        recommendedAction: 'Investigate allocation, expedite inbound, or deallocate lower-priority demand.',
        primaryLink: withQuery(`/items/${row.itemId}`, { locationId: row.locationId, warehouseId, type: 'availability_breach' })
      });
    }

    if (state.onHandQty < 0) {
      rows.push({
        id: `negative:${row.itemId}:${row.locationId}:${row.uom}`,
        type: 'negative_on_hand',
        severity: 'critical',
        itemLabel: readableItem,
        itemId: row.itemId,
        locationLabel: readableLocation,
        locationId: row.locationId,
        warehouseId,
        uom: row.uom,
        impactScore: Math.abs(state.onHandQty),
        occurredAt: params.asOf,
        recommendedAction: 'Investigate ledger sequence and post corrective movement.',
        primaryLink: withQuery('/movements', { itemId: row.itemId, locationId: row.locationId, warehouseId, type: 'negative_on_hand' })
      });
    }

    if (state.allocatedQty > state.onHandQty || (state.availableQty < 0 && state.qualityHoldQty <= 0 && state.damagedHoldQty <= 0)) {
      rows.push({
        id: `allocation:${row.itemId}:${row.locationId}:${row.uom}`,
        type: 'allocation_integrity',
        severity: 'critical',
        itemLabel: readableItem,
        itemId: row.itemId,
        locationLabel: readableLocation,
        locationId: row.locationId,
        warehouseId,
        uom: row.uom,
        impactScore: Math.max(state.allocatedQty - state.onHandQty, Math.abs(state.availableQty)),
        occurredAt: params.asOf,
        recommendedAction: 'Investigate reservations or deallocate lower-priority demand.',
        primaryLink: withQuery('/reservations', { itemId: row.itemId, locationId: row.locationId, warehouseId, type: 'allocation_integrity' })
      });
    }
  });

  params.recommendations.filter((recommendation) => recommendation.recommendation.reorderNeeded).forEach((recommendation) => {
    const threshold =
      recommendation.policyType === 'q_rop'
        ? toFiniteNumber(recommendation.inputs.reorderPointQty)
        : toFiniteNumber(recommendation.inputs.orderUpToLevelQty);
    const gap = Math.max(0, threshold - toFiniteNumber(recommendation.inventory.inventoryPosition));
    const severity: SignalSeverity = gap > Math.max(10, threshold * 0.25) ? 'action' : 'watch';
    const warehouseId = resolveWarehouseId(recommendation.locationId, new Map(params.locations.map((location) => [location.id, location]))) ?? undefined;
    const item = itemLookup.get(recommendation.itemId);
    const location = locationLookup.get(recommendation.locationId);
    rows.push({
      id: `reorder:${recommendation.policyId}`,
      type: 'reorder_risk',
      severity,
      itemLabel: item ? (item.name ? `${item.sku} - ${item.name}` : item.sku) : recommendation.itemId,
      itemId: recommendation.itemId,
      locationLabel: location ? (location.name ? `${location.code} - ${location.name}` : location.code ?? recommendation.locationId) : recommendation.locationId,
      locationId: recommendation.locationId,
      warehouseId,
      uom: recommendation.uom,
      impactScore: Math.max(gap, toFiniteNumber(recommendation.recommendation.recommendedOrderQty)),
      occurredAt: params.asOf,
      recommendedAction: 'Create or expedite a PO for the recommended quantity.',
      primaryLink: withQuery('/purchase-orders/new', {
        itemId: recommendation.itemId,
        locationId: recommendation.locationId,
        warehouseId,
        qty: recommendation.recommendation.recommendedOrderQty,
        uom: recommendation.uom,
        type: 'reorder_risk'
      })
    });
  });

  params.purchaseOrders.forEach((purchaseOrder) => {
    const status = String(purchaseOrder.status ?? '').toLowerCase();
    const submittedAge = daysSince(purchaseOrder.createdAt ?? purchaseOrder.orderDate);
    const overdueAge = purchaseOrder.expectedDate ? daysSince(purchaseOrder.expectedDate) : 0;
    const location = purchaseOrder.shipToLocationId ? locationLookup.get(purchaseOrder.shipToLocationId) : null;
    const warehouseId = resolveWarehouseId(purchaseOrder.shipToLocationId ?? undefined, locationLookup) ?? undefined;
    const locationLabel = location ? (location.name ? `${location.code} - ${location.name}` : location.code ?? 'Not set') : 'Not set';

    if (status === 'submitted' && submittedAge > 1) {
      rows.push({
        id: `inbound-submitted:${purchaseOrder.id}`,
        type: 'inbound_aging',
        severity: submittedAge > 3 ? 'action' : 'watch',
        itemLabel: purchaseOrder.poNumber,
        locationLabel,
        locationId: purchaseOrder.shipToLocationId ?? undefined,
        warehouseId,
        impactScore: submittedAge,
        occurredAt: purchaseOrder.createdAt ?? params.asOf,
        recommendedAction: 'Approve or reject the purchase order to unblock inbound execution.',
        primaryLink: withQuery(`/purchase-orders/${purchaseOrder.id}`, { warehouseId, type: 'inbound_aging' })
      });
    }

    if ((status === 'approved' || status === 'partially_received') && overdueAge > 0) {
      rows.push({
        id: `inbound-overdue:${purchaseOrder.id}`,
        type: 'inbound_aging',
        severity: overdueAge > 5 ? 'action' : 'watch',
        itemLabel: purchaseOrder.poNumber,
        locationLabel,
        locationId: purchaseOrder.shipToLocationId ?? undefined,
        warehouseId,
        impactScore: overdueAge,
        occurredAt: purchaseOrder.expectedDate ?? purchaseOrder.createdAt ?? params.asOf,
        recommendedAction: 'Expedite supplier confirmation and adjust expected receipt dates.',
        primaryLink: withQuery(`/purchase-orders/${purchaseOrder.id}`, { warehouseId, type: 'inbound_aging' })
      });
    }
  });

  params.workOrders
    .filter((workOrder) => !['completed', 'closed', 'voided', 'canceled'].includes(String(workOrder.status ?? '').toLowerCase()))
    .forEach((workOrder) => {
      const remaining = Math.max(0, toFiniteNumber(workOrder.quantityPlanned) - toFiniteNumber(workOrder.quantityCompleted));
      if (remaining <= 0) return;
      const locationId = workOrder.defaultProduceLocationId ?? undefined;
      const warehouseId = resolveWarehouseId(locationId, locationLookup) ?? undefined;
      const item = itemLookup.get(workOrder.outputItemId);
      rows.push({
        id: `work-order:${workOrder.id}`,
        type: 'work_order_risk',
        severity: daysSince(workOrder.scheduledDueAt) > 0 ? 'action' : 'watch',
        itemLabel: item ? (item.name ? `${item.sku} - ${item.name}` : item.sku) : workOrder.number,
        itemId: workOrder.outputItemId,
        locationLabel: locationId ? locationLookup.get(locationId)?.code ?? 'Production' : 'Production',
        locationId,
        warehouseId,
        impactScore: remaining,
        occurredAt: workOrder.scheduledDueAt ?? params.asOf,
        recommendedAction: 'Review component availability and prioritize issue or production steps.',
        primaryLink: withQuery(`/work-orders/${workOrder.id}`, { warehouseId, locationId, type: 'work_order_risk' })
      });
    });

  params.items.forEach((item) => {
    if (item.abcClass !== 'A') return;
    const metrics = itemMetricsLookup.get(item.id);
    const countAge = daysSince(metrics?.lastCountAt ?? null);
    const variancePct = Math.abs(toFiniteNumber(metrics?.lastCountVariancePct));
    const stale = !Number.isFinite(countAge) || countAge > 30;
    const highVariance = variancePct > 0.05;
    if (!stale && !highVariance) return;
    const warehouseId = resolveWarehouseId(item.defaultLocationId ?? undefined, locationLookup) ?? undefined;
    rows.push({
      id: `cycle:${item.id}`,
      type: 'cycle_count_hygiene',
      severity: stale || variancePct > 0.1 ? 'action' : 'watch',
      itemLabel: item.name ? `${item.sku} - ${item.name}` : item.sku,
      itemId: item.id,
      locationLabel: item.defaultLocationId ? locationLookup.get(item.defaultLocationId)?.code ?? 'Multiple' : 'Multiple',
      locationId: item.defaultLocationId ?? undefined,
      warehouseId,
      impactScore: Math.max(Number.isFinite(countAge) ? countAge : 45, variancePct * 100),
      occurredAt: metrics?.lastCountAt ?? params.asOf,
      recommendedAction: 'Schedule a cycle count and investigate root cause variance.',
      primaryLink: withQuery(`/items/${item.id}`, { locationId: item.defaultLocationId ?? undefined, warehouseId, type: 'cycle_count_hygiene' })
    });
  });

  params.uomInconsistencies.forEach((entry) => {
    const item = itemLookup.get(entry.itemId);
    const location = locationLookup.get(entry.locationId);
    const observedUoms = entry.observedUoms.join(', ');
    const warehouseId = resolveWarehouseId(entry.locationId, locationLookup) ?? undefined;
    rows.push({
      id: `uom:${entry.itemId}:${entry.locationId}`,
      type: 'uom_inconsistent',
      severity: (entry.severity ?? 'action') as SignalSeverity,
      itemLabel: item ? (item.name ? `${item.sku} - ${item.name}` : item.sku) : entry.itemId,
      itemId: entry.itemId,
      locationLabel: location ? (location.name ? `${location.code} - ${location.name}` : location.code ?? entry.locationId) : entry.locationId,
      locationId: entry.locationId,
      warehouseId,
      impactScore: Math.max(1, entry.observedUoms.length),
      occurredAt: params.asOf,
      recommendedAction:
        entry.reason === 'STOCKING_UOM_UNSET'
          ? 'Set stock UOM and conversion policy before aggregating location availability.'
          : `Define a valid conversion path for ${observedUoms}.`,
      primaryLink: withQuery(`/items/${entry.itemId}`, { locationId: entry.locationId, warehouseId, type: 'uom_inconsistent', observedUoms })
    });
  });

  return sortResolutionQueue(rows);
}

function buildLegacyDashboardSignals(params: {
  exceptions: ResolutionQueueRow[];
  fillRate: Awaited<ReturnType<typeof computeFulfillmentFillRate>>;
  asOfLabel: string;
}) {
  const countByType = new Map<DashboardExceptionType, number>();
  const severityByType = new Map<DashboardExceptionType, SignalSeverity>();
  params.exceptions.forEach((exception) => {
    countByType.set(exception.type, (countByType.get(exception.type) ?? 0) + 1);
    const previous = severityByType.get(exception.type);
    if (!previous || severityRank(exception.severity) > severityRank(previous)) {
      severityByType.set(exception.type, exception.severity);
    }
  });

  const makeSignal = (
    key: DashboardExceptionType,
    label: string,
    helper: string,
    formula: string,
    queryHint: string,
  ): DashboardSignal => ({
    key,
    label,
    type: key,
    severity: severityByType.get(key) ?? 'info',
    value: String(countByType.get(key) ?? 0),
    helper: `${helper} As of ${params.asOfLabel}.`,
    count: countByType.get(key) ?? 0,
    drilldownTo: `/dashboard/resolution-queue?type=${key}`,
    formula,
    sources: ['/api/dashboard/overview'],
    queryHint,
  });

  const fillRateValue = params.fillRate.fillRate !== null ? `${formatNumber(params.fillRate.fillRate * 100, 1)}%` : 'Not measurable yet';
  const fillSeverity: SignalSeverity =
    params.fillRate.fillRate === null ? 'info' : params.fillRate.fillRate < 0.85 ? 'action' : params.fillRate.fillRate < 0.95 ? 'watch' : 'info';

  return [
    makeSignal('availability_breach', 'Availability breaches', 'Available qty <= 0 with active demand or configured policy scope.', 'Available = On hand - reserved - held - rejected.', 'Derived from /api/dashboard/overview inventory ledger scope.'),
    makeSignal('negative_on_hand', 'Negative on-hand', 'Physical stock cannot be negative.', 'Flag when onHand < 0.', 'Derived from /api/dashboard/inventory-integrity.'),
    makeSignal('allocation_integrity', 'Allocation integrity', 'Allocated exceeds on-hand or available goes negative without holds.', 'Critical when reserved > on hand or available < 0 without holds.', 'Derived from /api/dashboard/inventory-integrity.'),
    makeSignal('reorder_risk', 'Reorder risks', 'Below reorder thresholds or projected short.', 'Triggered from replenishment policies and risk horizon coverage.', 'Derived from /api/dashboard/inventory-risk.'),
    makeSignal('inbound_aging', 'Inbound aging', 'Aging submitted or overdue purchase orders.', 'Submitted age and approved overdue days by PO status.', 'Derived from /api/dashboard/flow-reliability.'),
    makeSignal('work_order_risk', 'Open WO at risk', 'Open work orders with remaining quantity and due-date risk.', 'Risk weighted by due date and remaining quantity.', 'Derived from /api/dashboard/flow-reliability.'),
    makeSignal('cycle_count_hygiene', 'Cycle count hygiene', 'A-items with stale counts or large count variance.', 'Thresholds: >30 days stale or >5% variance.', 'Derived from /api/dashboard/inventory-integrity.'),
    makeSignal('uom_inconsistent', 'UOM inconsistent', 'Conflicting UOM rows cannot be safely aggregated.', 'Raised when item/location UOMs are not normalizable.', 'Derived from /api/dashboard/system-readiness.'),
    {
      key: 'fulfillment_reliability',
      label: 'Fulfillment reliability',
      type: 'fulfillment_reliability',
      severity: fillSeverity,
      value: fillRateValue,
      helper:
        params.fillRate.fillRate !== null
          ? `Measured fill rate from shipped vs requested quantity. As of ${params.asOfLabel}.`
          : `No shipped/requested quantity in the selected window. As of ${params.asOfLabel}.`,
      count: params.fillRate.fillRate !== null ? 1 : 0,
      drilldownTo: '/shipments',
      formula: 'Fill rate = shipped quantity / requested quantity.',
      sources: ['/api/dashboard/performance-metrics'],
      queryHint: 'Measured using posted shipment lines in the selected window.'
    }
  ];
}

function buildCoverageMatrix(): InventorySignalCoverageRow[] {
  return [
    { signal: 'inventoryIntegrity', implemented: true, dataSource: ['inventory_movements', 'inventory_cost_layers', 'inventory_reservations', 'inventory_snapshot'], accuracy: 'measured', dashboardIntegration: 'exception_queue' },
    { signal: 'inventoryRisk', implemented: true, dataSource: ['inventory_snapshot', 'replenishment_policies', 'sales_orders', 'item_metrics'], accuracy: 'derived', dashboardIntegration: 'dashboard_section' },
    { signal: 'operationalFlowReliability', implemented: true, dataSource: ['purchase_orders', 'purchase_order_receipts', 'work_orders', 'sales_orders', 'sales_order_shipments'], accuracy: 'measured', dashboardIntegration: 'dashboard_section' },
    { signal: 'operationalThroughput', implemented: true, dataSource: ['sales_order_shipments', 'inventory_movements', 'work_orders'], accuracy: 'measured', dashboardIntegration: 'dashboard_section' },
    { signal: 'systemReadiness', implemented: true, dataSource: ['items', 'boms', 'bom_versions', 'routings', 'replenishment_policies', 'locations', 'inventory_snapshot'], accuracy: 'derived', dashboardIntegration: 'dashboard_section' },
    { signal: 'demandVolatility', implemented: true, dataSource: ['sales_orders', 'sales_order_lines'], accuracy: 'derived', dashboardIntegration: 'dashboard_section' },
    { signal: 'inventoryCoverage', implemented: true, dataSource: ['inventory_snapshot', 'sales_orders', 'sales_order_lines'], accuracy: 'derived', dashboardIntegration: 'dashboard_section' },
    { signal: 'supplyReliability', implemented: true, dataSource: ['purchase_orders', 'purchase_order_receipts', 'vendors', 'qc_events', 'ncrs'], accuracy: 'measured', dashboardIntegration: 'dashboard_section' },
    { signal: 'excessInventoryRisk', implemented: true, dataSource: ['inventory_movements', 'inventory_snapshot', 'lots'], accuracy: 'derived', dashboardIntegration: 'dashboard_section' },
    { signal: 'forecastAccuracy', implemented: true, dataSource: ['mps_demand_inputs', 'mps_periods', 'sales_orders', 'sales_order_lines'], accuracy: 'derived', dashboardIntegration: 'dashboard_section' }
  ];
}

async function computeSystemReadinessSection(params: {
  tenantId: string;
  uomDiagnostics: InventoryUomInconsistency[];
}) : Promise<DashboardSignalSection> {
  const [missingBomRows, missingRoutingRows, missingPolicyRows, inactiveLocationRows, inactiveLocationCountRows] = await Promise.all([
    query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM items i
        WHERE i.tenant_id = $1
          AND COALESCE(i.type, '') IN ('wip', 'finished')
          AND NOT EXISTS (
            SELECT 1
              FROM boms b
              JOIN bom_versions v ON v.bom_id = b.id AND v.tenant_id = b.tenant_id
             WHERE b.output_item_id = i.id
               AND b.tenant_id = i.tenant_id
               AND v.status = 'active'
          )`,
      [params.tenantId]
    ),
    query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM items i
        WHERE i.tenant_id = $1
          AND COALESCE(i.type, '') IN ('wip', 'finished')
          AND NOT EXISTS (
            SELECT 1
              FROM routings r
             WHERE r.item_id = i.id
               AND r.tenant_id = i.tenant_id
               AND r.status = 'active'
          )`,
      [params.tenantId]
    ),
    query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM items i
        WHERE i.tenant_id = $1
          AND i.default_location_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
              FROM replenishment_policies p
             WHERE p.tenant_id = i.tenant_id
               AND p.item_id = i.id
               AND p.site_location_id = i.default_location_id
               AND p.status = 'active'
          )`,
      [params.tenantId]
    ),
    query<{ id: string; code: string | null; name: string | null }>(
      `SELECT id, code, name
         FROM locations
        WHERE tenant_id = $1
          AND active = false
        ORDER BY code NULLS LAST
        LIMIT 10`,
      [params.tenantId]
    ),
    query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM locations
        WHERE tenant_id = $1
          AND active = false`,
      [params.tenantId]
    )
  ]);

  const missingBomCount = toFiniteNumber(missingBomRows.rows[0]?.count);
  const missingRoutingCount = toFiniteNumber(missingRoutingRows.rows[0]?.count);
  const missingPolicyCount = toFiniteNumber(missingPolicyRows.rows[0]?.count);
  const uomCount = params.uomDiagnostics.length;
  const inactiveLocationCount = toFiniteNumber(inactiveLocationCountRows.rows[0]?.count);

  return {
    key: 'systemHealth',
    title: 'System readiness',
    description: 'Missing configuration that blocks replenishment, production, or safe aggregation.',
    metrics: [
      {
        key: 'missing-boms',
        label: 'Missing BOMs',
        severity: missingBomCount > 0 ? 'action' : 'info',
        value: String(missingBomCount),
        count: missingBomCount,
        helper: 'WIP and finished items without an active BOM version.',
        formula: 'Count of WIP/finished items with no active BOM version.',
        queryHint: 'Derived from items + boms + active bom_versions.',
        drilldownTo: '/items',
        sources: ['/api/dashboard/system-readiness'],
        investigativeAction: { label: 'Review items', href: '/items' },
        correctiveAction: { label: 'Create BOM', href: '/boms/new' }
      },
      {
        key: 'missing-routings',
        label: 'Missing routings',
        severity: missingRoutingCount > 0 ? 'action' : 'info',
        value: String(missingRoutingCount),
        count: missingRoutingCount,
        helper: 'Produceable items without an active routing.',
        formula: 'Count of WIP/finished items with no active routing.',
        queryHint: 'Derived from items + routings.',
        drilldownTo: '/items',
        sources: ['/api/dashboard/system-readiness'],
        investigativeAction: { label: 'Review items', href: '/items' },
        correctiveAction: { label: 'Create routing', href: '/routings' }
      },
      {
        key: 'missing-policies',
        label: 'Missing replenishment policies',
        severity: missingPolicyCount > 0 ? 'watch' : 'info',
        value: String(missingPolicyCount),
        count: missingPolicyCount,
        helper: 'Items with a default location but no active replenishment policy.',
        formula: 'Count of items where default location exists but no active replenishment policy scope exists.',
        queryHint: 'Derived from items + replenishment_policies.',
        drilldownTo: '/items',
        sources: ['/api/dashboard/system-readiness'],
        investigativeAction: { label: 'Review replenishment coverage', href: '/items' },
        correctiveAction: { label: 'Configure policy', href: '/items' }
      },
      {
        key: 'missing-uom-conversions',
        label: 'Missing UOM conversions',
        severity: uomCount > 0 ? 'action' : 'info',
        value: String(uomCount),
        count: uomCount,
        helper: 'Conflicting UOM scopes that cannot be safely aggregated.',
        formula: 'Count of UOM normalization diagnostics from inventory snapshot summary.',
        queryHint: 'Derived from /inventory-snapshot/summary diagnostics.',
        drilldownTo: '/dashboard/resolution-queue?type=uom_inconsistent',
        sources: ['/api/dashboard/system-readiness'],
        investigativeAction: { label: 'Review conversions', href: '/dashboard/resolution-queue?type=uom_inconsistent' },
        correctiveAction: { label: 'Fix item conversions', href: '/items' }
      },
      {
        key: 'inactive-locations',
        label: 'Inactive locations',
        severity: inactiveLocationCount > 0 ? 'watch' : 'info',
        value: String(inactiveLocationCount),
        count: inactiveLocationCount,
        helper: 'Inactive locations should not remain in active operational flows.',
        formula: 'Count of inactive locations in the tenant scope.',
        queryHint: 'Derived from locations.active.',
        drilldownTo: '/locations',
        sources: ['/api/dashboard/system-readiness'],
        investigativeAction: { label: 'Review locations', href: '/locations' },
        correctiveAction: { label: 'Activate or archive', href: '/locations' }
      }
    ],
    rows: inactiveLocationRows.rows.map((row) => ({
      id: row.id,
      label: row.code ?? row.id,
      secondaryLabel: row.name ?? undefined,
      value: 'Inactive',
      severity: 'watch',
      drilldownTo: `/locations/${row.id}`
    }))
  };
}

async function computeInventoryIntegritySection(params: {
  tenantId: string;
  inventoryRows: InventorySnapshotRow[];
  uomDiagnostics: InventoryUomInconsistency[];
  asOf: string;
}) : Promise<DashboardSignalSection> {
  const health = await computeInventoryHealth(params.tenantId, { topLimit: 10, countWindowDays: 90 });
  const orphanReservationResult = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM inventory_reservations r
  LEFT JOIN locations l
         ON l.id = r.location_id
        AND l.tenant_id = r.tenant_id
      WHERE r.tenant_id = $1
        AND r.status IN ('RESERVED', 'ALLOCATED')
        AND (l.id IS NULL OR r.warehouse_id IS NULL)`,
    [params.tenantId]
  );
  const missingLocationResult = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM inventory_movement_lines l
  LEFT JOIN locations loc
         ON loc.id = l.location_id
        AND loc.tenant_id = l.tenant_id
      WHERE l.tenant_id = $1
        AND loc.id IS NULL`,
    [params.tenantId]
  );

  const negativeStockCount = health.negativeInventory.count;
  const ledgerImbalanceCount = health.ledgerVsCostLayers.rowsWithVariance;
  const orphanReservations = toFiniteNumber(orphanReservationResult.rows[0]?.count);
  const missingLocations = toFiniteNumber(missingLocationResult.rows[0]?.count);
  const invalidUom = params.uomDiagnostics.length;
  const valuationMismatchCount = health.ledgerVsCostLayers.absValueVariance > 0 ? health.ledgerVsCostLayers.rowsWithVariance : 0;

  return {
    key: 'inventoryIntegrity',
    title: 'Inventory integrity',
    description: 'Ledger and stock hygiene checks used to catch corruption before it becomes a customer-impacting incident.',
    metrics: [
      {
        key: 'negative-stock',
        label: 'Negative stock',
        severity: negativeStockCount > 0 ? 'critical' : 'info',
        value: String(negativeStockCount),
        count: negativeStockCount,
        helper: 'Negative on-hand indicates ledger corruption or posting sequence problems.',
        formula: 'Count of item/location/UOM scopes where ledger on hand < 0.',
        queryHint: 'Derived from posted inventory movement lines.',
        drilldownTo: '/dashboard/resolution-queue?type=negative_on_hand',
        sources: ['/api/dashboard/inventory-integrity'],
        investigativeAction: { label: 'View movements', href: '/dashboard/resolution-queue?type=negative_on_hand' },
        correctiveAction: { label: 'Adjust stock', href: '/adjustments/new' }
      },
      {
        key: 'ledger-imbalance',
        label: 'Ledger imbalance',
        severity: ledgerImbalanceCount > 0 ? 'critical' : 'info',
        value: String(ledgerImbalanceCount),
        count: ledgerImbalanceCount,
        helper: 'Ledger quantity does not reconcile to cost layer quantity.',
        formula: 'Count of item/location/UOM scopes where ledger qty != cost layer qty.',
        queryHint: 'Derived from inventory_movement_lines vs inventory_cost_layers.',
        drilldownTo: '/admin/inventory-health',
        sources: ['/api/dashboard/inventory-integrity'],
        investigativeAction: { label: 'Review health gate', href: '/admin/inventory-health' },
        correctiveAction: { label: 'Repair ledger', href: '/movements' }
      },
      {
        key: 'orphan-reservations',
        label: 'Orphan reservations',
        severity: orphanReservations > 0 ? 'action' : 'info',
        value: String(orphanReservations),
        count: orphanReservations,
        helper: 'Reservations without valid warehouse or location scope.',
        formula: 'Active reservations with missing location join or warehouse scope.',
        queryHint: 'Derived from inventory_reservations.',
        drilldownTo: '/reservations',
        sources: ['/api/dashboard/inventory-integrity'],
        investigativeAction: { label: 'Review reservations', href: '/reservations' },
        correctiveAction: { label: 'Repair reservation scope', href: '/reservations' }
      },
      {
        key: 'missing-locations',
        label: 'Missing locations',
        severity: missingLocations > 0 ? 'action' : 'info',
        value: String(missingLocations),
        count: missingLocations,
        helper: 'Movement lines should never reference missing locations.',
        formula: 'Count of inventory movement lines with no location match.',
        queryHint: 'Derived from inventory_movement_lines left join locations.',
        drilldownTo: '/movements',
        sources: ['/api/dashboard/inventory-integrity'],
        investigativeAction: { label: 'Inspect movements', href: '/movements' },
        correctiveAction: { label: 'Repair location references', href: '/locations' }
      },
      {
        key: 'invalid-uom',
        label: 'Invalid UOM conversions',
        severity: invalidUom > 0 ? 'action' : 'info',
        value: String(invalidUom),
        count: invalidUom,
        helper: 'Conflicting UOM conversions can invalidate aggregated stock.',
        formula: 'Count of UOM normalization diagnostics across the scoped inventory snapshot.',
        queryHint: 'Derived from inventory snapshot normalization diagnostics.',
        drilldownTo: '/dashboard/resolution-queue?type=uom_inconsistent',
        sources: ['/api/dashboard/inventory-integrity'],
        investigativeAction: { label: 'Review UOM anomalies', href: '/dashboard/resolution-queue?type=uom_inconsistent' },
        correctiveAction: { label: 'Fix conversions', href: '/items' }
      },
      {
        key: 'valuation-mismatch',
        label: 'Valuation mismatches',
        severity: valuationMismatchCount > 0 ? 'watch' : 'info',
        value: String(valuationMismatchCount),
        count: valuationMismatchCount,
        helper: `Absolute value variance ${formatNumber(health.ledgerVsCostLayers.absValueVariance, 2)}.`,
        formula: 'Rows where ledger quantity variance implies a cost-layer value mismatch.',
        queryHint: 'Derived from inventory health ledger vs cost layers.',
        drilldownTo: '/admin/inventory-health',
        sources: ['/api/dashboard/inventory-integrity'],
        investigativeAction: { label: 'Review valuation variance', href: '/admin/inventory-health' },
        correctiveAction: { label: 'Reconcile layers', href: '/reports/inventory-valuation' }
      }
    ],
    rows: health.negativeInventory.topOffenders.map((row) => ({
      id: `${row.itemId}:${row.locationId}:${row.uom}`,
      label: row.itemSku ?? row.itemId,
      secondaryLabel: row.locationCode ?? row.locationId,
      value: `${formatNumber(row.onHand, 2)} ${row.uom}`,
      severity: 'critical',
      drilldownTo: withQuery('/movements', { itemId: row.itemId, locationId: row.locationId, type: 'negative_on_hand' })
    }))
  };
}

function computeInventoryRiskSection(params: {
  recommendations: Awaited<ReturnType<typeof computeReplenishmentRecommendations>>;
  coverageRows: CoverageRow[];
  demandStats: Map<string, DemandStat>;
}) : DashboardSignalSection {
  const itemsBelowSafetyStock = params.recommendations.filter((recommendation) => {
    const threshold =
      recommendation.policyType === 'q_rop'
        ? toFiniteNumber(recommendation.inputs.reorderPointQty)
        : toFiniteNumber(recommendation.inputs.orderUpToLevelQty);
    return threshold > 0 && toFiniteNumber(recommendation.inventory.inventoryPosition) < threshold;
  });
  const projected7 = params.coverageRows.filter((row) => row.daysOfSupply !== null && row.daysOfSupply < 7);
  const projected30 = params.coverageRows.filter((row) => row.daysOfSupply !== null && row.daysOfSupply < 30);
  const openShortages = params.coverageRows.filter((row) => row.available <= 0 && row.backordered > 0);
  const demandSpikeWarnings = params.coverageRows.filter((row) => {
    const stat = params.demandStats.get(row.itemId);
    if (!stat) return false;
    return stat.recent7Demand > 0 && stat.prior28Demand > 0 && stat.recent7Demand > stat.prior28Demand * 0.45;
  });
  const measurableCoverage = params.coverageRows.filter((row) => row.daysOfSupply !== null);
  const avgCoverage = measurableCoverage.length > 0
    ? measurableCoverage.reduce((sum, row) => sum + (row.daysOfSupply ?? 0), 0) / measurableCoverage.length
    : null;

  return {
    key: 'inventoryRisk',
    title: 'Inventory risk',
    description: 'Near-term stock failure predictors derived from coverage, reorder policies, and demand acceleration.',
    metrics: [
      {
        key: 'below-safety-stock',
        label: 'Items below safety stock',
        severity: itemsBelowSafetyStock.length > 0 ? 'action' : 'info',
        value: String(itemsBelowSafetyStock.length),
        count: itemsBelowSafetyStock.length,
        helper: 'Inventory position is below the policy threshold.',
        formula: 'Count of active replenishment scopes where inventory position < reorder threshold.',
        queryHint: 'Derived from replenishment policies and recommendations.',
        drilldownTo: '/items',
        sources: ['/api/dashboard/inventory-risk'],
        investigativeAction: { label: 'Review at-risk items', href: '/items' },
        correctiveAction: { label: 'Create PO', href: '/purchase-orders/new' }
      },
      {
        key: 'projected-7d-stockouts',
        label: 'Projected stockouts (7d)',
        severity: projected7.length > 0 ? 'critical' : 'info',
        value: String(projected7.length),
        count: projected7.length,
        helper: 'Days of supply below seven based on available stock and observed demand.',
        formula: 'Count of items where DaysOfSupply < 7.',
        queryHint: 'Derived from coverage rows and daily demand averages.',
        drilldownTo: '/items',
        sources: ['/api/dashboard/inventory-risk'],
        investigativeAction: { label: 'Review low coverage', href: '/items' },
        correctiveAction: { label: 'Expedite replenishment', href: '/purchase-orders/new' }
      },
      {
        key: 'projected-30d-stockouts',
        label: 'Projected stockouts (30d)',
        severity: projected30.length > 0 ? 'watch' : 'info',
        value: String(projected30.length),
        count: projected30.length,
        helper: 'Coverage below a thirty-day horizon.',
        formula: 'Count of items where DaysOfSupply < 30.',
        queryHint: 'Derived from coverage rows and demand averages.',
        drilldownTo: '/items',
        sources: ['/api/dashboard/inventory-risk'],
        investigativeAction: { label: 'Review coverage', href: '/items' },
        correctiveAction: { label: 'Plan replenishment', href: '/items' }
      },
      {
        key: 'open-shortages',
        label: 'Open shortages',
        severity: openShortages.length > 0 ? 'action' : 'info',
        value: String(openShortages.length),
        count: openShortages.length,
        helper: 'Backordered demand with no available stock.',
        formula: 'Count of item scopes where available <= 0 and backordered > 0.',
        queryHint: 'Derived from inventory snapshot summary.',
        drilldownTo: '/dashboard/resolution-queue?type=availability_breach',
        sources: ['/api/dashboard/inventory-risk'],
        investigativeAction: { label: 'View shortages', href: '/dashboard/resolution-queue?type=availability_breach' },
        correctiveAction: { label: 'Adjust or replenish', href: '/adjustments/new' }
      },
      {
        key: 'demand-spike-warnings',
        label: 'Demand spike warnings',
        severity: demandSpikeWarnings.length > 0 ? 'watch' : 'info',
        value: String(demandSpikeWarnings.length),
        count: demandSpikeWarnings.length,
        helper: 'Recent demand is materially higher than the prior baseline.',
        formula: 'Count of items where recent 7-day demand materially exceeds prior 28-day baseline.',
        queryHint: 'Derived from sales order daily demand history.',
        drilldownTo: '/items',
        sources: ['/api/dashboard/inventory-risk'],
        investigativeAction: { label: 'Review demand changes', href: '/items' },
        correctiveAction: { label: 'Raise policy levels', href: '/items' }
      },
      {
        key: 'avg-coverage',
        label: 'Average coverage',
        severity: avgCoverage !== null && avgCoverage < 14 ? 'watch' : 'info',
        value: formatDays(avgCoverage),
        helper: 'Average days of supply across items with measurable demand.',
        formula: 'DaysOfSupply = available inventory / average daily demand.',
        queryHint: 'Derived from coverage rows.',
        drilldownTo: '/api/dashboard/inventory-coverage',
        sources: ['/api/dashboard/inventory-risk'],
        investigativeAction: { label: 'Review coverage', href: '/dashboard' },
        correctiveAction: { label: 'Tune replenishment', href: '/items' }
      }
    ],
    rows: projected7.slice(0, 10).map((row) => ({
      id: row.itemId,
      label: row.itemLabel,
      value: formatDays(row.daysOfSupply),
      severity: 'critical',
      drilldownTo: row.drilldownTo
    }))
  };
}

async function computeFlowReliabilitySection(params: {
  tenantId: string;
  windowStart: string;
  windowEnd: string;
}) : Promise<DashboardSignalSection> {
  const [salesFill, workOrderProgress, lateReceipts] = await Promise.all([
    getSalesOrderFillPerformance({
      tenantId: params.tenantId,
      startDate: params.windowStart,
      endDate: params.windowEnd,
      includeFullyShipped: true,
      limit: 500
    }),
    getWorkOrderProgress({
      tenantId: params.tenantId,
      startDate: params.windowStart,
      endDate: params.windowEnd,
      includeCompleted: false,
      limit: 500
    }),
    getLeadTimeReliability({
      tenantId: params.tenantId,
      startDate: params.windowStart,
      endDate: params.windowEnd,
      limit: 250
    })
  ]);

  const lateShipments = salesFill.data.filter((row) => row.isLate);
  const lateReceiptCount = lateReceipts.data.reduce((sum, row) => sum + row.lateReceipts, 0);
  const blockedWorkOrders = workOrderProgress.data.filter((row) => row.isLate || ['draft', 'released'].includes(String(row.status).toLowerCase()));
  const materialShortages = blockedWorkOrders.filter((row) => row.percentComplete <= 0);
  const unfulfilledDemand = salesFill.data.filter((row) => row.outstandingLines > 0);

  return {
    key: 'flowReliability',
    title: 'Operational flow',
    description: 'How reliably material and order flow moves through inbound, production, and outbound operations.',
    metrics: [
      {
        key: 'late-shipments',
        label: 'Late shipments',
        severity: lateShipments.length > 0 ? 'action' : 'info',
        value: String(lateShipments.length),
        count: lateShipments.length,
        helper: 'Sales orders that missed requested ship date.',
        formula: 'Count of sales orders where shipped date > requested ship date or requested ship date is overdue.',
        queryHint: 'Derived from sales order fill performance report.',
        drilldownTo: '/reports/sales-order-fill?onlyLate=true',
        sources: ['/api/dashboard/flow-reliability'],
        investigativeAction: { label: 'Review late orders', href: '/reports/sales-order-fill?onlyLate=true' },
        correctiveAction: { label: 'Investigate movements', href: '/movements' }
      },
      {
        key: 'late-receipts',
        label: 'Late receipts',
        severity: lateReceiptCount > 0 ? 'watch' : 'info',
        value: String(lateReceiptCount),
        count: lateReceiptCount,
        helper: 'Supplier receipts landed after promised date.',
        formula: 'Sum of late receipt events in the selected window.',
        queryHint: 'Derived from purchase order receipts vs expected date.',
        drilldownTo: '/purchase-orders',
        sources: ['/api/dashboard/flow-reliability'],
        investigativeAction: { label: 'Review receipts', href: '/purchase-orders' },
        correctiveAction: { label: 'Expedite suppliers', href: '/purchase-orders' }
      },
      {
        key: 'blocked-work-orders',
        label: 'Blocked work orders',
        severity: blockedWorkOrders.length > 0 ? 'action' : 'info',
        value: String(blockedWorkOrders.length),
        count: blockedWorkOrders.length,
        helper: 'Open work orders that are late or not progressing.',
        formula: 'Count of open work orders that are late or remain at 0% completion.',
        queryHint: 'Derived from work order progress report.',
        drilldownTo: '/reports/work-order-progress',
        sources: ['/api/dashboard/flow-reliability'],
        investigativeAction: { label: 'Review work orders', href: '/reports/work-order-progress' },
        correctiveAction: { label: 'Prioritize execution', href: '/work-orders' }
      },
      {
        key: 'material-shortages',
        label: 'Material shortages',
        severity: materialShortages.length > 0 ? 'action' : 'info',
        value: String(materialShortages.length),
        count: materialShortages.length,
        helper: 'Late work orders with no measurable progress.',
        formula: 'Subset of blocked work orders with 0% completion.',
        queryHint: 'Derived from work order progress report.',
        drilldownTo: '/reports/work-order-progress',
        sources: ['/api/dashboard/flow-reliability'],
        investigativeAction: { label: 'Review shortages', href: '/reports/work-order-progress' },
        correctiveAction: { label: 'Issue materials', href: '/work-orders' }
      },
      {
        key: 'unfulfilled-demand',
        label: 'Unfulfilled demand',
        severity: unfulfilledDemand.length > 0 ? 'watch' : 'info',
        value: String(unfulfilledDemand.length),
        count: unfulfilledDemand.length,
        helper: 'Sales orders with outstanding lines.',
        formula: 'Count of sales orders where outstanding lines > 0.',
        queryHint: 'Derived from sales order fill performance report.',
        drilldownTo: '/reports/sales-order-fill',
        sources: ['/api/dashboard/flow-reliability'],
        investigativeAction: { label: 'Review fill gaps', href: '/reports/sales-order-fill' },
        correctiveAction: { label: 'Adjust stock', href: '/adjustments/new' }
      }
    ],
    rows: lateShipments.slice(0, 10).map((row) => ({
      id: row.salesOrderId,
      label: row.soNumber,
      secondaryLabel: row.customerName,
      value: row.requestedDate ?? 'Late',
      severity: 'action',
      drilldownTo: '/reports/sales-order-fill?onlyLate=true'
    }))
  };
}

async function computePerformanceSection(params: {
  tenantId: string;
  windowDays: number;
  windowStart: string;
  windowEnd: string;
}) : Promise<DashboardSignalSection> {
  const [fillRate, turnsRows, salesFill, productionTrend] = await Promise.all([
    computeFulfillmentFillRate(params.tenantId, { from: params.windowStart, to: params.windowEnd }),
    MetricsService.getTurnsAndDOI(params.tenantId, new Date(params.windowStart), new Date(params.windowEnd)),
    getSalesOrderFillPerformance({
      tenantId: params.tenantId,
      startDate: params.windowStart,
      endDate: params.windowEnd,
      includeFullyShipped: true,
      limit: 500
    }),
    getProductionVolumeTrend(params.tenantId, { dateFrom: params.windowStart, dateTo: params.windowEnd })
  ]);

  const measurableTurns = turnsRows.filter((row) => row.turns !== null);
  const avgTurns = measurableTurns.length > 0 ? measurableTurns.reduce((sum, row) => sum + (row.turns ?? 0), 0) / measurableTurns.length : null;
  const avgCycleTime = salesFill.data.filter((row) => row.daysToShip !== null).length > 0
    ? salesFill.data.filter((row) => row.daysToShip !== null).reduce((sum, row) => sum + (row.daysToShip ?? 0), 0) /
      salesFill.data.filter((row) => row.daysToShip !== null).length
    : null;
  const totalProduced = productionTrend.reduce((sum, row) => sum + row.totalQuantity, 0);
  const throughputRate = params.windowDays > 0 ? totalProduced / params.windowDays : 0;
  const onTimeShipmentRate =
    salesFill.data.length > 0
      ? salesFill.data.filter((row) => row.onTimeShipment).length / salesFill.data.length
      : null;

  return {
    key: 'performanceMetrics',
    title: 'Performance metrics',
    description: 'Throughput and service-level metrics that summarize how quickly inventory converts into fulfilled demand.',
    metrics: [
      {
        key: 'fill-rate',
        label: 'Fill rate',
        severity: fillRate.fillRate !== null && fillRate.fillRate < 0.95 ? 'watch' : 'info',
        value: formatPercent(fillRate.fillRate),
        helper: 'Measured shipped quantity divided by requested quantity.',
        formula: 'FillRate = shippedQty / requestedQty.',
        queryHint: 'Derived from posted shipment lines.',
        drilldownTo: '/shipments',
        sources: ['/api/dashboard/performance-metrics'],
        investigativeAction: { label: 'Review shipments', href: '/shipments' },
        correctiveAction: { label: 'Address shortages', href: '/dashboard/resolution-queue?type=availability_breach' }
      },
      {
        key: 'inventory-turns',
        label: 'Inventory turns',
        severity: avgTurns !== null && avgTurns < 1 ? 'watch' : 'info',
        value: avgTurns !== null ? formatNumber(avgTurns, 2) : 'Not measurable',
        helper: 'Average turns across items with measurable movement.',
        formula: 'Turns = total outflow / average on-hand over the window.',
        queryHint: 'Derived from inventory movement outflow and on-hand samples.',
        drilldownTo: '/reports/inventory-velocity',
        sources: ['/api/dashboard/performance-metrics'],
        investigativeAction: { label: 'Review velocity', href: '/reports/inventory-velocity' },
        correctiveAction: { label: 'Reduce excess stock', href: '/reports/inventory-velocity' }
      },
      {
        key: 'order-cycle-time',
        label: 'Order cycle time',
        severity: avgCycleTime !== null && avgCycleTime > 7 ? 'watch' : 'info',
        value: avgCycleTime !== null ? `${formatNumber(avgCycleTime, 1)} days` : 'Not measurable',
        helper: 'Average days from sales order to shipment.',
        formula: 'Average(shipped date - order date).',
        queryHint: 'Derived from sales order fill performance.',
        drilldownTo: '/reports/sales-order-fill',
        sources: ['/api/dashboard/performance-metrics'],
        investigativeAction: { label: 'Review order flow', href: '/reports/sales-order-fill' },
        correctiveAction: { label: 'Prioritize fulfillment', href: '/shipments' }
      },
      {
        key: 'throughput-rate',
        label: 'Throughput rate',
        severity: throughputRate <= 0 ? 'watch' : 'info',
        value: `${formatNumber(throughputRate, 1)} / day`,
        helper: 'Average completed work-order quantity per day in the selected window.',
        formula: 'ThroughputRate = total completed production quantity / window days.',
        queryHint: 'Derived from completed work orders.',
        drilldownTo: '/production-overview',
        sources: ['/api/dashboard/performance-metrics'],
        investigativeAction: { label: 'Review production', href: '/production-overview' },
        correctiveAction: { label: 'Unblock WIP', href: '/reports/work-order-progress' }
      },
      {
        key: 'on-time-shipment-rate',
        label: 'On-time shipment rate',
        severity: onTimeShipmentRate !== null && onTimeShipmentRate < 0.95 ? 'watch' : 'info',
        value: formatPercent(onTimeShipmentRate),
        helper: 'Share of sales orders shipped on or before requested ship date.',
        formula: 'OnTimeShipmentRate = on-time shipped orders / measurable shipped orders.',
        queryHint: 'Derived from sales order fill performance.',
        drilldownTo: '/reports/sales-order-fill',
        sources: ['/api/dashboard/performance-metrics'],
        investigativeAction: { label: 'Review lateness', href: '/reports/sales-order-fill?onlyLate=true' },
        correctiveAction: { label: 'Prioritize shipments', href: '/shipments' }
      }
    ],
    rows: []
  };
}

async function computeSupplyReliabilitySection(params: {
  tenantId: string;
  windowStart: string;
  windowEnd: string;
}) : Promise<DashboardSignalSection> {
  const [leadTimeReliability, vendorFillRate, supplierScorecards, latePurchaseOrders] = await Promise.all([
    getLeadTimeReliability({ tenantId: params.tenantId, startDate: params.windowStart, endDate: params.windowEnd, limit: 250 }),
    getVendorFillRate({ tenantId: params.tenantId, startDate: params.windowStart, endDate: params.windowEnd, limit: 250 }),
    getSupplierScorecards(params.tenantId, { startDate: params.windowStart, endDate: params.windowEnd, limit: 250 }),
    query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM purchase_orders
        WHERE tenant_id = $1
          AND status IN ('approved', 'partially_received')
          AND expected_date IS NOT NULL
          AND expected_date < CURRENT_DATE`,
      [params.tenantId]
    )
  ]);

  const reliabilityByVendor = new Map(leadTimeReliability.data.map((row) => [row.vendorId, row]));
  const fillRateByVendor = new Map(vendorFillRate.data.map((row) => [row.vendorId, row]));
  const scoredSuppliers = supplierScorecards.map((scorecard) => {
    const lead = reliabilityByVendor.get(scorecard.vendorId);
    const fill = fillRateByVendor.get(scorecard.vendorId);
    const leadReliability = (lead?.reliabilityPercent ?? 0) / 100;
    const fillReliability = (fill?.fillRatePercent ?? 0) / 100;
    const qualityReliability = scorecard.qualityRate / 100;
    const reliabilityScore = roundQuantity(leadReliability * 0.5 + fillReliability * 0.2 + qualityReliability * 0.3);
    return {
      scorecard,
      leadVariance: Math.abs((lead?.avgLeadTimeDays ?? 0) - (lead?.avgPromisedLeadTimeDays ?? 0)),
      fillRate: fillReliability,
      reliabilityScore
    };
  }).sort((left, right) => left.reliabilityScore - right.reliabilityScore);

  const avgLeadVariance =
    scoredSuppliers.length > 0 ? scoredSuppliers.reduce((sum, row) => sum + row.leadVariance, 0) / scoredSuppliers.length : 0;
  const avgSupplierFillRate =
    scoredSuppliers.length > 0 ? scoredSuppliers.reduce((sum, row) => sum + row.fillRate, 0) / scoredSuppliers.length : null;
  const avgReliabilityScore =
    scoredSuppliers.length > 0 ? scoredSuppliers.reduce((sum, row) => sum + row.reliabilityScore, 0) / scoredSuppliers.length : null;
  const latePoCount = toFiniteNumber(latePurchaseOrders.rows[0]?.count);

  return {
    key: 'supplyReliability',
    title: 'Supply reliability',
    description: 'Supplier delivery, fill, and quality trends that predict inbound disruption before stockouts occur.',
    metrics: [
      {
        key: 'supplier-lead-variance',
        label: 'Lead time variance',
        severity: avgLeadVariance > 2 ? 'watch' : 'info',
        value: `${formatNumber(avgLeadVariance, 1)} days`,
        helper: 'Average gap between actual and promised supplier lead times.',
        formula: 'Mean |actual lead time - promised lead time| across vendors.',
        queryHint: 'Derived from purchase order receipts vs purchase orders.',
        drilldownTo: '/supplier-scorecards',
        sources: ['/api/dashboard/supply-reliability'],
        investigativeAction: { label: 'Review suppliers', href: '/supplier-scorecards' },
        correctiveAction: { label: 'Adjust lead times', href: '/purchase-orders' }
      },
      {
        key: 'late-purchase-orders',
        label: 'Late purchase orders',
        severity: latePoCount > 0 ? 'watch' : 'info',
        value: String(latePoCount),
        count: latePoCount,
        helper: 'Open purchase orders past expected date.',
        formula: 'Count of approved or partially received purchase orders with expectedDate < today.',
        queryHint: 'Derived from purchase_orders.expected_date.',
        drilldownTo: '/reports/open-po-aging',
        sources: ['/api/dashboard/supply-reliability'],
        investigativeAction: { label: 'Review PO aging', href: '/reports/open-po-aging' },
        correctiveAction: { label: 'Expedite suppliers', href: '/purchase-orders' }
      },
      {
        key: 'supplier-fill-rate',
        label: 'Supplier fill rate',
        severity: avgSupplierFillRate !== null && avgSupplierFillRate < 0.95 ? 'watch' : 'info',
        value: formatPercent(avgSupplierFillRate),
        helper: 'Average received quantity divided by ordered quantity across suppliers.',
        formula: 'SupplierFillRate = received / ordered.',
        queryHint: 'Derived from vendor fill rate service.',
        drilldownTo: '/supplier-scorecards',
        sources: ['/api/dashboard/supply-reliability'],
        investigativeAction: { label: 'Review fill performance', href: '/supplier-scorecards' },
        correctiveAction: { label: 'Raise supplier issue', href: '/purchase-orders' }
      },
      {
        key: 'supplier-reliability-score',
        label: 'Supplier reliability score',
        severity: avgReliabilityScore !== null && avgReliabilityScore < 0.85 ? 'watch' : 'info',
        value: avgReliabilityScore !== null ? formatPercent(avgReliabilityScore) : 'Not measurable',
        helper: 'Weighted score using on-time delivery, quality, and fill rate.',
        formula: '0.5 * on-time delivery + 0.3 * quality + 0.2 * fill rate.',
        queryHint: 'Derived from supplier scorecard + lead time + fill-rate services.',
        drilldownTo: '/supplier-scorecards',
        sources: ['/api/dashboard/supply-reliability'],
        investigativeAction: { label: 'Review low-scoring suppliers', href: '/supplier-scorecards' },
        correctiveAction: { label: 'Adjust sourcing plan', href: '/purchase-orders' }
      }
    ],
    rows: scoredSuppliers.slice(0, 10).map(({ scorecard, reliabilityScore }) => ({
      id: scorecard.vendorId,
      label: `${scorecard.vendorCode} - ${scorecard.vendorName}`,
      value: formatPercent(reliabilityScore),
      severity: reliabilityScore < 0.8 ? 'action' : 'watch',
      drilldownTo: `/supplier-scorecards/${scorecard.vendorId}`
    }))
  };
}

async function computeExcessInventorySection(params: {
  tenantId: string;
  coverageRows: CoverageRow[];
}) : Promise<DashboardSignalSection> {
  const [slowDeadStock, inventoryAging] = await Promise.all([
    MetricsService.getSlowDeadStock(params.tenantId, 90, 180),
    MetricsService.getInventoryAging(params.tenantId)
  ]);
  const slowMoving = slowDeadStock.filter((row) => row.isSlowMoving);
  const deadStock = slowDeadStock.filter((row) => row.isDeadStock);
  const agingOver90 = inventoryAging.filter((row) => row.qty_over_90_days > 0);
  const excessCoverage = params.coverageRows.filter((row) => row.bucket === 'excess');

  return {
    key: 'excessInventory',
    title: 'Excess inventory',
    description: 'Slow-moving and over-covered stock that ties up capital and masks replenishment priorities.',
    metrics: [
      {
        key: 'slow-moving',
        label: 'Slow-moving items',
        severity: slowMoving.length > 0 ? 'watch' : 'info',
        value: String(slowMoving.length),
        count: slowMoving.length,
        helper: 'No recent movement beyond the slow-moving threshold.',
        formula: 'Items where daysSinceLastMovement >= 90 and onHand > 0.',
        queryHint: 'Derived from MetricsService slow/dead stock.',
        drilldownTo: '/metrics/slow-dead-stock',
        sources: ['/api/dashboard/excess-inventory'],
        investigativeAction: { label: 'Review slow movers', href: '/metrics/slow-dead-stock' },
        correctiveAction: { label: 'Review replenishment policy', href: '/items' }
      },
      {
        key: 'dead-stock',
        label: 'Dead stock',
        severity: deadStock.length > 0 ? 'action' : 'info',
        value: String(deadStock.length),
        count: deadStock.length,
        helper: 'No recent movement beyond the dead-stock threshold.',
        formula: 'Items where daysSinceLastMovement >= 180 and onHand > 0.',
        queryHint: 'Derived from MetricsService slow/dead stock.',
        drilldownTo: '/metrics/slow-dead-stock',
        sources: ['/api/dashboard/excess-inventory'],
        investigativeAction: { label: 'Review dead stock', href: '/metrics/slow-dead-stock' },
        correctiveAction: { label: 'Disposition excess', href: '/adjustments/new' }
      },
      {
        key: 'inventory-aging',
        label: 'Aged inventory lots',
        severity: agingOver90.length > 0 ? 'watch' : 'info',
        value: String(agingOver90.length),
        count: agingOver90.length,
        helper: 'Inventory buckets with quantity older than 90 days.',
        formula: 'Count of inventory aging rows where qty_over_90_days > 0.',
        queryHint: 'Derived from inventory aging report.',
        drilldownTo: '/metrics/inventory-aging',
        sources: ['/api/dashboard/excess-inventory'],
        investigativeAction: { label: 'Review aging', href: '/metrics/inventory-aging' },
        correctiveAction: { label: 'Disposition stock', href: '/adjustments/new' }
      },
      {
        key: 'excess-coverage',
        label: 'Excess coverage items',
        severity: excessCoverage.length > 0 ? 'watch' : 'info',
        value: String(excessCoverage.length),
        count: excessCoverage.length,
        helper: 'Items with more than 120 days of supply.',
        formula: 'Count of items where DaysOfSupply > 120.',
        queryHint: 'Derived from coverage rows.',
        drilldownTo: '/api/dashboard/inventory-coverage',
        sources: ['/api/dashboard/excess-inventory'],
        investigativeAction: { label: 'Review excess coverage', href: '/dashboard' },
        correctiveAction: { label: 'Reduce ordering', href: '/items' }
      }
    ],
    rows: excessCoverage.slice(0, 10).map((row) => ({
      id: row.itemId,
      label: row.itemLabel,
      value: formatDays(row.daysOfSupply),
      severity: 'watch',
      drilldownTo: row.drilldownTo
    }))
  };
}

function computeCoverageSection(params: { coverageRows: CoverageRow[] }) : DashboardSignalSection {
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

function computeDemandVolatilitySection(params: {
  demandStats: Map<string, DemandStat>;
  items: ItemRecord[];
}) : DashboardSignalSection {
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
        severity: 'watch' as SignalSeverity,
        drilldownTo: `/items/${row.itemId}`
      };
    })
  };
}

function computeForecastAccuracySection(params: { forecast: { forecastQty: number; actualQty: number; mape: number; bias: number } }) : DashboardSignalSection {
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

async function loadScopedInventorySummary(tenantId: string, warehouseId?: string) {
  const warehouses = await listWarehouseScope(tenantId, warehouseId);
  const snapshots = await Promise.all(
    warehouses.map((warehouse) =>
      getInventorySnapshotSummaryDetailed(tenantId, {
        warehouseId: warehouse.id,
        limit: 5000,
        offset: 0
      })
    )
  );

  return {
    warehouses,
    data: snapshots.flatMap((snapshot) => snapshot.data),
    diagnostics: snapshots.flatMap((snapshot) => snapshot.diagnostics.uomNormalizationDiagnostics)
  };
}

async function computeOverviewInternal(tenantId: string, options: InventorySignalsOptions = {}): Promise<InventoryIntelligenceOverview> {
  const windowDays = Math.max(30, options.windowDays ?? 90);
  const [inventorySummary, items, locations, purchaseOrders, workOrders] = await Promise.all([
    loadScopedInventorySummary(tenantId, options.warehouseId),
    loadItems(tenantId),
    loadLocations(tenantId),
    loadPurchaseOrders(tenantId, windowDays),
    loadWorkOrders(tenantId, windowDays)
  ]);

  const asOf = new Date().toISOString();
  const windowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const itemMetrics = await getItemMetrics(tenantId, items.map((item) => item.id), windowDays);
  const [replenishmentPoliciesResult, replenishmentRecommendations, fillRate, demandStats, forecastMetrics] = await Promise.all([
    listReplenishmentPolicies(tenantId, 2000, 0),
    computeReplenishmentRecommendations(tenantId, 2000, 0),
    computeFulfillmentFillRate(tenantId, { from: windowStart, to: asOf }),
    loadDemandStats(tenantId, windowDays),
    loadForecastAccuracyMetrics(tenantId, windowDays)
  ]);

  const replenishmentPolicies = replenishmentPoliciesResult;
  const policyScopeSet = new Set<string>();
  replenishmentPolicies.forEach((policy) => {
    if (!policy.siteLocationId) return;
    if (String(policy.status ?? '').toLowerCase() === 'inactive') return;
    policyScopeSet.add(`${policy.itemId}:${policy.siteLocationId}`);
  });

  const coverage = buildMonitoringCoverage({
    inventoryRows: inventorySummary.data,
    policies: replenishmentPolicies,
    items,
    itemMetrics,
    fillRate
  });

  const coverageRows = buildCoverageRows({
    inventoryRows: inventorySummary.data,
    items,
    demandStats
  });

  const exceptions = buildExceptionRows({
    asOf,
    inventoryRows: inventorySummary.data,
    uomInconsistencies: inventorySummary.diagnostics,
    recommendations: replenishmentRecommendations,
    policyScopeSet,
    purchaseOrders,
    workOrders,
    items,
    locations,
    itemMetrics
  });

  const asOfLabel = formatDateTime(asOf);
  const uomDiagnosticGroupBuckets = bucketUomDiagnostics(inventorySummary.diagnostics);
  const sections: InventoryIntelligenceOverview['sections'] = {
    inventoryIntegrity: await computeInventoryIntegritySection({
      tenantId,
      inventoryRows: inventorySummary.data,
      uomDiagnostics: inventorySummary.diagnostics,
      asOf
    }),
    inventoryRisk: computeInventoryRiskSection({
      recommendations: replenishmentRecommendations,
      coverageRows,
      demandStats
    }),
    inventoryCoverage: computeCoverageSection({ coverageRows }),
    flowReliability: await computeFlowReliabilitySection({
      tenantId,
      windowStart,
      windowEnd: asOf
    }),
    supplyReliability: await computeSupplyReliabilitySection({
      tenantId,
      windowStart,
      windowEnd: asOf
    }),
    excessInventory: await computeExcessInventorySection({
      tenantId,
      coverageRows
    }),
    performanceMetrics: await computePerformanceSection({
      tenantId,
      windowDays,
      windowStart,
      windowEnd: asOf
    }),
    systemHealth: await computeSystemReadinessSection({
      tenantId,
      uomDiagnostics: inventorySummary.diagnostics
    }),
    demandVolatility: computeDemandVolatilitySection({
      demandStats,
      items
    }),
    forecastAccuracy: computeForecastAccuracySection({
      forecast: forecastMetrics
    })
  };

  const scopeLabel =
    inventorySummary.warehouses.length === 1
      ? inventorySummary.warehouses[0].code ?? inventorySummary.warehouses[0].name ?? inventorySummary.warehouses[0].id
      : 'All warehouses';

  return {
    asOf,
    asOfLabel,
    warehouseScope: {
      ids: inventorySummary.warehouses.map((warehouse) => warehouse.id),
      label: scopeLabel
    },
    warehouses: inventorySummary.warehouses,
    coverage,
    exceptions,
    signals: buildLegacyDashboardSignals({
      exceptions,
      fillRate,
      asOfLabel
    }),
    uomNormalizationDiagnostics: inventorySummary.diagnostics,
    uomDiagnosticGroupBuckets,
    sections,
    coverageMatrix: buildCoverageMatrix()
  };
}

async function getCached<T>(
  tenantId: string,
  cacheKey: string,
  params: Record<string, unknown>,
  forceRefresh: boolean,
  compute: () => Promise<T>
) {
  if (!forceRefresh) {
    const cached = await cacheAdapter.get<T>(tenantId, cacheKey, params);
    if (cached) {
      return cached;
    }
  }
  const value = await compute();
  await cacheAdapter.set(tenantId, cacheKey, value, CACHE_TTL_SECONDS, params);
  return value;
}

export async function getInventoryIntelligenceOverview(
  tenantId: string,
  options: InventorySignalsOptions = {}
): Promise<InventoryIntelligenceOverview> {
  const cacheParams = {
    warehouseId: options.warehouseId ?? 'all',
    windowDays: options.windowDays ?? 90
  };
  return getCached(
    tenantId,
    'inventory_intelligence_overview',
    cacheParams,
    Boolean(options.forceRefresh),
    () => computeOverviewInternal(tenantId, options)
  );
}

export async function getInventoryIntegritySignals(tenantId: string, options: InventorySignalsOptions = {}) {
  const overview = await getInventoryIntelligenceOverview(tenantId, options);
  return overview.sections.inventoryIntegrity;
}

export async function getInventoryRiskSignals(tenantId: string, options: InventorySignalsOptions = {}) {
  const overview = await getInventoryIntelligenceOverview(tenantId, options);
  return overview.sections.inventoryRisk;
}

export async function getInventoryCoverageSignals(tenantId: string, options: InventorySignalsOptions = {}) {
  const overview = await getInventoryIntelligenceOverview(tenantId, options);
  return overview.sections.inventoryCoverage;
}

export async function getOperationalFlowSignals(tenantId: string, options: InventorySignalsOptions = {}) {
  const overview = await getInventoryIntelligenceOverview(tenantId, options);
  return overview.sections.flowReliability;
}

export async function getSupplyReliabilitySignals(tenantId: string, options: InventorySignalsOptions = {}) {
  const overview = await getInventoryIntelligenceOverview(tenantId, options);
  return overview.sections.supplyReliability;
}

export async function getExcessInventorySignals(tenantId: string, options: InventorySignalsOptions = {}) {
  const overview = await getInventoryIntelligenceOverview(tenantId, options);
  return overview.sections.excessInventory;
}

export async function getDemandVolatilitySignals(tenantId: string, options: InventorySignalsOptions = {}) {
  const overview = await getInventoryIntelligenceOverview(tenantId, options);
  return overview.sections.demandVolatility;
}

export async function getForecastAccuracySignals(tenantId: string, options: InventorySignalsOptions = {}) {
  const overview = await getInventoryIntelligenceOverview(tenantId, options);
  return overview.sections.forecastAccuracy;
}

export async function getSystemReadinessSignals(tenantId: string, options: InventorySignalsOptions = {}) {
  const overview = await getInventoryIntelligenceOverview(tenantId, options);
  return overview.sections.systemHealth;
}

export async function getPerformanceMetricSignals(tenantId: string, options: InventorySignalsOptions = {}) {
  const overview = await getInventoryIntelligenceOverview(tenantId, options);
  return overview.sections.performanceMetrics;
}

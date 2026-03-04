import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../db';
import { getInventorySnapshotSummaryDetailed } from './inventorySnapshot.service';
import {
  computeFulfillmentFillRate,
  computeReplenishmentRecommendations,
  listReplenishmentPolicies,
} from './planning.service';
import { listPurchaseOrders } from './purchaseOrders.service';
import { listWorkOrders } from './workOrders.service';
import { getItemMetrics } from './itemMetrics.service';
import { mapUomStatusToRouting } from './uomSeverityRouting.service';
import type { UomDiagnosticSeverity, UomNormalizationStatus } from '../types/uomNormalization';

type DashboardKpiComputeParams = {
  warehouseId?: string;
  windowDays?: number;
  idempotencyKey?: string;
};

export type DashboardKpiComputeResult = {
  runId: string;
  reused: boolean;
  computedAt: string;
  asOf: string;
  warehouseId: string;
  runtimeMs: number;
  runtimeEstimateSeconds: number;
  snapshotsWritten: number;
};

type DashboardSnapshot = {
  kpiName: string;
  value: number | null;
  units: string;
  dimensions?: Record<string, unknown>;
};

const DEFAULT_WINDOW_DAYS = 90;
const DEFAULT_RUNTIME_ESTIMATE_SECONDS = 20;
const ENABLE_DASHBOARD_UOM_INCONSISTENT =
  process.env.ENABLE_DASHBOARD_UOM_INCONSISTENT === 'true';

export type UomDiagnosticGroupBucketCounts = {
  actionGroups: number;
  watchGroups: number;
  totalGroups: number;
};

type UomDiagnosticGroupInput = {
  itemId: string;
  locationId: string;
  status?: UomNormalizationStatus;
  severity?: UomDiagnosticSeverity;
};

function severityRank(severity: UomDiagnosticSeverity) {
  switch (severity) {
    case 'critical':
      return 4;
    case 'action':
      return 3;
    case 'watch':
      return 2;
    case 'info':
    default:
      return 1;
  }
}

function resolveDiagnosticSeverity(input: UomDiagnosticGroupInput): UomDiagnosticSeverity {
  if (input.status) {
    return mapUomStatusToRouting(input.status).severity;
  }
  return input.severity ?? 'action';
}

export function summarizeDistinctUomDiagnosticGroups(
  diagnostics: UomDiagnosticGroupInput[]
): UomDiagnosticGroupBucketCounts {
  const byGroup = new Map<string, UomDiagnosticSeverity>();
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.itemId}:${diagnostic.locationId}`;
    const severity = resolveDiagnosticSeverity(diagnostic);
    const existing = byGroup.get(key);
    if (!existing || severityRank(severity) > severityRank(existing)) {
      byGroup.set(key, severity);
    }
  }

  let actionGroups = 0;
  let watchGroups = 0;
  for (const severity of byGroup.values()) {
    if (severityRank(severity) >= severityRank('action')) {
      actionGroups += 1;
      continue;
    }
    if (severity === 'watch') {
      watchGroups += 1;
    }
  }

  return {
    actionGroups,
    watchGroups,
    totalGroups: byGroup.size
  };
}

export function selectUomDiagnosticsForKpi(input: {
  uomNormalizationDiagnostics?: UomDiagnosticGroupInput[];
  uomInconsistencies?: UomDiagnosticGroupInput[];
}) {
  if ((input.uomNormalizationDiagnostics?.length ?? 0) > 0) {
    return input.uomNormalizationDiagnostics ?? [];
  }
  return input.uomInconsistencies ?? [];
}

function toFiniteNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function daysSince(value?: string | null): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return Number.POSITIVE_INFINITY;
  return Math.floor((Date.now() - parsed.getTime()) / (24 * 60 * 60 * 1000));
}

function computeAvailableQty(row: {
  onHand: number;
  reserved: number;
  held: number;
  rejected: number;
}) {
  return (
    toFiniteNumber(row.onHand) -
    toFiniteNumber(row.reserved) -
    toFiniteNumber(row.held) -
    toFiniteNumber(row.rejected)
  );
}

function buildFingerprint(params: {
  tenantId: string;
  warehouseId: string;
  windowDays: number;
  idempotencyScope: string;
}) {
  return [
    'dashboard-v2',
    params.tenantId,
    params.warehouseId,
    `window:${params.windowDays}`,
    `scope:${params.idempotencyScope}`,
  ].join('|');
}

type DashboardRunNote = {
  source: 'dashboard_compute';
  fingerprint: string;
  warehouseId?: string;
  windowDays?: number;
  idempotencyScope?: string;
  runtimeMs?: number;
  readOnlyInventory: true;
};

function parseDashboardRunNote(note: string | null): DashboardRunNote | null {
  if (!note) return null;
  try {
    const parsed = JSON.parse(note) as DashboardRunNote;
    if (parsed?.source !== 'dashboard_compute') return null;
    if (typeof parsed?.fingerprint !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function resolveWarehouseScope(tenantId: string, preferredWarehouseId?: string) {
  if (preferredWarehouseId) return preferredWarehouseId;
  const result = await query<{ id: string }>(
    `SELECT id
       FROM locations
      WHERE tenant_id = $1
        AND type = 'warehouse'
        AND active = true
      ORDER BY created_at ASC
      LIMIT 1`,
    [tenantId],
  );
  if (result.rowCount === 0) {
    throw new Error('WAREHOUSE_SCOPE_REQUIRED');
  }
  return result.rows[0].id;
}

async function estimateRuntimeSeconds(tenantId: string) {
  const result = await query<{ notes: string | null }>(
    `SELECT notes
       FROM kpi_runs
      WHERE tenant_id = $1
        AND notes IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 20`,
    [tenantId],
  );
  const runtimes = result.rows
    .map((row) => parseDashboardRunNote(row.notes))
    .filter((note): note is DashboardRunNote => Boolean(note))
    .map((note) => note.runtimeMs)
    .filter((runtime): runtime is number => Number.isFinite(runtime))
    .sort((left, right) => left - right);

  if (runtimes.length === 0) return DEFAULT_RUNTIME_ESTIMATE_SECONDS;
  const midpoint = Math.floor(runtimes.length / 2);
  const medianMs =
    runtimes.length % 2 === 0
      ? (runtimes[midpoint - 1] + runtimes[midpoint]) / 2
      : runtimes[midpoint];
  return Math.max(1, Math.round(medianMs / 1000));
}

async function computeDashboardSnapshots(tenantId: string, warehouseId: string, windowDays: number) {
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const asOf = windowEnd.toISOString();

  const [summaryDetailed, recommendations, policies, purchaseOrders, workOrdersResult, aItemsResult, fillRate] =
    await Promise.all([
      getInventorySnapshotSummaryDetailed(tenantId, {
        warehouseId,
        limit: 5000,
        offset: 0,
      }),
      computeReplenishmentRecommendations(tenantId, 5000, 0),
      listReplenishmentPolicies(tenantId, 5000, 0),
      listPurchaseOrders(tenantId, 5000, 0),
      listWorkOrders(tenantId, { limit: 5000, offset: 0 }),
      query<{ id: string }>(
        `SELECT id
           FROM items
          WHERE tenant_id = $1
            AND abc_class = 'A'
          LIMIT 500`,
        [tenantId],
      ),
      computeFulfillmentFillRate(tenantId, {
        from: windowStart.toISOString(),
        to: windowEnd.toISOString(),
      }),
    ]);
  const snapshotRows = summaryDetailed.data;
  const uomDiagnostics = selectUomDiagnosticsForKpi({
    uomNormalizationDiagnostics: summaryDetailed.diagnostics.uomNormalizationDiagnostics,
    uomInconsistencies: summaryDetailed.diagnostics.uomInconsistencies
  });
  const uomDiagnosticBuckets = summarizeDistinctUomDiagnosticGroups(uomDiagnostics);

  const policyByScope = new Set(
    policies
      .filter((policy) => String(policy.status ?? '').toLowerCase() !== 'inactive')
      .map((policy) => `${policy.itemId}:${policy.siteLocationId}`),
  );
  const availabilityBreaches = snapshotRows.filter((row) => {
    const availableQty = computeAvailableQty({
      onHand: row.onHand,
      reserved: row.reserved,
      held: row.held,
      rejected: row.rejected,
    });
    const activeDemand = toFiniteNumber(row.reserved) > 0 || toFiniteNumber(row.backordered) > 0;
    const hasPolicy = policyByScope.has(`${row.itemId}:${row.locationId}`);
    return availableQty <= 0 && (activeDemand || hasPolicy);
  }).length;

  const negativeOnHand = snapshotRows.filter((row) => toFiniteNumber(row.onHand) < 0).length;
  const allocationIntegrity = snapshotRows.filter((row) => {
    const onHand = toFiniteNumber(row.onHand);
    const allocated = toFiniteNumber(row.reserved);
    const held = toFiniteNumber(row.held);
    const rejected = toFiniteNumber(row.rejected);
    const available = computeAvailableQty({
      onHand: row.onHand,
      reserved: row.reserved,
      held: row.held,
      rejected: row.rejected,
    });
    return allocated > onHand || (available < 0 && held <= 0 && rejected <= 0);
  }).length;
  const reorderRisks = recommendations.filter((rec) => rec.recommendation.reorderNeeded).length;

  const inboundAging = purchaseOrders.filter((po) => {
    const status = String(po.status ?? '').toLowerCase();
    if (status === 'submitted') return daysSince(po.createdAt ?? po.orderDate ?? null) > 1;
    if (status === 'approved' || status === 'partially_received') {
      return po.expectedDate ? daysSince(po.expectedDate) > 0 : false;
    }
    return false;
  }).length;

  const workOrderRisks = workOrdersResult.data.filter((workOrder) => {
    const status = String(workOrder.status ?? '').toLowerCase();
    if (status === 'completed' || status === 'closed' || status === 'voided') return false;
    const planned = toFiniteNumber(workOrder.quantityPlanned);
    const completed = toFiniteNumber(workOrder.quantityCompleted);
    const remaining = Math.max(0, planned - completed);
    if (remaining <= 0) return false;
    if (workOrder.scheduledDueAt) {
      return daysSince(workOrder.scheduledDueAt) >= 0;
    }
    return true;
  }).length;

  const aItemIds = aItemsResult.rows.map((row) => row.id);
  const aItemMetrics = await getItemMetrics(tenantId, aItemIds, windowDays);
  const cycleCountHygiene = aItemMetrics.filter((metric) => {
    const staleCount = daysSince(metric.lastCountAt) > 30;
    const highVariance = Math.abs(toFiniteNumber(metric.lastCountVariancePct)) > 0.05;
    return staleCount || highVariance;
  }).length;

  const fillRateValue = fillRate.fillRate;
  const unfilledRate = fillRate.fillRate === null ? null : Math.max(0, 1 - fillRate.fillRate);

  const snapshots: DashboardSnapshot[] = [
    { kpiName: 'dashboard.availability_breaches', value: availabilityBreaches, units: 'count' },
    { kpiName: 'dashboard.negative_on_hand', value: negativeOnHand, units: 'count' },
    { kpiName: 'dashboard.allocation_integrity', value: allocationIntegrity, units: 'count' },
    { kpiName: 'dashboard.reorder_risks', value: reorderRisks, units: 'count' },
    { kpiName: 'dashboard.inbound_aging', value: inboundAging, units: 'count' },
    { kpiName: 'dashboard.work_order_risks', value: workOrderRisks, units: 'count' },
    { kpiName: 'dashboard.cycle_count_hygiene', value: cycleCountHygiene, units: 'count' },
    { kpiName: 'dashboard.fill_rate', value: fillRateValue, units: 'ratio' },
    { kpiName: 'dashboard.unfilled_rate_proxy', value: unfilledRate, units: 'ratio' },
  ];
  if (ENABLE_DASHBOARD_UOM_INCONSISTENT) {
    snapshots.push({
      kpiName: 'dashboard.uom_inconsistent',
      value: uomDiagnosticBuckets.actionGroups,
      units: 'count',
      dimensions: {
        uomInconsistentCountMode: 'distinct_group_action'
      }
    });
    snapshots.push({
      kpiName: 'dashboard.uom_legacy_fallback',
      value: uomDiagnosticBuckets.watchGroups,
      units: 'count',
      dimensions: {
        uomLegacyFallbackCountMode: 'distinct_group_watch'
      }
    });
  }

  return {
    asOf,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    snapshots,
  };
}

export async function computeDashboardKpis(
  tenantId: string,
  params: DashboardKpiComputeParams = {},
): Promise<DashboardKpiComputeResult> {
  const startedAt = Date.now();
  const warehouseId = await resolveWarehouseScope(tenantId, params.warehouseId);
  const windowDays = Math.max(1, Math.min(365, Number(params.windowDays ?? DEFAULT_WINDOW_DAYS)));
  const now = new Date();
  const idempotencyScope = params.idempotencyKey?.trim() || `auto-hour:${now.toISOString().slice(0, 13)}`;
  const fingerprint = buildFingerprint({
    tenantId,
    warehouseId,
    windowDays,
    idempotencyScope,
  });
  const notePrefix = JSON.stringify({
    source: 'dashboard_compute',
    fingerprint,
    warehouseId,
    windowDays,
    idempotencyScope,
    readOnlyInventory: true,
  } satisfies DashboardRunNote);
  const noteFingerprintLike = `%\"fingerprint\":\"${fingerprint}\"%`;

  const runtimeEstimateSeconds = await estimateRuntimeSeconds(tenantId);

  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`dashboard-kpi:${fingerprint}`]);

    const existing = await client.query<{
      id: string;
      as_of: string | null;
      created_at: string;
    }>(
      `SELECT id, as_of, created_at
         FROM kpi_runs
        WHERE tenant_id = $1
          AND notes LIKE $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [tenantId, noteFingerprintLike],
    );

    if (existing.rowCount > 0) {
      const snapshotsCount = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM kpi_snapshots
          WHERE tenant_id = $1
            AND kpi_run_id = $2`,
        [tenantId, existing.rows[0].id],
      );
      return {
        runId: existing.rows[0].id,
        reused: true,
        computedAt: existing.rows[0].created_at,
        asOf: existing.rows[0].as_of ?? existing.rows[0].created_at,
        warehouseId,
        runtimeMs: 0,
        runtimeEstimateSeconds,
        snapshotsWritten: Number(snapshotsCount.rows[0]?.count ?? '0'),
      };
    }

    const computed = await computeDashboardSnapshots(tenantId, warehouseId, windowDays);
    const runId = uuidv4();
    const insertRun = await client.query<{ created_at: string; as_of: string | null }>(
      `INSERT INTO kpi_runs (id, tenant_id, status, window_start, window_end, as_of, notes, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now())
       RETURNING created_at, as_of`,
      [runId, tenantId, 'published', computed.windowStart, computed.windowEnd, computed.asOf, notePrefix],
    );

    for (const snapshot of computed.snapshots) {
      await client.query(
        `INSERT INTO kpi_snapshots (id, tenant_id, kpi_run_id, kpi_name, dimensions, value, units, computed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())`,
        [
          uuidv4(),
          tenantId,
          runId,
          snapshot.kpiName,
          {
            scope: 'dashboard',
            warehouseId,
            formulaVersion: 'dashboard-v1',
            readOnlyInventory: true,
            ...(snapshot.dimensions ?? {})
          },
          snapshot.value,
          snapshot.units,
        ],
      );
    }

    await client.query(
      `INSERT INTO kpi_rollup_inputs (id, tenant_id, kpi_run_id, metric_name, dimensions, numerator_qty, denominator_qty, computed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now())`,
      [
        uuidv4(),
        tenantId,
        runId,
        'dashboard.compute.runtime_ms',
        { scope: 'dashboard', warehouseId },
        Date.now() - startedAt,
        null,
      ],
    );

    const finishedRuntimeMs = Date.now() - startedAt;
    const noteWithRuntime = JSON.stringify({
      source: 'dashboard_compute',
      fingerprint,
      warehouseId,
      windowDays,
      idempotencyScope,
      runtimeMs: finishedRuntimeMs,
      readOnlyInventory: true,
    } satisfies DashboardRunNote);

    await client.query(`UPDATE kpi_runs SET notes = $2 WHERE tenant_id = $1 AND id = $3`, [
      tenantId,
      noteWithRuntime,
      runId,
    ]);

    return {
      runId,
      reused: false,
      computedAt: insertRun.rows[0]?.created_at ?? new Date().toISOString(),
      asOf: insertRun.rows[0]?.as_of ?? computed.asOf,
      warehouseId,
      runtimeMs: finishedRuntimeMs,
      runtimeEstimateSeconds,
      snapshotsWritten: computed.snapshots.length,
    };
  });
}

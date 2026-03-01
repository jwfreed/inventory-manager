import './telemetry';
import type { Server } from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import { pool, logDbConnectionHint } from './db';
import healthRouter from './routes/health.routes';
import authRouter from './routes/auth.routes';
import vendorsRouter from './routes/vendors.routes';
import purchaseOrdersRouter from './routes/purchaseOrders.routes';
import receiptsRouter from './routes/receipts.routes';
import qcRouter from './routes/qc.routes';
import ncrRouter from './routes/ncr.routes';
import putawaysRouter from './routes/putaways.routes';
import transfersRouter from './routes/transfers.routes';
import closeoutRouter from './routes/closeout.routes';
import adjustmentsRouter from './routes/adjustments.routes';
import countsRouter from './routes/counts.routes';
import bomsRouter from './routes/boms.routes';
import workOrdersRouter from './routes/workOrders.routes';
import workOrderExecutionRouter from './routes/workOrderExecution.routes';
import orderToCashRouter from './routes/orderToCash.routes';
import masterDataRouter from './routes/masterData.routes';
import ledgerRouter from './routes/ledger.routes';
import inventorySummaryRouter from './routes/inventorySummary.routes';
import inventoryLedgerReconcileRouter from './routes/inventoryLedgerReconcile.routes';
import inventorySnapshotRouter from './routes/inventorySnapshot.routes';
import inventoryChangesRouter from './routes/inventoryChanges.routes';
import importsRouter from './routes/imports.routes';
import pickingRouter from './routes/picking.routes';
import shippingContainersRouter from './routes/shippingContainers.routes';
import returnsExtendedRouter from './routes/returnsExtended.routes';
import planningRouter from './routes/planning.routes';
import drpRouter from './routes/drp.routes';
import complianceRouter from './routes/compliance.routes';
import eventsRouter from './routes/events.routes';
import auditRouter from './routes/audit.routes';
import routingsRouter from './routes/routings.routes';
import atpRouter from './routes/atp.routes';
import supplierScorecardRouter from './routes/supplierScorecard.routes';
import licensePlatesRouter from './routes/licensePlates.routes';
import vendorInvoicesRouter from './routes/vendorInvoices.routes';
import vendorPaymentsRouter from './routes/vendorPayments.routes';
import reportsRouter from './routes/reports.routes';
import metricsRouter from './routes/metrics.routes';
import supplierPerformanceRouter from './routes/supplierPerformance.routes';
import productionOverviewRouter from './routes/productionOverview.routes';
import costLayersRouter from './routes/costLayers.routes';
import costsRouter from './routes/costs.routes';
import { requireAuth } from './middleware/auth.middleware';
import { destructiveGuard } from './middleware/destructiveGuard.middleware';
import { requestContextMiddleware } from './middleware/requestContext.middleware';
import { requestLoggerMiddleware } from './middleware/requestLogger.middleware';
import { registerJob, startScheduler, stopScheduler } from './jobs/scheduler';
import { recalculateMetrics } from './jobs/metricsRecalculation.job';
import { syncExchangeRates } from './jobs/exchangeRateSync.job';
import { runInventoryHealthCheck } from './jobs/inventoryHealth.job';
import { runInventoryInvariantCheck } from './jobs/inventoryInvariants.job';
import { runInventoryLedgerReconcileAndRepair } from './jobs/inventoryLedgerReconcileAndRepair.job';
import { ensureWarehouseDefaults } from './services/warehouseDefaults.service';
import { pruneOutboxEvents } from './jobs/outboxRetention.job';
import { pruneIdempotencyKeys } from './jobs/idempotencyRetention.job';
import { runReservationExpiry } from './jobs/reservationExpiry.job';
import inventoryHealthRouter from './routes/inventoryHealth.routes';
import outboxAdminRouter from './routes/outboxAdmin.routes';
import { startEventBridge } from './lib/events';
import { shutdownCache } from './lib/redis';
import {
  logStructuredStartupFailure,
  resolveWarehouseDefaultsStartupMode
} from './config/warehouseDefaultsStartup';
import { resolveSchedulerStartupMode } from './config/schedulerStartup';
import { emitAtpRetryBudgetsEffectiveLogOnce, resolveAtpRetryBudgets } from './config/atpRetryBudgets';

const PORT = Number(process.env.PORT) || 3000;
const HOST = String(process.env.HOST ?? '0.0.0.0').trim() || '0.0.0.0';
const CORS_ORIGINS = (process.env.CORS_ORIGIN ?? process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
let httpServer: Server | null = null;
let isShuttingDown = false;

const startupMode = resolveWarehouseDefaultsStartupMode();
const schedulerMode = resolveSchedulerStartupMode();
const REQUIRED_NON_PROD_LOCATION_COLUMNS = ['role', 'is_sellable'] as const;
const REQUIRED_NON_PROD_LOCATION_CHECK_CONSTRAINTS = [
  {
    name: 'chk_locations_role',
    checkExpression: "role IS NULL OR role IN ('SELLABLE','QA','HOLD','REJECT','SCRAP')"
  },
  {
    name: 'chk_locations_role_sellable',
    checkExpression: "role IS NULL OR ((role = 'SELLABLE') = is_sellable)"
  },
  {
    name: 'chk_locations_role_required_except_warehouse_root',
    checkExpression: "role IS NOT NULL OR (type = 'warehouse' AND parent_location_id IS NULL)"
  },
  {
    name: 'chk_locations_orphan_is_warehouse',
    checkExpression: "(parent_location_id IS NOT NULL) OR (type = 'warehouse')"
  }
] as const;
const SCHEMA_COMPAT_PROBE_TABLE = '__schema_compat_locations_probe';
const SCHEMA_COMPAT_PROBE_CONSTRAINT = '__schema_compat_probe_check';

const app = express();

app.use(requestContextMiddleware);
app.use(requestLoggerMiddleware);
app.use((req, res, next) => {
  const origin = req.headers.origin as string | undefined;
  if (!origin) {
    return next();
  }

  const allowOrigin =
    CORS_ORIGINS.length === 0
      ? origin
      : CORS_ORIGINS.includes(origin)
        ? origin
        : null;

  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  return next();
});

app.use(express.json({ limit: process.env.JSON_BODY_LIMIT ?? '1mb' }));
app.use(cookieParser());
startEventBridge();

app.use(healthRouter);
app.use(authRouter);
app.use(requireAuth);
app.use(destructiveGuard);

// Refactor map:
// - Vendors + Purchase Orders routes are defined under src/routes/*.routes.ts.
// - Receiving + QC routes are defined under src/routes/receipts.routes.ts and qc.routes.ts.
// - Putaway routes are defined under src/routes/putaways.routes.ts.
// - Inbound closeout routes are defined under src/routes/closeout.routes.ts.
// - Inventory adjustment routes are defined under src/routes/adjustments.routes.ts.
// - Inventory count routes are defined under src/routes/counts.routes.ts.
// - BOM routes are defined under src/routes/boms.routes.ts.
app.use(vendorsRouter);
app.use(vendorInvoicesRouter);
app.use(vendorPaymentsRouter);
app.use(purchaseOrdersRouter);
app.use(receiptsRouter);
app.use(qcRouter);
app.use(ncrRouter);
app.use(putawaysRouter);
app.use(transfersRouter);
app.use(closeoutRouter);
app.use(adjustmentsRouter);
app.use(countsRouter);
app.use(bomsRouter);
app.use(routingsRouter);
app.use(workOrdersRouter);
app.use(workOrderExecutionRouter);
app.use(orderToCashRouter);
app.use(masterDataRouter);
app.use(ledgerRouter);
app.use(inventorySummaryRouter);
app.use(inventoryLedgerReconcileRouter);
app.use(inventorySnapshotRouter);
app.use(inventoryChangesRouter);
app.use(importsRouter);
app.use('/atp', atpRouter);
app.use('/supplier-scorecards', supplierScorecardRouter);
app.use('/reports', reportsRouter);
app.use('/metrics', metricsRouter);
app.use('/supplier-performance', supplierPerformanceRouter);
app.use(productionOverviewRouter);
app.use('/api/cost-layers', costLayersRouter);
app.use('/api', costsRouter);
app.use(inventoryHealthRouter);
app.use(outboxAdminRouter);
app.use(licensePlatesRouter);
app.use(pickingRouter);
app.use(shippingContainersRouter);
app.use(returnsExtendedRouter);
app.use(planningRouter);
app.use(drpRouter);
app.use(complianceRouter);
app.use(eventsRouter);
app.use(auditRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

pool.on('error', (err) => {
  console.error('Unexpected DB pool error', err);
});

if (schedulerMode.schedulerEnabled) {
  // Register scheduled jobs
  console.log('\n📅 Registering scheduled jobs (in-process)...');
  registerJob(
    'metrics-recalculation',
    '0 2 * * *', // 02:00 UTC daily
    recalculateMetrics,
    true
  );

  registerJob(
    'exchange-rate-sync',
    '0 6 * * *', // 06:00 UTC daily
    syncExchangeRates,
    true
  );

  registerJob(
    'inventory-health-check',
    process.env.INVENTORY_HEALTH_CRON ?? '0 * * * *', // Hourly by default
    runInventoryHealthCheck,
    true
  );

  registerJob(
    'inventory-invariant-check',
    process.env.INVENTORY_INVARIANT_CRON ?? '30 * * * *', // Hourly by default
    async () => {
      await runInventoryInvariantCheck();
    },
    true
  );

  registerJob(
    'inventory-ledger-reconcile',
    process.env.INVENTORY_LEDGER_RECONCILE_CRON ?? '15 3 * * *', // 03:15 UTC daily by default
    async () => {
      await runInventoryLedgerReconcileAndRepair({
        mode: (process.env.INVENTORY_LEDGER_RECONCILE_MODE as 'report' | 'strict') ?? 'report',
        allowRepair: process.env.FEATURE_BALANCE_REBUILD === 'true'
      });
    },
    true
  );

  registerJob(
    'outbox-retention',
    process.env.OUTBOX_RETENTION_CRON ?? '0 3 * * *', // 03:00 UTC daily
    async () => {
      const result = await pruneOutboxEvents();
      if (result.deleted > 0) {
        console.log(`🧹 Outbox retention pruned ${result.deleted} events (retention=${result.retentionDays}d)`);
      }
    },
    true
  );

  registerJob(
    'idempotency-retention',
    process.env.IDEMPOTENCY_RETENTION_CRON ?? '15 3 * * *', // 03:15 UTC daily
    async () => {
      const result = await pruneIdempotencyKeys();
      if (result.deleted > 0) {
        console.log(`🧹 Idempotency retention pruned ${result.deleted} keys (retention=${result.retentionDays}d)`);
      }
    },
    true
  );

  registerJob(
    'reservation-expiry',
    process.env.RESERVATION_EXPIRY_CRON ?? '*/15 * * * *', // Every 15 minutes by default
    runReservationExpiry,
    true
  );

  // Start the scheduler
  startScheduler();
} else if (schedulerMode.runInProcessJobs && (process.env.NODE_ENV ?? 'development') === 'development') {
  console.log('\n📅 Scheduler disabled for development (set ENABLE_SCHEDULER=true to enable)');
}

async function closeHttpServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function shutdown(signal: 'SIGTERM' | 'SIGINT'): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n🛑 ${signal} received, shutting down gracefully...`);
  try {
    if (schedulerMode.schedulerEnabled) {
      stopScheduler();
    }
    if (httpServer) {
      await closeHttpServer(httpServer);
      httpServer = null;
    }
    await pool.end().catch(() => undefined);
    await shutdownCache().catch(() => undefined);
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

async function assertNonProductionSchemaCompatibility(): Promise<void> {
  const nodeEnv = (process.env.NODE_ENV ?? 'development').toLowerCase();
  if (nodeEnv === 'production') return;
  const remediation = [
    'Run migrations against the configured DATABASE_URL.',
    'Suggested command: npm run migrate:up',
    'If local schema is severely behind, reset and migrate: CONFIRM_DB_RESET=1 npm run db:reset:migrate'
  ].join(' ');
  const client = await pool.connect();
  try {
    const res = await client.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'locations'
          AND column_name = ANY($1::text[])`,
      [REQUIRED_NON_PROD_LOCATION_COLUMNS]
    );
    const present = new Set(res.rows.map((row) => row.column_name));
    const missing = REQUIRED_NON_PROD_LOCATION_COLUMNS.filter((column) => !present.has(column));

    if (missing.length > 0) {
      const code = 'SCHEMA_COMPAT_LOCATIONS_COLUMNS_MISSING';
      console.error('[schema.compatibility.failed]', {
        code,
        table: 'locations',
        missingColumns: missing,
        nodeEnv,
        remediation
      });

      const error = new Error(`${code} missingColumns=${missing.join(',')}`) as Error & {
        code?: string;
        details?: { table: string; missingColumns: readonly string[] };
      };
      error.code = code;
      error.details = { table: 'locations', missingColumns: missing };
      throw error;
    }

    const existingConstraintRes = await client.query<{ conname: string; definition: string }>(
      `SELECT c.conname,
              pg_get_constraintdef(c.oid) AS definition
         FROM pg_constraint c
         JOIN pg_class t
           ON t.oid = c.conrelid
         JOIN pg_namespace n
           ON n.oid = t.relnamespace
        WHERE n.nspname = 'public'
          AND t.relname = 'locations'
          AND c.conname = ANY($1::text[])`,
      [REQUIRED_NON_PROD_LOCATION_CHECK_CONSTRAINTS.map((entry) => entry.name)]
    );

    const existingByName = new Map(existingConstraintRes.rows.map((row) => [row.conname, row.definition]));
    const missingConstraints = REQUIRED_NON_PROD_LOCATION_CHECK_CONSTRAINTS
      .map((entry) => entry.name)
      .filter((name) => !existingByName.has(name));
    if (missingConstraints.length > 0) {
      const code = 'SCHEMA_COMPAT_LOCATIONS_CONSTRAINTS_MISSING';
      console.error('[schema.compatibility.failed]', {
        code,
        table: 'locations',
        missingConstraints,
        nodeEnv,
        remediation
      });
      const error = new Error(`${code} missingConstraints=${missingConstraints.join(',')}`) as Error & {
        code?: string;
        details?: { table: string; missingConstraints: readonly string[] };
      };
      error.code = code;
      error.details = { table: 'locations', missingConstraints };
      throw error;
    }

    await client.query(
      `CREATE TEMP TABLE IF NOT EXISTS ${SCHEMA_COMPAT_PROBE_TABLE} (
         LIKE public.locations
         INCLUDING DEFAULTS
         INCLUDING GENERATED
         INCLUDING IDENTITY
       )`
    );

    const normalizeDefinition = (value: string) => value.toLowerCase().replace(/\s+/g, '');
    const mismatchedConstraints: Array<{ name: string; existing: string; expected: string }> = [];
    for (const required of REQUIRED_NON_PROD_LOCATION_CHECK_CONSTRAINTS) {
      await client.query(
        `ALTER TABLE ${SCHEMA_COMPAT_PROBE_TABLE}
            DROP CONSTRAINT IF EXISTS ${SCHEMA_COMPAT_PROBE_CONSTRAINT}`
      );
      await client.query(
        `ALTER TABLE ${SCHEMA_COMPAT_PROBE_TABLE}
            ADD CONSTRAINT ${SCHEMA_COMPAT_PROBE_CONSTRAINT}
            CHECK (${required.checkExpression})`
      );
      const expectedRes = await client.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(c.oid) AS definition
           FROM pg_constraint c
           JOIN pg_class t
             ON t.oid = c.conrelid
           JOIN pg_namespace n
             ON n.oid = t.relnamespace
          WHERE n.oid = pg_my_temp_schema()
            AND t.relname = $1
            AND c.conname = $2`,
        [SCHEMA_COMPAT_PROBE_TABLE, SCHEMA_COMPAT_PROBE_CONSTRAINT]
      );
      if (expectedRes.rowCount === 0) {
        const code = 'SCHEMA_COMPAT_PROBE_CONSTRAINT_DEFINITION_MISSING';
        const error = new Error(`${code} constraint=${required.name}`) as Error & { code?: string };
        error.code = code;
        throw error;
      }
      const existing = existingByName.get(required.name)!;
      const expected = expectedRes.rows[0].definition;
      if (normalizeDefinition(existing) !== normalizeDefinition(expected)) {
        mismatchedConstraints.push({
          name: required.name,
          existing,
          expected
        });
      }
    }

    if (mismatchedConstraints.length > 0) {
      const code = 'SCHEMA_COMPAT_LOCATIONS_CONSTRAINT_DEFINITION_MISMATCH';
      console.error('[schema.compatibility.failed]', {
        code,
        table: 'locations',
        mismatchedConstraints,
        nodeEnv,
        remediation
      });
      const error = new Error(`${code} count=${mismatchedConstraints.length}`) as Error & {
        code?: string;
        details?: { table: string; mismatchedConstraints: typeof mismatchedConstraints };
      };
      error.code = code;
      error.details = { table: 'locations', mismatchedConstraints };
      throw error;
    }
  } finally {
    client.release();
  }
}

async function start() {
  const atpRetryBudgets = resolveAtpRetryBudgets({ enforceProductionCaps: true });
  emitAtpRetryBudgetsEffectiveLogOnce(atpRetryBudgets);
  await assertNonProductionSchemaCompatibility();

  const startupTenantId = process.env.WAREHOUSE_DEFAULTS_TENANT_ID?.trim() || undefined;
  await ensureWarehouseDefaults(startupTenantId, { repair: startupMode.startupRepairMode });
  httpServer = app.listen(PORT, HOST);
  httpServer.on('error', (error) => {
    scheduleFatalExit('server.listen', error);
  });
  httpServer.on('listening', () => {
    console.log(`\n🚀 Inventory Manager API listening on ${HOST}:${PORT}`);
    console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`   Timezone: UTC (for scheduled jobs)\n`);
  });
}

function logFatalStartupError(context: string, error: unknown): void {
  const candidate = error as {
    message?: unknown;
    code?: unknown;
    stack?: unknown;
    cause?: { message?: unknown; code?: unknown; stack?: unknown } | unknown;
  } | undefined;
  const causeCandidate = candidate?.cause as {
    message?: unknown;
    code?: unknown;
    stack?: unknown;
  } | undefined;

  const payload = {
    context,
    message: typeof candidate?.message === 'string' ? candidate.message : String(error),
    code: typeof candidate?.code === 'string' ? candidate.code : null,
    stack: typeof candidate?.stack === 'string' ? candidate.stack : null,
    cause: causeCandidate
      ? {
          message: typeof causeCandidate.message === 'string' ? causeCandidate.message : String(candidate?.cause),
          code: typeof causeCandidate.code === 'string' ? causeCandidate.code : null,
          stack: typeof causeCandidate.stack === 'string' ? causeCandidate.stack : null
        }
      : null
  };

  process.stderr.write(`Startup fatal error details: ${JSON.stringify(payload)}\n`);
}

let fatalExitScheduled = false;

function scheduleFatalExit(context: string, error: unknown): void {
  if (fatalExitScheduled) return;
  fatalExitScheduled = true;
  logDbConnectionHint(error, context);
  logStructuredStartupFailure(error);
  logFatalStartupError(context, error);
  setTimeout(() => {
    process.exit(1);
  }, 25).unref();
}

process.on('unhandledRejection', (reason) => {
  scheduleFatalExit('unhandledRejection', reason);
});

process.on('uncaughtException', (error) => {
  scheduleFatalExit('uncaughtException', error);
});

void start().catch((error) => {
  scheduleFatalExit('server.start', error);
});

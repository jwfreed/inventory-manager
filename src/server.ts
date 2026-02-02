import './telemetry';
import express from 'express';
import cookieParser from 'cookie-parser';
import { pool } from './db';
import healthRouter from './routes/health.routes';
import authRouter from './routes/auth.routes';
import vendorsRouter from './routes/vendors.routes';
import purchaseOrdersRouter from './routes/purchaseOrders.routes';
import receiptsRouter from './routes/receipts.routes';
import qcRouter from './routes/qc.routes';
import ncrRouter from './routes/ncr.routes';
import putawaysRouter from './routes/putaways.routes';
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
import { ensureWarehouseDefaults } from './services/warehouseDefaults.service';
import { pruneOutboxEvents } from './jobs/outboxRetention.job';
import { runReservationExpiry } from './jobs/reservationExpiry.job';
import inventoryHealthRouter from './routes/inventoryHealth.routes';
import outboxAdminRouter from './routes/outboxAdmin.routes';
import { startEventBridge } from './lib/events';

const PORT = Number(process.env.PORT) || 3000;
const RUN_INPROCESS_JOBS = process.env.RUN_INPROCESS_JOBS === 'true';
const CORS_ORIGINS = (process.env.CORS_ORIGIN ?? process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

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

if (RUN_INPROCESS_JOBS) {
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
    runInventoryInvariantCheck,
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
    'reservation-expiry',
    process.env.RESERVATION_EXPIRY_CRON ?? '*/15 * * * *', // Every 15 minutes by default
    runReservationExpiry,
    true
  );

  // Start the scheduler
  startScheduler();
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('\n🛑 SIGTERM received, shutting down gracefully...');
  if (RUN_INPROCESS_JOBS) {
    stopScheduler();
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n🛑 SIGINT received, shutting down gracefully...');
  if (RUN_INPROCESS_JOBS) {
    stopScheduler();
  }
  process.exit(0);
});

async function start() {
  await ensureWarehouseDefaults();
  app.listen(PORT, () => {
    console.log(`\n🚀 Inventory Manager API listening on port ${PORT}`);
    console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`   Timezone: UTC (for scheduled jobs)\n`);
  });
}

start().catch((error) => {
  console.error('Startup failed:', error);
  process.exit(1);
});

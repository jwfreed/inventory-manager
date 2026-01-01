import express from 'express';
import cookieParser from 'cookie-parser';
import { pool } from './db';
import authRouter from './routes/auth.routes';
import vendorsRouter from './routes/vendors.routes';
import purchaseOrdersRouter from './routes/purchaseOrders.routes';
import receiptsRouter from './routes/receipts.routes';
import qcRouter from './routes/qc.routes';
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
import pickingRouter from './routes/picking.routes';
import shippingContainersRouter from './routes/shippingContainers.routes';
import returnsExtendedRouter from './routes/returnsExtended.routes';
import planningRouter from './routes/planning.routes';
import drpRouter from './routes/drp.routes';
import complianceRouter from './routes/compliance.routes';
import eventsRouter from './routes/events.routes';
import auditRouter from './routes/audit.routes';
import routingsRouter from './routes/routings.routes';
import { requireAuth } from './middleware/auth.middleware';
import { destructiveGuard } from './middleware/destructiveGuard.middleware';

const PORT = Number(process.env.PORT) || 3000;
const CORS_ORIGINS = (process.env.CORS_ORIGIN ?? process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const app = express();

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

app.use(express.json());
app.use(cookieParser());

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
app.use(purchaseOrdersRouter);
app.use(receiptsRouter);
app.use(qcRouter);
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

app.listen(PORT, () => {
  console.log(`Inventory Manager API listening on port ${PORT}`);
});

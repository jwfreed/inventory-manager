import express from 'express';
import { pool } from './db';
import vendorsRouter from './routes/vendors.routes';
import purchaseOrdersRouter from './routes/purchaseOrders.routes';
import receiptsRouter from './routes/receipts.routes';
import qcRouter from './routes/qc.routes';
import putawaysRouter from './routes/putaways.routes';
import closeoutRouter from './routes/closeout.routes';
import adjustmentsRouter from './routes/adjustments.routes';
import countsRouter from './routes/counts.routes';
import bomsRouter from './routes/boms.routes';

const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.use(express.json());

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

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

pool.on('error', (err) => {
  console.error('Unexpected DB pool error', err);
});

app.listen(PORT, () => {
  console.log(`Inventory Manager API listening on port ${PORT}`);
});

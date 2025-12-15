import express, { Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { pool, query, withTransaction } from './db';
import type { PoolClient } from 'pg';
import vendorsRouter from './routes/vendors.routes';
import purchaseOrdersRouter from './routes/purchaseOrders.routes';
import receiptsRouter from './routes/receipts.routes';
import qcRouter from './routes/qc.routes';
import putawaysRouter from './routes/putaways.routes';
import {
  calculateAcceptedQuantity,
  calculatePutawayAvailability,
  defaultBreakdown,
  loadReceiptLineContexts,
  loadPutawayTotals,
  loadQcBreakdown
} from './services/inbound/receivingAggregations';
import type { QcBreakdown } from './services/inbound/receivingAggregations';

const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.use(express.json());

// Refactor map:
// - Vendors + Purchase Orders routes are defined under src/routes/*.routes.ts.
// - Receiving + QC routes are defined under src/routes/receipts.routes.ts and qc.routes.ts.
// - Putaway routes are defined under src/routes/putaways.routes.ts.
app.use(vendorsRouter);
app.use(purchaseOrdersRouter);
app.use(receiptsRouter);
app.use(qcRouter);
app.use(putawaysRouter);

const receiptCloseSchema = z
  .object({
    actorType: z.enum(['user', 'system']).optional(),
    actorId: z.string().max(255).optional(),
    closeoutReasonCode: z.string().max(255).optional(),
    notes: z.string().max(2000).optional()
  })
  .superRefine((data, ctx) => {
    if (data.actorId && !data.actorType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'actorType is required when actorId is provided',
        path: ['actorType']
      });
    }
  });

const adjustmentLineSchema = z.object({
  lineNumber: z.number().int().positive().optional(),
  itemId: z.string().uuid(),
  locationId: z.string().uuid(),
  uom: z.string().min(1).max(32),
  quantityDelta: z
    .number()
    .refine((value) => value !== 0, { message: 'quantityDelta must be non-zero' }),
  reasonCode: z.string().min(1).max(255),
  notes: z.string().max(2000).optional()
});

const inventoryAdjustmentSchema = z.object({
  occurredAt: z.string().datetime(),
  notes: z.string().max(2000).optional(),
  lines: z.array(adjustmentLineSchema).min(1)
});

const countLineSchema = z.object({
  lineNumber: z.number().int().positive().optional(),
  itemId: z.string().uuid(),
  uom: z.string().min(1).max(32),
  countedQuantity: z.number().min(0),
  notes: z.string().max(2000).optional()
});

const inventoryCountSchema = z.object({
  countedAt: z.string().datetime(),
  locationId: z.string().uuid(),
  notes: z.string().max(2000).optional(),
  lines: z.array(countLineSchema).min(1)
});

const bomComponentInputSchema = z.object({
  lineNumber: z.number().int().positive(),
  componentItemId: z.string().uuid(),
  uom: z.string().min(1).max(32),
  quantityPer: z.number().positive(),
  scrapFactor: z.number().min(0).optional(),
  notes: z.string().max(2000).optional()
});

const bomVersionInputSchema = z
  .object({
    versionNumber: z.number().int().positive().optional(),
    effectiveFrom: z.string().datetime().optional(),
    effectiveTo: z.string().datetime().optional(),
    yieldQuantity: z.number().positive(),
    yieldUom: z.string().min(1).max(32),
    notes: z.string().max(2000).optional(),
    components: z.array(bomComponentInputSchema).min(1)
  })
  .superRefine((data, ctx) => {
    if (data.effectiveFrom && data.effectiveTo) {
      const from = new Date(data.effectiveFrom);
      const to = new Date(data.effectiveTo);
      if (!(from instanceof Date && !Number.isNaN(from.valueOf()) && to instanceof Date && !Number.isNaN(to.valueOf()))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'effectiveFrom and effectiveTo must be valid ISO datetimes.',
          path: ['effectiveFrom']
        });
        return;
      }
      if (to <= from) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'effectiveTo must be after effectiveFrom.',
          path: ['effectiveTo']
        });
      }
    }
  });

const bomCreateSchema = z.object({
  bomCode: z.string().min(1).max(64),
  outputItemId: z.string().uuid(),
  defaultUom: z.string().min(1).max(32),
  notes: z.string().max(2000).optional(),
  version: bomVersionInputSchema
});

const bomActivationSchema = z
  .object({
    effectiveFrom: z.string().datetime(),
    effectiveTo: z.string().datetime().optional()
  })
  .superRefine((data, ctx) => {
    if (data.effectiveTo) {
      const from = new Date(data.effectiveFrom);
      const to = new Date(data.effectiveTo);
      if (!(from instanceof Date && !Number.isNaN(from.valueOf()) && to instanceof Date && !Number.isNaN(to.valueOf()))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'effectiveFrom and effectiveTo must be valid ISO datetimes.',
          path: ['effectiveFrom']
        });
        return;
      }
      if (to <= from) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'effectiveTo must be after effectiveFrom.',
          path: ['effectiveTo']
        });
      }
    }
  });

function toNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (value === null || value === undefined) {
    return 0;
  }
  const num = Number(value);
  return Number.isNaN(num) ? 0 : num;
}

function roundQuantity(value: number): number {
  return parseFloat(value.toFixed(6));
}

function buildQcSummary(lineId: string, breakdownMap: Map<string, QcBreakdown>, quantityReceived: number) {
  const breakdown = breakdownMap.get(lineId) ?? defaultBreakdown();
  const totalQcQuantity = roundQuantity(breakdown.hold + breakdown.accept + breakdown.reject);
  return {
    totalQcQuantity,
    breakdown,
    remainingUninspectedQuantity: roundQuantity(Math.max(0, quantityReceived - totalQcQuantity))
  };
}

type ReceiptLineReconciliation = {
  purchaseOrderReceiptLineId: string;
  quantityReceived: number;
  qcBreakdown: QcBreakdown;
  quantityPutawayPosted: number;
  remainingToPutaway: number;
  blockedReasons: string[];
};

type ReceiptReconciliation = {
  receipt: {
    id: string;
    purchaseOrderId: string;
    status: 'open' | 'closed' | 'reopened';
    closedAt: string | null;
    closeout: {
      status: string;
      closedAt: string | null;
      closeoutReasonCode: string | null;
      notes: string | null;
    } | null;
  };
  lines: ReceiptLineReconciliation[];
};

type InventoryAdjustmentRow = {
  id: string;
  status: string;
  occurred_at: string;
  inventory_movement_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type InventoryAdjustmentLineRow = {
  id: string;
  inventory_adjustment_id: string;
  line_number: number;
  item_id: string;
  location_id: string;
  uom: string;
  quantity_delta: string | number;
  reason_code: string;
  notes: string | null;
  created_at: string;
};

type CycleCountRow = {
  id: string;
  status: string;
  counted_at: string;
  location_id: string;
  notes: string | null;
  inventory_movement_id: string | null;
  created_at: string;
  updated_at: string;
};

type CycleCountLineRow = {
  id: string;
  cycle_count_id: string;
  line_number: number;
  item_id: string;
  uom: string;
  counted_quantity: string | number;
  system_quantity: string | number | null;
  variance_quantity: string | number | null;
  notes: string | null;
  created_at: string;
};

type BomRow = {
  id: string;
  bom_code: string;
  output_item_id: string;
  default_uom: string;
  active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type BomVersionRow = {
  id: string;
  bom_id: string;
  version_number: number;
  status: string;
  effective_from: string | null;
  effective_to: string | null;
  yield_quantity: string | number;
  yield_uom: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type BomVersionLineRow = {
  id: string;
  bom_version_id: string;
  line_number: number;
  component_item_id: string;
  component_quantity: string | number;
  component_uom: string;
  scrap_factor: string | number | null;
  notes: string | null;
  created_at: string;
};

function mapBomVersionLine(row: BomVersionLineRow) {
  return {
    id: row.id,
    bomVersionId: row.bom_version_id,
    lineNumber: row.line_number,
    componentItemId: row.component_item_id,
    quantityPer: roundQuantity(toNumber(row.component_quantity)),
    uom: row.component_uom,
    scrapFactor: row.scrap_factor !== null ? roundQuantity(toNumber(row.scrap_factor)) : null,
    notes: row.notes,
    createdAt: row.created_at
  };
}

function mapBomVersion(row: BomVersionRow, lines: BomVersionLineRow[]) {
  return {
    id: row.id,
    bomId: row.bom_id,
    versionNumber: row.version_number,
    status: row.status,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    yieldQuantity: roundQuantity(toNumber(row.yield_quantity)),
    yieldUom: row.yield_uom,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    components: lines.map((line) => mapBomVersionLine(line))
  };
}

function mapBom(row: BomRow, versionRows: BomVersionRow[], lineMap: Map<string, BomVersionLineRow[]>) {
  return {
    id: row.id,
    bomCode: row.bom_code,
    outputItemId: row.output_item_id,
    defaultUom: row.default_uom,
    active: row.active,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    versions: versionRows.map((versionRow) => mapBomVersion(versionRow, lineMap.get(versionRow.id) ?? []))
  };
}

async function fetchBomById(id: string, client?: PoolClient) {
  const executor = client ?? pool;
  const bomResult = await executor.query<BomRow>('SELECT * FROM boms WHERE id = $1', [id]);
  if (bomResult.rowCount === 0) {
    return null;
  }
  const versionResult = await executor.query<BomVersionRow>(
    'SELECT * FROM bom_versions WHERE bom_id = $1 ORDER BY version_number ASC',
    [id]
  );
  const versionIds = versionResult.rows.map((version) => version.id);
  let lineRows: BomVersionLineRow[] = [];
  if (versionIds.length > 0) {
    const { rows } = await executor.query<BomVersionLineRow>(
      'SELECT * FROM bom_version_lines WHERE bom_version_id = ANY($1::uuid[]) ORDER BY line_number ASC',
      [versionIds]
    );
    lineRows = rows;
  }
  const lineMap = new Map<string, BomVersionLineRow[]>();
  for (const line of lineRows) {
    const arr = lineMap.get(line.bom_version_id) ?? [];
    arr.push(line);
    lineMap.set(line.bom_version_id, arr);
  }
  return mapBom(bomResult.rows[0], versionResult.rows, lineMap);
}

function parseDateInput(value: string): Date | null {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return null;
  }
  return date;
}

function rangesOverlap(
  existingFrom: string | null,
  existingTo: string | null,
  candidateFrom: Date,
  candidateTo: Date | null
): boolean {
  const existingFromTime = existingFrom ? new Date(existingFrom).getTime() : Number.NEGATIVE_INFINITY;
  const existingToTime = existingTo ? new Date(existingTo).getTime() : Number.POSITIVE_INFINITY;
  const candidateFromTime = candidateFrom.getTime();
  const candidateToTime = candidateTo ? candidateTo.getTime() : Number.POSITIVE_INFINITY;
  return candidateFromTime <= existingToTime && existingFromTime <= candidateToTime;
}

type CloseoutRow = {
  id: string;
  purchase_order_receipt_id: string;
  status: 'open' | 'closed' | 'reopened';
  closed_at: string | null;
  closeout_reason_code: string | null;
  notes: string | null;
};

async function fetchReceiptReconciliation(receiverId: string, client?: PoolClient): Promise<ReceiptReconciliation | null> {
  const executor = client ?? pool;
  const receiptResult = await executor.query('SELECT * FROM purchase_order_receipts WHERE id = $1', [receiverId]);
  if (receiptResult.rowCount === 0) {
    return null;
  }
  const receipt = receiptResult.rows[0];

  const linesResult = await executor.query(
    'SELECT * FROM purchase_order_receipt_lines WHERE purchase_order_receipt_id = $1 ORDER BY created_at ASC',
    [receiverId]
  );
  const lineIds = linesResult.rows.map((line: any) => line.id);
  const qcMap = await loadQcBreakdown(lineIds, client);
  const totalsMap = await loadPutawayTotals(lineIds, client);

  const closeoutResult = await executor.query<CloseoutRow>(
    'SELECT * FROM inbound_closeouts WHERE purchase_order_receipt_id = $1',
    [receiverId]
  );
  const closeout = closeoutResult.rows[0] ?? null;

  const lineSummaries: ReceiptLineReconciliation[] = linesResult.rows.map((line: any) => {
    const qc = qcMap.get(line.id) ?? defaultBreakdown();
    const totals = totalsMap.get(line.id) ?? { posted: 0, pending: 0 };
    const quantityReceived = roundQuantity(toNumber(line.quantity_received));
    const acceptedQty = calculateAcceptedQuantity(quantityReceived, qc);
    const postedQty = roundQuantity(totals.posted ?? 0);
    const remaining = Math.max(0, roundQuantity(acceptedQty - postedQty));
    const blockedReasons: string[] = [];
    if (roundQuantity(qc.hold ?? 0) > 0 && roundQuantity(qc.accept ?? 0) === 0) {
      blockedReasons.push('QC hold unresolved');
    }
    if (remaining > 0) {
      blockedReasons.push('Accepted quantity not fully put away');
    }
    return {
      purchaseOrderReceiptLineId: line.id,
      quantityReceived,
      qcBreakdown: {
        hold: roundQuantity(qc.hold ?? 0),
        accept: roundQuantity(qc.accept ?? 0),
        reject: roundQuantity(qc.reject ?? 0)
      },
      quantityPutawayPosted: postedQty,
      remainingToPutaway: remaining,
      blockedReasons
    };
  });

  return {
    receipt: {
      id: receipt.id,
      purchaseOrderId: receipt.purchase_order_id,
      status: closeout?.status ?? 'open',
      closedAt: closeout?.closed_at ?? null,
      closeout: closeout
        ? {
            status: closeout.status,
            closedAt: closeout.closed_at,
            closeoutReasonCode: closeout.closeout_reason_code,
            notes: closeout.notes
          }
        : null
    },
    lines: lineSummaries
  };
}

function mapInventoryAdjustment(row: InventoryAdjustmentRow, lines: InventoryAdjustmentLineRow[]) {
  return {
    id: row.id,
    status: row.status,
    occurredAt: row.occurred_at,
    inventoryMovementId: row.inventory_movement_id,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines: lines.map((line) => ({
      id: line.id,
      lineNumber: line.line_number,
      itemId: line.item_id,
      locationId: line.location_id,
      uom: line.uom,
      quantityDelta: roundQuantity(toNumber(line.quantity_delta)),
      reasonCode: line.reason_code,
      notes: line.notes,
      createdAt: line.created_at
    }))
  };
}

async function fetchInventoryAdjustmentById(id: string, client?: PoolClient) {
  const executor = client ?? pool;
  const adjustmentResult = await executor.query<InventoryAdjustmentRow>('SELECT * FROM inventory_adjustments WHERE id = $1', [
    id
  ]);
  if (adjustmentResult.rowCount === 0) {
    return null;
  }
  const linesResult = await executor.query<InventoryAdjustmentLineRow>(
    'SELECT * FROM inventory_adjustment_lines WHERE inventory_adjustment_id = $1 ORDER BY line_number ASC',
    [id]
  );
  return mapInventoryAdjustment(adjustmentResult.rows[0], linesResult.rows);
}

type OnHandKey = string;

function makeOnHandKey(itemId: string, uom: string): OnHandKey {
  return `${itemId}:${uom}`;
}

async function loadSystemOnHandForLocation(
  locationId: string,
  countedAt: string,
  items: { itemId: string; uom: string }[],
  client?: PoolClient
): Promise<Map<OnHandKey, number>> {
  const map = new Map<OnHandKey, number>();
  if (items.length === 0) {
    return map;
  }
  const executor = client ?? pool;
  const itemIds = Array.from(new Set(items.map((item) => item.itemId)));
  const { rows } = await executor.query(
    `SELECT l.item_id, l.uom, COALESCE(SUM(l.quantity_delta), 0) AS qty
       FROM inventory_movement_lines l
       JOIN inventory_movements m ON m.id = l.movement_id
      WHERE m.status = 'posted'
        AND l.location_id = $1
        AND m.occurred_at <= $2
        AND l.item_id = ANY($3::uuid[])
      GROUP BY l.item_id, l.uom`,
    [locationId, countedAt, itemIds]
  );
  for (const row of rows) {
    map.set(makeOnHandKey(row.item_id, row.uom), roundQuantity(toNumber(row.qty)));
  }
  return map;
}

type CycleCountLineSummary = {
  id: string;
  lineNumber: number;
  itemId: string;
  uom: string;
  countedQuantity: number;
  systemQuantity: number;
  varianceQuantity: number;
  varianceRatio: number;
  notes: string | null;
  createdAt: string;
};

type CycleCountSummary = {
  totalAbsVariance: number;
  lineCount: number;
  linesWithVariance: number;
};

function mapCycleCountLines(
  countRow: CycleCountRow,
  lines: CycleCountLineRow[],
  systemMap: Map<OnHandKey, number>
): { lineSummaries: CycleCountLineSummary[]; summary: CycleCountSummary } {
  const lineSummaries = lines.map((line) => {
    const countedQty = roundQuantity(toNumber(line.counted_quantity));
    const systemQty = systemMap.get(makeOnHandKey(line.item_id, line.uom)) ?? 0;
    const variance = roundQuantity(countedQty - systemQty);
    const varianceRatio = countedQty === 0 ? Math.abs(variance) : Math.abs(variance) / countedQty;
    return {
      id: line.id,
      lineNumber: line.line_number,
      itemId: line.item_id,
      uom: line.uom,
      countedQuantity: countedQty,
      systemQuantity: systemQty,
      varianceQuantity: variance,
      varianceRatio: roundQuantity(varianceRatio),
      notes: line.notes,
      createdAt: line.created_at
    };
  });

  const totalAbsVariance = roundQuantity(
    lineSummaries.reduce((sum, line) => sum + Math.abs(line.varianceQuantity), 0)
  );
  const linesWithVariance = lineSummaries.filter((line) => line.varianceQuantity !== 0).length;

  return {
    lineSummaries,
    summary: {
      totalAbsVariance,
      lineCount: lineSummaries.length,
      linesWithVariance
    }
  };
}

function mapCycleCount(
  row: CycleCountRow,
  lines: CycleCountLineRow[],
  systemMap: Map<OnHandKey, number>
) {
  const { lineSummaries, summary } = mapCycleCountLines(row, lines, systemMap);
  return {
    id: row.id,
    status: row.status,
    countedAt: row.counted_at,
    locationId: row.location_id,
    inventoryMovementId: row.inventory_movement_id,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines: lineSummaries,
    summary
  };
}

async function fetchCycleCountById(id: string, client?: PoolClient) {
  const executor = client ?? pool;
  const countResult = await executor.query<CycleCountRow>('SELECT * FROM cycle_counts WHERE id = $1', [id]);
  if (countResult.rowCount === 0) {
    return null;
  }
  const linesResult = await executor.query<CycleCountLineRow>(
    'SELECT * FROM cycle_count_lines WHERE cycle_count_id = $1 ORDER BY line_number ASC',
    [id]
  );
  const items = linesResult.rows.map((line) => ({ itemId: line.item_id, uom: line.uom }));
  const systemMap = await loadSystemOnHandForLocation(
    countResult.rows[0].location_id,
    countResult.rows[0].counted_at,
    items,
    client
  );
  return mapCycleCount(countResult.rows[0], linesResult.rows, systemMap);
}

app.post('/inventory-adjustments', async (req: Request, res: Response) => {
  const parsed = inventoryAdjustmentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const data = parsed.data;
  const lineNumbers = new Set<number>();
  const normalizedLines = data.lines.map((line, index) => {
    const lineNumber = line.lineNumber ?? index + 1;
    if (lineNumbers.has(lineNumber)) {
      throw new Error('ADJUSTMENT_DUPLICATE_LINE');
    }
    lineNumbers.add(lineNumber);
    return {
      lineNumber,
      itemId: line.itemId,
      locationId: line.locationId,
      uom: line.uom,
      quantityDelta: roundQuantity(line.quantityDelta),
      reasonCode: line.reasonCode,
      notes: line.notes ?? null
    };
  });

  const now = new Date();
  const adjustmentId = uuidv4();

  try {
    await withTransaction(async (client: PoolClient) => {
      await client.query(
        `INSERT INTO inventory_adjustments (
            id, status, occurred_at, notes, created_at, updated_at
         ) VALUES ($1, 'draft', $2, $3, $4, $4)`,
        [adjustmentId, new Date(data.occurredAt), data.notes ?? null, now]
      );

      for (const line of normalizedLines) {
        await client.query(
          `INSERT INTO inventory_adjustment_lines (
              id, inventory_adjustment_id, line_number, item_id, location_id, uom, quantity_delta, reason_code, notes
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            uuidv4(),
            adjustmentId,
            line.lineNumber,
            line.itemId,
            line.locationId,
            line.uom,
            line.quantityDelta,
            line.reasonCode,
            line.notes
          ]
        );
      }
    });

    const adjustment = await fetchInventoryAdjustmentById(adjustmentId);
    return res.status(201).json(adjustment);
  } catch (error: any) {
    if (error?.message === 'ADJUSTMENT_DUPLICATE_LINE') {
      return res.status(400).json({ error: 'Line numbers must be unique within an adjustment.' });
    }
    if (error?.code === '23503') {
      return res.status(400).json({ error: 'Invalid reference: ensure item and location exist before adjustment.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create inventory adjustment.' });
  }
});

app.get('/inventory-adjustments/:id', async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!z.string().uuid().safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid adjustment id.' });
  }

  try {
    const adjustment = await fetchInventoryAdjustmentById(id);
    if (!adjustment) {
      return res.status(404).json({ error: 'Inventory adjustment not found.' });
    }
    return res.json(adjustment);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch inventory adjustment.' });
  }
});

app.post('/inventory-adjustments/:id/post', async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!z.string().uuid().safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid adjustment id.' });
  }

  try {
    const adjustment = await withTransaction(async (client: PoolClient) => {
      const now = new Date();
      const adjustmentResult = await client.query<InventoryAdjustmentRow>(
        'SELECT * FROM inventory_adjustments WHERE id = $1 FOR UPDATE',
        [id]
      );
      if (adjustmentResult.rowCount === 0) {
        throw new Error('ADJUSTMENT_NOT_FOUND');
      }
      const adjustmentRow = adjustmentResult.rows[0];
      if (adjustmentRow.status === 'posted') {
        throw new Error('ADJUSTMENT_ALREADY_POSTED');
      }
      if (adjustmentRow.status === 'canceled') {
        throw new Error('ADJUSTMENT_CANCELED');
      }

      const linesResult = await client.query<InventoryAdjustmentLineRow>(
        'SELECT * FROM inventory_adjustment_lines WHERE inventory_adjustment_id = $1 ORDER BY line_number ASC',
        [id]
      );
      if (linesResult.rowCount === 0) {
        throw new Error('ADJUSTMENT_NO_LINES');
      }

      const movementId = uuidv4();
      await client.query(
        `INSERT INTO inventory_movements (
            id, movement_type, status, external_ref, occurred_at, posted_at, notes, created_at, updated_at
         ) VALUES ($1, 'adjustment', 'posted', $2, $3, $4, $5, $4, $4)`,
        [movementId, `inventory_adjustment:${id}`, adjustmentRow.occurred_at, now, adjustmentRow.notes ?? null]
      );

      for (const line of linesResult.rows) {
        const qty = roundQuantity(toNumber(line.quantity_delta));
        if (qty === 0) {
          throw new Error('ADJUSTMENT_LINE_ZERO');
        }
        await client.query(
          `INSERT INTO inventory_movement_lines (
              id, movement_id, item_id, location_id, quantity_delta, uom, reason_code, line_notes
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            uuidv4(),
            movementId,
            line.item_id,
            line.location_id,
            qty,
            line.uom,
            line.reason_code,
            line.notes ?? `Adjustment ${id} line ${line.line_number}`
          ]
        );
      }

      await client.query(
        `UPDATE inventory_adjustments
            SET status = 'posted',
                inventory_movement_id = $1,
                updated_at = $2
         WHERE id = $3`,
        [movementId, now, id]
      );

      return fetchInventoryAdjustmentById(id, client);
    });

    return res.json(adjustment);
  } catch (error: any) {
    if (error?.message === 'ADJUSTMENT_NOT_FOUND') {
      return res.status(404).json({ error: 'Inventory adjustment not found.' });
    }
    if (error?.message === 'ADJUSTMENT_ALREADY_POSTED') {
      return res.status(409).json({ error: 'Inventory adjustment already posted.' });
    }
    if (error?.message === 'ADJUSTMENT_CANCELED') {
      return res.status(400).json({ error: 'Canceled adjustments cannot be posted.' });
    }
    if (error?.message === 'ADJUSTMENT_NO_LINES') {
      return res.status(400).json({ error: 'Inventory adjustment has no lines to post.' });
    }
    if (error?.message === 'ADJUSTMENT_LINE_ZERO') {
      return res.status(400).json({ error: 'Inventory adjustment lines must have non-zero quantity.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to post inventory adjustment.' });
  }
});

app.post('/inventory-counts', async (req: Request, res: Response) => {
  const parsed = inventoryCountSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const data = parsed.data;
  const lineNumbers = new Set<number>();
  const itemUomKeys = new Set<string>();
  const normalizedLines = data.lines.map((line, index) => {
    const lineNumber = line.lineNumber ?? index + 1;
    if (lineNumbers.has(lineNumber)) {
      throw new Error('COUNT_DUPLICATE_LINE');
    }
    lineNumbers.add(lineNumber);
    const key = makeOnHandKey(line.itemId, line.uom);
    if (itemUomKeys.has(key)) {
      throw new Error('COUNT_DUPLICATE_ITEM');
    }
    itemUomKeys.add(key);
    return {
      lineNumber,
      itemId: line.itemId,
      uom: line.uom,
      countedQuantity: roundQuantity(line.countedQuantity),
      notes: line.notes ?? null
    };
  });

  const countId = uuidv4();
  const now = new Date();

  try {
    await withTransaction(async (client: PoolClient) => {
      await client.query(
        `INSERT INTO cycle_counts (
            id, status, counted_at, location_id, notes, created_at, updated_at
         ) VALUES ($1, 'draft', $2, $3, $4, $5, $5)`,
        [countId, new Date(data.countedAt), data.locationId, data.notes ?? null, now]
      );

      for (const line of normalizedLines) {
        await client.query(
          `INSERT INTO cycle_count_lines (
              id, cycle_count_id, line_number, item_id, uom, counted_quantity, notes
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [uuidv4(), countId, line.lineNumber, line.itemId, line.uom, line.countedQuantity, line.notes]
        );
      }
    });

    const count = await fetchCycleCountById(countId);
    return res.status(201).json(count);
  } catch (error: any) {
    if (error?.message === 'COUNT_DUPLICATE_LINE') {
      return res.status(400).json({ error: 'Line numbers must be unique within a cycle count.' });
    }
    if (error?.message === 'COUNT_DUPLICATE_ITEM') {
      return res.status(400).json({ error: 'Each item/UOM may only appear once in a cycle count.' });
    }
    if (error?.code === '23503') {
      return res.status(400).json({ error: 'Invalid reference: ensure location and items exist before counting.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create inventory count.' });
  }
});

app.get('/inventory-counts/:id', async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!z.string().uuid().safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid inventory count id.' });
  }

  try {
    const count = await fetchCycleCountById(id);
    if (!count) {
      return res.status(404).json({ error: 'Inventory count not found.' });
    }
    return res.json(count);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch inventory count.' });
  }
});

app.post('/inventory-counts/:id/post', async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!z.string().uuid().safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid inventory count id.' });
  }

  try {
    const count = await withTransaction(async (client: PoolClient) => {
      const now = new Date();
      const countResult = await client.query<CycleCountRow>('SELECT * FROM cycle_counts WHERE id = $1 FOR UPDATE', [id]);
      if (countResult.rowCount === 0) {
        throw new Error('COUNT_NOT_FOUND');
      }
      const cycleCount = countResult.rows[0];
      if (cycleCount.status === 'posted') {
        throw new Error('COUNT_ALREADY_POSTED');
      }
      if (cycleCount.status === 'canceled') {
        throw new Error('COUNT_CANCELED');
      }

      const linesResult = await client.query<CycleCountLineRow>(
        'SELECT * FROM cycle_count_lines WHERE cycle_count_id = $1 ORDER BY line_number ASC FOR UPDATE',
        [id]
      );
      if (linesResult.rowCount === 0) {
        throw new Error('COUNT_NO_LINES');
      }

      const items = linesResult.rows.map((line) => ({ itemId: line.item_id, uom: line.uom }));
      const systemMap = await loadSystemOnHandForLocation(
        cycleCount.location_id,
        cycleCount.counted_at,
        items,
        client
      );

      const deltas = linesResult.rows.map((line) => {
        const countedQty = roundQuantity(toNumber(line.counted_quantity));
        const systemQty = systemMap.get(makeOnHandKey(line.item_id, line.uom)) ?? 0;
        return {
          line,
          countedQty,
          systemQty,
          variance: roundQuantity(countedQty - systemQty)
        };
      });

      const movementId = uuidv4();
      await client.query(
        `INSERT INTO inventory_movements (
            id, movement_type, status, external_ref, occurred_at, posted_at, notes, created_at, updated_at
         ) VALUES ($1, 'count', 'posted', $2, $3, $4, $5, $4, $4)`,
        [movementId, `inventory_count:${id}`, cycleCount.counted_at, now, cycleCount.notes ?? null]
      );

      for (const delta of deltas) {
        await client.query(
          `UPDATE cycle_count_lines
              SET system_quantity = $1,
                  variance_quantity = $2
           WHERE id = $3`,
          [delta.systemQty, delta.variance, delta.line.id]
        );

        if (delta.variance !== 0) {
          await client.query(
            `INSERT INTO inventory_movement_lines (
                id, movement_id, item_id, location_id, quantity_delta, uom, reason_code, line_notes
             ) VALUES ($1, $2, $3, $4, $5, $6, 'cycle_count', $7)`,
            [
              uuidv4(),
              movementId,
              delta.line.item_id,
              cycleCount.location_id,
              delta.variance,
              delta.line.uom,
              delta.line.notes ?? `Cycle count ${id} line ${delta.line.line_number}`
            ]
          );
        }
      }

      await client.query(
        `UPDATE cycle_counts
            SET status = 'posted',
                inventory_movement_id = $1,
                updated_at = $2
         WHERE id = $3`,
        [movementId, now, id]
      );

      return fetchCycleCountById(id, client);
    });

    return res.json(count);
  } catch (error: any) {
    if (error?.message === 'COUNT_NOT_FOUND') {
      return res.status(404).json({ error: 'Inventory count not found.' });
    }
    if (error?.message === 'COUNT_ALREADY_POSTED') {
      return res.status(409).json({ error: 'Inventory count already posted.' });
    }
    if (error?.message === 'COUNT_CANCELED') {
      return res.status(400).json({ error: 'Canceled counts cannot be posted.' });
    }
    if (error?.message === 'COUNT_NO_LINES') {
      return res.status(400).json({ error: 'Inventory count has no lines to post.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to post inventory count.' });
  }
});

app.get('/purchase-order-receipts/:id/reconciliation', async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!z.string().uuid().safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid receipt id.' });
  }
  try {
    const reconciliation = await fetchReceiptReconciliation(id);
    if (!reconciliation) {
      return res.status(404).json({ error: 'Receipt not found.' });
    }
    return res.json(reconciliation);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to compute receipt reconciliation.' });
  }
});

app.post('/purchase-order-receipts/:id/close', async (req: Request, res: Response) => {
  const receiptId = req.params.id;
  if (!z.string().uuid().safeParse(receiptId).success) {
    return res.status(400).json({ error: 'Invalid receipt id.' });
  }
  const parsed = receiptCloseSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const data = parsed.data;

  try {
    const reconciliation = await withTransaction(async (client: PoolClient) => {
      const receiptRecon = await fetchReceiptReconciliation(receiptId, client);
      if (!receiptRecon) {
        throw new Error('RECEIPT_NOT_FOUND');
      }

      const closeoutResult = await client.query<CloseoutRow>(
        'SELECT * FROM inbound_closeouts WHERE purchase_order_receipt_id = $1 FOR UPDATE',
        [receiptId]
      );
      const existingCloseout = closeoutResult.rows[0];
      if (existingCloseout && existingCloseout.status === 'closed') {
        throw new Error('RECEIPT_ALREADY_CLOSED');
      }

      const blockingLines = receiptRecon.lines.filter((line) => line.blockedReasons.length > 0);
      if (blockingLines.length > 0) {
        const reasons = Array.from(new Set(blockingLines.flatMap((line) => line.blockedReasons)));
        const error: any = new Error('RECEIPT_NOT_ELIGIBLE');
        error.reasons = reasons;
        throw error;
      }

      const now = new Date();
      if (existingCloseout) {
        await client.query(
          `UPDATE inbound_closeouts
              SET status = 'closed',
                  closed_at = $1,
                  closed_by_actor_type = $2,
                  closed_by_actor_id = $3,
                  closeout_reason_code = $4,
                  notes = $5,
                  updated_at = $1
            WHERE id = $6`,
          [now, data.actorType ?? null, data.actorId ?? null, data.closeoutReasonCode ?? null, data.notes ?? null, existingCloseout.id]
        );
      } else {
        await client.query(
          `INSERT INTO inbound_closeouts (
              id, purchase_order_receipt_id, status, closed_at,
              closed_by_actor_type, closed_by_actor_id, closeout_reason_code, notes, created_at, updated_at
           ) VALUES ($1, $2, 'closed', $3, $4, $5, $6, $7, $3, $3)`,
          [
            uuidv4(),
            receiptId,
            now,
            data.actorType ?? null,
            data.actorId ?? null,
            data.closeoutReasonCode ?? null,
            data.notes ?? null
          ]
        );
      }

      return fetchReceiptReconciliation(receiptId, client);
    });

    return res.json(reconciliation);
  } catch (error: any) {
    if (error?.message === 'RECEIPT_NOT_FOUND') {
      return res.status(404).json({ error: 'Receipt not found.' });
    }
    if (error?.message === 'RECEIPT_ALREADY_CLOSED') {
      return res.status(409).json({ error: 'Receipt already closed.' });
    }
    if (error?.message === 'RECEIPT_NOT_ELIGIBLE') {
      return res.status(400).json({ error: 'Receipt cannot be closed.', reasons: error.reasons ?? [] });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to close receipt.' });
  }
});

app.post('/boms', async (req: Request, res: Response) => {
  const parsed = bomCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const data = parsed.data;
  const version = data.version;
  const lineNumbers = new Set<number>();
  for (const component of version.components) {
    if (lineNumbers.has(component.lineNumber)) {
      return res.status(400).json({ error: 'Component line numbers must be unique per BOM version.' });
    }
    lineNumbers.add(component.lineNumber);
  }

  const now = new Date();
  const bomId = uuidv4();
  const versionId = uuidv4();
  const versionNumber = version.versionNumber ?? 1;

  try {
    const createdBom = await withTransaction(async (client: PoolClient) => {
      await client.query(
        `INSERT INTO boms (id, bom_code, output_item_id, default_uom, active, notes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, true, $5, $6, $6)`,
        [bomId, data.bomCode, data.outputItemId, data.defaultUom, data.notes ?? null, now]
      );

      await client.query(
        `INSERT INTO bom_versions (
            id, bom_id, version_number, status, effective_from, effective_to,
            yield_quantity, yield_uom, notes, created_at, updated_at
         ) VALUES ($1, $2, $3, 'draft', $4, $5, $6, $7, $8, $9, $9)`,
        [
          versionId,
          bomId,
          versionNumber,
          version.effectiveFrom ?? null,
          version.effectiveTo ?? null,
          roundQuantity(version.yieldQuantity),
          version.yieldUom,
          version.notes ?? null,
          now
        ]
      );

      for (const component of version.components) {
        await client.query(
          `INSERT INTO bom_version_lines (
              id, bom_version_id, line_number, component_item_id, component_quantity,
              component_uom, scrap_factor, notes, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            uuidv4(),
            versionId,
            component.lineNumber,
            component.componentItemId,
            roundQuantity(component.quantityPer),
            component.uom,
            component.scrapFactor !== undefined ? roundQuantity(component.scrapFactor) : null,
            component.notes ?? null,
            now
          ]
        );
      }

      const bom = await fetchBomById(bomId, client);
      if (!bom) {
        throw new Error('BOM_NOT_FOUND_AFTER_CREATE');
      }
      return bom;
    });

    return res.status(201).json(createdBom);
  } catch (error: any) {
    if (error?.code === '23505') {
      if (error?.constraint === 'boms_bom_code_key') {
        return res.status(409).json({ error: 'bomCode must be unique.' });
      }
      if (error?.constraint === 'bom_version_lines_line_unique') {
        return res.status(400).json({ error: 'Component line numbers must be unique per BOM version.' });
      }
    }
    if (error?.code === '23503') {
      return res.status(400).json({ error: 'Referenced item does not exist.' });
    }
    if (error?.message === 'BOM_NOT_FOUND_AFTER_CREATE') {
      console.error(error);
      return res.status(500).json({ error: 'Failed to load BOM after creation.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create BOM.' });
  }
});

app.get('/boms/:id', async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!z.string().uuid().safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid BOM id.' });
  }

  try {
    const bom = await fetchBomById(id);
    if (!bom) {
      return res.status(404).json({ error: 'BOM not found.' });
    }
    return res.json(bom);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to load BOM.' });
  }
});

app.get('/items/:id/boms', async (req: Request, res: Response) => {
  const itemId = req.params.id;
  if (!z.string().uuid().safeParse(itemId).success) {
    return res.status(400).json({ error: 'Invalid item id.' });
  }

  try {
    const { rows } = await query(
      `SELECT
          b.id AS bom_id,
          b.bom_code,
          b.output_item_id,
          b.default_uom,
          b.active,
          b.notes AS bom_notes,
          b.created_at AS bom_created_at,
          b.updated_at AS bom_updated_at,
          v.id AS version_id,
          v.version_number,
          v.status,
          v.effective_from,
          v.effective_to,
          v.yield_quantity,
          v.yield_uom,
          v.notes AS version_notes,
          v.created_at AS version_created_at,
          v.updated_at AS version_updated_at
       FROM boms b
       LEFT JOIN bom_versions v ON v.bom_id = b.id
       WHERE b.output_item_id = $1
       ORDER BY b.created_at DESC, v.version_number DESC`,
      [itemId]
    );

    const bomMap = new Map<
      string,
      {
        id: string;
        bomCode: string;
        outputItemId: string;
        defaultUom: string;
        active: boolean;
        notes: string | null;
        createdAt: string;
        updatedAt: string;
        versions: any[];
      }
    >();

    for (const row of rows) {
      let entry = bomMap.get(row.bom_id);
      if (!entry) {
        entry = {
          id: row.bom_id,
          bomCode: row.bom_code,
          outputItemId: row.output_item_id,
          defaultUom: row.default_uom,
          active: row.active,
          notes: row.bom_notes,
          createdAt: row.bom_created_at,
          updatedAt: row.bom_updated_at,
          versions: []
        };
        bomMap.set(row.bom_id, entry);
      }
      if (row.version_id) {
        entry.versions.push({
          id: row.version_id,
          bomId: row.bom_id,
          versionNumber: row.version_number,
          status: row.status,
          effectiveFrom: row.effective_from,
          effectiveTo: row.effective_to,
          yieldQuantity: roundQuantity(toNumber(row.yield_quantity ?? 0)),
          yieldUom: row.yield_uom,
          notes: row.version_notes,
          createdAt: row.version_created_at,
          updatedAt: row.version_updated_at
        });
      }
    }

    return res.json({ itemId, boms: Array.from(bomMap.values()) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to list BOMs for item.' });
  }
});

app.post('/boms/:id/activate', async (req: Request, res: Response) => {
  const versionId = req.params.id;
  if (!z.string().uuid().safeParse(versionId).success) {
    return res.status(400).json({ error: 'Invalid BOM version id.' });
  }

  const parsed = bomActivationSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const effectiveFrom = parseDateInput(parsed.data.effectiveFrom);
  const effectiveTo = parsed.data.effectiveTo ? parseDateInput(parsed.data.effectiveTo) : null;
  if (!effectiveFrom) {
    return res.status(400).json({ error: 'effectiveFrom must be a valid ISO datetime.' });
  }
  if (parsed.data.effectiveTo && !effectiveTo) {
    return res.status(400).json({ error: 'effectiveTo must be a valid ISO datetime.' });
  }

  const effectiveFromIso = effectiveFrom.toISOString();
  const effectiveToIso = effectiveTo ? effectiveTo.toISOString() : null;
  const now = new Date();

  try {
    const bom = await withTransaction(async (client: PoolClient) => {
      const versionResult = await client.query<
        BomVersionRow & { output_item_id: string }
      >(
        `SELECT v.*, b.output_item_id
           FROM bom_versions v
           JOIN boms b ON b.id = v.bom_id
          WHERE v.id = $1
          FOR UPDATE`,
        [versionId]
      );
      if (versionResult.rowCount === 0) {
        throw new Error('BOM_VERSION_NOT_FOUND');
      }
      const versionRow = versionResult.rows[0];
      if (versionRow.status === 'active') {
        throw new Error('BOM_VERSION_ALREADY_ACTIVE');
      }
      const { rows: activeRows } = await client.query(
        `SELECT v.id, v.effective_from, v.effective_to
           FROM bom_versions v
           JOIN boms b ON b.id = v.bom_id
          WHERE b.output_item_id = $1
            AND v.status = 'active'
            AND v.id <> $2`,
        [versionRow.output_item_id, versionId]
      );
      for (const row of activeRows) {
        if (rangesOverlap(row.effective_from, row.effective_to, effectiveFrom, effectiveTo)) {
          throw new Error('BOM_EFFECTIVE_RANGE_OVERLAP');
        }
      }
      await client.query(
        `UPDATE bom_versions
            SET status = 'active',
                effective_from = $2,
                effective_to = $3,
                updated_at = $4
          WHERE id = $1`,
        [versionId, effectiveFromIso, effectiveToIso, now]
      );
      const updated = await fetchBomById(versionRow.bom_id, client);
      if (!updated) {
        throw new Error('BOM_NOT_FOUND_AFTER_UPDATE');
      }
      return updated;
    });

    return res.json(bom);
  } catch (error: any) {
    if (error?.message === 'BOM_VERSION_NOT_FOUND') {
      return res.status(404).json({ error: 'BOM version not found.' });
    }
    if (error?.message === 'BOM_VERSION_ALREADY_ACTIVE') {
      return res.status(409).json({ error: 'BOM version is already active.' });
    }
    if (error?.message === 'BOM_EFFECTIVE_RANGE_OVERLAP') {
      return res
        .status(409)
        .json({ error: 'Another BOM version is active for this item during the requested range.' });
    }
    if (error?.message === 'BOM_NOT_FOUND_AFTER_UPDATE') {
      console.error(error);
      return res.status(500).json({ error: 'Failed to load BOM after activation.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to activate BOM version.' });
  }
});

app.get('/items/:id/bom', async (req: Request, res: Response) => {
  const itemId = req.params.id;
  if (!z.string().uuid().safeParse(itemId).success) {
    return res.status(400).json({ error: 'Invalid item id.' });
  }
  const asOfParam = typeof req.query.asOf === 'string' ? req.query.asOf : undefined;
  let asOfDate: Date;
  if (asOfParam) {
    const parsedAsOf = parseDateInput(asOfParam);
    if (!parsedAsOf) {
      return res.status(400).json({ error: 'asOf must be a valid ISO datetime or date.' });
    }
    asOfDate = parsedAsOf;
  } else {
    asOfDate = new Date();
  }
  const asOfIso = asOfDate.toISOString();

  try {
    const { rows } = await query<{ bom_id: string; version_id: string }>(
      `SELECT b.id AS bom_id, v.id AS version_id
         FROM boms b
         JOIN bom_versions v ON v.bom_id = b.id
        WHERE b.output_item_id = $1
          AND v.status = 'active'
          AND v.effective_from <= $2
          AND (v.effective_to IS NULL OR v.effective_to >= $2)
        ORDER BY v.effective_from DESC
        LIMIT 1`,
      [itemId, asOfIso]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'No active BOM found for the specified date.' });
    }
    const { bom_id: bomId, version_id: versionId } = rows[0];
    const bom = await fetchBomById(bomId);
    if (!bom) {
      return res.status(404).json({ error: 'BOM not found.' });
    }
    const version = bom.versions.find((v) => v.id === versionId);
    if (!version) {
      return res.status(404).json({ error: 'BOM version not found.' });
    }
    return res.json({
      itemId,
      asOf: asOfIso,
      bom: {
        id: bom.id,
        bomCode: bom.bomCode,
        outputItemId: bom.outputItemId,
        defaultUom: bom.defaultUom,
        active: bom.active,
        notes: bom.notes,
        createdAt: bom.createdAt,
        updatedAt: bom.updatedAt
      },
      version
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to load effective BOM.' });
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

pool.on('error', (err) => {
  console.error('Unexpected DB pool error', err);
});

app.listen(PORT, () => {
  console.log(`Inventory Manager API listening on port ${PORT}`);
});

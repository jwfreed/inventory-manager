import express, { Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { pool, query, withTransaction } from './db';
import type { PoolClient } from 'pg';

const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.use(express.json());

const vendorSchema = z.object({
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(255),
  email: z.string().email().max(255).optional(),
  phone: z.string().max(32).optional()
});

const purchaseOrderLineSchema = z.object({
  lineNumber: z.number().int().positive().optional(),
  itemId: z.string().uuid(),
  uom: z.string().min(1).max(32),
  quantityOrdered: z.number().positive(),
  notes: z.string().max(1000).optional()
});

const isoDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use ISO date format YYYY-MM-DD');

const purchaseOrderSchema = z.object({
  poNumber: z.string().min(1).max(64),
  vendorId: z.string().uuid(),
  status: z.enum(['draft', 'submitted']).optional(),
  orderDate: isoDateString.optional(),
  expectedDate: isoDateString.optional(),
  shipToLocationId: z.string().uuid().optional(),
  vendorReference: z.string().max(255).optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(purchaseOrderLineSchema).min(1)
});

const receiptLineSchema = z.object({
  purchaseOrderLineId: z.string().uuid(),
  uom: z.string().min(1).max(32),
  quantityReceived: z.number().positive()
});

const purchaseOrderReceiptSchema = z.object({
  purchaseOrderId: z.string().uuid(),
  receivedAt: z.string().datetime(),
  receivedToLocationId: z.string().uuid().optional(),
  externalRef: z.string().max(255).optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(receiptLineSchema).min(1)
});

const qcEventSchema = z.object({
  purchaseOrderReceiptLineId: z.string().uuid(),
  eventType: z.enum(['hold', 'accept', 'reject']),
  quantity: z.number().positive(),
  uom: z.string().min(1).max(32),
  reasonCode: z.string().max(255).optional(),
  notes: z.string().max(2000).optional(),
  actorType: z.enum(['user', 'system']),
  actorId: z.string().max(255).optional()
});

const putawayLineInputSchema = z.object({
  purchaseOrderReceiptLineId: z.string().uuid(),
  toLocationId: z.string().uuid(),
  uom: z.string().min(1).max(32),
  quantity: z.number().positive(),
  lineNumber: z.number().int().positive().optional(),
  fromLocationId: z.string().uuid().optional(),
  notes: z.string().max(1000).optional()
});

const putawaySchema = z
  .object({
    sourceType: z.enum(['purchase_order_receipt', 'qc', 'manual']),
    purchaseOrderReceiptId: z.string().uuid().optional(),
    notes: z.string().max(2000).optional(),
    lines: z.array(putawayLineInputSchema).min(1)
  })
  .superRefine((data, ctx) => {
    if (data.sourceType === 'purchase_order_receipt' && !data.purchaseOrderReceiptId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'purchaseOrderReceiptId is required when sourceType is purchase_order_receipt',
        path: ['purchaseOrderReceiptId']
      });
    }
  });

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

const poCloseSchema = z.object({
  notes: z.string().max(2000).optional()
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

function mapPurchaseOrder(row: any, lines: any[]) {
  return {
    id: row.id,
    poNumber: row.po_number,
    vendorId: row.vendor_id,
    status: row.status,
    orderDate: row.order_date,
    expectedDate: row.expected_date,
    shipToLocationId: row.ship_to_location_id,
    vendorReference: row.vendor_reference,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines: lines.map((line) => ({
      id: line.id,
      purchaseOrderId: line.purchase_order_id,
      lineNumber: line.line_number,
      itemId: line.item_id,
      uom: line.uom,
      quantityOrdered: line.quantity_ordered,
      notes: line.notes,
      createdAt: line.created_at
    }))
  };
}

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

type QcBreakdown = { hold: number; accept: number; reject: number };

function defaultBreakdown(): QcBreakdown {
  return { hold: 0, accept: 0, reject: 0 };
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

async function loadQcBreakdown(lineIds: string[], client?: PoolClient): Promise<Map<string, QcBreakdown>> {
  const map = new Map<string, QcBreakdown>();
  if (lineIds.length === 0) {
    return map;
  }
  const executor = client ?? pool;
  const { rows } = await executor.query(
    `SELECT purchase_order_receipt_line_id AS line_id, event_type, SUM(quantity) AS total_quantity
       FROM qc_events
       WHERE purchase_order_receipt_line_id = ANY($1::uuid[])
       GROUP BY purchase_order_receipt_line_id, event_type`,
    [lineIds]
  );
  for (const row of rows) {
    const lineId = row.line_id as string;
    const breakdown = map.get(lineId) ?? defaultBreakdown();
    const eventType = row.event_type as keyof QcBreakdown;
    breakdown[eventType] = roundQuantity(toNumber(row.total_quantity));
    map.set(lineId, breakdown);
  }
  return map;
}

function mapReceiptLine(line: any, qcBreakdown: Map<string, QcBreakdown>) {
  const quantityReceived = roundQuantity(toNumber(line.quantity_received));
  return {
    id: line.id,
    purchaseOrderReceiptId: line.purchase_order_receipt_id,
    purchaseOrderLineId: line.purchase_order_line_id,
    uom: line.uom,
    quantityReceived,
    createdAt: line.created_at,
    qcSummary: buildQcSummary(line.id, qcBreakdown, quantityReceived)
  };
}

function mapReceipt(row: any, lineRows: any[], qcBreakdown: Map<string, QcBreakdown>) {
  return {
    id: row.id,
    purchaseOrderId: row.purchase_order_id,
    receivedAt: row.received_at,
    receivedToLocationId: row.received_to_location_id,
    inventoryMovementId: row.inventory_movement_id,
    externalRef: row.external_ref,
    notes: row.notes,
    createdAt: row.created_at,
    lines: lineRows.map((line) => mapReceiptLine(line, qcBreakdown))
  };
}

async function fetchReceiptById(id: string) {
  const receiptResult = await query('SELECT * FROM purchase_order_receipts WHERE id = $1', [id]);
  if (receiptResult.rowCount === 0) {
    return null;
  }
  const linesResult = await query(
    'SELECT * FROM purchase_order_receipt_lines WHERE purchase_order_receipt_id = $1 ORDER BY created_at ASC',
    [id]
  );
  const lineIds = linesResult.rows.map((line) => line.id);
  const breakdown = await loadQcBreakdown(lineIds);
  return mapReceipt(receiptResult.rows[0], linesResult.rows, breakdown);
}

function mapQcEvent(row: any) {
  return {
    id: row.id,
    purchaseOrderReceiptLineId: row.purchase_order_receipt_line_id,
    eventType: row.event_type,
    quantity: roundQuantity(toNumber(row.quantity)),
    uom: row.uom,
    reasonCode: row.reason_code,
    notes: row.notes,
    actorType: row.actor_type,
    actorId: row.actor_id,
    occurredAt: row.occurred_at,
    createdAt: row.created_at
  };
}

type ReceiptLineContext = {
  id: string;
  receiptId: string;
  purchaseOrderId: string;
  itemId: string;
  uom: string;
  quantityReceived: number;
  defaultFromLocationId: string | null;
};

async function loadReceiptLineContexts(
  lineIds: string[],
  client?: PoolClient
): Promise<Map<string, ReceiptLineContext>> {
  const map = new Map<string, ReceiptLineContext>();
  if (lineIds.length === 0) {
    return map;
  }
  const executor = client ?? pool;
  const { rows } = await executor.query(
    `SELECT
        prl.id,
        prl.purchase_order_receipt_id,
        prl.quantity_received,
        prl.uom,
        pol.item_id,
        pol.purchase_order_id,
        por.received_to_location_id
     FROM purchase_order_receipt_lines prl
     JOIN purchase_order_lines pol ON pol.id = prl.purchase_order_line_id
     JOIN purchase_order_receipts por ON por.id = prl.purchase_order_receipt_id
     WHERE prl.id = ANY($1::uuid[])`,
    [lineIds]
  );
  for (const row of rows) {
    map.set(row.id, {
      id: row.id,
      receiptId: row.purchase_order_receipt_id,
      purchaseOrderId: row.purchase_order_id,
      itemId: row.item_id,
      uom: row.uom,
      quantityReceived: roundQuantity(toNumber(row.quantity_received)),
      defaultFromLocationId: row.received_to_location_id
    });
  }
  return map;
}

type PutawayTotals = {
  posted: number;
  pending: number;
};

async function loadPutawayTotals(lineIds: string[], client?: PoolClient): Promise<Map<string, PutawayTotals>> {
  const map = new Map<string, PutawayTotals>();
  if (lineIds.length === 0) {
    return map;
  }
  const executor = client ?? pool;
  const { rows } = await executor.query(
    `SELECT
        purchase_order_receipt_line_id AS line_id,
        SUM(CASE WHEN status = 'completed' THEN COALESCE(quantity_moved, 0) ELSE 0 END) AS posted_qty,
        SUM(CASE WHEN status = 'pending' THEN COALESCE(quantity_planned, 0) ELSE 0 END) AS pending_qty
     FROM putaway_lines
     WHERE purchase_order_receipt_line_id = ANY($1::uuid[])
       AND status <> 'canceled'
     GROUP BY purchase_order_receipt_line_id`,
    [lineIds]
  );
  for (const row of rows) {
    map.set(row.line_id, {
      posted: roundQuantity(toNumber(row.posted_qty)),
      pending: roundQuantity(toNumber(row.pending_qty))
    });
  }
  return map;
}

type PutawayAvailability = {
  availableForPlanning: number;
  remainingAfterPosted: number;
  blockedReason?: string;
};

function calculatePutawayAvailability(
  context: ReceiptLineContext,
  qcBreakdown: QcBreakdown,
  totals: PutawayTotals,
  excludePendingQuantity = 0
): PutawayAvailability {
  const receiptQty = roundQuantity(context.quantityReceived);
  const rejected = roundQuantity(qcBreakdown.reject ?? 0);
  const hold = roundQuantity(qcBreakdown.hold ?? 0);
  const accept = roundQuantity(qcBreakdown.accept ?? 0);
  const baseAvailable = Math.max(0, receiptQty - rejected);

  let qcAllowed = baseAvailable;
  let blockedReason: string | undefined;
  if (accept > 0) {
    qcAllowed = Math.min(qcAllowed, accept);
  } else if (hold > 0) {
    qcAllowed = 0;
    blockedReason = 'Receipt line is on QC hold with no accepted quantity.';
  }

  const posted = roundQuantity(totals.posted ?? 0);
  const pending = Math.max(0, roundQuantity(totals.pending ?? 0) - roundQuantity(excludePendingQuantity));

  const remainingAfterPosted = Math.max(0, qcAllowed - posted);
  const availableForPlanning = Math.max(0, qcAllowed - posted - pending);

  if (availableForPlanning <= 0 && !blockedReason && remainingAfterPosted <= 0) {
    blockedReason = 'No remaining quantity available for putaway.';
  }

  return { availableForPlanning, remainingAfterPosted, blockedReason };
}

function calculateAcceptedQuantity(
  quantityReceived: number,
  qcBreakdown: QcBreakdown,
  allowBaseOnReject = true
): number {
  const rejected = roundQuantity(qcBreakdown.reject ?? 0);
  const hold = roundQuantity(qcBreakdown.hold ?? 0);
  const accepted = roundQuantity(qcBreakdown.accept ?? 0);
  if (accepted > 0) {
    return accepted;
  }
  if (hold > 0) {
    return 0;
  }
  if (!allowBaseOnReject) {
    return 0;
  }
  return Math.max(0, roundQuantity(quantityReceived) - rejected);
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

type PutawayLineRow = {
  id: string;
  putaway_id: string;
  purchase_order_receipt_line_id: string;
  line_number: number;
  item_id: string;
  uom: string;
  quantity_planned: string | number | null;
  quantity_moved: string | number | null;
  from_location_id: string;
  to_location_id: string;
  inventory_movement_id: string | null;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type PutawayRow = {
  id: string;
  status: string;
  source_type: string;
  purchase_order_receipt_id: string | null;
  inventory_movement_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
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

function mapPutawayLine(
  line: PutawayLineRow,
  context: ReceiptLineContext,
  qc: QcBreakdown,
  totals: PutawayTotals
) {
  const plannedQty = roundQuantity(toNumber(line.quantity_planned ?? line.quantity_moved ?? 0));
  const movedQty = line.quantity_moved ? roundQuantity(toNumber(line.quantity_moved)) : null;
  const availability = calculatePutawayAvailability(context, qc, totals);
  return {
    id: line.id,
    lineNumber: line.line_number,
    purchaseOrderReceiptLineId: line.purchase_order_receipt_line_id,
    itemId: line.item_id,
    uom: line.uom,
    quantityPlanned: plannedQty,
    quantityMoved: movedQty,
    fromLocationId: line.from_location_id,
    toLocationId: line.to_location_id,
    inventoryMovementId: line.inventory_movement_id,
    status: line.status,
    notes: line.notes,
    createdAt: line.created_at,
    updatedAt: line.updated_at,
    qcBreakdown: qc,
    remainingQuantityToPutaway: availability.remainingAfterPosted,
    availableForNewPutaway: availability.availableForPlanning
  };
}

function mapPutaway(
  row: PutawayRow,
  lines: PutawayLineRow[],
  contexts: Map<string, ReceiptLineContext>,
  qcMap: Map<string, QcBreakdown>,
  totalsMap: Map<string, PutawayTotals>
) {
  return {
    id: row.id,
    status: row.status,
    sourceType: row.source_type,
    purchaseOrderReceiptId: row.purchase_order_receipt_id,
    inventoryMovementId: row.inventory_movement_id,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines: lines.map((line) => {
      const context = contexts.get(line.purchase_order_receipt_line_id);
      const qc = qcMap.get(line.purchase_order_receipt_line_id) ?? defaultBreakdown();
      const totals = totalsMap.get(line.purchase_order_receipt_line_id) ?? { posted: 0, pending: 0 };
      if (!context) {
        throw new Error('Missing receipt line context for putaway line');
      }
      return mapPutawayLine(line, context, qc, totals);
    })
  };
}

async function fetchPutawayById(id: string) {
  const putawayResult = await query<PutawayRow>('SELECT * FROM putaways WHERE id = $1', [id]);
  if (putawayResult.rowCount === 0) {
    return null;
  }
  const linesResult = await query<PutawayLineRow>(
    'SELECT * FROM putaway_lines WHERE putaway_id = $1 ORDER BY line_number ASC',
    [id]
  );
  const receiptLineIds = linesResult.rows.map((line) => line.purchase_order_receipt_line_id);
  const contexts = await loadReceiptLineContexts(receiptLineIds);
  const qcBreakdown = await loadQcBreakdown(receiptLineIds);
  const totals = await loadPutawayTotals(receiptLineIds);
  return mapPutaway(putawayResult.rows[0], linesResult.rows, contexts, qcBreakdown, totals);
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

app.post('/vendors', async (req: Request, res: Response) => {
  const parsed = vendorSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const now = new Date();
  const id = uuidv4();

  try {
    const { rows } = await query(
      `INSERT INTO vendors (id, code, name, email, phone, active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, true, $6, $6)
       RETURNING id, code, name, email, phone, active, created_at, updated_at`,
      [id, parsed.data.code, parsed.data.name, parsed.data.email ?? null, parsed.data.phone ?? null, now]
    );
    return res.status(201).json(rows[0]);
  } catch (error: any) {
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'Vendor code must be unique.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create vendor.' });
  }
});

app.get('/vendors', async (_req: Request, res: Response) => {
  try {
    const { rows } = await query(
      'SELECT id, code, name, email, phone, active, created_at, updated_at FROM vendors ORDER BY created_at DESC'
    );
    return res.json({ data: rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to list vendors.' });
  }
});

app.post('/purchase-orders', async (req: Request, res: Response) => {
  const parsed = purchaseOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const data = parsed.data;
  const poId = uuidv4();
  const now = new Date();
  const status = data.status ?? 'draft';

  const lineNumbers = new Set<number>();
  let hasDuplicateLineNumbers = false;
  const normalizedLines = data.lines.map((line, index) => {
    const number = line.lineNumber ?? index + 1;
    if (lineNumbers.has(number)) {
      hasDuplicateLineNumbers = true;
    }
    lineNumbers.add(number);
    return { ...line, lineNumber: number };
  });
  if (hasDuplicateLineNumbers) {
    return res.status(400).json({ error: 'Line numbers must be unique within a purchase order.' });
  }

  try {
    const purchaseOrder = await withTransaction(async (client: PoolClient) => {
      const insertedOrder = await client.query(
        `INSERT INTO purchase_orders (
            id, po_number, vendor_id, status, order_date, expected_date,
            ship_to_location_id, vendor_reference, notes, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
         RETURNING *`,
        [
          poId,
          data.poNumber,
          data.vendorId,
          status,
          data.orderDate ?? null,
          data.expectedDate ?? null,
          data.shipToLocationId ?? null,
          data.vendorReference ?? null,
          data.notes ?? null,
          now
        ]
      );

      const lineInserts = [];
      for (const line of normalizedLines) {
        const lineResult = await client.query(
          `INSERT INTO purchase_order_lines (
              id, purchase_order_id, line_number, item_id, uom, quantity_ordered, notes
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [
            uuidv4(),
            poId,
            line.lineNumber,
            line.itemId,
            line.uom,
            line.quantityOrdered,
            line.notes ?? null
          ]
        );
        lineInserts.push(lineResult.rows[0]);
      }

      return mapPurchaseOrder(insertedOrder.rows[0], lineInserts);
    });

    return res.status(201).json(purchaseOrder);
  } catch (error: any) {
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'PO number must be unique.' });
    }
    if (error?.code === '23503') {
      return res.status(400).json({ error: 'Referenced vendor, item, or location does not exist.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create purchase order.' });
  }
});

app.get('/purchase-orders/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!z.string().uuid().safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid purchase order id.' });
  }

  try {
    const poResult = await query('SELECT * FROM purchase_orders WHERE id = $1', [id]);
    if (poResult.rowCount === 0) {
      return res.status(404).json({ error: 'Purchase order not found.' });
    }

    const lineResult = await query(
      'SELECT * FROM purchase_order_lines WHERE purchase_order_id = $1 ORDER BY line_number ASC',
      [id]
    );

    return res.json(mapPurchaseOrder(poResult.rows[0], lineResult.rows));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch purchase order.' });
  }
});

app.get('/purchase-orders', async (req: Request, res: Response) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const offset = Math.max(0, Number(req.query.offset) || 0);

  try {
    const { rows } = await query(
      `SELECT id, po_number, vendor_id, status, order_date, expected_date, ship_to_location_id,
              vendor_reference, notes, created_at, updated_at
         FROM purchase_orders
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    return res.json({ data: rows, paging: { limit, offset } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to list purchase orders.' });
  }
});

app.post('/purchase-orders/:id/close', async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!z.string().uuid().safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid purchase order id.' });
  }

  const parsed = poCloseSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const purchaseOrder = await withTransaction(async (client: PoolClient) => {
      const now = new Date();
      const poResult = await client.query('SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE', [id]);
      if (poResult.rowCount === 0) {
        throw new Error('PO_NOT_FOUND');
      }
      const po = poResult.rows[0];
      if (po.status === 'closed') {
        throw new Error('PO_ALREADY_CLOSED');
      }
      if (po.status === 'canceled') {
        throw new Error('PO_CANCELED');
      }

      const receiptsResult = await client.query(
        `SELECT por.id, ico.status
           FROM purchase_order_receipts por
           LEFT JOIN inbound_closeouts ico ON ico.purchase_order_receipt_id = por.id
          WHERE por.purchase_order_id = $1`,
        [id]
      );
      const blocking = receiptsResult.rows.filter((row: any) => row.status !== 'closed');
      if (receiptsResult.rowCount > 0 && blocking.length > 0) {
        throw new Error('PO_RECEIPTS_OPEN');
      }

      await client.query('UPDATE purchase_orders SET status = $1, updated_at = $2 WHERE id = $3', ['closed', now, id]);

      const updatedPo = await client.query('SELECT * FROM purchase_orders WHERE id = $1', [id]);
      const linesResult = await client.query(
        'SELECT * FROM purchase_order_lines WHERE purchase_order_id = $1 ORDER BY line_number ASC',
        [id]
      );
      return mapPurchaseOrder(updatedPo.rows[0], linesResult.rows);
    });

    return res.json(purchaseOrder);
  } catch (error: any) {
    if (error?.message === 'PO_NOT_FOUND') {
      return res.status(404).json({ error: 'Purchase order not found.' });
    }
    if (error?.message === 'PO_ALREADY_CLOSED') {
      return res.status(409).json({ error: 'Purchase order already closed.' });
    }
    if (error?.message === 'PO_CANCELED') {
      return res.status(400).json({ error: 'Canceled purchase orders cannot be closed.' });
    }
    if (error?.message === 'PO_RECEIPTS_OPEN') {
      return res.status(409).json({ error: 'All receipts must be closed before closing the purchase order.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to close purchase order.' });
  }
});

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

app.post('/purchase-order-receipts', async (req: Request, res: Response) => {
  const parsed = purchaseOrderReceiptSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const data = parsed.data;
  const receiptId = uuidv4();
  const uniqueSet = new Set(data.lines.map((line) => line.purchaseOrderLineId));
  const uniqueLineIds = Array.from(uniqueSet);

  try {
    const { rows: poLineRows } = await query(
      'SELECT id, purchase_order_id, uom FROM purchase_order_lines WHERE id = ANY($1::uuid[])',
      [uniqueLineIds]
    );
    if (poLineRows.length !== uniqueLineIds.length) {
      return res.status(400).json({ error: 'One or more purchase order lines were not found.' });
    }
    const poLineMap = new Map<string, { purchase_order_id: string; uom: string }>();
    for (const row of poLineRows) {
      poLineMap.set(row.id, { purchase_order_id: row.purchase_order_id, uom: row.uom });
    }
    for (const line of data.lines) {
      const poLine = poLineMap.get(line.purchaseOrderLineId);
      if (!poLine) {
        return res.status(400).json({ error: 'Invalid purchase order line reference.' });
      }
      if (poLine.purchase_order_id !== data.purchaseOrderId) {
        return res
          .status(400)
          .json({ error: 'All receipt lines must reference the provided purchase order.' });
      }
      if (poLine.uom !== line.uom) {
        return res
          .status(400)
          .json({ error: 'Receipt line UOM must match the purchase order line UOM.' });
      }
    }

    await withTransaction(async (client: PoolClient) => {
      await client.query(
        `INSERT INTO purchase_order_receipts (
            id, purchase_order_id, received_at, received_to_location_id,
            inventory_movement_id, external_ref, notes
         ) VALUES ($1, $2, $3, $4, NULL, $5, $6)`,
        [
          receiptId,
          data.purchaseOrderId,
          new Date(data.receivedAt),
          data.receivedToLocationId ?? null,
          data.externalRef ?? null,
          data.notes ?? null
        ]
      );

      for (const line of data.lines) {
        await client.query(
          `INSERT INTO purchase_order_receipt_lines (
              id, purchase_order_receipt_id, purchase_order_line_id, uom, quantity_received
           ) VALUES ($1, $2, $3, $4, $5)`,
          [uuidv4(), receiptId, line.purchaseOrderLineId, line.uom, line.quantityReceived]
        );
      }
    });

    const receipt = await fetchReceiptById(receiptId);
    if (!receipt) {
      return res
        .status(500)
        .json({ error: 'Receipt was created but could not be reloaded. Please retry fetch.' });
    }
    return res.status(201).json(receipt);
  } catch (error: any) {
    if (error?.code === '23503') {
      return res.status(400).json({ error: 'Referenced purchase order, line, or location does not exist.' });
    }
    if (error?.code === '23514') {
      return res.status(400).json({ error: 'Quantity received must be greater than zero.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create purchase order receipt.' });
  }
});

app.get('/purchase-order-receipts/:id', async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!z.string().uuid().safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid receipt id.' });
  }
  try {
    const receipt = await fetchReceiptById(id);
    if (!receipt) {
      return res.status(404).json({ error: 'Receipt not found.' });
    }
    return res.json(receipt);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch receipt.' });
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

app.post('/qc-events', async (req: Request, res: Response) => {
  const parsed = qcEventSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const data = parsed.data;

  try {
    const lineResult = await query(
      'SELECT id, uom, quantity_received FROM purchase_order_receipt_lines WHERE id = $1',
      [data.purchaseOrderReceiptLineId]
    );
    if (lineResult.rowCount === 0) {
      return res.status(404).json({ error: 'Receipt line not found.' });
    }
    const line = lineResult.rows[0];
    if (line.uom !== data.uom) {
      return res.status(400).json({ error: 'QC event UOM must match the receipt line UOM.' });
    }

    const totalResult = await query(
      'SELECT COALESCE(SUM(quantity), 0) AS total FROM qc_events WHERE purchase_order_receipt_line_id = $1',
      [data.purchaseOrderReceiptLineId]
    );
    const currentTotal = roundQuantity(toNumber(totalResult.rows[0]?.total ?? 0));
    const lineQuantity = roundQuantity(toNumber(line.quantity_received));
    const newTotal = roundQuantity(currentTotal + data.quantity);
    if (newTotal - lineQuantity > 1e-6) {
      return res
        .status(400)
        .json({ error: 'QC quantities cannot exceed the received quantity for the line.' });
    }

    const { rows } = await query(
      `INSERT INTO qc_events (
          id, purchase_order_receipt_line_id, event_type, quantity, uom, reason_code, notes, actor_type, actor_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        uuidv4(),
        data.purchaseOrderReceiptLineId,
        data.eventType,
        data.quantity,
        data.uom,
        data.reasonCode ?? null,
        data.notes ?? null,
        data.actorType,
        data.actorId ?? null
      ]
    );
    return res.status(201).json(mapQcEvent(rows[0]));
  } catch (error: any) {
    if (error?.code === '23503') {
      return res.status(400).json({ error: 'Referenced receipt line does not exist.' });
    }
    if (error?.code === '23514') {
      return res.status(400).json({ error: 'QC quantity must be greater than zero.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create QC event.' });
  }
});

app.get('/purchase-order-receipt-lines/:id/qc-events', async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!z.string().uuid().safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid receipt line id.' });
  }

  try {
    const lineResult = await query('SELECT id FROM purchase_order_receipt_lines WHERE id = $1', [id]);
    if (lineResult.rowCount === 0) {
      return res.status(404).json({ error: 'Receipt line not found.' });
    }
    const { rows } = await query(
      `SELECT * FROM qc_events
         WHERE purchase_order_receipt_line_id = $1
         ORDER BY occurred_at ASC`,
      [id]
    );
    return res.json({ data: rows.map(mapQcEvent) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to list QC events.' });
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

app.post('/putaways', async (req: Request, res: Response) => {
  const parsed = putawaySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const data = parsed.data;
  const lineIds = data.lines.map((line) => line.purchaseOrderReceiptLineId);
  const uniqueLineIds = Array.from(new Set(lineIds));

  try {
    const contexts = await loadReceiptLineContexts(uniqueLineIds);
    if (contexts.size !== uniqueLineIds.length) {
      return res.status(400).json({ error: 'One or more receipt lines were not found.' });
    }

    const qcBreakdown = await loadQcBreakdown(uniqueLineIds);
    const totals = await loadPutawayTotals(uniqueLineIds);

    const requestedByLine = new Map<string, number>();
    const normalizedLines = data.lines.map((line, index) => {
      const context = contexts.get(line.purchaseOrderReceiptLineId)!;

      if (context.uom !== line.uom) {
        throw new Error('PUTAWAY_UOM_MISMATCH');
      }

      const fromLocationId = line.fromLocationId ?? context.defaultFromLocationId;
      if (!fromLocationId) {
        throw new Error('PUTAWAY_FROM_LOCATION_REQUIRED');
      }
      if (fromLocationId === line.toLocationId) {
        throw new Error('PUTAWAY_SAME_LOCATION');
      }

      const qty = roundQuantity(line.quantity);
      requestedByLine.set(line.purchaseOrderReceiptLineId, (requestedByLine.get(line.purchaseOrderReceiptLineId) ?? 0) + qty);

      return {
        lineNumber: line.lineNumber ?? index + 1,
        receiptLineId: line.purchaseOrderReceiptLineId,
        toLocationId: line.toLocationId,
        fromLocationId,
        itemId: context.itemId,
        uom: line.uom,
        quantity: qty,
        notes: line.notes ?? null
      };
    });

    const lineNumbers = new Set<number>();
    for (const line of normalizedLines) {
      if (lineNumbers.has(line.lineNumber)) {
        return res.status(400).json({ error: 'Line numbers must be unique within a putaway.' });
      }
      lineNumbers.add(line.lineNumber);
    }

    for (const [lineId, qty] of requestedByLine.entries()) {
      const context = contexts.get(lineId)!;
      const qc = qcBreakdown.get(lineId) ?? defaultBreakdown();
      const total = totals.get(lineId) ?? { posted: 0, pending: 0 };
      const availability = calculatePutawayAvailability(context, qc, total);
      if (availability.blockedReason && availability.availableForPlanning <= 0) {
        return res.status(409).json({ error: availability.blockedReason });
      }
      if (roundQuantity(qty) - availability.availableForPlanning > 1e-6) {
        return res.status(409).json({
          error: `Requested quantity exceeds available putaway quantity for receipt line ${lineId}.`
        });
      }
    }

    let receiptIdForPutaway = data.purchaseOrderReceiptId ?? null;
    if (!receiptIdForPutaway) {
      const uniqueReceiptIds = new Set(
        normalizedLines.map((line) => contexts.get(line.receiptLineId)?.receiptId).filter(Boolean) as string[]
      );
      if (uniqueReceiptIds.size === 1) {
        receiptIdForPutaway = Array.from(uniqueReceiptIds)[0] ?? null;
      }
    }

    if (data.sourceType === 'purchase_order_receipt' && !receiptIdForPutaway) {
      return res.status(400).json({ error: 'purchaseOrderReceiptId is required for receipt-based putaways.' });
    }

    const now = new Date();
    const putawayId = uuidv4();

    await withTransaction(async (client: PoolClient) => {
      await client.query(
        `INSERT INTO putaways (
            id, status, source_type, purchase_order_receipt_id, notes, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $6)`,
        [putawayId, 'draft', data.sourceType, receiptIdForPutaway ?? null, data.notes ?? null, now]
      );

      for (const line of normalizedLines) {
        await client.query(
          `INSERT INTO putaway_lines (
              id, putaway_id, purchase_order_receipt_line_id, line_number,
              item_id, uom, quantity_planned, from_location_id, to_location_id,
              status, notes, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11, $11)`,
          [
            uuidv4(),
            putawayId,
            line.receiptLineId,
            line.lineNumber,
            line.itemId,
            line.uom,
            line.quantity,
            line.fromLocationId,
            line.toLocationId,
            line.notes,
            now
          ]
        );
      }
    });

    const putaway = await fetchPutawayById(putawayId);
    return res.status(201).json(putaway);
  } catch (error: any) {
    if (error?.message === 'PUTAWAY_UOM_MISMATCH') {
      return res.status(400).json({ error: 'Putaway line UOM must match the receipt line UOM.' });
    }
    if (error?.message === 'PUTAWAY_FROM_LOCATION_REQUIRED') {
      return res.status(400).json({ error: 'fromLocationId is required when the receipt lacks a staging location.' });
    }
    if (error?.message === 'PUTAWAY_SAME_LOCATION') {
      return res.status(400).json({ error: 'Source and destination locations must differ.' });
    }
    if (error?.code === '23503') {
      return res
        .status(400)
        .json({ error: 'Invalid reference: ensure locations, items, and receipt lines exist before putaway.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create putaway.' });
  }
});

app.get('/putaways/:id', async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!z.string().uuid().safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid putaway id.' });
  }

  try {
    const putaway = await fetchPutawayById(id);
    if (!putaway) {
      return res.status(404).json({ error: 'Putaway not found.' });
    }
    return res.json(putaway);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch putaway.' });
  }
});

app.post('/putaways/:id/post', async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!z.string().uuid().safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid putaway id.' });
  }

  try {
    const now = new Date();
    await withTransaction(async (client: PoolClient) => {
      const putawayResult = await client.query<PutawayRow>('SELECT * FROM putaways WHERE id = $1 FOR UPDATE', [id]);
      if (putawayResult.rowCount === 0) {
        throw new Error('PUTAWAY_NOT_FOUND');
      }
      const putaway = putawayResult.rows[0];
      if (putaway.status === 'completed') {
        throw new Error('PUTAWAY_ALREADY_POSTED');
      }
      if (putaway.status === 'canceled') {
        throw new Error('PUTAWAY_CANCELED');
      }

      const linesResult = await client.query<PutawayLineRow>(
        'SELECT * FROM putaway_lines WHERE putaway_id = $1 ORDER BY line_number ASC FOR UPDATE',
        [id]
      );
      if (linesResult.rowCount === 0) {
        throw new Error('PUTAWAY_NO_LINES');
      }
      const pendingLines = linesResult.rows.filter((line) => line.status === 'pending');
      if (pendingLines.length === 0) {
        throw new Error('PUTAWAY_NOTHING_TO_POST');
      }

      const receiptLineIds = pendingLines.map((line) => line.purchase_order_receipt_line_id);
      const contexts = await loadReceiptLineContexts(receiptLineIds);
      const qcBreakdown = await loadQcBreakdown(receiptLineIds);
      const totals = await loadPutawayTotals(receiptLineIds);

      const movementId = uuidv4();

      for (const line of pendingLines) {
        const context = contexts.get(line.purchase_order_receipt_line_id);
        if (!context) {
          throw new Error('PUTAWAY_CONTEXT_MISSING');
        }
        if (!line.quantity_planned || toNumber(line.quantity_planned) <= 0) {
          throw new Error('PUTAWAY_INVALID_QUANTITY');
        }
        const qc = qcBreakdown.get(line.purchase_order_receipt_line_id) ?? defaultBreakdown();
        const total = totals.get(line.purchase_order_receipt_line_id) ?? { posted: 0, pending: 0 };
        const availability = calculatePutawayAvailability(
          context,
          qc,
          total,
          roundQuantity(toNumber(line.quantity_planned))
        );
        if (availability.blockedReason && availability.availableForPlanning <= 0) {
          throw new Error('PUTAWAY_QC_BLOCKED');
        }
        if (roundQuantity(toNumber(line.quantity_planned)) - availability.availableForPlanning > 1e-6) {
          throw new Error('PUTAWAY_QUANTITY_EXCEEDED');
        }
        if (roundQuantity(toNumber(line.quantity_planned)) - availability.remainingAfterPosted > 1e-6) {
          throw new Error('PUTAWAY_ACCEPT_LIMIT');
        }
      }

      await client.query(
        `INSERT INTO inventory_movements (
            id, movement_type, status, external_ref, occurred_at, posted_at, notes, created_at, updated_at
         ) VALUES ($1, 'transfer', 'posted', $2, $3, $3, $4, $3, $3)`,
        [movementId, `putaway:${id}`, now, `Putaway ${id}`]
      );

      for (const line of pendingLines) {
        const qty = roundQuantity(toNumber(line.quantity_planned));
        const lineNote = `Putaway ${id} line ${line.line_number}`;
        await client.query(
          `INSERT INTO inventory_movement_lines (
              id, movement_id, item_id, location_id, quantity_delta, uom, reason_code, line_notes
           ) VALUES ($1, $2, $3, $4, $5, $6, 'putaway', $7)`,
          [uuidv4(), movementId, line.item_id, line.from_location_id, -qty, line.uom, lineNote]
        );
        await client.query(
          `INSERT INTO inventory_movement_lines (
              id, movement_id, item_id, location_id, quantity_delta, uom, reason_code, line_notes
           ) VALUES ($1, $2, $3, $4, $5, $6, 'putaway', $7)`,
          [uuidv4(), movementId, line.item_id, line.to_location_id, qty, line.uom, lineNote]
        );
        await client.query(
          `UPDATE putaway_lines
              SET status = 'completed',
                  quantity_moved = $1,
                  inventory_movement_id = $2,
                  updated_at = $3
           WHERE id = $4`,
          [qty, movementId, now, line.id]
        );
      }

      await client.query(
        'UPDATE putaways SET status = $1, inventory_movement_id = $2, updated_at = $3 WHERE id = $4',
        ['completed', movementId, now, id]
      );
    });

    const putaway = await fetchPutawayById(id);
    return res.json(putaway);
  } catch (error: any) {
    if (error?.message === 'PUTAWAY_NOT_FOUND') {
      return res.status(404).json({ error: 'Putaway not found.' });
    }
    if (error?.message === 'PUTAWAY_ALREADY_POSTED') {
      return res.status(409).json({ error: 'Putaway already posted.' });
    }
    if (error?.message === 'PUTAWAY_CANCELED') {
      return res.status(400).json({ error: 'Canceled putaways cannot be posted.' });
    }
    if (error?.message === 'PUTAWAY_NO_LINES') {
      return res.status(400).json({ error: 'Putaway has no lines to post.' });
    }
    if (error?.message === 'PUTAWAY_NOTHING_TO_POST') {
      return res.status(400).json({ error: 'All putaway lines are already completed or canceled.' });
    }
    if (error?.message === 'PUTAWAY_INVALID_QUANTITY') {
      return res.status(400).json({ error: 'Putaway line quantity must be greater than zero before posting.' });
    }
    if (error?.message === 'PUTAWAY_QC_BLOCKED') {
      return res.status(409).json({ error: 'QC hold or missing acceptance prevents posting this putaway.' });
    }
    if (error?.message === 'PUTAWAY_QUANTITY_EXCEEDED') {
      return res.status(409).json({ error: 'Putaway quantity exceeds available accepted quantity.' });
    }
    if (error?.message === 'PUTAWAY_ACCEPT_LIMIT') {
      return res.status(409).json({ error: 'Requested putaway quantity exceeds accepted quantity.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to post putaway.' });
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

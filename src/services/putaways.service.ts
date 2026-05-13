import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db';
import { putawaySchema } from '../schemas/putaways.schema';
import type { z } from 'zod';
import { roundQuantity, toNumber } from '../lib/numbers';
import { recordAuditLog } from '../lib/audit';
import { validateSufficientStock, validateLocationCapacity } from './stockValidation.service';
import { getCanonicalMovementFields } from './uomCanonical.service';
import { resolveWarehouseIdForLocation } from './warehouseDefaults.service';
import {
  persistInventoryMovement
} from '../domains/inventory';
import { relocateTransferCostLayersInTx, type TransferLinePair } from './transferCosting.service';
import {
  runInventoryCommand,
  type InventoryCommandProjectionOp
} from '../modules/platform/application/runInventoryCommand';
import {
  buildPostedDocumentReplayResult,
  buildReplayCorruptionError,
  buildInventoryBalanceProjectionOp,
  buildMovementPostedEvent,
  sortDeterministicMovementLines
} from '../modules/platform/application/inventoryMutationSupport';
import {
  calculateAcceptedQuantity,
  calculatePutawayAvailability,
  defaultBreakdown,
  loadQcBreakdown,
  loadPutawayTotals,
  loadReceiptLineContexts,
  type ReceiptLineContext
} from './inbound/receivingAggregations';
import {
  RECEIPT_ALLOCATION_STATUSES,
  moveReceiptAllocations,
  type ValidatedReceiptAllocationMutationContext
} from '../domain/receipts/receiptAllocationModel';
import { validateOrRebuildReceiptAllocationsForMutation } from '../domain/receipts/receiptAllocationRebuilder';
import { resolveInventoryBin } from '../domain/receipts/receiptBinModel';
import { completePutawayCommand } from '../domain/receipts/receiptCommands';

type PutawayInput = z.infer<typeof putawaySchema>;

type PutawayLineRow = {
  id: string;
  putaway_id: string;
  purchase_order_receipt_line_id: string;
  line_number: number;
  item_id: string;
  item_sku?: string | null;
  item_name?: string | null;
  uom: string;
  quantity_planned: string | number | null;
  quantity_moved: string | number | null;
  from_location_id: string;
  from_bin_id: string;
  from_location_code?: string | null;
  from_location_name?: string | null;
  to_location_id: string;
  to_bin_id: string;
  to_location_code?: string | null;
  to_location_name?: string | null;
  inventory_movement_id: string | null;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type PutawayRow = {
  id: string;
  putaway_number?: string | null;
  status: string;
  source_type: string;
  purchase_order_receipt_id: string | null;
  inventory_movement_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
  completed_by_user_id?: string | null;
  completed_by_name?: string | null;
  completed_by_email?: string | null;
  receipt_number?: string | null;
  purchase_order_number?: string | null;
};

type PreparedPutawayTransferLine = {
  putawayLine: PutawayLineRow;
  quantity: number;
  lineNote: string;
  canonicalOut: Awaited<ReturnType<typeof getCanonicalMovementFields>>;
  canonicalIn: Awaited<ReturnType<typeof getCanonicalMovementFields>>;
  fromWarehouseId: string;
  toWarehouseId: string;
  fromBinId: string | null;
  toBinId: string | null;
  groupKey: string;
  outLineId: string;
  inLineId: string;
};

type PutawayTransferGroup = {
  key: string;
  canonicalUom: string;
  fromLocationId: string;
  toLocationId: string;
  fromBinId: string | null;
  toBinId: string | null;
  fromWarehouseId: string;
  toWarehouseId: string;
  lines: PreparedPutawayTransferLine[];
};

type PutawayPostedMovementGroup = {
  movementId: string;
  lines: PreparedPutawayTransferLine[];
};

function buildPutawayTransferGroupKey(params: {
  canonicalUom: string;
  fromLocationId: string;
  toLocationId: string;
  fromBinId: string | null;
  toBinId: string | null;
  fromWarehouseId: string;
  toWarehouseId: string;
}) {
  return [
    params.canonicalUom,
    params.fromWarehouseId,
    params.toWarehouseId,
    params.fromLocationId,
    params.toLocationId,
    params.fromBinId ?? '',
    params.toBinId ?? ''
  ].join('|');
}

function groupPreparedPutawayTransferLines(
  preparedLines: PreparedPutawayTransferLine[]
): PutawayTransferGroup[] {
  const groups = new Map<string, PutawayTransferGroup>();
  for (const prepared of preparedLines) {
    const line = prepared.putawayLine;
    const existing = groups.get(prepared.groupKey);
    if (existing) {
      existing.lines.push(prepared);
      continue;
    }
    groups.set(prepared.groupKey, {
      key: prepared.groupKey,
      canonicalUom: prepared.canonicalIn.canonicalUom,
      fromLocationId: line.from_location_id,
      toLocationId: line.to_location_id,
      fromBinId: line.from_bin_id,
      toBinId: line.to_bin_id,
      fromWarehouseId: prepared.fromWarehouseId,
      toWarehouseId: prepared.toWarehouseId,
      lines: [prepared]
    });
  }
  return Array.from(groups.values()).sort((left, right) => left.key.localeCompare(right.key));
}

async function assertReceiptLinesNotVoided(tenantId: string, lineIds: string[]) {
  if (lineIds.length === 0) return;
  const { rows } = await query(
    `SELECT prl.id, por.status
       FROM purchase_order_receipt_lines prl
       JOIN purchase_order_receipts por ON por.id = prl.purchase_order_receipt_id AND por.tenant_id = prl.tenant_id
      WHERE prl.id = ANY($1::uuid[]) AND prl.tenant_id = $2`,
    [lineIds, tenantId]
  );
  for (const row of rows) {
    if (row.status === 'voided') {
      const error: any = new Error('PUTAWAY_RECEIPT_VOIDED');
      error.lineId = row.id;
      throw error;
    }
  }
}

async function generatePutawayNumber() {
  const { rows } = await query(`SELECT nextval('putaway_number_seq') AS seq`);
  const seq = Number(rows[0]?.seq ?? 0);
  const padded = String(seq).padStart(6, '0');
  return `P-${padded}`;
}

function mapPutawayLine(
  line: PutawayLineRow,
  context: ReceiptLineContext,
  qc: ReturnType<typeof defaultBreakdown>,
  totals: { posted: number; pending: number; qa: number; hold: number }
) {
  const plannedQty = roundQuantity(toNumber(line.quantity_planned ?? line.quantity_moved ?? 0));
  const movedQty = line.quantity_moved ? roundQuantity(toNumber(line.quantity_moved)) : null;
  const availability = calculatePutawayAvailability(context, qc, totals);
  return {
    id: line.id,
    lineNumber: line.line_number,
    purchaseOrderReceiptLineId: line.purchase_order_receipt_line_id,
    itemId: line.item_id,
    itemSku: (line as any).item_sku ?? null,
    itemName: (line as any).item_name ?? null,
    uom: line.uom,
    quantityPlanned: plannedQty,
    quantityMoved: movedQty,
    fromLocationId: line.from_location_id,
    fromBinId: line.from_bin_id,
    fromLocationCode: (line as any).from_location_code ?? null,
    fromLocationName: (line as any).from_location_name ?? null,
    toLocationId: line.to_location_id,
    toBinId: line.to_bin_id,
    toLocationCode: (line as any).to_location_code ?? null,
    toLocationName: (line as any).to_location_name ?? null,
    inventoryMovementId: line.inventory_movement_id,
    status: line.status,
    notes: line.notes,
    createdAt: line.created_at,
    updatedAt: line.updated_at,
    qcBreakdown: qc,
    remainingQuantityToPutaway: availability.remainingAfterPosted,
    availableForNewPutaway: availability.availableForPlanning,
    putawayBlockedReason: availability.blockedReason ?? null
  };
}

function mapPutaway(row: PutawayRow, lines: PutawayLineRow[], contexts: Map<string, ReceiptLineContext>, qcMap: Map<string, ReturnType<typeof defaultBreakdown>>, totalsMap: Map<string, { posted: number; pending: number; qa: number; hold: number }>) {
  return {
    id: row.id,
    putawayNumber: row.putaway_number ?? null,
    status: row.status,
    sourceType: row.source_type,
    purchaseOrderReceiptId: row.purchase_order_receipt_id,
    receiptNumber: row.receipt_number ?? null,
    purchaseOrderNumber: row.purchase_order_number ?? null,
    inventoryMovementId: row.inventory_movement_id,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? null,
    completedByUserId: row.completed_by_user_id ?? null,
    completedByName: row.completed_by_name ?? null,
    completedByEmail: row.completed_by_email ?? null,
    lines: lines.map((line) => {
      const context = contexts.get(line.purchase_order_receipt_line_id);
      const qc = qcMap.get(line.purchase_order_receipt_line_id) ?? defaultBreakdown();
      const totals = totalsMap.get(line.purchase_order_receipt_line_id) ?? { posted: 0, pending: 0, qa: 0, hold: 0 };
      if (!context) {
        throw new Error('Missing receipt line context for putaway line');
      }
      return mapPutawayLine(line, context, qc, totals);
    })
  };
}

export async function fetchPutawayById(tenantId: string, id: string, client?: PoolClient) {
  const executor = client ? client.query.bind(client) : query;
  const putawayResult = await executor<PutawayRow>(
    `SELECT p.*,
            por.receipt_number,
            po.po_number AS purchase_order_number,
            u.full_name AS completed_by_name,
            u.email AS completed_by_email
       FROM putaways p
       LEFT JOIN purchase_order_receipts por ON por.id = p.purchase_order_receipt_id AND por.tenant_id = p.tenant_id
       LEFT JOIN purchase_orders po ON po.id = por.purchase_order_id AND po.tenant_id = por.tenant_id
       LEFT JOIN users u ON u.id = p.completed_by_user_id
      WHERE p.id = $1 AND p.tenant_id = $2`,
    [id, tenantId]
  );
  if (putawayResult.rowCount === 0) {
    return null;
  }
  const linesResult = await executor<PutawayLineRow>(
    `SELECT pl.*,
            i.sku AS item_sku,
            i.name AS item_name,
            lf.code AS from_location_code,
            lf.name AS from_location_name,
            lt.code AS to_location_code,
            lt.name AS to_location_name
       FROM putaway_lines pl
       LEFT JOIN items i ON i.id = pl.item_id AND i.tenant_id = pl.tenant_id
       LEFT JOIN locations lf ON lf.id = pl.from_location_id AND lf.tenant_id = pl.tenant_id
       LEFT JOIN locations lt ON lt.id = pl.to_location_id AND lt.tenant_id = pl.tenant_id
      WHERE pl.putaway_id = $1 AND pl.tenant_id = $2
      ORDER BY pl.line_number ASC`,
    [id, tenantId]
  );
  const receiptLineIds = linesResult.rows.map((line) => line.purchase_order_receipt_line_id);
  const contexts = await loadReceiptLineContexts(tenantId, receiptLineIds, client);
  const qcBreakdown = await loadQcBreakdown(tenantId, receiptLineIds, client);
  const totals = await loadPutawayTotals(tenantId, receiptLineIds, client);
  return mapPutaway(putawayResult.rows[0], linesResult.rows, contexts, qcBreakdown, totals);
}

async function repairPutawayReplayAggregateState(
  client: PoolClient,
  tenantId: string,
  putawayId: string,
  movementId: string | null
) {
  const now = new Date();
  await client.query(
    `UPDATE putaway_lines
        SET status = 'completed',
            quantity_moved = COALESCE(quantity_moved, quantity_planned),
            inventory_movement_id = CASE
              WHEN $1::uuid IS NULL THEN inventory_movement_id
              ELSE COALESCE(inventory_movement_id, $1::uuid)
            END,
            updated_at = $2
      WHERE putaway_id = $3
        AND tenant_id = $4
        AND status <> 'canceled'`,
    [movementId, now, putawayId, tenantId]
  );
  await client.query(
    `UPDATE putaways
        SET status = 'completed',
            inventory_movement_id = CASE
              WHEN $1::uuid IS NULL THEN inventory_movement_id
              ELSE COALESCE(inventory_movement_id, $1::uuid)
            END,
            updated_at = $2,
            completed_at = COALESCE(completed_at, $2)
      WHERE id = $3
        AND tenant_id = $4`,
    [movementId, now, putawayId, tenantId]
  );
}

async function loadPutawayReplayMovementExpectations(params: {
  client: PoolClient;
  tenantId: string;
  putawayId: string;
  fallbackMovementId: string | null;
}) {
  const result = await params.client.query<{
    line_id: string;
    line_movement_id: string | null;
    header_movement_id: string | null;
  }>(
    `SELECT pl.id AS line_id,
            pl.inventory_movement_id AS line_movement_id,
            p.inventory_movement_id AS header_movement_id
       FROM putaway_lines pl
       JOIN putaways p
         ON p.id = pl.putaway_id
        AND p.tenant_id = pl.tenant_id
      WHERE pl.putaway_id = $1
        AND pl.tenant_id = $2
        AND pl.status <> 'canceled'
      ORDER BY pl.line_number ASC, pl.id ASC`,
    [params.putawayId, params.tenantId]
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new Error('PUTAWAY_NO_LINES');
  }

  const lineMovementIds = result.rows
    .map((row) => row.line_movement_id)
    .filter((movementId): movementId is string => Boolean(movementId));
  const distinctLineMovementIds = Array.from(new Set(lineMovementIds)).sort();
  const missingLineMovementCount = result.rows.length - lineMovementIds.length;
  const headerMovementId = params.fallbackMovementId ?? result.rows[0]?.header_movement_id ?? null;

  let movementIdByLineId = new Map<string, string>();
  let singleRepairMovementId: string | null = null;

  if (missingLineMovementCount === 0) {
    movementIdByLineId = new Map(result.rows.map((row) => [row.line_id, row.line_movement_id!]));
    singleRepairMovementId = distinctLineMovementIds.length === 1 ? distinctLineMovementIds[0] : null;
  } else if (distinctLineMovementIds.length === 0 && headerMovementId) {
    movementIdByLineId = new Map(result.rows.map((row) => [row.line_id, headerMovementId]));
    singleRepairMovementId = headerMovementId;
  } else if (distinctLineMovementIds.length === 1) {
    const movementId = distinctLineMovementIds[0];
    movementIdByLineId = new Map(
      result.rows.map((row) => [row.line_id, row.line_movement_id ?? movementId])
    );
    singleRepairMovementId = movementId;
  } else {
    throw buildReplayCorruptionError({
      tenantId: params.tenantId,
      putawayId: params.putawayId,
      reason: 'putaway_line_movement_missing_for_multi_movement_replay',
      missingLineMovementCount,
      movementIds: distinctLineMovementIds
    });
  }

  const lineCountByMovementId = new Map<string, number>();
  for (const movementId of movementIdByLineId.values()) {
    lineCountByMovementId.set(movementId, (lineCountByMovementId.get(movementId) ?? 0) + 1);
  }
  const authoritativeMovements = Array.from(lineCountByMovementId.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([movementId, lineCount]) => ({
      movementId,
      expectedLineCount: lineCount * 2
    }));
  if (authoritativeMovements.length === 0) {
    throw buildReplayCorruptionError({
      tenantId: params.tenantId,
      putawayId: params.putawayId,
      reason: 'putaway_authoritative_movement_missing'
    });
  }

  return {
    authoritativeMovements,
    singleRepairMovementId
  };
}

async function buildPutawayReplayResult(params: {
  tenantId: string;
  putawayId: string;
  fallbackMovementId?: string | null;
  client: PoolClient;
}) {
  const replayState = await loadPutawayReplayMovementExpectations({
    client: params.client,
    tenantId: params.tenantId,
    putawayId: params.putawayId,
    fallbackMovementId: params.fallbackMovementId ?? null
  });
  return buildPostedDocumentReplayResult({
    tenantId: params.tenantId,
    authoritativeMovements: replayState.authoritativeMovements,
    client: params.client,
    preFetchIntegrityCheck: async () => {
      await repairPutawayReplayAggregateState(
        params.client,
        params.tenantId,
        params.putawayId,
        replayState.singleRepairMovementId
      );
    },
    fetchAggregateView: () => fetchPutawayById(params.tenantId, params.putawayId, params.client),
    aggregateNotFoundError: new Error('PUTAWAY_NOT_FOUND'),
    authoritativeEvents: replayState.authoritativeMovements.map((movement) =>
      buildMovementPostedEvent(movement.movementId)
    ),
    responseStatus: 200
  });
}

async function moveReceiptAllocationsToAvailable(params: {
  client: PoolClient;
  tenantId: string;
  movementId: string;
  occurredAt: Date;
  pendingLines: PutawayLineRow[];
  destinationMovementLineIdByPutawayLineId: Map<string, string>;
  allocationContextByReceiptLineId: Map<string, ValidatedReceiptAllocationMutationContext>;
}) {
  for (const line of params.pendingLines) {
    const allocationContext = params.allocationContextByReceiptLineId.get(line.purchase_order_receipt_line_id);
    if (!allocationContext) {
      throw new Error('PUTAWAY_ALLOCATION_VALIDATION_REQUIRED');
    }
    try {
      await moveReceiptAllocations({
        client: params.client,
        tenantId: params.tenantId,
        context: allocationContext,
        receiptLineId: line.purchase_order_receipt_line_id,
        quantity: roundQuantity(toNumber(line.quantity_planned ?? 0)),
        sourceStatus: RECEIPT_ALLOCATION_STATUSES.QA,
        sourceBinId: line.from_bin_id,
        destinationLocationId: line.to_location_id,
        destinationBinId: line.to_bin_id,
        movementId: params.movementId,
        movementLineId: params.destinationMovementLineIdByPutawayLineId.get(line.id) ?? null,
        occurredAt: params.occurredAt,
        destinationStatus: RECEIPT_ALLOCATION_STATUSES.AVAILABLE
      });
    } catch (error) {
      if ((error as Error).message === 'RECEIPT_ALLOCATION_PRECHECK_FAILED') {
        throw new Error('PUTAWAY_ALLOCATION_INSUFFICIENT_QA');
      }
      throw error;
    }
  }
}

export async function createPutaway(
  tenantId: string,
  data: PutawayInput,
  actor?: { type: 'user' | 'system'; id?: string | null },
  options?: { idempotencyKey?: string | null }
) {
  const lineIds = data.lines.map((line) => line.purchaseOrderReceiptLineId);
  const uniqueLineIds = Array.from(new Set(lineIds));
  await assertReceiptLinesNotVoided(tenantId, uniqueLineIds);
  const contexts = await loadReceiptLineContexts(tenantId, uniqueLineIds);
  if (contexts.size !== uniqueLineIds.length) {
    throw new Error('PUTAWAY_LINES_NOT_FOUND');
  }
  const qcBreakdown = await loadQcBreakdown(tenantId, uniqueLineIds);
  const totals = await loadPutawayTotals(tenantId, uniqueLineIds);

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
    const qty = toNumber(line.quantity);
    requestedByLine.set(line.purchaseOrderReceiptLineId, (requestedByLine.get(line.purchaseOrderReceiptLineId) ?? 0) + qty);
    return {
      lineNumber: line.lineNumber ?? index + 1,
      receiptLineId: line.purchaseOrderReceiptLineId,
      toLocationId: line.toLocationId,
      toBinId: line.toBinId ?? null,
      fromLocationId,
      fromBinId: line.fromBinId ?? null,
      itemId: context.itemId,
      uom: line.uom,
      quantity: qty,
      notes: line.notes ?? null
    };
  });

  const lineNumbers = new Set<number>();
  for (const line of normalizedLines) {
    if (lineNumbers.has(line.lineNumber)) {
      throw new Error('PUTAWAY_DUPLICATE_LINE');
    }
    lineNumbers.add(line.lineNumber);
  }

  for (const [lineId, qty] of requestedByLine.entries()) {
    const context = contexts.get(lineId)!;
    const qc = qcBreakdown.get(lineId) ?? defaultBreakdown();
    const total = totals.get(lineId) ?? { posted: 0, pending: 0, qa: 0, hold: 0 };
    const availability = calculatePutawayAvailability(context, qc, total);
    if (availability.blockedReason && availability.availableForPlanning <= 0) {
      throw new Error('PUTAWAY_BLOCKED');
    }
    if (roundQuantity(qty) - availability.availableForPlanning > 1e-6) {
      const error: any = new Error('PUTAWAY_QUANTITY_EXCEEDED');
      error.lineId = lineId;
      throw error;
    }
  }

  // Validate location capacity
  const itemsByLocation = new Map<string, { itemId: string; quantity: number; uom: string }[]>();
  for (const line of normalizedLines) {
    const items = itemsByLocation.get(line.toLocationId) ?? [];
    items.push({ itemId: line.itemId, quantity: line.quantity, uom: line.uom });
    itemsByLocation.set(line.toLocationId, items);
  }

  for (const [locationId, items] of itemsByLocation.entries()) {
    await validateLocationCapacity(tenantId, locationId, items);
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
    throw new Error('PUTAWAY_RECEIPT_REQUIRED');
  }

  const now = new Date();
  const putawayId = uuidv4();
  const idempotencyKey = options?.idempotencyKey ?? null;
  const putawayNumber = await generatePutawayNumber();

  await withTransaction(async (client) => {
    if (idempotencyKey) {
      const existing = await client.query(
        `SELECT id FROM putaways WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenantId, idempotencyKey]
      );
      if ((existing.rowCount ?? 0) > 0) {
        return;
      }
    }
    await client.query(
      `INSERT INTO putaways (
          id, tenant_id, status, source_type, purchase_order_receipt_id, notes, idempotency_key, created_at, updated_at, putaway_number
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9)`,
      [
        putawayId,
        tenantId,
        'draft',
        data.sourceType,
        receiptIdForPutaway ?? null,
        data.notes ?? null,
        idempotencyKey,
        now,
        putawayNumber
      ]
    );

    for (const line of normalizedLines) {
      const fromWarehouseId = await resolveWarehouseIdForLocation(tenantId, line.fromLocationId, client);
      const toWarehouseId = await resolveWarehouseIdForLocation(tenantId, line.toLocationId, client);
      const fromBinId = (
        await resolveInventoryBin({
          client,
          tenantId,
          warehouseId: fromWarehouseId,
          locationId: line.fromLocationId,
          binId: line.fromBinId,
          allowDefaultBinResolution: true
        })
      ).id;
      const toBinId = (
        await resolveInventoryBin({
          client,
          tenantId,
          warehouseId: toWarehouseId,
          locationId: line.toLocationId,
          binId: line.toBinId,
          allowDefaultBinResolution: true
        })
      ).id;
      await client.query(
        `INSERT INTO putaway_lines (
            id, tenant_id, putaway_id, purchase_order_receipt_line_id, line_number,
            item_id, uom, quantity_planned, from_location_id, from_bin_id, to_location_id, to_bin_id,
            status, notes, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending', $13, $14, $14)`,
        [
          uuidv4(),
          tenantId,
          putawayId,
          line.receiptLineId,
          line.lineNumber,
          line.itemId,
          line.uom,
          line.quantity,
          line.fromLocationId,
          fromBinId,
          line.toLocationId,
          toBinId,
          line.notes,
          now
        ]
      );
    }

    if (actor) {
      await recordAuditLog(
        {
          tenantId,
          actorType: actor.type,
          actorId: actor.id ?? null,
          action: 'create',
          entityType: 'putaway',
          entityId: putawayId,
          occurredAt: now,
          metadata: {
            sourceType: data.sourceType,
            purchaseOrderReceiptId: receiptIdForPutaway ?? null,
            lineCount: normalizedLines.length
          }
        },
        client
      );
    }
  });

  const putawayIdResolved = idempotencyKey
    ? (await query<{ id: string }>(
        'SELECT id FROM putaways WHERE tenant_id = $1 AND idempotency_key = $2',
        [tenantId, idempotencyKey]
      )).rows[0]?.id ?? putawayId
    : putawayId;
  const putaway = await fetchPutawayById(tenantId, putawayIdResolved);
  if (!putaway) {
    throw new Error('PUTAWAY_NOT_FOUND_AFTER_CREATE');
  }
  return putaway;
}

export async function postPutaway(
  tenantId: string,
  id: string,
  context?: {
    actor?: { type: 'user' | 'system'; id?: string | null; role?: string | null };
    overrideRequested?: boolean;
    overrideReason?: string | null;
  }
) {
  let putaway: PutawayRow | null = null;
  let putawayLines: PutawayLineRow[] = [];
  let pendingLines: PutawayLineRow[] = [];
  let warehouseIdsByLocation = new Map<string, string>();

  return runInventoryCommand<any>({
    tenantId,
    endpoint: 'putaways.post',
    operation: 'putaway_post',
    retryOptions: { retries: 0 },
    lockTargets: async (client) => {
      const putawayResult = await client.query<PutawayRow>(
        'SELECT * FROM putaways WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
        [id, tenantId]
      );
      if (putawayResult.rowCount === 0) {
        throw new Error('PUTAWAY_NOT_FOUND');
      }
      putaway = putawayResult.rows[0];
      if (putaway.status === 'canceled') {
        throw new Error('PUTAWAY_CANCELED');
      }

      const linesResult = await client.query<PutawayLineRow>(
        'SELECT * FROM putaway_lines WHERE putaway_id = $1 AND tenant_id = $2 ORDER BY line_number ASC FOR UPDATE',
        [id, tenantId]
      );
      if (linesResult.rowCount === 0) {
        throw new Error('PUTAWAY_NO_LINES');
      }
      putawayLines = linesResult.rows;
      if (putaway.status === 'completed') {
        pendingLines = [];
        return [];
      }
      pendingLines = putawayLines.filter((line) => line.status === 'pending');
      if (pendingLines.length === 0) {
        throw new Error('PUTAWAY_NOTHING_TO_POST');
      }

      warehouseIdsByLocation = new Map<string, string>();
      const targets: Array<{ tenantId: string; warehouseId: string; itemId: string }> = [];
      for (const line of pendingLines) {
        if (!warehouseIdsByLocation.has(line.from_location_id)) {
          warehouseIdsByLocation.set(
            line.from_location_id,
            await resolveWarehouseIdForLocation(tenantId, line.from_location_id, client)
          );
        }
        if (!warehouseIdsByLocation.has(line.to_location_id)) {
          warehouseIdsByLocation.set(
            line.to_location_id,
            await resolveWarehouseIdForLocation(tenantId, line.to_location_id, client)
          );
        }
        targets.push({
          tenantId,
          warehouseId: warehouseIdsByLocation.get(line.from_location_id)!,
          itemId: line.item_id
        });
        targets.push({
          tenantId,
          warehouseId: warehouseIdsByLocation.get(line.to_location_id)!,
          itemId: line.item_id
        });
      }
      return targets.sort((left, right) => {
        const warehouseCompare = left.warehouseId.localeCompare(right.warehouseId);
        if (warehouseCompare !== 0) return warehouseCompare;
        return left.itemId.localeCompare(right.itemId);
      });
    },
    execute: async ({ client }) => {
      if (!putaway) {
        throw new Error('PUTAWAY_NOT_FOUND');
      }
      if (putaway.status === 'completed') {
        return buildPutawayReplayResult({
          tenantId,
          putawayId: id,
          fallbackMovementId: putaway.inventory_movement_id,
          client
        });
      }

      const now = new Date();
      const receiptLineIds = pendingLines.map((line) => line.purchase_order_receipt_line_id);
      await assertReceiptLinesNotVoided(tenantId, receiptLineIds);
      const contexts = await loadReceiptLineContexts(tenantId, receiptLineIds, client);
      const allocationContextByReceiptLineId = new Map<string, ValidatedReceiptAllocationMutationContext>();
      const linesByReceiptId = new Map<string, PutawayLineRow[]>();
      for (const line of pendingLines) {
        const receiptId = contexts.get(line.purchase_order_receipt_line_id)?.receiptId;
        if (!receiptId) {
          throw new Error('PUTAWAY_CONTEXT_MISSING');
        }
        const receiptLines = linesByReceiptId.get(receiptId) ?? [];
        receiptLines.push(line);
        linesByReceiptId.set(receiptId, receiptLines);
      }
      for (const [receiptId, lines] of linesByReceiptId.entries()) {
        const allocationContext = await validateOrRebuildReceiptAllocationsForMutation({
          client,
          tenantId,
          receiptId,
          occurredAt: now,
          requirements: lines.map((line) => ({
            receiptLineId: line.purchase_order_receipt_line_id,
            requiredStatus: RECEIPT_ALLOCATION_STATUSES.QA,
            requiredBinId: line.from_bin_id,
            requiredQuantity: roundQuantity(toNumber(line.quantity_planned ?? 0))
          }))
        });
        for (const line of lines) {
          allocationContextByReceiptLineId.set(line.purchase_order_receipt_line_id, allocationContext);
        }
      }
      const qcBreakdown = await loadQcBreakdown(tenantId, receiptLineIds, client);
      const totals = await loadPutawayTotals(tenantId, receiptLineIds, client);

      for (const line of pendingLines) {
        const receiptContext = contexts.get(line.purchase_order_receipt_line_id);
        if (!receiptContext) {
          throw new Error('PUTAWAY_CONTEXT_MISSING');
        }
        if (!line.quantity_planned || toNumber(line.quantity_planned) <= 0) {
          throw new Error('PUTAWAY_INVALID_QUANTITY');
        }
        const qc = qcBreakdown.get(line.purchase_order_receipt_line_id) ?? defaultBreakdown();
        const total = totals.get(line.purchase_order_receipt_line_id) ?? { posted: 0, pending: 0, qa: 0, hold: 0 };
        const availability = calculatePutawayAvailability(
          receiptContext,
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

      const validation = await validateSufficientStock(
        tenantId,
        now,
        pendingLines.map((line) => ({
          warehouseId: warehouseIdsByLocation.get(line.from_location_id) ?? '',
          itemId: line.item_id,
          locationId: line.from_location_id,
          uom: line.uom,
          quantityToConsume: roundQuantity(toNumber(line.quantity_planned ?? 0))
        })),
        {
          actorId: context?.actor?.id ?? null,
          actorRole: context?.actor?.role ?? null,
          overrideRequested: context?.overrideRequested,
          overrideReason: context?.overrideReason ?? null,
          overrideReference: `putaway:${id}`
        },
        { client }
      );

      const preparedPutawayLines: PreparedPutawayTransferLine[] = [];
      for (const line of pendingLines) {
        const qty = toNumber(line.quantity_planned);
        const lineNote = `Putaway ${id} line ${line.line_number}`;
        const fromWarehouseId = warehouseIdsByLocation.get(line.from_location_id) ?? '';
        const toWarehouseId = warehouseIdsByLocation.get(line.to_location_id) ?? '';

        const canonicalOut = await getCanonicalMovementFields(
          tenantId,
          line.item_id,
          -qty,
          line.uom,
          client
        );
        const canonicalIn = await getCanonicalMovementFields(
          tenantId,
          line.item_id,
          qty,
          line.uom,
          client
        );
        if (
          canonicalOut.canonicalUom !== canonicalIn.canonicalUom
          || Math.abs(Math.abs(canonicalOut.quantityDeltaCanonical) - canonicalIn.quantityDeltaCanonical) > 1e-6
        ) {
          throw new Error('TRANSFER_CANONICAL_MISMATCH');
        }
        const groupKey = buildPutawayTransferGroupKey({
          canonicalUom: canonicalIn.canonicalUom,
          fromLocationId: line.from_location_id,
          toLocationId: line.to_location_id,
          fromBinId: line.from_bin_id,
          toBinId: line.to_bin_id,
          fromWarehouseId,
          toWarehouseId
        });
        preparedPutawayLines.push({
          putawayLine: line,
          quantity: qty,
          lineNote,
          canonicalOut,
          canonicalIn,
          fromWarehouseId,
          toWarehouseId,
          fromBinId: line.from_bin_id,
          toBinId: line.to_bin_id,
          groupKey,
          outLineId: uuidv4(),
          inLineId: uuidv4()
        });
      }

      const transferGroups = groupPreparedPutawayTransferLines(preparedPutawayLines);
      const projectionOps: InventoryCommandProjectionOp[] = [];
      const postedMovementGroups: PutawayPostedMovementGroup[] = [];

      for (const [groupIndex, group] of transferGroups.entries()) {
        const groupOrdinal = groupIndex + 1;
        const movementId = uuidv4();
        const movementPreparedLines = group.lines.flatMap((prepared) => [
          {
            id: prepared.outLineId,
            putawayLineId: prepared.putawayLine.id,
            sourceLineId: `${prepared.putawayLine.id}#0`,
            warehouseId: prepared.fromWarehouseId,
            itemId: prepared.putawayLine.item_id,
            locationId: prepared.putawayLine.from_location_id,
            reasonCode: 'putaway',
            lineNotes: prepared.lineNote,
            canonicalFields: prepared.canonicalOut
          },
          {
            id: prepared.inLineId,
            putawayLineId: prepared.putawayLine.id,
            sourceLineId: `${prepared.putawayLine.id}#1`,
            warehouseId: prepared.toWarehouseId,
            itemId: prepared.putawayLine.item_id,
            locationId: prepared.putawayLine.to_location_id,
            reasonCode: 'putaway',
            lineNotes: prepared.lineNote,
            canonicalFields: prepared.canonicalIn
          }
        ]);
        const sortedPreparedLines = sortDeterministicMovementLines(
          movementPreparedLines,
          (line) => ({
            tenantId,
            warehouseId: line.warehouseId,
            locationId: line.locationId,
            itemId: line.itemId,
            canonicalUom: line.canonicalFields.canonicalUom,
            sourceLineId: line.sourceLineId
          })
        );

        const movement = await persistInventoryMovement(client, {
          id: movementId,
          tenantId,
          movementType: 'transfer',
          status: 'posted',
          externalRef: `putaway:${id}:transfer:${groupOrdinal}`,
          sourceType: 'putaway',
          sourceId: `${id}:transfer:${groupOrdinal}`,
          idempotencyKey: `putaway:${id}:transfer:${groupOrdinal}`,
          occurredAt: now,
          postedAt: now,
          notes: `Putaway ${id} transfer group ${groupOrdinal}`,
          metadata: validation.overrideMetadata ?? null,
          createdAt: now,
          updatedAt: now,
          lines: sortedPreparedLines.map((line) => ({
            id: line.id,
            warehouseId: line.warehouseId,
            sourceLineId: line.sourceLineId,
            eventTimestamp: now,
            itemId: line.itemId,
            locationId: line.locationId,
            quantityDelta: line.canonicalFields.quantityDeltaCanonical,
            uom: line.canonicalFields.canonicalUom,
            quantityDeltaEntered: line.canonicalFields.quantityDeltaEntered,
            uomEntered: line.canonicalFields.uomEntered,
            quantityDeltaCanonical: line.canonicalFields.quantityDeltaCanonical,
            canonicalUom: line.canonicalFields.canonicalUom,
            uomDimension: line.canonicalFields.uomDimension,
            reasonCode: line.reasonCode,
            lineNotes: line.lineNotes,
            createdAt: now
          }))
        });
        if (!movement.created) {
          throw buildReplayCorruptionError({
            tenantId,
            putawayId: id,
            movementId: movement.movementId,
            reason: 'putaway_group_movement_exists_before_completion',
            groupKey: group.key
          });
        }

        const destinationMovementLineIdByPutawayLineId = new Map<string, string>();
        const transferPairByPutawayLineId = new Map<string, TransferLinePair>();
        for (const prepared of group.lines) {
          transferPairByPutawayLineId.set(prepared.putawayLine.id, {
            itemId: prepared.putawayLine.item_id,
            sourceLocationId: prepared.putawayLine.from_location_id,
            destinationLocationId: prepared.putawayLine.to_location_id,
            outLineId: '',
            inLineId: '',
            quantity: prepared.canonicalIn.quantityDeltaCanonical,
            uom: prepared.canonicalIn.canonicalUom
          });
        }

        for (const line of sortedPreparedLines) {
          projectionOps.push(
            buildInventoryBalanceProjectionOp({
              tenantId,
              itemId: line.itemId,
              locationId: line.locationId,
              uom: line.canonicalFields.canonicalUom,
              deltaOnHand: line.canonicalFields.quantityDeltaCanonical
            })
          );

          const pair = transferPairByPutawayLineId.get(line.putawayLineId);
          if (!pair) {
            throw new Error('PUTAWAY_TRANSFER_PAIR_MISSING');
          }
          if (line.canonicalFields.quantityDeltaCanonical < 0) {
            pair.outLineId = line.id;
          } else {
            pair.inLineId = line.id;
            destinationMovementLineIdByPutawayLineId.set(line.putawayLineId, line.id);
          }
        }

        const transferPairs: TransferLinePair[] = [];
        for (const prepared of group.lines) {
          const line = prepared.putawayLine;
          await client.query(
            `UPDATE putaway_lines
                SET status = 'completed',
                    quantity_moved = $1,
                    inventory_movement_id = $2,
                    updated_at = $3
             WHERE id = $4 AND tenant_id = $5`,
            [toNumber(line.quantity_planned), movement.movementId, now, line.id, tenantId]
          );

          const pair = transferPairByPutawayLineId.get(line.id);
          if (!pair?.outLineId || !pair.inLineId) {
            throw new Error('PUTAWAY_TRANSFER_PAIR_INCOMPLETE');
          }
          transferPairs.push({
            itemId: pair.itemId,
            sourceLocationId: pair.sourceLocationId,
            destinationLocationId: pair.destinationLocationId,
            outLineId: pair.outLineId,
            inLineId: pair.inLineId,
            quantity: pair.quantity,
            uom: pair.uom
          });
        }

        await relocateTransferCostLayersInTx({
          client,
          tenantId,
          transferMovementId: movement.movementId,
          occurredAt: now,
          notes: `Putaway ${id}`,
          pairs: transferPairs
        });

        await moveReceiptAllocationsToAvailable({
          client,
          tenantId,
          movementId: movement.movementId,
          occurredAt: now,
          pendingLines: group.lines.map((prepared) => prepared.putawayLine),
          destinationMovementLineIdByPutawayLineId,
          allocationContextByReceiptLineId
        });

        postedMovementGroups.push({
          movementId: movement.movementId,
          lines: group.lines
        });
      }

      const primaryMovementId = postedMovementGroups[0]?.movementId;
      if (!primaryMovementId) {
        throw new Error('PUTAWAY_NOTHING_TO_POST');
      }

      await client.query(
        `UPDATE putaways
            SET status = $1,
                inventory_movement_id = $2,
                updated_at = $3,
                completed_at = $3,
                completed_by_user_id = $6
          WHERE id = $4 AND tenant_id = $5`,
        ['completed', primaryMovementId, now, id, tenantId, context?.actor?.id ?? null]
      );

      if (context?.actor) {
        await recordAuditLog(
          {
            tenantId,
            actorType: context.actor.type,
            actorId: context.actor.id ?? null,
            action: 'post',
            entityType: 'putaway',
            entityId: id,
            occurredAt: now,
            metadata: {
              movementId: primaryMovementId,
              movementIds: postedMovementGroups.map((group) => group.movementId)
            }
          },
          client
        );
      }

      if (validation.overrideMetadata && context?.actor) {
        for (const group of postedMovementGroups) {
          await recordAuditLog(
            {
              tenantId,
              actorType: context.actor.type,
              actorId: context.actor.id ?? null,
              action: 'negative_override',
              entityType: 'inventory_movement',
              entityId: group.movementId,
              occurredAt: now,
              metadata: {
                reason: validation.overrideMetadata.override_reason ?? null,
                putawayId: id,
                reference: validation.overrideMetadata.override_reference ?? null,
                lines: group.lines.map((prepared) => ({
                  itemId: prepared.putawayLine.item_id,
                  locationId: prepared.putawayLine.from_location_id,
                  uom: prepared.putawayLine.uom,
                  quantity: roundQuantity(toNumber(prepared.putawayLine.quantity_planned ?? 0))
                }))
              }
            },
            client
          );
        }
      }

      const receiptIds = new Set<string>();
      for (const line of pendingLines) {
        const receiptId = contexts.get(line.purchase_order_receipt_line_id)?.receiptId;
        if (receiptId) {
          receiptIds.add(receiptId);
        }
      }
      for (const receiptId of receiptIds) {
        const lifecycleGuard = await client.query(
          `WITH receipt_qc AS (
              SELECT prl.purchase_order_receipt_id AS receipt_id,
                     COALESCE(SUM(CASE WHEN qe.event_type = 'accept' THEN qe.quantity ELSE 0 END), 0)::numeric AS accept_qty
                FROM purchase_order_receipt_lines prl
                LEFT JOIN qc_events qe
                  ON qe.purchase_order_receipt_line_id = prl.id
                 AND qe.tenant_id = prl.tenant_id
               WHERE prl.purchase_order_receipt_id = $1
                 AND prl.tenant_id = $2
               GROUP BY prl.purchase_order_receipt_id
            ),
            receipt_alloc AS (
              SELECT purchase_order_receipt_id AS receipt_id,
                     COALESCE(SUM(CASE WHEN status = 'AVAILABLE' THEN quantity ELSE 0 END), 0)::numeric AS available_qty
                FROM receipt_allocations
               WHERE purchase_order_receipt_id = $1
                 AND tenant_id = $2
               GROUP BY purchase_order_receipt_id
            )
            SELECT por.lifecycle_state,
                   COALESCE(rq.accept_qty, 0)::numeric AS accept_qty,
                   COALESCE(ra.available_qty, 0)::numeric AS available_qty
              FROM purchase_order_receipts por
              LEFT JOIN receipt_qc rq
                ON rq.receipt_id = por.id
              LEFT JOIN receipt_alloc ra
                ON ra.receipt_id = por.id
             WHERE por.id = $1
               AND por.tenant_id = $2`,
          [receiptId, tenantId]
        );
        const guardRow = lifecycleGuard.rows[0];
        if (!guardRow) {
          throw new Error('RECEIPT_NOT_FOUND');
        }
        const acceptedQty = roundQuantity(toNumber(guardRow.accept_qty ?? 0));
        const availableQty = roundQuantity(toNumber(guardRow.available_qty ?? 0));
        await completePutawayCommand({
          client,
          tenantId,
          receiptId,
          occurredAt: now,
          currentState: guardRow.lifecycle_state,
          putawayStarted: availableQty > 1e-6,
          putawayComplete: acceptedQty > 0 && availableQty + 1e-6 >= acceptedQty,
          acceptedQty,
          availableQty
        });
      }

      return {
        responseBody: await fetchPutawayById(tenantId, id, client),
        events: postedMovementGroups.map((group) => buildMovementPostedEvent(group.movementId)),
        projectionOps
      };
    }
  });
}

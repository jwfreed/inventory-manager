import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { pool, withTransaction } from '../db';
import { roundQuantity, toNumber } from '../lib/numbers';
import { getCanonicalMovementFields } from './uomCanonical.service';
import { acquireAtpLocks, createAtpLockContext, persistInventoryMovement } from '../domains/inventory';
import {
  buildInventoryBalanceProjectionOp,
  buildRefreshItemCostSummaryProjectionOp
} from '../modules/platform/application/inventoryMutationSupport';
import {
  loadPutawayTotals,
  loadQcBreakdown
} from './inbound/receivingAggregations';
import { receiptCloseSchema, poCloseSchema } from '../schemas/closeout.schema';
import { mapPurchaseOrder } from './purchaseOrders.service';
import {
  RECEIPT_ALLOCATION_STATUSES,
  addReceiptAllocations,
  moveReceiptAllocations,
  loadReceiptAllocationsByLine,
  summarizeReceiptAllocations,
  type ReceiptAllocation,
  type ValidatedReceiptAllocationMutationContext
} from '../domain/receipts/receiptAllocationModel';
import { validateOrRebuildReceiptAllocationsForMutation } from '../domain/receipts/receiptAllocationRebuilder';
import { assertReceiptCloseoutAllowed } from '../domain/receipts/receiptCloseoutPolicy';

type ReceiptCloseInput = z.infer<typeof receiptCloseSchema>;
type PurchaseOrderCloseInput = z.infer<typeof poCloseSchema>;

type CloseoutRow = {
  id: string;
  purchase_order_receipt_id: string;
  status: 'open' | 'closed' | 'reopened';
  closed_at: string | null;
  closeout_reason_code: string | null;
  notes: string | null;
};

type ReconciliationDiscrepancyRow = {
  id: string;
  purchase_order_receipt_line_id: string | null;
  discrepancy_type: 'POSTING_INTEGRITY' | 'PHYSICAL_COUNT';
  status: 'OPEN' | 'APPROVED' | 'ADJUSTED';
  location_id: string | null;
  bin_id: string | null;
  allocation_status: 'QA' | 'AVAILABLE' | 'HOLD' | null;
  expected_qty: string | number;
  actual_qty: string | number;
  discrepancy_qty: string | number;
  tolerance_qty: string | number;
  notes: string | null;
  metadata: Record<string, unknown> | null;
  detected_at: string;
  resolved_at: string | null;
};

export type ReceiptLineReconciliation = {
  purchaseOrderReceiptLineId: string;
  quantityReceived: number;
  allocationExpectedQuantity: number;
  qcBreakdown: { hold: number; accept: number; reject: number };
  allocationSummary: { qa: number; available: number; hold: number; total: number };
  quantityPutawayPosted: number;
  remainingToPutaway: number;
  blockedReasons: string[];
};

export type ReceiptReconciliationDiscrepancy = {
  id: string;
  purchaseOrderReceiptLineId: string | null;
  discrepancyType: 'POSTING_INTEGRITY' | 'PHYSICAL_COUNT';
  status: 'OPEN' | 'APPROVED' | 'ADJUSTED';
  locationId: string | null;
  binId: string | null;
  allocationStatus: 'QA' | 'AVAILABLE' | 'HOLD' | null;
  expectedQty: number;
  actualQty: number;
  discrepancyQty: number;
  toleranceQty: number;
  notes: string | null;
  metadata: Record<string, unknown> | null;
  detectedAt: string;
  resolvedAt: string | null;
};

export type ReceiptReconciliation = {
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
  discrepancies: ReceiptReconciliationDiscrepancy[];
};

function mapDiscrepancy(row: ReconciliationDiscrepancyRow): ReceiptReconciliationDiscrepancy {
  return {
    id: row.id,
    purchaseOrderReceiptLineId: row.purchase_order_receipt_line_id ?? null,
    discrepancyType: row.discrepancy_type,
    status: row.status,
    locationId: row.location_id ?? null,
    binId: row.bin_id ?? null,
    allocationStatus: row.allocation_status ?? null,
    expectedQty: roundQuantity(toNumber(row.expected_qty ?? 0)),
    actualQty: roundQuantity(toNumber(row.actual_qty ?? 0)),
    discrepancyQty: roundQuantity(toNumber(row.discrepancy_qty ?? 0)),
    toleranceQty: roundQuantity(toNumber(row.tolerance_qty ?? 0)),
    notes: row.notes ?? null,
    metadata: row.metadata ?? null,
    detectedAt: row.detected_at,
    resolvedAt: row.resolved_at ?? null
  };
}

async function loadPersistedDiscrepancies(
  tenantId: string,
  receiptId: string,
  client?: PoolClient
): Promise<ReceiptReconciliationDiscrepancy[]> {
  const executor = client ?? pool;
  const { rows } = await executor.query<ReconciliationDiscrepancyRow>(
    `SELECT *
       FROM receipt_reconciliation_discrepancies
      WHERE tenant_id = $1
        AND purchase_order_receipt_id = $2
      ORDER BY detected_at ASC, id ASC`,
    [tenantId, receiptId]
  );
  return rows.map(mapDiscrepancy);
}

async function loadAllocationExpectedQtyByLine(
  tenantId: string,
  receiptId: string,
  client?: PoolClient
) {
  const executor = client ?? pool;
  const { rows } = await executor.query<{ receipt_line_id: string; adjustment_qty: string | number }>(
    `SELECT d.purchase_order_receipt_line_id AS receipt_line_id,
            COALESCE(SUM(d.discrepancy_qty), 0)::numeric AS adjustment_qty
       FROM receipt_reconciliation_discrepancies d
       JOIN receipt_reconciliation_resolutions r
         ON r.discrepancy_id = d.id
        AND r.tenant_id = d.tenant_id
        AND r.resolution_type = 'ADJUSTMENT'
      WHERE d.tenant_id = $1
        AND d.purchase_order_receipt_id = $2
        AND d.status = 'ADJUSTED'
      GROUP BY d.purchase_order_receipt_line_id`,
    [tenantId, receiptId]
  );
  const adjustmentQtyByLine = new Map<string, number>();
  for (const row of rows) {
    adjustmentQtyByLine.set(row.receipt_line_id, roundQuantity(toNumber(row.adjustment_qty ?? 0)));
  }
  return adjustmentQtyByLine;
}

async function upsertReconciliationDiscrepancy(params: {
  client: PoolClient;
  tenantId: string;
  receiptId: string;
  receiptLineId: string | null;
  discrepancyType: 'POSTING_INTEGRITY' | 'PHYSICAL_COUNT';
  locationId?: string | null;
  binId?: string | null;
  allocationStatus?: 'QA' | 'AVAILABLE' | 'HOLD' | null;
  expectedQty: number;
  actualQty: number;
  toleranceQty?: number;
  notes?: string | null;
  metadata?: Record<string, unknown>;
  occurredAt: Date;
}) {
  const discrepancyQty = roundQuantity(params.actualQty - params.expectedQty);
  const existing = await params.client.query<{ id: string }>(
    `SELECT id
       FROM receipt_reconciliation_discrepancies
      WHERE tenant_id = $1
        AND purchase_order_receipt_id = $2
        AND purchase_order_receipt_line_id IS NOT DISTINCT FROM $3
        AND discrepancy_type = $4
        AND location_id IS NOT DISTINCT FROM $5
        AND bin_id IS NOT DISTINCT FROM $6
        AND allocation_status IS NOT DISTINCT FROM $7
        AND status = 'OPEN'
      LIMIT 1`,
    [
      params.tenantId,
      params.receiptId,
      params.receiptLineId,
      params.discrepancyType,
      params.locationId ?? null,
      params.binId ?? null,
      params.allocationStatus ?? null
    ]
  );
  if ((existing.rowCount ?? 0) > 0) {
    await params.client.query(
      `UPDATE receipt_reconciliation_discrepancies
          SET expected_qty = $2,
              actual_qty = $3,
              discrepancy_qty = $4,
              tolerance_qty = $5,
              notes = $6,
              metadata = $7,
              updated_at = $8
        WHERE id = $1
          AND tenant_id = $9`,
      [
        existing.rows[0].id,
        params.expectedQty,
        params.actualQty,
        discrepancyQty,
        params.toleranceQty ?? 0,
        params.notes ?? null,
        params.metadata ?? {},
        params.occurredAt,
        params.tenantId
      ]
    );
    return existing.rows[0].id;
  }

  const id = uuidv4();
  await params.client.query(
    `INSERT INTO receipt_reconciliation_discrepancies (
        id, tenant_id, purchase_order_receipt_id, purchase_order_receipt_line_id, discrepancy_type, status,
        location_id, bin_id, allocation_status, expected_qty, actual_qty, discrepancy_qty, tolerance_qty,
        notes, metadata, detected_at, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,'OPEN',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$15)`,
    [
      id,
      params.tenantId,
      params.receiptId,
      params.receiptLineId,
      params.discrepancyType,
      params.locationId ?? null,
      params.binId ?? null,
      params.allocationStatus ?? null,
      params.expectedQty,
      params.actualQty,
      discrepancyQty,
      params.toleranceQty ?? 0,
      params.notes ?? null,
      params.metadata ?? {},
      params.occurredAt
    ]
  );
  return id;
}

async function recordResolution(params: {
  client: PoolClient;
  tenantId: string;
  discrepancyId: string;
  mode: 'approval' | 'adjustment';
  actorType?: 'user' | 'system';
  actorId?: string | null;
  movementId?: string | null;
  notes?: string | null;
  occurredAt: Date;
}) {
  const status = params.mode === 'approval' ? 'APPROVED' : 'ADJUSTED';
  await params.client.query(
    `UPDATE receipt_reconciliation_discrepancies
        SET status = $2,
            notes = COALESCE($3, notes),
            resolved_at = $4,
            updated_at = $4
      WHERE id = $1
        AND tenant_id = $5`,
    [params.discrepancyId, status, params.notes ?? null, params.occurredAt, params.tenantId]
  );
  await params.client.query(
    `INSERT INTO receipt_reconciliation_resolutions (
        id, tenant_id, discrepancy_id, resolution_type, actor_type, actor_id, notes, metadata, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      uuidv4(),
      params.tenantId,
      params.discrepancyId,
      params.mode === 'approval' ? 'APPROVAL' : 'ADJUSTMENT',
      params.actorType ?? null,
      params.actorId ?? null,
      params.notes ?? null,
      { inventoryMovementId: params.movementId ?? null },
      params.occurredAt
    ]
  );
}

function sumMatchingAllocations(
  allocations: ReceiptAllocation[],
  filter: { locationId?: string; binId?: string; allocationStatus?: 'QA' | 'AVAILABLE' | 'HOLD' | null }
) {
  return roundQuantity(
    allocations
      .filter(
        (allocation) =>
          (!filter.locationId || allocation.locationId === filter.locationId)
          && (!filter.binId || allocation.binId === filter.binId)
          && (!filter.allocationStatus || allocation.status === filter.allocationStatus)
      )
      .reduce((total, allocation) => total + allocation.quantity, 0)
  );
}

async function applyAdjustmentResolution(params: {
  client: PoolClient;
  tenantId: string;
  receiptId: string;
  discrepancy: ReconciliationDiscrepancyRow;
  line: { id: string; item_id: string; uom: string };
  allocations: ReceiptAllocation[];
  allocationContext: ValidatedReceiptAllocationMutationContext;
  actorType?: 'user' | 'system';
  actorId?: string | null;
  notes?: string | null;
  occurredAt: Date;
}) {
  const allocationStatus = params.discrepancy.allocation_status ?? 'AVAILABLE';
  const locationId = params.discrepancy.location_id;
  const binId = params.discrepancy.bin_id;
  if (!locationId || !binId) {
    throw new Error('RECEIPT_RECONCILIATION_ADJUSTMENT_CONTEXT_REQUIRED');
  }
  const delta = roundQuantity(toNumber(params.discrepancy.discrepancy_qty ?? 0));
  if (Math.abs(delta) <= 1e-6) {
    return null;
  }

  const matchingAllocations = params.allocations
    .filter(
      (allocation) =>
        allocation.locationId === locationId
        && allocation.binId === binId
        && allocation.status === allocationStatus
    )
    .sort((left, right) => String(left.id ?? '').localeCompare(String(right.id ?? '')));
  const warehouseId =
    matchingAllocations[0]?.warehouseId
    ?? params.allocations[0]?.warehouseId
    ?? params.discrepancy.metadata?.warehouseId;
  if (!warehouseId || typeof warehouseId !== 'string') {
    throw new Error('RECEIPT_RECONCILIATION_ADJUSTMENT_WAREHOUSE_REQUIRED');
  }

  const canonical = await getCanonicalMovementFields(
    params.tenantId,
    params.line.item_id,
    delta,
    params.line.uom,
    params.client
  );
  const lockContext = createAtpLockContext({
    operation: 'receipt_reconciliation_adjustment',
    tenantId: params.tenantId
  });
  await acquireAtpLocks(
    params.client,
    [{ tenantId: params.tenantId, warehouseId, itemId: params.line.item_id, locationId }],
    { lockContext }
  );
  const movement = await persistInventoryMovement(params.client, {
    tenantId: params.tenantId,
    movementType: 'adjustment',
    status: 'posted',
    externalRef: `receipt_reconciliation:${params.discrepancy.id}`,
    sourceType: 'receipt_reconciliation',
    sourceId: params.discrepancy.id,
    idempotencyKey: `receipt-reconciliation:${params.discrepancy.id}`,
    occurredAt: params.occurredAt,
    postedAt: params.occurredAt,
    notes: params.notes ?? 'Receipt reconciliation adjustment',
    lines: [
      {
        warehouseId,
        sourceLineId: params.discrepancy.id,
        eventTimestamp: params.occurredAt,
        itemId: params.line.item_id,
        locationId,
        quantityDelta: canonical.quantityDeltaCanonical,
        uom: canonical.canonicalUom,
        quantityDeltaEntered: delta,
        uomEntered: params.line.uom,
        quantityDeltaCanonical: canonical.quantityDeltaCanonical,
        canonicalUom: canonical.canonicalUom,
        uomDimension: canonical.uomDimension,
        reasonCode: 'receipt_reconciliation',
        lineNotes: params.notes ?? 'Receipt reconciliation adjustment'
      }
    ]
  });
  const movementLineId = movement.lineIds[0] ?? null;
  if (!movementLineId) {
    throw new Error('RECEIPT_RECONCILIATION_ADJUSTMENT_MOVEMENT_LINE_REQUIRED');
  }

  // Update balance + cost summary projections for the affected item/location
  const balanceOp = buildInventoryBalanceProjectionOp({
    tenantId: params.tenantId,
    itemId: params.line.item_id,
    locationId,
    uom: canonical.canonicalUom,
    deltaOnHand: canonical.quantityDeltaCanonical
  });
  await balanceOp(params.client);
  const costOp = buildRefreshItemCostSummaryProjectionOp(params.tenantId, params.line.item_id);
  await costOp(params.client);

  if (delta > 0) {
    await addReceiptAllocations({
      client: params.client,
      tenantId: params.tenantId,
      context: params.allocationContext,
      allocations: [
        {
          id: uuidv4(),
          receiptId: params.receiptId,
          receiptLineId: params.line.id,
          warehouseId,
          locationId,
          binId,
          inventoryMovementId: movement.movementId,
          inventoryMovementLineId: movementLineId,
          costLayerId: null,
          quantity: delta,
          status: allocationStatus
        }
      ],
      expectedQuantityDeltaByReceiptLineId: new Map([[params.line.id, delta]]),
      occurredAt: params.occurredAt
    });
  } else {
    try {
      await moveReceiptAllocations({
        client: params.client,
        tenantId: params.tenantId,
        context: params.allocationContext,
        receiptLineId: params.line.id,
        quantity: Math.abs(delta),
        sourceStatus: allocationStatus,
        sourceBinId: binId,
        movementId: movement.movementId,
        movementLineId,
        occurredAt: params.occurredAt,
        expectedQuantityDelta: delta
      });
    } catch (error) {
      if ((error as Error).message === 'RECEIPT_ALLOCATION_PRECHECK_FAILED') {
        throw new Error('RECEIPT_RECONCILIATION_ADJUSTMENT_INSUFFICIENT_ALLOCATION');
      }
      throw error;
    }
  }

  return movement.movementId;
}

export async function fetchReceiptReconciliation(
  tenantId: string,
  receiverId: string,
  client?: PoolClient
): Promise<ReceiptReconciliation | null> {
  const executor = client ?? pool;
  const receiptResult = await executor.query(
    'SELECT * FROM purchase_order_receipts WHERE id = $1 AND tenant_id = $2',
    [receiverId, tenantId]
  );
  if (receiptResult.rowCount === 0) {
    return null;
  }
  const receipt = receiptResult.rows[0];

  const linesResult = await executor.query(
    'SELECT * FROM purchase_order_receipt_lines WHERE purchase_order_receipt_id = $1 AND tenant_id = $2 ORDER BY created_at ASC',
    [receiverId, tenantId]
  );
  const lineIds = linesResult.rows.map((line: any) => line.id);
  const qcMap = await loadQcBreakdown(tenantId, lineIds, client);
  const totalsMap = await loadPutawayTotals(tenantId, lineIds, client);
  const allocationsByLine = client
    ? await loadReceiptAllocationsByLine(client, tenantId, lineIds)
    : await withTransaction((tx) => loadReceiptAllocationsByLine(tx, tenantId, lineIds));
  const discrepancies = await loadPersistedDiscrepancies(tenantId, receiverId, client);
  const adjustmentQtyByLine = await loadAllocationExpectedQtyByLine(tenantId, receiverId, client);

  const closeoutResult = await executor.query<CloseoutRow>(
    'SELECT * FROM inbound_closeouts WHERE purchase_order_receipt_id = $1 AND tenant_id = $2',
    [receiverId, tenantId]
  );
  const closeout = closeoutResult.rows[0] ?? null;

    const lineSummaries: ReceiptLineReconciliation[] = linesResult.rows.map((line: any) => {
    const qc = qcMap.get(line.id) ?? { hold: 0, accept: 0, reject: 0 };
    const totals = totalsMap.get(line.id) ?? { posted: 0, pending: 0, qa: 0, hold: 0 };
    const quantityReceived = roundQuantity(toNumber(line.quantity_received));
    const allocationExpectedQuantity = roundQuantity(
      quantityReceived + (adjustmentQtyByLine.get(line.id) ?? 0)
    );
    const allocationSummary = summarizeReceiptAllocations(allocationsByLine.get(line.id) ?? []);
    const remaining = Math.max(0, roundQuantity(allocationSummary.qaQty));
    const blockedReasons: string[] = [];
    if (Math.abs(allocationSummary.totalQty - allocationExpectedQuantity) > 1e-6) {
      blockedReasons.push('Receipt allocation total does not match received quantity');
    }
    if (remaining > 0) {
      blockedReasons.push('Accepted quantity remains outside available bins');
    }
    if (roundQuantity(qc.hold ?? 0) > 0) {
      blockedReasons.push('QC hold unresolved');
    }
    return {
      purchaseOrderReceiptLineId: line.id,
      quantityReceived,
      allocationExpectedQuantity,
      qcBreakdown: {
        hold: roundQuantity(qc.hold ?? 0),
        accept: roundQuantity(qc.accept ?? 0),
        reject: roundQuantity(qc.reject ?? 0)
      },
      allocationSummary: {
        qa: allocationSummary.qaQty,
        available: allocationSummary.availableQty,
        hold: allocationSummary.holdQty,
        total: allocationSummary.totalQty
      },
      quantityPutawayPosted: roundQuantity(totals.posted ?? 0),
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
    lines: lineSummaries,
    discrepancies
  };
}

export async function closePurchaseOrderReceipt(
  tenantId: string,
  receiptId: string,
  data: ReceiptCloseInput
) {
  return withTransaction(async (client) => {
    const receiptResult = await client.query(
      'SELECT * FROM purchase_order_receipts WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [receiptId, tenantId]
    );
    if (receiptResult.rowCount === 0) {
      throw new Error('RECEIPT_NOT_FOUND');
    }

    const linesResult = await client.query(
      `SELECT prl.*,
              pol.item_id
         FROM purchase_order_receipt_lines prl
         JOIN purchase_order_lines pol
           ON pol.id = prl.purchase_order_line_id
          AND pol.tenant_id = prl.tenant_id
        WHERE prl.purchase_order_receipt_id = $1
          AND prl.tenant_id = $2
        ORDER BY prl.created_at ASC`,
      [receiptId, tenantId]
    );
    const lineIds = linesResult.rows.map((line: any) => line.id);
    const now = new Date();
    const adjustmentQtyByLine = await loadAllocationExpectedQtyByLine(tenantId, receiptId, client);
    const allocationContext = await validateOrRebuildReceiptAllocationsForMutation({
      client,
      tenantId,
      receiptId,
      occurredAt: now,
      requirements: lineIds.map((receiptLineId: string) => ({ receiptLineId }))
    });
    let allocationsByLine = await loadReceiptAllocationsByLine(client, tenantId, lineIds);

    for (const line of linesResult.rows) {
      const receivedQty = roundQuantity(toNumber(line.quantity_received ?? 0));
      const expectedQty = roundQuantity(receivedQty + (adjustmentQtyByLine.get(line.id) ?? 0));
      const allocationSummary = summarizeReceiptAllocations(allocationsByLine.get(line.id) ?? []);
      if (Math.abs(allocationSummary.totalQty - expectedQty) > 1e-6) {
        await upsertReconciliationDiscrepancy({
          client,
          tenantId,
          receiptId,
          receiptLineId: line.id,
          discrepancyType: 'POSTING_INTEGRITY',
          expectedQty,
          actualQty: allocationSummary.totalQty,
          notes: 'Receipt quantity does not match persisted allocations.',
          occurredAt: now
        });
      }
    }

    for (const count of data.physicalCounts ?? []) {
      const allocations = allocationsByLine.get(count.purchaseOrderReceiptLineId) ?? [];
      const expectedQty = sumMatchingAllocations(allocations, {
        locationId: count.locationId,
        binId: count.binId,
        allocationStatus: count.allocationStatus ?? null
      });
      const countedQty = roundQuantity(toNumber(count.countedQty));
      const toleranceQty = roundQuantity(toNumber(count.toleranceQty ?? 0));
      if (Math.abs(countedQty - expectedQty) > toleranceQty + 1e-6) {
        await upsertReconciliationDiscrepancy({
          client,
          tenantId,
          receiptId,
          receiptLineId: count.purchaseOrderReceiptLineId,
          discrepancyType: 'PHYSICAL_COUNT',
          locationId: count.locationId,
          binId: count.binId,
          allocationStatus: count.allocationStatus ?? null,
          expectedQty,
          actualQty: countedQty,
          toleranceQty,
          notes: 'Physical count differs from persisted receipt allocations.',
          metadata: { countedQty },
          occurredAt: now
        });
      }
    }

    const openDiscrepancies = await client.query<ReconciliationDiscrepancyRow>(
      `SELECT *
         FROM receipt_reconciliation_discrepancies
        WHERE tenant_id = $1
          AND purchase_order_receipt_id = $2
          AND status = 'OPEN'
        ORDER BY detected_at ASC, id ASC
        FOR UPDATE`,
      [tenantId, receiptId]
    );

    if ((openDiscrepancies.rowCount ?? 0) > 0) {
      if (!data.resolution) {
        assertReceiptCloseoutAllowed({
          lineFacts: [],
          openDiscrepancyCount: openDiscrepancies.rowCount ?? 0
        });
      }
      const resolution = data.resolution!;
      for (const discrepancy of openDiscrepancies.rows) {
        const line = linesResult.rows.find((candidate: any) => candidate.id === discrepancy.purchase_order_receipt_line_id);
        let movementId: string | null = null;
        if (resolution.mode === 'adjustment') {
          if (!line) {
            throw new Error('RECEIPT_RECONCILIATION_LINE_REQUIRED');
          }
          movementId = await applyAdjustmentResolution({
            client,
            tenantId,
            receiptId,
            discrepancy,
            line,
            allocations: allocationsByLine.get(line.id) ?? [],
            allocationContext,
            actorType: data.actorType,
            actorId: data.actorId ?? null,
            notes: resolution.notes ?? data.notes ?? null,
            occurredAt: now
          });
          allocationsByLine = await loadReceiptAllocationsByLine(client, tenantId, lineIds);
        }
        await recordResolution({
          client,
          tenantId,
          discrepancyId: discrepancy.id,
          mode: resolution.mode,
          actorType: data.actorType,
          actorId: data.actorId ?? null,
          movementId,
          notes: resolution.notes ?? data.notes ?? null,
          occurredAt: now
        });
      }
    }

    const refreshedReconciliation = await fetchReceiptReconciliation(tenantId, receiptId, client);
    if (!refreshedReconciliation) {
      throw new Error('RECEIPT_NOT_FOUND');
    }
    assertReceiptCloseoutAllowed({
      lineFacts: refreshedReconciliation.lines.map((line) => ({
        remainingToPutaway: line.remainingToPutaway,
        holdQty: line.qcBreakdown.hold,
        allocationQuantityMatchesReceipt: line.allocationSummary.total === line.allocationExpectedQuantity
      })),
      openDiscrepancyCount: refreshedReconciliation.discrepancies.filter((item) => item.status === 'OPEN').length
    });

    const closeoutResult = await client.query<CloseoutRow>(
      'SELECT * FROM inbound_closeouts WHERE purchase_order_receipt_id = $1 AND tenant_id = $2 FOR UPDATE',
      [receiptId, tenantId]
    );
    const existingCloseout = closeoutResult.rows[0];
    if (existingCloseout && existingCloseout.status === 'closed') {
      throw new Error('RECEIPT_ALREADY_CLOSED');
    }

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
          WHERE id = $6 AND tenant_id = $7`,
        [
          now,
          data.actorType ?? null,
          data.actorId ?? null,
          data.closeoutReasonCode ?? null,
          data.notes ?? null,
          existingCloseout.id,
          tenantId
        ]
      );
    } else {
      await client.query(
        `INSERT INTO inbound_closeouts (
            id, tenant_id, purchase_order_receipt_id, status, closed_at,
            closed_by_actor_type, closed_by_actor_id, closeout_reason_code, notes, created_at, updated_at
         ) VALUES ($1, $2, $3, 'closed', $4, $5, $6, $7, $8, $4, $4)`,
        [
          uuidv4(),
          tenantId,
          receiptId,
          now,
          data.actorType ?? null,
          data.actorId ?? null,
          data.closeoutReasonCode ?? null,
          data.notes ?? null
        ]
      );
    }

    return fetchReceiptReconciliation(tenantId, receiptId, client);
  });
}

export async function closePurchaseOrder(tenantId: string, id: string, _data: PurchaseOrderCloseInput) {
  return withTransaction(async (client) => {
    const now = new Date();
    const poResult = await client.query('SELECT * FROM purchase_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [
      id,
      tenantId
    ]);
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
        WHERE por.purchase_order_id = $1 AND por.tenant_id = $2`,
      [id, tenantId]
    );
    const blocking = receiptsResult.rows.filter((row: any) => row.status !== 'closed');
    if ((receiptsResult.rowCount ?? 0) > 0 && blocking.length > 0) {
      throw new Error('PO_RECEIPTS_OPEN');
    }

    await client.query(
      'UPDATE purchase_orders SET status = $1, updated_at = $2 WHERE id = $3 AND tenant_id = $4',
      ['closed', now, id, tenantId]
    );

    const updatedPo = await client.query('SELECT * FROM purchase_orders WHERE id = $1 AND tenant_id = $2', [
      id,
      tenantId
    ]);
    const linesResult = await client.query(
      'SELECT * FROM purchase_order_lines WHERE purchase_order_id = $1 AND tenant_id = $2 ORDER BY line_number ASC',
      [id, tenantId]
    );
    return mapPurchaseOrder(updatedPo.rows[0], linesResult.rows);
  });
}

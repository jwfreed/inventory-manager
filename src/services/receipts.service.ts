import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db';
import {
  buildReceiptPostedEvents,
  recordReceiptCreatedAuditEffect,
  type ReceiptActor
} from '../domain/receipts/receiptEffects';
import {
  normalizeReceiptRequest,
  normalizeOptionalIdempotencyKey,
  normalizeReceiptRequestForHash,
  type ReceiptInput,
  type ReceiptInput as PurchaseOrderReceiptInput
} from '../domain/receipts/receiptNormalization';
import {
  assertReceiptCanBeCreated,
  assertReceiptLocationContext,
  assertReceiptPostingQuantityIntegrity,
  assertUniqueReceiptPurchaseOrderLines,
  RECEIPT_STATUS_EPSILON,
  type ReceiptPurchaseOrderSnapshot,
  type ReceiptPurchaseOrderLineSnapshot
} from '../domain/receipts/receiptPolicy';
import {
  assertReceiptInventoryUnavailable,
  RECEIPT_EVENTS,
  RECEIPT_STATES,
  transitionReceiptState,
  type ReceiptLifecycleState
} from '../domain/receipts/receiptStateModel';
import { assertReceiptQcOutcomeIntegrity } from '../domain/receipts/receiptAvailabilityModel';
import {
  RECEIPT_ALLOCATION_STATUSES,
  assertReceiptAllocationTraceability,
  buildReceiptPostingIntegrity,
  insertReceiptAllocations,
  loadReceiptAllocationsByLine
} from '../domain/receipts/receiptAllocationModel';
import { resolveInventoryBin } from '../domain/receipts/receiptBinModel';
import {
  assertReceiptLineLocationsResolved,
  assertReceiptLocationResolution
} from '../domain/receipts/receiptLocationModel';
import {
  assertReceiptPostingTraceability,
  assertReceiptReconciliationIntegrity,
  buildReceiptPostingTrace
} from '../domain/receipts/receiptReconciliation';
import {
  postReceiptInventoryMovement,
  insertPostedReceipt,
  insertPostedReceiptLine,
  insertReceiptCostLayer,
  type PlannedReceiptPostingLine
} from '../domain/receipts/receiptPosting';
import {
  persistInventoryMovement
} from '../domains/inventory';
import {
  assertProjectionDeltaContract,
  buildReplayDeterminismExpectation,
  invertMovementQuantityFields
} from '../domain/inventory/mutationInvariants';
import {
  defaultBreakdown,
  loadPutawayTotals,
  loadQcBreakdown
} from './inbound/receivingAggregations';
import { roundQuantity, toNumber } from '../lib/numbers';
import {
  buildReceiptStatusSummary,
  mapReceipt,
  mapReceiptLine,
  type ReceiptTotals
} from './helpers/receiptReadModel';
import { query as baseQuery } from '../db';
import { updatePoStatusFromReceipts } from './status/purchaseOrdersStatus.service';
import { recordAuditLog } from '../lib/audit';
import { calculateMovementCostWithUnitCost } from './costing.service';
import { getCanonicalMovementFields } from './uomCanonical.service';
import { resolveDefaultLocationForRole, resolveWarehouseIdForLocation } from './warehouseDefaults.service';
import { hashTransactionalIdempotencyRequest } from '../lib/transactionalIdempotency';
import { IDEMPOTENCY_ENDPOINTS } from '../lib/idempotencyEndpoints';
import {
  runInventoryCommand,
  type InventoryCommandProjectionOp
} from '../modules/platform/application/runInventoryCommand';
import {
  buildPostedDocumentReplayResult,
  buildInventoryBalanceProjectionOp,
  buildRefreshItemCostSummaryProjectionOp,
  buildReplayCorruptionError,
  buildMovementPostedEvent,
  sortDeterministicMovementLines
} from '../modules/platform/application/inventoryMutationSupport';
import {
  postInventoryCommand,
  validateReceiptCommand
} from '../domain/receipts/receiptCommands';

async function generateReceiptNumber() {
  const { rows } = await query(`SELECT nextval('receipt_number_seq') AS seq`);
  const seq = Number(rows[0]?.seq ?? 0);
  const padded = String(seq).padStart(6, '0');
  return `R-${padded}`;
}

const REVERSAL_MOVEMENT_TYPE = 'receipt_reversal';
const STATUS_EPSILON = 1e-6;
type ReceiptVoidActor = { type: 'user' | 'system'; id?: string | null };

export async function fetchReceiptById(tenantId: string, id: string, client?: PoolClient) {
  const executor = client ? client.query.bind(client) : query;
  const receiptResult = await executor(
    `SELECT por.*,
            po.po_number,
            po.vendor_id,
            v.name AS vendor_name,
            v.code AS vendor_code,
            loc.name AS received_to_location_name,
            loc.code AS received_to_location_code,
            EXISTS (
              SELECT 1
                FROM purchase_order_receipt_lines porl
                JOIN putaway_lines pl
                  ON pl.purchase_order_receipt_line_id = porl.id
                 AND pl.tenant_id = porl.tenant_id
               WHERE porl.purchase_order_receipt_id = por.id
                 AND porl.tenant_id = por.tenant_id
            ) AS has_putaway,
            (
              SELECT p.id
                FROM putaways p
               WHERE p.purchase_order_receipt_id = por.id
                 AND p.tenant_id = por.tenant_id
                 AND p.status IN ('draft','in_progress')
               ORDER BY p.created_at DESC
               LIMIT 1
            ) AS draft_putaway_id
       FROM purchase_order_receipts por
       LEFT JOIN purchase_orders po ON po.id = por.purchase_order_id AND po.tenant_id = por.tenant_id
       LEFT JOIN vendors v ON v.id = po.vendor_id AND v.tenant_id = por.tenant_id
       LEFT JOIN locations loc ON loc.id = por.received_to_location_id AND loc.tenant_id = por.tenant_id
      WHERE por.id = $1 AND por.tenant_id = $2`,
    [id, tenantId]
  );
  if (receiptResult.rowCount === 0) {
    return null;
  }
  const linesResult = await executor(
    `SELECT porl.*,
            pol.item_id,
            pol.purchase_order_id,
            i.sku AS item_sku,
            i.name AS item_name,
            i.default_location_id AS item_default_location_id,
            i.requires_lot,
            i.requires_serial,
            i.requires_qc,
            por.received_to_location_id
       FROM purchase_order_receipt_lines porl
       JOIN purchase_order_receipts por ON por.id = porl.purchase_order_receipt_id AND por.tenant_id = porl.tenant_id
       LEFT JOIN purchase_order_lines pol ON pol.id = porl.purchase_order_line_id AND pol.tenant_id = porl.tenant_id
       LEFT JOIN items i ON i.id = pol.item_id AND i.tenant_id = porl.tenant_id
      WHERE porl.purchase_order_receipt_id = $1 AND porl.tenant_id = $2
      ORDER BY porl.created_at ASC`,
    [id, tenantId]
  );
  const lineIds = linesResult.rows.map((line) => line.id);
  const breakdown = await loadQcBreakdown(tenantId, lineIds, client);
  const totals = await loadPutawayTotals(tenantId, lineIds, client);
  const receipt = mapReceipt(receiptResult.rows[0], linesResult.rows, breakdown, totals);

  const totalsSummary: ReceiptTotals = {
    totalReceived: 0,
    totalAccept: 0,
    totalHold: 0,
    totalReject: 0,
    totalAcceptedQty: 0,
    putawayPosted: 0,
    putawayPending: 0
  };
  for (const line of linesResult.rows) {
    const quantityReceived = roundQuantity(toNumber(line.quantity_received));
    const qc = breakdown.get(line.id) ?? defaultBreakdown();
    const lineTotals = totals.get(line.id) ?? { posted: 0, pending: 0, qa: 0, hold: 0 };
    totalsSummary.totalReceived += quantityReceived;
    totalsSummary.totalAccept += roundQuantity(qc.accept ?? 0);
    totalsSummary.totalHold += roundQuantity(qc.hold ?? 0);
    totalsSummary.totalReject += roundQuantity(qc.reject ?? 0);
    totalsSummary.totalAcceptedQty += roundQuantity(qc.accept ?? 0);
    totalsSummary.putawayPosted += roundQuantity(lineTotals.posted ?? 0);
    totalsSummary.putawayPending += roundQuantity(lineTotals.pending ?? 0);
  }

  const statusSummary = buildReceiptStatusSummary(receipt.status, totalsSummary, receipt.lifecycleState);
  return { ...receipt, ...statusSummary };
}

async function buildReceiptCreateReplayResult(params: {
  tenantId: string;
  receiptId: string;
  movementId: string;
  expectedLineCount: number;
  idempotencyKey?: string | null;
  client: PoolClient;
}) {
  const replay = await buildPostedDocumentReplayResult({
    tenantId: params.tenantId,
    authoritativeMovements: [
      buildReplayDeterminismExpectation({
        movementId: params.movementId,
        expectedLineCount: params.expectedLineCount
      })
    ],
    client: params.client,
    fetchAggregateView: () => fetchReceiptById(params.tenantId, params.receiptId, params.client),
    aggregateNotFoundError: new Error('RECEIPT_NOT_FOUND'),
    authoritativeEvents: [
      buildMovementPostedEvent(params.movementId, params.idempotencyKey ?? null)
    ],
    responseStatus: 200
  });

  return {
    responseBody: {
      receipt: replay.responseBody,
      replayed: true,
      responseStatus: replay.responseStatus
    },
    responseStatus: replay.responseStatus,
    events: replay.events
  };
}

async function buildReceiptVoidReplayResult(params: {
  tenantId: string;
  receiptId: string;
  reversalMovementId: string;
  expectedLineCount: number;
  idempotencyKey?: string | null;
  client: PoolClient;
}) {
  const replay = await buildPostedDocumentReplayResult({
    tenantId: params.tenantId,
    authoritativeMovements: [
      buildReplayDeterminismExpectation({
        movementId: params.reversalMovementId,
        expectedLineCount: params.expectedLineCount
      })
    ],
    client: params.client,
    fetchAggregateView: async () => {
      const receipt = await fetchReceiptById(params.tenantId, params.receiptId, params.client);
      if (receipt && receipt.status !== 'voided') {
        throw buildReplayCorruptionError({
          tenantId: params.tenantId,
          receiptId: params.receiptId,
          movementId: params.reversalMovementId,
          reason: 'receipt_void_status_mismatch',
          status: receipt.status
        });
      }
      return receipt;
    },
    aggregateNotFoundError: new Error('RECEIPT_NOT_FOUND'),
    authoritativeEvents: [
      buildMovementPostedEvent(params.reversalMovementId, params.idempotencyKey ?? null)
    ],
    responseStatus: 200
  });

  return {
    responseBody: {
      receipt: replay.responseBody,
      purchaseOrderId: replay.responseBody.purchaseOrderId ?? null,
      replayed: true,
      responseStatus: replay.responseStatus
    },
    responseStatus: replay.responseStatus,
    events: replay.events
  };
}

export async function createPurchaseOrderReceipt(
  tenantId: string,
  input: PurchaseOrderReceiptInput,
  actor?: ReceiptActor
) {
  const data = normalizeReceiptRequest(input as ReceiptInput);
  const normalizedIdempotencyKey = data.idempotencyKey;
  const idempotencyRequestHash = normalizedIdempotencyKey
    ? hashTransactionalIdempotencyRequest({
      method: 'POST',
      endpoint: IDEMPOTENCY_ENDPOINTS.PURCHASE_ORDER_RECEIPTS_CREATE,
      body: normalizeReceiptRequestForHash(data)
    })
    : null;
  const receiptId = uuidv4();
  const uniqueLineIds = data.lines.map((line) => line.purchaseOrderLineId);
  assertUniqueReceiptPurchaseOrderLines(data.lines);

  let poRow: ReceiptPurchaseOrderSnapshot | null = null;
  const poLineMap = new Map<string, ReceiptPurchaseOrderLineSnapshot>();
  let resolvedReceivedToLocationId: string | null = null;
  let qaLocationId: string | null = null;
  let qaWarehouseId: string | null = null;
  let qaBinId: string | null = null;
  let receiptState: ReceiptLifecycleState = RECEIPT_STATES.RECEIVED;

  return runInventoryCommand<{ receipt: any; replayed: boolean; responseStatus: number }>({
    tenantId,
    endpoint: IDEMPOTENCY_ENDPOINTS.PURCHASE_ORDER_RECEIPTS_CREATE,
    operation: 'receipt_post',
    idempotencyKey: normalizedIdempotencyKey,
    requestHash: idempotencyRequestHash,
    retryOptions: { retries: 0 },
    onReplay: async ({ client, responseBody }) => {
      const replayedReceiptId = responseBody?.receipt?.id;
      const replayMovementId = responseBody?.receipt?.inventoryMovementId;
      if (typeof replayedReceiptId !== 'string' || !replayedReceiptId) {
        throw buildReplayCorruptionError({
          tenantId,
          idempotencyKey: normalizedIdempotencyKey,
          reason: 'receipt_replay_receipt_missing'
        });
      }
      if (typeof replayMovementId !== 'string' || !replayMovementId) {
        throw buildReplayCorruptionError({
          tenantId,
          receiptId: replayedReceiptId,
          idempotencyKey: normalizedIdempotencyKey,
          reason: 'receipt_replay_movement_missing'
        });
      }
      return (
        await buildReceiptCreateReplayResult({
          tenantId,
          receiptId: replayedReceiptId,
          movementId: replayMovementId,
          expectedLineCount: Array.isArray(responseBody?.receipt?.lines)
            ? responseBody.receipt.lines.length
            : data.lines.length,
          idempotencyKey: normalizedIdempotencyKey,
          client
        })
      ).responseBody;
    },
    lockTargets: async (client) => {
      const poResult = await client.query(
        `SELECT status, ship_to_location_id, receiving_location_id
           FROM purchase_orders
          WHERE id = $1
            AND tenant_id = $2
          FOR UPDATE`,
        [data.purchaseOrderId, tenantId]
      );
      if (poResult.rowCount === 0) {
        throw new Error('RECEIPT_PO_NOT_FOUND');
      }
      poRow = {
        status: poResult.rows[0].status,
        shipToLocationId: poResult.rows[0].ship_to_location_id,
        receivingLocationId: poResult.rows[0].receiving_location_id
      };
      const currentPoRow = poRow;
      if (!currentPoRow) {
        throw new Error('RECEIPT_PO_NOT_FOUND');
      }
      if (currentPoRow.status === 'submitted') {
        if (process.env.NODE_ENV !== 'production') {
          await client.query(
            `UPDATE purchase_orders
                SET status = 'approved',
                    updated_at = now()
              WHERE id = $1
                AND tenant_id = $2`,
            [data.purchaseOrderId, tenantId]
          );
          currentPoRow.status = 'approved';
        } else {
          throw new Error('RECEIPT_PO_NOT_APPROVED');
        }
      }

      const { rows: poLineRows } = await client.query(
        `SELECT pol.id, pol.purchase_order_id, pol.item_id, pol.uom, pol.quantity_ordered, pol.unit_price,
                pol.status AS line_status,
                pol.over_receipt_tolerance_pct,
                i.requires_lot, i.requires_serial, i.requires_qc
           FROM purchase_order_lines pol
           LEFT JOIN items i ON i.id = pol.item_id AND i.tenant_id = pol.tenant_id
          WHERE pol.id = ANY($1::uuid[])
            AND pol.tenant_id = $2
          ORDER BY pol.id
          FOR UPDATE OF pol`,
        [uniqueLineIds, tenantId]
      );
      if (poLineRows.length !== uniqueLineIds.length) {
        throw new Error('RECEIPT_PO_LINES_NOT_FOUND');
      }
      poLineMap.clear();
      for (const row of poLineRows) {
        poLineMap.set(row.id, {
          purchase_order_id: row.purchase_order_id,
          item_id: row.item_id,
          uom: row.uom,
          quantity_ordered: roundQuantity(toNumber(row.quantity_ordered ?? 0)),
          unit_price: row.unit_price != null ? Number(row.unit_price) : null,
          line_status: String(row.line_status ?? 'open'),
          over_receipt_tolerance_pct: row.over_receipt_tolerance_pct != null ? Number(row.over_receipt_tolerance_pct) : 0,
          requires_lot: !!row.requires_lot,
          requires_serial: !!row.requires_serial,
          requires_qc: !!row.requires_qc
        });
      }

      const { rows: receivedRows } = await client.query(
        `SELECT porl.purchase_order_line_id AS line_id,
                COALESCE(SUM(porl.quantity_received), 0)::numeric AS qty
           FROM purchase_order_receipt_lines porl
           JOIN purchase_order_receipts por
             ON por.id = porl.purchase_order_receipt_id
            AND por.tenant_id = porl.tenant_id
          WHERE por.tenant_id = $1
            AND por.purchase_order_id = $2
            AND COALESCE(por.status, 'posted') <> 'voided'
          GROUP BY porl.purchase_order_line_id`,
        [tenantId, data.purchaseOrderId]
      );
      const receivedMap = new Map<string, number>();
      for (const row of receivedRows) {
        receivedMap.set(String(row.line_id), roundQuantity(toNumber(row.qty ?? 0)));
      }

      assertReceiptCanBeCreated({
        receipt: data,
        purchaseOrder: currentPoRow,
        poLines: poLineMap,
        receivedQuantities: receivedMap
      });

      resolvedReceivedToLocationId = data.receivedToLocationId ?? null;
      if (!resolvedReceivedToLocationId) {
        const receivingLoc = currentPoRow.receivingLocationId ?? (await findDefaultReceivingLocation(tenantId));
        resolvedReceivedToLocationId = receivingLoc ?? currentPoRow.shipToLocationId ?? null;
      }
      if (!resolvedReceivedToLocationId) {
        throw new Error('RECEIPT_RECEIVING_LOCATION_REQUIRED');
      }
      try {
        qaLocationId = await resolveDefaultLocationForRole(tenantId, resolvedReceivedToLocationId, 'QA', client);
      } catch (error) {
        if ((error as Error)?.message === 'WAREHOUSE_DEFAULT_LOCATION_REQUIRED') {
          throw new Error('QA_LOCATION_REQUIRED');
        }
        throw error;
      }
      assertReceiptLocationContext({
        receivedToLocationId: resolvedReceivedToLocationId,
        qaLocationId
      });
      qaWarehouseId = await resolveWarehouseIdForLocation(tenantId, qaLocationId!, client);
      qaBinId = (
        await resolveInventoryBin({
          client,
          tenantId,
          warehouseId: qaWarehouseId,
          locationId: qaLocationId!,
          allowDefaultBinResolution: true
        })
      ).id;
      const resolvedLocationContext = assertReceiptLocationResolution({
        receivingLocationId: resolvedReceivedToLocationId,
        qaLocationId,
        warehouseId: qaWarehouseId
      });
      assertReceiptLineLocationsResolved(data.lines, resolvedLocationContext);
      receiptState = transitionReceiptState(receiptState, RECEIPT_EVENTS.VALIDATE);

      return Array.from(new Set(data.lines.map((line) => poLineMap.get(line.purchaseOrderLineId)?.item_id).filter(Boolean))).map((itemId) => ({
        tenantId,
        warehouseId: resolvedLocationContext.warehouseId,
        itemId: String(itemId)
      }));
    },
    execute: async ({ client }) => {
      if (!poRow || !qaLocationId || !qaWarehouseId || !qaBinId) {
        throw new Error('RECEIPT_RECEIVING_LOCATION_REQUIRED');
      }
      const receivingQaLocationId = qaLocationId;
      const receivingQaWarehouseId = qaWarehouseId;
      const receivingQaBinId = qaBinId;

      const now = new Date();
      const occurredAt = new Date(data.receivedAt);
      const receiptNumber = await generateReceiptNumber();
      receiptState = transitionReceiptState(receiptState, RECEIPT_EVENTS.START_QC);
      assertReceiptInventoryUnavailable(receiptState);
      const projectionOps: InventoryCommandProjectionOp[] = [];
      const refreshedItemIds = new Set<string>();
      const plannedReceiptLines: PlannedReceiptPostingLine[] = [];
      const receiptTraceCostLayerIds = new Map<string, string | null>();

      for (const line of data.lines) {
        assertReceiptQcOutcomeIntegrity({
          quantityReceived: line.quantityReceived,
          acceptedQty: 0,
          heldQty: 0,
          rejectedQty: 0
        });
        const receiptLineId = uuidv4();
        const receivedQty = line.quantityReceived;
        const poLine = poLineMap.get(line.purchaseOrderLineId);
        const expectedQty = roundQuantity(toNumber(poLine?.quantity_ordered ?? 0));
        const unitCost = line.unitCost ?? (poLine?.unit_price ?? null);
        if (!poLine?.item_id) {
          throw new Error('RECEIPT_LINE_ITEM_REQUIRED');
        }

        const canonicalFields = await getCanonicalMovementFields(
          tenantId,
          poLine.item_id,
          receivedQty,
          line.uom,
          client
        );
        const costData =
          unitCost !== null && unitCost !== undefined
            ? calculateMovementCostWithUnitCost(canonicalFields.quantityDeltaCanonical, unitCost)
            : { unitCost: null, extendedCost: null };
        plannedReceiptLines.push({
          receiptLineId,
          purchaseOrderLineId: line.purchaseOrderLineId,
          itemId: poLine.item_id,
          receivedQty,
          expectedQty,
          unitCost,
          canonicalFields,
          costData,
          discrepancyReason: line.discrepancyReason ?? null,
          discrepancyNotes: line.discrepancyNotes ?? null,
          lotCode: line.lotCode ?? null,
          serialNumbers: line.serialNumbers ?? null,
          overReceiptApproved: line.overReceiptApproved ?? false
        });
      }
      assertReceiptPostingQuantityIntegrity({
        receiptLines: data.lines,
        plannedLines: plannedReceiptLines.map((line) => ({
          purchaseOrderLineId: line.purchaseOrderLineId,
          receivedQty: line.receivedQty
        }))
      });
      const receiptProjectionDeltas = plannedReceiptLines.map((line) => ({
        itemId: line.itemId,
        locationId: receivingQaLocationId,
        uom: line.canonicalFields.canonicalUom,
        deltaOnHand: line.canonicalFields.quantityDeltaCanonical
      }));
      assertProjectionDeltaContract({
        movementDeltas: plannedReceiptLines.map((line) => ({
          itemId: line.itemId,
          locationId: receivingQaLocationId,
          uom: line.canonicalFields.canonicalUom,
          deltaOnHand: line.canonicalFields.quantityDeltaCanonical
        })),
        projectionDeltas: receiptProjectionDeltas,
        errorCode: 'RECEIPT_PROJECTION_CONTRACT_INVALID'
      });

      const movementResult = await postReceiptInventoryMovement({
        client,
        tenantId,
        receiptId,
        warehouseId: receivingQaWarehouseId,
        locationId: receivingQaLocationId,
        occurredAt,
        createdAt: now,
        idempotencyKey: data.idempotencyKey,
        lines: plannedReceiptLines
      });
      const movementId = movementResult.movementId;

      if (!movementResult.created) {
        return buildReceiptCreateReplayResult({
          tenantId,
          receiptId,
          movementId,
          expectedLineCount: plannedReceiptLines.length,
          idempotencyKey: data.idempotencyKey,
          client
        });
      }

      await insertPostedReceipt({
        client,
        tenantId,
        receiptId,
        purchaseOrderId: data.purchaseOrderId,
        occurredAt,
        receivedToLocationId: receivingQaLocationId,
        movementId,
        externalRef: data.externalRef,
        notes: data.notes,
        idempotencyKey: data.idempotencyKey,
        receiptNumber,
        lifecycleState: RECEIPT_STATES.RECEIVED
      });
      receiptState = await validateReceiptCommand({
        client,
        tenantId,
        receiptId,
        occurredAt: now
      });
      receiptState = await postInventoryCommand({
        client,
        tenantId,
        receiptId,
        currentState: receiptState,
        occurredAt: now
      });

      for (const line of plannedReceiptLines) {
        await insertPostedReceiptLine({
          client,
          tenantId,
          receiptId,
          line
        });
        projectionOps.push(
          buildInventoryBalanceProjectionOp({
            tenantId,
            itemId: line.itemId,
            locationId: qaLocationId,
            uom: line.canonicalFields.canonicalUom,
            deltaOnHand: line.canonicalFields.quantityDeltaCanonical
          })
        );
        const costLayer = await insertReceiptCostLayer({
          client,
          tenantId,
          movementId,
          qaLocationId,
          occurredAt,
          line
        });
        receiptTraceCostLayerIds.set(line.receiptLineId, costLayer?.id ?? null);
        if (!refreshedItemIds.has(line.itemId)) {
          refreshedItemIds.add(line.itemId);
          projectionOps.push(buildRefreshItemCostSummaryProjectionOp(tenantId, line.itemId));
        }
      }

      const sortedReceiptLines = sortDeterministicMovementLines(
        plannedReceiptLines,
        (line) => ({
          tenantId,
          warehouseId: receivingQaWarehouseId,
          locationId: receivingQaLocationId,
          itemId: line.itemId,
          canonicalUom: line.canonicalFields.canonicalUom,
          sourceLineId: line.receiptLineId
        })
      );
      const receiptAllocations = sortedReceiptLines.map((line, index) => ({
        receiptId,
        receiptLineId: line.receiptLineId,
        warehouseId: receivingQaWarehouseId,
        locationId: receivingQaLocationId,
        binId: receivingQaBinId,
        inventoryMovementId: movementId,
        inventoryMovementLineId: movementResult.lineIds[index] ?? null,
        costLayerId: receiptTraceCostLayerIds.get(line.receiptLineId) ?? null,
        quantity: line.canonicalFields.quantityDeltaCanonical,
        status: RECEIPT_ALLOCATION_STATUSES.QA
      }));
      assertReceiptAllocationTraceability(receiptAllocations);
      await insertReceiptAllocations(client, tenantId, receiptAllocations, now);

      const traceLines = buildReceiptPostingTrace(
        plannedReceiptLines.map((line) => ({
          receiptLineId: line.receiptLineId,
          purchaseOrderLineId: line.purchaseOrderLineId,
          itemId: line.itemId,
          quantity: line.canonicalFields.quantityDeltaCanonical,
          costLayerId: receiptTraceCostLayerIds.get(line.receiptLineId) ?? null
        }))
      );
      assertReceiptPostingTraceability(traceLines);
      const allocationsByReceiptLineId = await loadReceiptAllocationsByLine(
        client,
        tenantId,
        plannedReceiptLines.map((line) => line.receiptLineId)
      );
      assertReceiptReconciliationIntegrity({
        expectedQtyByReceiptLineId: new Map(
          plannedReceiptLines.map((line) => [line.receiptLineId, line.canonicalFields.quantityDeltaCanonical])
        ),
        traceLines
      });
      buildReceiptPostingIntegrity({
        expectedQtyByReceiptLineId: new Map(
          plannedReceiptLines.map((line) => [line.receiptLineId, line.canonicalFields.quantityDeltaCanonical])
        ),
        allocationsByReceiptLineId,
        postedQtyByReceiptLineId: new Map(
          traceLines.map((line) => [line.receiptLineId, line.quantity])
        )
      });

      await updatePoStatusFromReceipts(tenantId, data.purchaseOrderId, client);

      await recordReceiptCreatedAuditEffect({
        client,
        tenantId,
        actor,
        receiptId,
        purchaseOrderId: data.purchaseOrderId,
        lineCount: data.lines.length,
        occurredAt: now
      });

      const receiptView = await fetchReceiptById(tenantId, receiptId, client);
      if (!receiptView) {
        throw new Error('RECEIPT_NOT_FOUND_AFTER_CREATE');
      }
      if (receiptState !== RECEIPT_STATES.QC_PENDING) {
        throw new Error(`RECEIPT_STATE_TRANSITION_INVALID:${receiptState}`);
      }

      return {
        responseBody: {
          receipt: receiptView,
          replayed: false,
          responseStatus: 201
        },
        responseStatus: 201,
        events: buildReceiptPostedEvents(movementId, normalizedIdempotencyKey),
        projectionOps
      };
    }
  });
}

export async function fetchReceiptByIdempotencyKey(tenantId: string, key: string) {
  const existing = await query(
    'SELECT id FROM purchase_order_receipts WHERE tenant_id = $1 AND idempotency_key = $2',
    [tenantId, key]
  );
  if (!existing.rowCount || !existing.rows[0]?.id) return null;
  return fetchReceiptById(tenantId, existing.rows[0].id);
}

export async function listReceipts(
  tenantId: string,
  options: {
    limit?: number;
    offset?: number;
    status?: string;
    vendorId?: string;
    from?: string;
    to?: string;
    search?: string;
    includeLines?: boolean;
  } = {}
) {
  const limit = options.limit ?? 20;
  const offset = options.offset ?? 0;
  const params: Array<string | number> = [tenantId];
  const where: string[] = ['por.tenant_id = $1'];
  let paramIndex = params.length + 1;

  if (options.vendorId) {
    where.push(`po.vendor_id = $${paramIndex}`);
    params.push(options.vendorId);
    paramIndex += 1;
  }
  if (options.from) {
    where.push(`por.received_at >= $${paramIndex}`);
    params.push(options.from);
    paramIndex += 1;
  }
  if (options.to) {
    where.push(`por.received_at <= $${paramIndex}`);
    params.push(options.to);
    paramIndex += 1;
  }
  if (options.search) {
    where.push(
      `(
        por.id::text ILIKE $${paramIndex}
        OR po.po_number ILIKE $${paramIndex}
        OR por.external_ref ILIKE $${paramIndex}
        OR v.name ILIKE $${paramIndex}
        OR v.code ILIKE $${paramIndex}
        OR EXISTS (
          SELECT 1
            FROM purchase_order_receipt_lines porl_search
            JOIN items i_search
              ON i_search.id = porl_search.item_id
             AND i_search.tenant_id = porl_search.tenant_id
           WHERE porl_search.purchase_order_receipt_id = por.id
             AND porl_search.tenant_id = por.tenant_id
             AND (
               i_search.sku ILIKE $${paramIndex}
               OR i_search.name ILIKE $${paramIndex}
             )
        )
      )`
    );
    params.push(`%${options.search}%`);
    paramIndex += 1;
  }

  const statusFilter = options.status;
  const statusClause = statusFilter ? `WHERE receipt_status."workflowStatus" = $${paramIndex}` : '';
  if (statusFilter) {
    params.push(statusFilter);
    paramIndex += 1;
  }

  params.push(limit);
  params.push(offset);

  const { rows } = await query(
    `
    WITH line_qc AS (
      SELECT
        prl.id AS line_id,
        prl.purchase_order_receipt_id AS receipt_id,
        prl.quantity_received,
        COALESCE(SUM(CASE WHEN qe.event_type = 'accept' THEN qe.quantity ELSE 0 END), 0) AS accept_qty,
        COALESCE(SUM(CASE WHEN qe.event_type = 'hold' THEN qe.quantity ELSE 0 END), 0) AS hold_qty,
        COALESCE(SUM(CASE WHEN qe.event_type = 'reject' THEN qe.quantity ELSE 0 END), 0) AS reject_qty
      FROM purchase_order_receipt_lines prl
      LEFT JOIN qc_events qe
        ON qe.purchase_order_receipt_line_id = prl.id
       AND qe.tenant_id = prl.tenant_id
      WHERE prl.tenant_id = $1
      GROUP BY prl.id
    ),
    line_putaway AS (
      SELECT
        purchase_order_receipt_line_id AS line_id,
        SUM(CASE WHEN status = 'completed' THEN COALESCE(quantity_moved, 0) ELSE 0 END) AS posted_qty,
        SUM(CASE WHEN status = 'pending' THEN COALESCE(quantity_planned, 0) ELSE 0 END) AS pending_qty
      FROM putaway_lines
      WHERE tenant_id = $1
        AND status <> 'canceled'
      GROUP BY purchase_order_receipt_line_id
    ),
    receipt_totals AS (
      SELECT
        l.receipt_id,
        COUNT(*) AS line_count,
        SUM(l.quantity_received) AS total_received,
        SUM(l.accept_qty) AS total_accept,
        SUM(l.hold_qty) AS total_hold,
        SUM(l.reject_qty) AS total_reject,
        SUM(l.accept_qty) AS total_accepted_qty,
        SUM(COALESCE(p.posted_qty, 0)) AS putaway_posted,
        SUM(COALESCE(p.pending_qty, 0)) AS putaway_pending
      FROM line_qc l
      LEFT JOIN line_putaway p ON p.line_id = l.line_id
      GROUP BY l.receipt_id
    ),
    receipt_status AS (
      SELECT
        por.id,
        por.receipt_number AS "receiptNumber",
        por.purchase_order_id AS "purchaseOrderId",
        po.po_number AS "purchaseOrderNumber",
        po.vendor_id AS "vendorId",
        v.name AS "vendorName",
        v.code AS "vendorCode",
        por.status AS "status",
        por.received_at AS "receivedAt",
        por.received_to_location_id AS "receivedToLocationId",
        loc.name AS "receivedToLocationName",
        loc.code AS "receivedToLocationCode",
        por.inventory_movement_id AS "inventoryMovementId",
        por.external_ref AS "externalRef",
        por.notes,
        por.created_at AS "createdAt",
        EXISTS (
          SELECT 1
            FROM purchase_order_receipt_lines porl
            JOIN putaway_lines pl
              ON pl.purchase_order_receipt_line_id = porl.id
             AND pl.tenant_id = porl.tenant_id
           WHERE porl.purchase_order_receipt_id = por.id
             AND porl.tenant_id = por.tenant_id
        ) AS "hasPutaway",
        (
          SELECT p.id
            FROM putaways p
           WHERE p.purchase_order_receipt_id = por.id
             AND p.tenant_id = por.tenant_id
             AND p.status IN ('draft','in_progress')
           ORDER BY p.created_at DESC
           LIMIT 1
        ) AS "draftPutawayId",
        COALESCE(rt.line_count, 0) AS "lineCount",
        COALESCE(rt.total_received, 0) AS "totalReceived",
        COALESCE(rt.total_accept, 0) AS "totalAccepted",
        COALESCE(rt.total_hold, 0) AS "totalHold",
        COALESCE(rt.total_reject, 0) AS "totalReject",
        GREATEST(
          COALESCE(rt.total_received, 0)
          - (COALESCE(rt.total_accept, 0) + COALESCE(rt.total_hold, 0) + COALESCE(rt.total_reject, 0)),
          0
        ) AS "qcRemaining",
        COALESCE(rt.putaway_posted, 0) AS "putawayPosted",
        COALESCE(rt.putaway_pending, 0) AS "putawayPending",
        CASE
          WHEN por.status = 'voided' THEN 'failed'
          WHEN COALESCE(rt.total_received, 0) <= 0 THEN 'pending'
          WHEN GREATEST(
            COALESCE(rt.total_received, 0)
            - (COALESCE(rt.total_accept, 0) + COALESCE(rt.total_hold, 0) + COALESCE(rt.total_reject, 0)),
            0
          ) > ${STATUS_EPSILON} THEN 'pending'
          WHEN COALESCE(rt.total_hold, 0) > ${STATUS_EPSILON} THEN 'failed'
          WHEN COALESCE(rt.total_accept, 0) > ${STATUS_EPSILON} THEN 'passed'
          ELSE 'failed'
        END AS "qcStatus",
        CASE
          WHEN GREATEST(
            COALESCE(rt.total_received, 0)
            - (COALESCE(rt.total_accept, 0) + COALESCE(rt.total_hold, 0) + COALESCE(rt.total_reject, 0)),
            0
          ) > ${STATUS_EPSILON} THEN 'not_available'
          WHEN COALESCE(rt.total_accept, 0) <= ${STATUS_EPSILON} THEN 'not_available'
          WHEN COALESCE(rt.total_hold, 0) > ${STATUS_EPSILON} THEN 'not_available'
          WHEN COALESCE(rt.total_accept, 0) > ${STATUS_EPSILON}
               AND COALESCE(rt.putaway_posted, 0) + COALESCE(rt.putaway_pending, 0) <= ${STATUS_EPSILON}
            THEN 'not_started'
          WHEN COALESCE(rt.total_accept, 0) > ${STATUS_EPSILON}
               AND COALESCE(rt.putaway_posted, 0) + ${STATUS_EPSILON} < COALESCE(rt.total_accepted_qty, 0)
            THEN 'pending'
          WHEN COALESCE(rt.total_accept, 0) > ${STATUS_EPSILON} THEN 'complete'
          ELSE 'not_available'
        END AS "putawayStatus",
        CASE
          WHEN por.status = 'voided' THEN 'voided'
          WHEN por.status = 'draft' THEN 'draft'
          WHEN COALESCE(rt.total_received, 0) <= 0 THEN 'posted'
          WHEN GREATEST(
            COALESCE(rt.total_received, 0)
            - (COALESCE(rt.total_accept, 0) + COALESCE(rt.total_hold, 0) + COALESCE(rt.total_reject, 0)),
            0
          ) > ${STATUS_EPSILON} THEN 'pending_qc'
          WHEN COALESCE(rt.total_hold, 0) > ${STATUS_EPSILON} THEN 'qc_failed'
          WHEN COALESCE(rt.total_accept, 0) <= ${STATUS_EPSILON} THEN 'qc_failed'
          WHEN COALESCE(rt.total_accept, 0) > ${STATUS_EPSILON}
               AND COALESCE(rt.putaway_posted, 0) + COALESCE(rt.putaway_pending, 0) <= ${STATUS_EPSILON}
            THEN 'qc_passed'
          WHEN COALESCE(rt.total_accept, 0) > ${STATUS_EPSILON}
               AND COALESCE(rt.putaway_posted, 0) + ${STATUS_EPSILON} < COALESCE(rt.total_accepted_qty, 0)
            THEN 'putaway_pending'
          ELSE 'complete'
        END AS "workflowStatus",
        (
          por.status = 'posted'
          AND GREATEST(
            COALESCE(rt.total_received, 0)
            - (COALESCE(rt.total_accept, 0) + COALESCE(rt.total_hold, 0) + COALESCE(rt.total_reject, 0)),
            0
          ) > ${STATUS_EPSILON}
        ) AS "qcEligible",
        (
          por.status = 'posted'
          AND COALESCE(rt.total_accept, 0) > ${STATUS_EPSILON}
          AND COALESCE(rt.total_hold, 0) <= ${STATUS_EPSILON}
          AND GREATEST(
            COALESCE(rt.total_received, 0)
            - (COALESCE(rt.total_accept, 0) + COALESCE(rt.total_hold, 0) + COALESCE(rt.total_reject, 0)),
            0
          ) <= ${STATUS_EPSILON}
          AND COALESCE(rt.putaway_posted, 0) + COALESCE(rt.putaway_pending, 0) + ${STATUS_EPSILON}
              < COALESCE(rt.total_accepted_qty, 0)
        ) AS "putawayEligible"
      FROM purchase_order_receipts por
      LEFT JOIN purchase_orders po ON po.id = por.purchase_order_id AND po.tenant_id = por.tenant_id
      LEFT JOIN vendors v ON v.id = po.vendor_id AND v.tenant_id = por.tenant_id
      LEFT JOIN locations loc ON loc.id = por.received_to_location_id AND loc.tenant_id = por.tenant_id
      LEFT JOIN receipt_totals rt ON rt.receipt_id = por.id
      WHERE ${where.join(' AND ')}
    )
    SELECT *
      FROM receipt_status
      ${statusClause}
     ORDER BY "createdAt" DESC
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    params
  );

  if (!options.includeLines || rows.length === 0) {
    return rows;
  }

  const receiptIds = rows.map((row) => row.id);
  const linesResult = await query(
    `SELECT porl.*,
            pol.item_id,
            pol.purchase_order_id,
            i.sku AS item_sku,
            i.name AS item_name,
            i.default_location_id AS item_default_location_id,
            por.received_to_location_id
       FROM purchase_order_receipt_lines porl
       JOIN purchase_order_receipts por ON por.id = porl.purchase_order_receipt_id AND por.tenant_id = porl.tenant_id
       LEFT JOIN purchase_order_lines pol ON pol.id = porl.purchase_order_line_id AND pol.tenant_id = porl.tenant_id
       LEFT JOIN items i ON i.id = pol.item_id AND i.tenant_id = porl.tenant_id
      WHERE porl.purchase_order_receipt_id = ANY($1::uuid[]) AND porl.tenant_id = $2
      ORDER BY porl.created_at ASC`,
    [receiptIds, tenantId]
  );
  const lineIds = linesResult.rows.map((line) => line.id);
  const breakdown = await loadQcBreakdown(tenantId, lineIds);
  const totals = await loadPutawayTotals(tenantId, lineIds);

  const linesByReceipt = new Map<string, any[]>();
  for (const line of linesResult.rows) {
    const mapped = mapReceiptLine(line, breakdown, totals);
    const receiptId = line.purchase_order_receipt_id;
    const existing = linesByReceipt.get(receiptId) ?? [];
    existing.push(mapped);
    linesByReceipt.set(receiptId, existing);
  }

  return rows.map((row) => ({
    ...row,
    lines: linesByReceipt.get(row.id) ?? []
  }));
}

export async function deleteReceipt(tenantId: string, id: string) {
  const { rows: receiptLineIds } = await query(
    'SELECT id FROM purchase_order_receipt_lines WHERE purchase_order_receipt_id = $1 AND tenant_id = $2',
    [id, tenantId]
  );
  const lineIds = receiptLineIds.map((r) => r.id);
  if (lineIds.length > 0) {
    const { rows: putawayRefs } = await query(
      `SELECT pl.id,
              pl.putaway_id,
              pl.status AS line_status,
              p.status AS putaway_status,
              pl.inventory_movement_id
         FROM putaway_lines pl
         JOIN putaways p ON p.id = pl.putaway_id AND p.tenant_id = pl.tenant_id
        WHERE pl.purchase_order_receipt_line_id = ANY($1::uuid[]) AND pl.tenant_id = $2`,
      [lineIds, tenantId]
    );
    if (putawayRefs.length > 0) {
      const hasPosted = putawayRefs.some(
        (r) => r.line_status === 'completed' || r.putaway_status === 'completed' || r.inventory_movement_id
      );
      if (hasPosted) {
        throw new Error('RECEIPT_HAS_PUTAWAYS_POSTED');
      }
      // Safe to delete pending putaways tied to this receipt
      const putawayIds = Array.from(new Set(putawayRefs.map((r) => r.putaway_id)));
      await withTransaction(async (client) => {
        await client.query('DELETE FROM putaway_lines WHERE putaway_id = ANY($1::uuid[]) AND tenant_id = $2', [
          putawayIds,
          tenantId
        ]);
        await client.query('DELETE FROM putaways WHERE id = ANY($1::uuid[]) AND tenant_id = $2', [putawayIds, tenantId]);
      });
    }
  }
  await withTransaction(async (client) => {
    await client.query(
      'DELETE FROM purchase_order_receipt_lines WHERE purchase_order_receipt_id = $1 AND tenant_id = $2',
      [id, tenantId]
    );
    await client.query('DELETE FROM purchase_order_receipts WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
  });
}

function assertReason(reason: string) {
  const trimmed = reason.trim();
  if (!trimmed) {
    throw new Error('RECEIPT_VOID_REASON_REQUIRED');
  }
  return trimmed;
}

async function findExistingReversalMovement(
  client: PoolClient,
  tenantId: string,
  originalMovementId: string
) {
  const existing = await client.query(
    `SELECT id, movement_type, status
       FROM inventory_movements
      WHERE tenant_id = $1
        AND reversal_of_movement_id = $2
      LIMIT 1`,
    [tenantId, originalMovementId]
  );
  return existing.rows[0] ?? null;
}

async function assertReceiptCostLayersReversible(
  client: PoolClient,
  tenantId: string,
  originalMovementId: string
): Promise<string[]> {
  const layersResult = await client.query<{
    id: string;
    original_quantity: string | number;
    remaining_quantity: string | number;
  }>(
    `SELECT id, original_quantity, remaining_quantity
       FROM inventory_cost_layers
      WHERE tenant_id = $1
        AND movement_id = $2
        AND source_type = 'receipt'
        AND voided_at IS NULL
      FOR UPDATE`,
    [tenantId, originalMovementId]
  );

  if (layersResult.rowCount === 0) {
    return [];
  }

  const layerIds = layersResult.rows.map((row) => row.id);
  const consumptionResult = await client.query<{ cost_layer_id: string }>(
    `SELECT DISTINCT cost_layer_id
       FROM cost_layer_consumptions
      WHERE tenant_id = $1
        AND cost_layer_id = ANY($2::uuid[])`,
    [tenantId, layerIds]
  );
  const consumedLayerIds = new Set(consumptionResult.rows.map((row) => row.cost_layer_id));

  for (const layer of layersResult.rows) {
    const originalQty = roundQuantity(toNumber(layer.original_quantity));
    const remainingQty = roundQuantity(toNumber(layer.remaining_quantity));
    if (consumedLayerIds.has(layer.id)) {
      throw new Error('RECEIPT_REVERSAL_NOT_POSSIBLE_CONSUMED');
    }
    if (Math.abs(remainingQty - originalQty) > STATUS_EPSILON) {
      throw new Error('RECEIPT_REVERSAL_NOT_POSSIBLE_CONSUMED');
    }
  }

  return layerIds;
}

async function insertReversalLinesAndCollectDeltas(
  client: PoolClient,
  tenantId: string,
  originalMovementId: string,
  reason: string
) {
  const sourceLinesResult = await client.query<{
    source_line_id: string;
    item_id: string;
    location_id: string;
    warehouse_id: string | null;
    quantity_delta: string | number;
    uom: string;
    quantity_delta_entered: string | number | null;
    uom_entered: string | null;
    quantity_delta_canonical: string | number | null;
    canonical_uom: string | null;
    uom_dimension: string | null;
    unit_cost: string | number | null;
    extended_cost: string | number | null;
    reason_code: string | null;
  }>(
    `SELECT iml.id AS source_line_id,
            item_id,
            location_id,
            l.warehouse_id,
            quantity_delta,
            uom,
            quantity_delta_entered,
            uom_entered,
            quantity_delta_canonical,
            canonical_uom,
            uom_dimension,
            unit_cost,
            extended_cost,
            reason_code
       FROM inventory_movement_lines iml
       JOIN locations l
         ON l.id = iml.location_id
        AND l.tenant_id = iml.tenant_id
      WHERE iml.tenant_id = $1
        AND iml.movement_id = $2`,
    [tenantId, originalMovementId]
  );

  if ((sourceLinesResult.rowCount ?? 0) === 0) {
    throw new Error('RECEIPT_NOT_POSTED');
  }

  const reversalLines = sortDeterministicMovementLines(
    sourceLinesResult.rows.map((row) => {
      const inverted = invertMovementQuantityFields({
        quantityDelta: toNumber(row.quantity_delta),
        quantityDeltaEntered: row.quantity_delta_entered === null ? null : toNumber(row.quantity_delta_entered),
        quantityDeltaCanonical: row.quantity_delta_canonical === null ? null : toNumber(row.quantity_delta_canonical),
        extendedCost: row.extended_cost === null ? null : Number(row.extended_cost)
      });
      return ({
      ...(typeof row.warehouse_id === 'string' && row.warehouse_id.trim()
        ? {}
        : (() => {
            throw new Error('RECEIPT_REPLAY_SCOPE_UNRESOLVED');
          })()),
      id: uuidv4(),
      sourceLineId: row.source_line_id,
      warehouseId: row.warehouse_id!,
      itemId: row.item_id,
      locationId: row.location_id,
      quantityDelta: inverted.quantityDelta,
      uom: row.uom,
      quantityDeltaEntered: inverted.quantityDeltaEntered,
      uomEntered: row.uom_entered,
      quantityDeltaCanonical: inverted.quantityDeltaCanonical,
      canonicalUom: row.canonical_uom,
      uomDimension: row.uom_dimension,
      unitCost: row.unit_cost === null ? null : Number(row.unit_cost),
      extendedCost: inverted.extendedCost,
      reasonCode: row.reason_code ?? 'receipt_void_reversal',
      lineNotes: `Reversal of movement line ${row.source_line_id} (${reason})`,
      balanceUom: row.canonical_uom ?? row.uom,
      balanceQuantityDelta: inverted.balanceQuantityDelta
    });
    }),
    (line) => ({
      tenantId,
      warehouseId: line.warehouseId,
      locationId: line.locationId,
      itemId: line.itemId,
      canonicalUom: line.canonicalUom ?? line.uom,
      sourceLineId: line.sourceLineId
    })
  );

  return {
    reversalLines,
    balanceDeltas: reversalLines.map((line) => ({
      item_id: line.itemId,
      location_id: line.locationId,
      balance_uom: line.balanceUom,
      quantity_delta_effective: line.balanceQuantityDelta
    }))
  };
}

export async function voidReceipt(
  tenantId: string,
  id: string,
  params: { reason: string; actor: ReceiptVoidActor; idempotencyKey?: string | null }
) {
  const reason = assertReason(params.reason);
  const normalizedIdempotencyKey = normalizeOptionalIdempotencyKey(params.idempotencyKey ?? null);
  const idempotencyRequestHash = normalizedIdempotencyKey
    ? hashTransactionalIdempotencyRequest({
      method: 'POST',
      endpoint: IDEMPOTENCY_ENDPOINTS.PURCHASE_ORDER_RECEIPTS_VOID,
      body: {
        receiptId: id,
        reason
      }
    })
    : null;

  let receipt:
    | {
        id: string;
        status: string;
        inventory_movement_id: string | null;
        purchase_order_id: string;
      }
    | null = null;
  let originalMovement:
    | {
        id: string;
        status: string;
        movement_type: string;
        reversal_of_movement_id: string | null;
        reversed_by_movement_id: string | null;
      }
    | null = null;
  let reversibleLayerIds: string[] = [];

  const outcome = await runInventoryCommand<{
    receipt: any;
    purchaseOrderId: string | null;
    replayed: boolean;
    responseStatus: number;
  }>({
    tenantId,
    endpoint: IDEMPOTENCY_ENDPOINTS.PURCHASE_ORDER_RECEIPTS_VOID,
    operation: 'receipt_void',
    idempotencyKey: normalizedIdempotencyKey,
    requestHash: idempotencyRequestHash,
    retryOptions: { isolationLevel: 'SERIALIZABLE', retries: 2 },
    onReplay: async ({ client, responseBody }) => {
      const replayedReceiptId = responseBody?.receipt?.id ?? id;
      const originalMovementId = responseBody?.receipt?.inventoryMovementId;
      if (typeof originalMovementId !== 'string' || !originalMovementId) {
        throw buildReplayCorruptionError({
          tenantId,
          receiptId: replayedReceiptId,
          idempotencyKey: normalizedIdempotencyKey,
          reason: 'receipt_void_replay_original_movement_missing'
        });
      }
      const reversalMovement = await findExistingReversalMovement(client, tenantId, originalMovementId);
      if (!reversalMovement?.id) {
        throw buildReplayCorruptionError({
          tenantId,
          receiptId: replayedReceiptId,
          originalMovementId,
          idempotencyKey: normalizedIdempotencyKey,
          reason: 'receipt_void_replay_reversal_missing'
        });
      }
      return (
        await buildReceiptVoidReplayResult({
          tenantId,
          receiptId: replayedReceiptId,
          reversalMovementId: reversalMovement.id,
          expectedLineCount: Array.isArray(responseBody?.receipt?.lines)
            ? responseBody.receipt.lines.length
            : 0,
          idempotencyKey: normalizedIdempotencyKey,
          client
        })
      ).responseBody;
    },
    lockTargets: async (client) => {
      const receiptResult = await client.query<{
        id: string;
        status: string;
        inventory_movement_id: string | null;
        purchase_order_id: string;
      }>(
        `SELECT id, status, inventory_movement_id, purchase_order_id
           FROM purchase_order_receipts
          WHERE id = $1
            AND tenant_id = $2
          FOR UPDATE`,
        [id, tenantId]
      );
      if (receiptResult.rowCount === 0) {
        throw new Error('RECEIPT_NOT_FOUND');
      }
      receipt = receiptResult.rows[0];
      if (!receipt.inventory_movement_id) {
        throw new Error('RECEIPT_NOT_POSTED');
      }

      const originalMovementResult = await client.query<{
        id: string;
        status: string;
        movement_type: string;
        reversal_of_movement_id: string | null;
        reversed_by_movement_id: string | null;
      }>(
        `SELECT id, status, movement_type, reversal_of_movement_id, reversed_by_movement_id
           FROM inventory_movements
          WHERE id = $1
            AND tenant_id = $2
          FOR UPDATE`,
        [receipt.inventory_movement_id, tenantId]
      );
      if (originalMovementResult.rowCount === 0) {
        throw new Error('RECEIPT_NOT_POSTED');
      }
      originalMovement = originalMovementResult.rows[0];
      if (originalMovement.status !== 'posted') {
        throw new Error('RECEIPT_NOT_POSTED');
      }
      if (
        originalMovement.movement_type === REVERSAL_MOVEMENT_TYPE
        || originalMovement.reversal_of_movement_id !== null
      ) {
        throw new Error('RECEIPT_REVERSAL_INVALID_TARGET');
      }
      if (originalMovement.reversed_by_movement_id !== null) {
        throw new Error('RECEIPT_ALREADY_REVERSED');
      }
      if (originalMovement.movement_type !== 'receive') {
        throw new Error('RECEIPT_NOT_POSTED');
      }

      const existingReversal = await findExistingReversalMovement(client, tenantId, originalMovement.id);
      if (receipt.status === 'voided' || existingReversal) {
        throw new Error('RECEIPT_ALREADY_REVERSED');
      }

      const { rows: putawayRefs } = await client.query(
        `SELECT pl.id,
                pl.status AS line_status,
                p.status AS putaway_status,
                pl.inventory_movement_id
           FROM putaway_lines pl
           JOIN putaways p ON p.id = pl.putaway_id AND p.tenant_id = pl.tenant_id
          WHERE pl.purchase_order_receipt_line_id IN (
                SELECT id
                  FROM purchase_order_receipt_lines
                 WHERE purchase_order_receipt_id = $1
                   AND tenant_id = $2
              )
            AND pl.tenant_id = $2`,
        [id, tenantId]
      );
      if (putawayRefs.length > 0) {
        const hasPosted = putawayRefs.some(
          (row) => row.line_status === 'completed' || row.putaway_status === 'completed' || row.inventory_movement_id
        );
        if (hasPosted) {
          throw new Error('RECEIPT_HAS_PUTAWAYS_POSTED');
        }
      }

      reversibleLayerIds = await assertReceiptCostLayersReversible(client, tenantId, originalMovement.id);
      const lineScopeResult = await client.query<{
        item_id: string;
        location_id: string;
        warehouse_id: string | null;
      }>(
        `SELECT iml.item_id,
                iml.location_id,
                l.warehouse_id
           FROM inventory_movement_lines iml
           JOIN locations l
             ON l.id = iml.location_id
            AND l.tenant_id = iml.tenant_id
          WHERE iml.tenant_id = $1
            AND iml.movement_id = $2
          ORDER BY iml.location_id ASC, iml.item_id ASC`,
        [tenantId, originalMovement.id]
      );
      return lineScopeResult.rows
        .filter((row) => typeof row.warehouse_id === 'string' && row.warehouse_id.length > 0)
        .map((row) => ({
          tenantId,
          warehouseId: row.warehouse_id!,
          itemId: row.item_id
        }));
    },
    execute: async ({ client }) => {
      if (!receipt || !originalMovement) {
        throw new Error('RECEIPT_NOT_FOUND');
      }

      const now = new Date();
      const reversalPlan = await insertReversalLinesAndCollectDeltas(
        client,
        tenantId,
        originalMovement.id,
        reason
      );
      const reversalMovement = await persistInventoryMovement(client, {
        tenantId,
        movementType: REVERSAL_MOVEMENT_TYPE,
        status: 'posted',
        externalRef: `po_receipt_void:${id}`,
        sourceType: 'po_receipt_void',
        sourceId: id,
        idempotencyKey: params.idempotencyKey ?? null,
        occurredAt: now,
        postedAt: now,
        notes: `Receipt void reversal ${id}: ${reason}`,
        reversalOfMovementId: originalMovement.id,
        reversalReason: reason,
        createdAt: now,
        updatedAt: now,
        lines: reversalPlan.reversalLines.map((line) => ({
          id: line.id,
          warehouseId: line.warehouseId,
          sourceLineId: line.sourceLineId,
          itemId: line.itemId,
          locationId: line.locationId,
          quantityDelta: line.quantityDelta,
          uom: line.uom,
          quantityDeltaEntered: line.quantityDeltaEntered,
          uomEntered: line.uomEntered,
          quantityDeltaCanonical: line.quantityDeltaCanonical,
          canonicalUom: line.canonicalUom,
          uomDimension: line.uomDimension,
          unitCost: line.unitCost,
          extendedCost: line.extendedCost,
          reasonCode: line.reasonCode,
          lineNotes: line.lineNotes,
          createdAt: now
        }))
      });

      if (!reversalMovement.created) {
        const existingMovementResult = await client.query<{
          id: string;
          movement_type: string;
          reversal_of_movement_id: string | null;
        }>(
          `SELECT id, movement_type, reversal_of_movement_id
             FROM inventory_movements
            WHERE id = $1
              AND tenant_id = $2
            FOR UPDATE`,
          [reversalMovement.movementId, tenantId]
        );
        const existingMovement = existingMovementResult.rows[0];
        if (
          existingMovement &&
          existingMovement.movement_type === REVERSAL_MOVEMENT_TYPE &&
          existingMovement.reversal_of_movement_id === originalMovement.id
        ) {
          throw new Error('RECEIPT_ALREADY_REVERSED');
        }
        throw new Error('RECEIPT_VOID_CONFLICT');
      }

      const balanceDeltaByKey = new Map<string, {
        itemId: string;
        locationId: string;
        uom: string;
        deltaOnHand: number;
      }>();
      const itemIdsToRefresh = new Set<string>();
      for (const row of reversalPlan.balanceDeltas) {
        const delta = roundQuantity(toNumber(row.quantity_delta_effective));
        const key = `${row.item_id}|${row.location_id}|${row.balance_uom}`;
        const current = balanceDeltaByKey.get(key) ?? {
          itemId: row.item_id,
          locationId: row.location_id,
          uom: row.balance_uom,
          deltaOnHand: 0
        };
        current.deltaOnHand = roundQuantity(current.deltaOnHand + delta);
        balanceDeltaByKey.set(key, current);
        itemIdsToRefresh.add(row.item_id);
      }
      const reversalMovementDeltas = reversalPlan.balanceDeltas.map((row) => ({
        itemId: row.item_id,
        locationId: row.location_id,
        uom: row.balance_uom,
        deltaOnHand: roundQuantity(toNumber(row.quantity_delta_effective))
      }));
      assertProjectionDeltaContract({
        movementDeltas: reversalMovementDeltas,
        projectionDeltas: [...balanceDeltaByKey.values()],
        errorCode: 'RECEIPT_REVERSAL_PROJECTION_CONTRACT_INVALID',
        epsilon: STATUS_EPSILON
      });

      if (reversibleLayerIds.length > 0) {
        await client.query(
          `UPDATE inventory_cost_layers
              SET voided_at = $3,
                  void_reason = $4,
                  updated_at = $3
            WHERE tenant_id = $1
              AND id = ANY($2::uuid[])`,
          [tenantId, reversibleLayerIds, now, `receipt_void:${id}`]
        );
      }

      await client.query(
        `UPDATE purchase_order_receipts
            SET status = 'voided'
          WHERE id = $1
            AND tenant_id = $2`,
        [id, tenantId]
      );

      await recordAuditLog(
        {
          tenantId,
          actorType: params.actor.type,
          actorId: params.actor.id ?? null,
          action: 'update',
          entityType: 'purchase_order_receipt',
          entityId: id,
          metadata: {
            statusFrom: receipt.status,
            statusTo: 'voided',
            reversalMovementId: reversalMovement.movementId,
            reversalOfMovementId: originalMovement.id,
            reason
          }
        },
        client
      );

      const receiptView = await fetchReceiptById(tenantId, id, client);
      if (!receiptView) {
        throw new Error('RECEIPT_NOT_FOUND');
      }
      const projectionOps: InventoryCommandProjectionOp[] = [];
      for (const delta of balanceDeltaByKey.values()) {
        if (Math.abs(delta.deltaOnHand) <= STATUS_EPSILON) continue;
        projectionOps.push(
          buildInventoryBalanceProjectionOp({
            tenantId,
            itemId: delta.itemId,
            locationId: delta.locationId,
            uom: delta.uom,
            deltaOnHand: delta.deltaOnHand
          })
        );
      }
      for (const itemId of itemIdsToRefresh.values()) {
        projectionOps.push(buildRefreshItemCostSummaryProjectionOp(tenantId, itemId));
      }

      return {
        responseBody: {
          receipt: receiptView,
          purchaseOrderId: receipt.purchase_order_id,
          replayed: false,
          responseStatus: 200
        },
        responseStatus: 200,
        events: [buildMovementPostedEvent(reversalMovement.movementId, normalizedIdempotencyKey)],
        projectionOps
      };
    }
  });
  if (outcome.purchaseOrderId) {
    await updatePoStatusFromReceipts(tenantId, outcome.purchaseOrderId);
  }
  return outcome;
}
async function findDefaultReceivingLocation(tenantId: string): Promise<string | null> {
  const { rows } = await baseQuery(
    `SELECT id
       FROM locations
      WHERE tenant_id = $1
        AND active = true
        AND type = 'warehouse'
      ORDER BY created_at ASC
      LIMIT 1`,
    [tenantId]
  );
  return rows[0]?.id ?? null;
}

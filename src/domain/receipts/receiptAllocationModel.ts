import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { roundQuantity } from '../../lib/numbers';
import { assertQuantityEquality } from '../inventory/mutationInvariants';
import { RECEIPT_STATUS_EPSILON } from './receiptPolicy';
import { RECEIPT_AVAILABILITY_STATES, type ReceiptAvailabilityDecision } from './receiptAvailabilityModel';
import { RECEIPT_STATES, type ReceiptState } from './receiptStateModel';

export const RECEIPT_ALLOCATION_STATUSES = {
  QA: 'QA',
  AVAILABLE: 'AVAILABLE',
  HOLD: 'HOLD'
} as const;

export type ReceiptAllocationStatus =
  typeof RECEIPT_ALLOCATION_STATUSES[keyof typeof RECEIPT_ALLOCATION_STATUSES];

export type ReceiptAllocation = {
  id?: string;
  receiptId: string;
  receiptLineId: string;
  warehouseId: string;
  locationId: string;
  binId: string;
  inventoryMovementId: string | null;
  inventoryMovementLineId: string | null;
  costLayerId: string | null;
  quantity: number;
  status: ReceiptAllocationStatus;
};

export type ReceiptAllocationSummary = {
  qaQty: number;
  availableQty: number;
  holdQty: number;
  totalQty: number;
};

export type ReceiptPhysicalCount = {
  receiptLineId: string;
  countedQty: number;
  toleranceQty?: number;
};

export function summarizeReceiptAllocations(allocations: ReceiptAllocation[]): ReceiptAllocationSummary {
  const summary: ReceiptAllocationSummary = {
    qaQty: 0,
    availableQty: 0,
    holdQty: 0,
    totalQty: 0
  };
  for (const allocation of allocations) {
    const quantity = roundQuantity(allocation.quantity);
    summary.totalQty = roundQuantity(summary.totalQty + quantity);
    if (allocation.status === RECEIPT_ALLOCATION_STATUSES.QA) {
      summary.qaQty = roundQuantity(summary.qaQty + quantity);
    } else if (allocation.status === RECEIPT_ALLOCATION_STATUSES.AVAILABLE) {
      summary.availableQty = roundQuantity(summary.availableQty + quantity);
    } else if (allocation.status === RECEIPT_ALLOCATION_STATUSES.HOLD) {
      summary.holdQty = roundQuantity(summary.holdQty + quantity);
    }
  }
  return summary;
}

export function assertReceiptAllocationQuantityConservation(params: {
  receiptQuantity: number;
  allocations: ReceiptAllocation[];
}) {
  const receiptQuantity = roundQuantity(params.receiptQuantity);
  const summary = summarizeReceiptAllocations(params.allocations);
  assertQuantityEquality({
    expectedQuantity: receiptQuantity,
    actualQuantity: summary.totalQty,
    errorCode: 'RECEIPT_ALLOCATION_QUANTITY_MISMATCH',
    epsilon: RECEIPT_STATUS_EPSILON
  });
  return summary;
}

export function assertReceiptAllocationTraceability(allocations: ReceiptAllocation[]) {
  for (const allocation of allocations) {
    if (
      !allocation.receiptLineId
      || !allocation.inventoryMovementId
      || !allocation.inventoryMovementLineId
      || !allocation.warehouseId
      || !allocation.locationId
      || !allocation.binId
    ) {
      throw new Error('RECEIPT_ALLOCATION_TRACEABILITY_VIOLATION');
    }
    if (allocation.quantity <= RECEIPT_STATUS_EPSILON) {
      throw new Error('RECEIPT_ALLOCATION_TRACEABILITY_VIOLATION');
    }
  }
}

export function deriveReceiptAvailabilityFromAllocations(params: {
  baseStatus: string | null | undefined;
  lifecycleState: ReceiptState;
  allocations: ReceiptAllocation[];
}): ReceiptAvailabilityDecision {
  const summary = summarizeReceiptAllocations(params.allocations);
  const blockedReasons: string[] = [];
  if (params.baseStatus === 'voided') {
    blockedReasons.push('Receipt is voided.');
  }
  if (params.lifecycleState !== RECEIPT_STATES.AVAILABLE) {
    blockedReasons.push('Receipt lifecycle is not available.');
  }
  if (summary.qaQty > RECEIPT_STATUS_EPSILON) {
    blockedReasons.push('QA allocations must not contribute to availability.');
  }
  if (summary.holdQty > RECEIPT_STATUS_EPSILON) {
    blockedReasons.push('Held allocations must not contribute to availability.');
  }

  if (params.lifecycleState !== RECEIPT_STATES.AVAILABLE || summary.availableQty <= RECEIPT_STATUS_EPSILON) {
    return {
      state: RECEIPT_AVAILABILITY_STATES.UNAVAILABLE,
      availableQty: 0,
      blockedQty: roundQuantity(summary.totalQty),
      blockedReasons
    };
  }

  return {
    state: RECEIPT_AVAILABILITY_STATES.AVAILABLE,
    availableQty: roundQuantity(summary.availableQty),
    blockedQty: roundQuantity(summary.qaQty + summary.holdQty),
    blockedReasons
  };
}

export function buildReceiptPostingIntegrity(params: {
  expectedQtyByReceiptLineId: Map<string, number>;
  allocationsByReceiptLineId: Map<string, ReceiptAllocation[]>;
  postedQtyByReceiptLineId: Map<string, number>;
}) {
  for (const [receiptLineId, expectedQty] of params.expectedQtyByReceiptLineId.entries()) {
    const allocations = params.allocationsByReceiptLineId.get(receiptLineId) ?? [];
    const summary = assertReceiptAllocationQuantityConservation({
      receiptQuantity: expectedQty,
      allocations
    });
    const postedQty = roundQuantity(params.postedQtyByReceiptLineId.get(receiptLineId) ?? 0);
    if (Math.abs(postedQty - roundQuantity(expectedQty)) > RECEIPT_STATUS_EPSILON) {
      throw new Error('RECEIPT_POSTING_TRACE_INTEGRITY_VIOLATION');
    }
    if (Math.abs(summary.totalQty - roundQuantity(expectedQty)) > RECEIPT_STATUS_EPSILON) {
      throw new Error('RECEIPT_POSTING_TRACE_INTEGRITY_VIOLATION');
    }
  }
}

export function reconcileReceiptPhysicalCount(params: {
  expectedQty: number;
  physicalCount: ReceiptPhysicalCount;
}) {
  const expectedQty = roundQuantity(params.expectedQty);
  const countedQty = roundQuantity(params.physicalCount.countedQty);
  const discrepancyQty = roundQuantity(countedQty - expectedQty);
  const toleranceQty = roundQuantity(params.physicalCount.toleranceQty ?? 0);
  return {
    receiptLineId: params.physicalCount.receiptLineId,
    expectedQty,
    countedQty,
    discrepancyQty,
    toleranceQty,
    withinTolerance: Math.abs(discrepancyQty) <= toleranceQty + RECEIPT_STATUS_EPSILON
  };
}

export async function insertReceiptAllocations(
  client: PoolClient,
  tenantId: string,
  allocations: ReceiptAllocation[],
  now: Date
) {
  for (const allocation of allocations) {
    await client.query(
      `INSERT INTO receipt_allocations (
          id, tenant_id, purchase_order_receipt_id, purchase_order_receipt_line_id,
          warehouse_id, location_id, bin_id, inventory_movement_id, inventory_movement_line_id,
          cost_layer_id, quantity, status, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)`,
      [
        allocation.id ?? uuidv4(),
        tenantId,
        allocation.receiptId,
        allocation.receiptLineId,
        allocation.warehouseId,
        allocation.locationId,
        allocation.binId,
        allocation.inventoryMovementId,
        allocation.inventoryMovementLineId,
        allocation.costLayerId,
        roundQuantity(allocation.quantity),
        allocation.status,
        now
      ]
    );
  }
}

export async function loadReceiptAllocationsByLine(
  client: PoolClient,
  tenantId: string,
  receiptLineIds: string[]
): Promise<Map<string, ReceiptAllocation[]>> {
  const map = new Map<string, ReceiptAllocation[]>();
  if (receiptLineIds.length === 0) {
    return map;
  }
  const { rows } = await client.query(
    `SELECT id,
            purchase_order_receipt_id,
            purchase_order_receipt_line_id,
            warehouse_id,
            location_id,
            bin_id,
            inventory_movement_id,
            inventory_movement_line_id,
            cost_layer_id,
            quantity,
            status
       FROM receipt_allocations
      WHERE tenant_id = $1
        AND purchase_order_receipt_line_id = ANY($2::uuid[])
      ORDER BY created_at ASC, id ASC`,
    [tenantId, receiptLineIds]
  );
  for (const row of rows) {
    const lineId = String(row.purchase_order_receipt_line_id);
    const entries = map.get(lineId) ?? [];
    entries.push({
      id: row.id,
      receiptId: row.purchase_order_receipt_id,
      receiptLineId: row.purchase_order_receipt_line_id,
      warehouseId: row.warehouse_id,
      locationId: row.location_id,
      binId: row.bin_id,
      inventoryMovementId: row.inventory_movement_id ?? null,
      inventoryMovementLineId: row.inventory_movement_line_id ?? null,
      costLayerId: row.cost_layer_id ?? null,
      quantity: roundQuantity(Number(row.quantity ?? 0)),
      status: row.status
    });
    map.set(lineId, entries);
  }
  return map;
}

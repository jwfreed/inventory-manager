import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { roundQuantity } from '../../lib/numbers';
import { assertQuantityEquality } from '../inventory/mutationInvariants';
import { RECEIPT_STATUS_EPSILON } from './receiptPolicy';
import { RECEIPT_AVAILABILITY_STATES, type ReceiptAvailabilityDecision } from './receiptAvailabilityModel';
import { RECEIPT_STATES, type ReceiptState } from './receiptStateModel';

/*
 * receipt_allocations is non-authoritative operational support state.
 * It is required for receipt workflow execution, but quantity truth remains
 * owned by receipt lines, ledger movements, QC events, putaway lines, and
 * reconciliation resolutions.
 */

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

const RECEIPT_ALLOCATION_WRITE_CONTEXT = Symbol('RECEIPT_ALLOCATION_WRITE_CONTEXT');

type ReceiptAllocationWriteContextKind = 'initial' | 'validated' | 'rebuild';

export type ReceiptAllocationValidationRequirement = {
  receiptLineId: string;
  requiredStatus?: ReceiptAllocationStatus;
  requiredBinId?: string | null;
  requiredQuantity?: number;
};

export type ReceiptAllocationWriteContext = {
  readonly tenantId: string;
  readonly kind: ReceiptAllocationWriteContextKind;
  readonly receiptLineIds: ReadonlySet<string>;
  readonly allocationsByLine: ReadonlyMap<string, ReceiptAllocation[]>;
  readonly [RECEIPT_ALLOCATION_WRITE_CONTEXT]: true;
};

export type ValidatedReceiptAllocationMutationContext = ReceiptAllocationWriteContext & {
  readonly kind: 'validated';
};

function assertReceiptAllocationWriteContext(
  tenantId: string,
  context: ReceiptAllocationWriteContext
) {
  if (
    !context
    || context[RECEIPT_ALLOCATION_WRITE_CONTEXT] !== true
    || context.tenantId !== tenantId
  ) {
    throw new Error('RECEIPT_ALLOCATION_VALIDATION_REQUIRED');
  }
}

function buildReceiptAllocationWriteContext(params: {
  tenantId: string;
  kind: ReceiptAllocationWriteContextKind;
  receiptLineIds: Iterable<string>;
  allocationsByLine?: Map<string, ReceiptAllocation[]>;
}): ReceiptAllocationWriteContext {
  return {
    tenantId: params.tenantId,
    kind: params.kind,
    receiptLineIds: new Set(params.receiptLineIds),
    allocationsByLine: params.allocationsByLine ?? new Map(),
    [RECEIPT_ALLOCATION_WRITE_CONTEXT]: true
  };
}

function assertContextCoversAllocations(
  context: ReceiptAllocationWriteContext,
  allocations: ReceiptAllocation[]
) {
  for (const allocation of allocations) {
    if (!context.receiptLineIds.has(allocation.receiptLineId)) {
      throw new Error('RECEIPT_ALLOCATION_VALIDATION_SCOPE_MISMATCH');
    }
  }
}

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

export async function assertReceiptAllocationMovementLinks(params: {
  client: PoolClient;
  tenantId: string;
  allocations: ReceiptAllocation[];
}) {
  const movementIds = Array.from(
    new Set(params.allocations.map((allocation) => allocation.inventoryMovementId).filter(Boolean))
  );
  const movementLineIds = Array.from(
    new Set(params.allocations.map((allocation) => allocation.inventoryMovementLineId).filter(Boolean))
  );
  if (movementIds.length === 0 && movementLineIds.length === 0) {
    return;
  }
  const [movementResult, movementLineResult] = await Promise.all([
    movementIds.length > 0
      ? params.client.query(
          `SELECT id
             FROM inventory_movements
            WHERE tenant_id = $1
              AND id = ANY($2::uuid[])`,
          [params.tenantId, movementIds]
        )
      : Promise.resolve({ rows: [] }),
    movementLineIds.length > 0
      ? params.client.query(
          `SELECT id
             FROM inventory_movement_lines
            WHERE tenant_id = $1
              AND id = ANY($2::uuid[])`,
          [params.tenantId, movementLineIds]
        )
      : Promise.resolve({ rows: [] })
  ]);
  const foundMovements = new Set(movementResult.rows.map((row: any) => row.id));
  const foundMovementLines = new Set(movementLineResult.rows.map((row: any) => row.id));
  for (const allocation of params.allocations) {
    if (
      !allocation.inventoryMovementId
      || !allocation.inventoryMovementLineId
      || !foundMovements.has(allocation.inventoryMovementId)
      || !foundMovementLines.has(allocation.inventoryMovementLineId)
    ) {
      throw new Error('RECEIPT_ALLOCATION_MOVEMENT_LINK_INVALID');
    }
  }
}

export function createInitialReceiptAllocationWriteContext(params: {
  tenantId: string;
  expectedQtyByReceiptLineId: Map<string, number>;
  allocations: ReceiptAllocation[];
}) {
  const allocationsByLine = new Map<string, ReceiptAllocation[]>();
  for (const allocation of params.allocations) {
    const lineAllocations = allocationsByLine.get(allocation.receiptLineId) ?? [];
    lineAllocations.push(allocation);
    allocationsByLine.set(allocation.receiptLineId, lineAllocations);
  }
  for (const [receiptLineId, expectedQty] of params.expectedQtyByReceiptLineId.entries()) {
    assertReceiptAllocationQuantityConservation({
      receiptQuantity: expectedQty,
      allocations: allocationsByLine.get(receiptLineId) ?? []
    });
  }
  assertReceiptAllocationTraceability(params.allocations);
  return buildReceiptAllocationWriteContext({
    tenantId: params.tenantId,
    kind: 'initial',
    receiptLineIds: params.expectedQtyByReceiptLineId.keys(),
    allocationsByLine
  });
}

export function createRebuildReceiptAllocationWriteContext(params: {
  tenantId: string;
  expectedQtyByReceiptLineId: Map<string, number>;
  allocations: ReceiptAllocation[];
}) {
  const context = createInitialReceiptAllocationWriteContext(params);
  return buildReceiptAllocationWriteContext({
    tenantId: params.tenantId,
    kind: 'rebuild',
    receiptLineIds: context.receiptLineIds,
    allocationsByLine: new Map(context.allocationsByLine)
  });
}

export async function validateReceiptAllocationMutationContext(params: {
  client: PoolClient;
  tenantId: string;
  requirements: ReceiptAllocationValidationRequirement[];
}): Promise<ValidatedReceiptAllocationMutationContext> {
  const receiptLineIds = Array.from(new Set(params.requirements.map((requirement) => requirement.receiptLineId)));
  if (receiptLineIds.length === 0) {
    throw new Error('RECEIPT_ALLOCATION_VALIDATION_SCOPE_REQUIRED');
  }
  const lineResult = await params.client.query(
    `SELECT id, quantity_received
       FROM purchase_order_receipt_lines
      WHERE tenant_id = $1
        AND id = ANY($2::uuid[])
      ORDER BY created_at ASC, id ASC
      FOR UPDATE`,
    [params.tenantId, receiptLineIds]
  );
  if ((lineResult.rowCount ?? 0) !== receiptLineIds.length) {
    throw new Error('RECEIPT_ALLOCATION_VALIDATION_LINE_NOT_FOUND');
  }

  const expectedQtyByLine = new Map<string, number>();
  for (const row of lineResult.rows) {
    expectedQtyByLine.set(row.id, roundQuantity(Number(row.quantity_received ?? 0)));
  }

  const allocationsByLine = await loadReceiptAllocationsByLine(params.client, params.tenantId, receiptLineIds);
  for (const receiptLineId of receiptLineIds) {
    const expectedQty = expectedQtyByLine.get(receiptLineId) ?? 0;
    const allocations = allocationsByLine.get(receiptLineId) ?? [];
    assertReceiptAllocationTraceability(allocations);
    await assertReceiptAllocationMovementLinks({
      client: params.client,
      tenantId: params.tenantId,
      allocations
    });
    assertReceiptAllocationQuantityConservation({
      receiptQuantity: expectedQty,
      allocations
    });
  }

  for (const requirement of params.requirements) {
    if (!requirement.requiredStatus || requirement.requiredQuantity === undefined) {
      continue;
    }
    const requiredQuantity = roundQuantity(requirement.requiredQuantity);
    if (requiredQuantity <= RECEIPT_STATUS_EPSILON) {
      continue;
    }
    const availableQty = roundQuantity(
      (allocationsByLine.get(requirement.receiptLineId) ?? [])
        .filter(
          (allocation) =>
            allocation.status === requirement.requiredStatus
            && (
              !requirement.requiredBinId
              || allocation.binId === requirement.requiredBinId
            )
        )
        .reduce((total, allocation) => total + allocation.quantity, 0)
    );
    if (availableQty + RECEIPT_STATUS_EPSILON < requiredQuantity) {
      throw new Error('RECEIPT_ALLOCATION_PRECHECK_FAILED');
    }
  }

  return buildReceiptAllocationWriteContext({
    tenantId: params.tenantId,
    kind: 'validated',
    receiptLineIds,
    allocationsByLine
  }) as ValidatedReceiptAllocationMutationContext;
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
  now: Date,
  context: ReceiptAllocationWriteContext
) {
  assertReceiptAllocationWriteContext(tenantId, context);
  assertContextCoversAllocations(context, allocations);
  assertReceiptAllocationTraceability(allocations);
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

export async function replaceReceiptAllocationsForReceipt(params: {
  client: PoolClient;
  tenantId: string;
  receiptId: string;
  allocations: ReceiptAllocation[];
  occurredAt: Date;
  context: ReceiptAllocationWriteContext;
}) {
  assertReceiptAllocationWriteContext(params.tenantId, params.context);
  if (params.context.kind !== 'rebuild') {
    throw new Error('RECEIPT_ALLOCATION_REBUILD_CONTEXT_REQUIRED');
  }
  assertContextCoversAllocations(params.context, params.allocations);
  await params.client.query(
    `DELETE FROM receipt_allocations
      WHERE tenant_id = $1
        AND purchase_order_receipt_id = $2`,
    [params.tenantId, params.receiptId]
  );
  await insertReceiptAllocations(
    params.client,
    params.tenantId,
    params.allocations,
    params.occurredAt,
    params.context
  );
}

export async function consumeReceiptAllocations(params: {
  client: PoolClient;
  tenantId: string;
  context: ValidatedReceiptAllocationMutationContext;
  receiptLineId: string;
  quantity: number;
  sourceStatus: ReceiptAllocationStatus;
  sourceBinId?: string | null;
  destinationLocationId?: string | null;
  destinationBinId?: string | null;
  destinationStatus?: ReceiptAllocationStatus | null;
  movementId: string;
  movementLineId?: string | null;
  occurredAt: Date;
}) {
  assertReceiptAllocationWriteContext(params.tenantId, params.context);
  if (!params.context.receiptLineIds.has(params.receiptLineId)) {
    throw new Error('RECEIPT_ALLOCATION_VALIDATION_SCOPE_MISMATCH');
  }
  let remaining = roundQuantity(params.quantity);
  const sourceAllocations = (params.context.allocationsByLine.get(params.receiptLineId) ?? [])
    .filter(
      (allocation) =>
        allocation.status === params.sourceStatus
        && (!params.sourceBinId || allocation.binId === params.sourceBinId)
    )
    .sort((left, right) => String(left.id ?? '').localeCompare(String(right.id ?? '')));
  const inserts: ReceiptAllocation[] = [];

  for (const allocation of sourceAllocations) {
    if (remaining <= RECEIPT_STATUS_EPSILON) {
      break;
    }
    const consumed = Math.min(remaining, allocation.quantity);
    remaining = roundQuantity(remaining - consumed);
    const updatedQty = roundQuantity(allocation.quantity - consumed);
    if (updatedQty <= RECEIPT_STATUS_EPSILON) {
      await params.client.query(
        `DELETE FROM receipt_allocations
          WHERE id = $1
            AND tenant_id = $2`,
        [allocation.id, params.tenantId]
      );
    } else {
      await params.client.query(
        `UPDATE receipt_allocations
            SET quantity = $3,
                updated_at = $4
          WHERE id = $1
            AND tenant_id = $2`,
        [allocation.id, params.tenantId, updatedQty, params.occurredAt]
      );
    }
    if (params.destinationStatus && params.destinationLocationId && params.destinationBinId) {
      inserts.push({
        receiptId: allocation.receiptId,
        receiptLineId: allocation.receiptLineId,
        warehouseId: allocation.warehouseId,
        locationId: params.destinationLocationId,
        binId: params.destinationBinId,
        inventoryMovementId: params.movementId,
        inventoryMovementLineId: params.movementLineId ?? null,
        costLayerId: allocation.costLayerId,
        quantity: consumed,
        status: params.destinationStatus
      });
    }
  }
  if (remaining > RECEIPT_STATUS_EPSILON) {
    throw new Error('RECEIPT_ALLOCATION_PRECHECK_FAILED');
  }
  if (inserts.length > 0) {
    await insertReceiptAllocations(
      params.client,
      params.tenantId,
      inserts,
      params.occurredAt,
      params.context
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

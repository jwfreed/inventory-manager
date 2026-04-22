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
  HOLD: 'HOLD',
  REWORK: 'REWORK',
  DISCARDED: 'DISCARDED'
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
  reworkQty: number;
  discardedQty: number;
  totalQty: number;
};

export type ReceiptPhysicalCount = {
  receiptLineId: string;
  countedQty: number;
  toleranceQty?: number;
};

type ReceiptAllocationDomainError = Error & {
  code?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
};

export function createReceiptAllocationError(
  code: string,
  details?: Record<string, unknown>,
  options?: { cause?: unknown }
) {
  const error = new Error(code) as ReceiptAllocationDomainError;
  error.code = code;
  if (details && Object.keys(details).length > 0) {
    error.details = details;
  }
  if (options?.cause !== undefined) {
    error.cause = options.cause;
  }
  return error;
}

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
  readonly expectedQtyByLine: ReadonlyMap<string, number>;
  allocationsByLine: ReadonlyMap<string, ReceiptAllocation[]>;
  readonly aggregate: ReceiptAllocationAggregate;
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
    throw createReceiptAllocationError('RECEIPT_ALLOCATION_VALIDATION_REQUIRED', {
      tenantId,
      contextTenantId: context?.tenantId ?? null
    });
  }
}

function buildReceiptAllocationWriteContext(params: {
  tenantId: string;
  kind: ReceiptAllocationWriteContextKind;
  expectedQtyByLine: Map<string, number>;
  aggregate: ReceiptAllocationAggregate;
}): ReceiptAllocationWriteContext {
  return {
    tenantId: params.tenantId,
    kind: params.kind,
    receiptLineIds: new Set(params.expectedQtyByLine.keys()),
    expectedQtyByLine: new Map(params.expectedQtyByLine),
    allocationsByLine: params.aggregate.snapshotByLine(),
    aggregate: params.aggregate,
    [RECEIPT_ALLOCATION_WRITE_CONTEXT]: true
  };
}

function refreshContextSnapshot(context: ReceiptAllocationWriteContext) {
  context.allocationsByLine = context.aggregate.snapshotByLine();
}

function assertContextCoversAllocations(
  context: ReceiptAllocationWriteContext,
  allocations: ReceiptAllocation[]
) {
  for (const allocation of allocations) {
    if (!context.receiptLineIds.has(allocation.receiptLineId)) {
      throw createReceiptAllocationError('RECEIPT_ALLOCATION_VALIDATION_SCOPE_MISMATCH', {
        receiptLineId: allocation.receiptLineId
      });
    }
  }
}

export function summarizeReceiptAllocations(allocations: ReceiptAllocation[]): ReceiptAllocationSummary {
  const summary: ReceiptAllocationSummary = {
    qaQty: 0,
    availableQty: 0,
    holdQty: 0,
    reworkQty: 0,
    discardedQty: 0,
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
    } else if (allocation.status === RECEIPT_ALLOCATION_STATUSES.REWORK) {
      summary.reworkQty = roundQuantity(summary.reworkQty + quantity);
    } else if (allocation.status === RECEIPT_ALLOCATION_STATUSES.DISCARDED) {
      summary.discardedQty = roundQuantity(summary.discardedQty + quantity);
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
      throw createReceiptAllocationError('RECEIPT_ALLOCATION_TRACEABILITY_VIOLATION', {
        receiptId: allocation.receiptId,
        receiptLineId: allocation.receiptLineId ?? null,
        inventoryMovementId: allocation.inventoryMovementId ?? null,
        inventoryMovementLineId: allocation.inventoryMovementLineId ?? null,
        warehouseId: allocation.warehouseId ?? null,
        locationId: allocation.locationId ?? null,
        binId: allocation.binId ?? null
      });
    }
    if (allocation.quantity <= RECEIPT_STATUS_EPSILON) {
      throw createReceiptAllocationError('RECEIPT_ALLOCATION_TRACEABILITY_VIOLATION', {
        receiptId: allocation.receiptId,
        receiptLineId: allocation.receiptLineId,
        quantity: allocation.quantity
      });
    }
  }
}

export function assertReceiptAllocationMappingConsistency(allocations: ReceiptAllocation[]) {
  const targetByMovementLine = new Map<string, string>();
  for (const allocation of allocations) {
    if (!allocation.inventoryMovementId || !allocation.inventoryMovementLineId) {
      continue;
    }
    const mappingKey = [
      allocation.receiptLineId,
      allocation.inventoryMovementId,
      allocation.inventoryMovementLineId
    ].join('|');
    const targetKey = [
      allocation.receiptId,
      allocation.locationId,
      allocation.binId,
      allocation.status
    ].join('|');
    const existingTarget = targetByMovementLine.get(mappingKey);
    if (existingTarget && existingTarget !== targetKey) {
      throw createReceiptAllocationError('RECEIPT_ALLOCATION_CONFLICTING_MAPPING', {
        receiptId: allocation.receiptId,
        receiptLineId: allocation.receiptLineId,
        inventoryMovementId: allocation.inventoryMovementId,
        inventoryMovementLineId: allocation.inventoryMovementLineId,
        existingTarget,
        conflictingTarget: targetKey
      });
    }
    targetByMovementLine.set(mappingKey, targetKey);
  }
}

function assertValidReceiptAllocationStatus(status: string): asserts status is ReceiptAllocationStatus {
  if (!Object.values(RECEIPT_ALLOCATION_STATUSES).includes(status as ReceiptAllocationStatus)) {
    throw createReceiptAllocationError('RECEIPT_ALLOCATION_STATUS_INVALID', { status });
  }
}

function cloneReceiptAllocation(allocation: ReceiptAllocation): ReceiptAllocation {
  return {
    ...allocation,
    id: allocation.id ?? uuidv4(),
    quantity: roundQuantity(allocation.quantity)
  };
}

function allocationBucketKey(params: {
  receiptLineId: string;
  status: ReceiptAllocationStatus;
  binId?: string | null;
}) {
  return [
    params.receiptLineId,
    params.status,
    params.binId ?? '*'
  ].join('|');
}

function addExpectedDelta(
  expectedQtyByLine: Map<string, number>,
  receiptLineId: string,
  delta: number
) {
  expectedQtyByLine.set(
    receiptLineId,
    roundQuantity((expectedQtyByLine.get(receiptLineId) ?? 0) + delta)
  );
}

export class ReceiptAllocationAggregate {
  private constructor(
    private readonly expectedQtyByLine: Map<string, number>,
    private readonly allocationsByLine: Map<string, ReceiptAllocation[]>
  ) {}

  static create(params: {
    expectedQtyByReceiptLineId: Map<string, number>;
    allocations: ReceiptAllocation[];
  }) {
    const allocationsByLine = new Map<string, ReceiptAllocation[]>();
    for (const allocation of params.allocations) {
      const normalized = cloneReceiptAllocation(allocation);
      assertValidReceiptAllocationStatus(normalized.status);
      const entries = allocationsByLine.get(normalized.receiptLineId) ?? [];
      entries.push(normalized);
      allocationsByLine.set(normalized.receiptLineId, entries);
    }
    const aggregate = new ReceiptAllocationAggregate(
      new Map(
        Array.from(params.expectedQtyByReceiptLineId.entries()).map(([lineId, quantity]) => [
          lineId,
          roundQuantity(quantity)
        ])
      ),
      allocationsByLine
    );
    aggregate.validateAll();
    return aggregate;
  }

  snapshotByLine() {
    const snapshot = new Map<string, ReceiptAllocation[]>();
    for (const [lineId, allocations] of this.allocationsByLine.entries()) {
      snapshot.set(lineId, allocations.map(cloneReceiptAllocation));
    }
    return snapshot;
  }

  snapshotAllocations() {
    return Array.from(this.snapshotByLine().values()).flat();
  }

  expectedQuantities() {
    return new Map(this.expectedQtyByLine);
  }

  assertRequirements(requirements: ReceiptAllocationValidationRequirement[]) {
    const requiredByBucket = new Map<string, ReceiptAllocationValidationRequirement & { requiredQuantity: number }>();
    for (const requirement of requirements) {
      if (!this.expectedQtyByLine.has(requirement.receiptLineId)) {
        throw createReceiptAllocationError('RECEIPT_ALLOCATION_VALIDATION_SCOPE_MISMATCH', {
          receiptLineId: requirement.receiptLineId
        });
      }
      if (!requirement.requiredStatus || requirement.requiredQuantity === undefined) {
        continue;
      }
      const requiredQuantity = roundQuantity(requirement.requiredQuantity);
      if (requiredQuantity <= RECEIPT_STATUS_EPSILON) {
        continue;
      }
      const key = allocationBucketKey({
        receiptLineId: requirement.receiptLineId,
        status: requirement.requiredStatus,
        binId: requirement.requiredBinId
      });
      const existing = requiredByBucket.get(key);
      requiredByBucket.set(key, {
        ...requirement,
        requiredQuantity: roundQuantity((existing?.requiredQuantity ?? 0) + requiredQuantity)
      });
    }
    for (const requirement of requiredByBucket.values()) {
      const availableQty = this.quantityAvailable({
        receiptLineId: requirement.receiptLineId,
        status: requirement.requiredStatus!,
        binId: requirement.requiredBinId
      });
      if (availableQty + RECEIPT_STATUS_EPSILON < requirement.requiredQuantity) {
        throw createReceiptAllocationError('RECEIPT_ALLOCATION_PRECHECK_FAILED', {
          receiptLineId: requirement.receiptLineId,
          requiredStatus: requirement.requiredStatus,
          requiredBinId: requirement.requiredBinId ?? null,
          requiredQuantity: requirement.requiredQuantity,
          availableQty
        });
      }
    }
  }

  applyInsert(params: {
    allocations: ReceiptAllocation[];
    expectedQuantityDeltaByReceiptLineId?: Map<string, number>;
  }) {
    const prepared = params.allocations.map(cloneReceiptAllocation);
    const nextExpected = new Map(this.expectedQtyByLine);
    for (const [receiptLineId, delta] of params.expectedQuantityDeltaByReceiptLineId?.entries() ?? []) {
      addExpectedDelta(nextExpected, receiptLineId, delta);
    }
    for (const allocation of prepared) {
      if (!nextExpected.has(allocation.receiptLineId)) {
        throw createReceiptAllocationError('RECEIPT_ALLOCATION_VALIDATION_SCOPE_MISMATCH', {
          receiptLineId: allocation.receiptLineId
        });
      }
      assertValidReceiptAllocationStatus(allocation.status);
    }
    const touchedLineIds = new Set(prepared.map((allocation) => allocation.receiptLineId));
    for (const [receiptLineId, expectedQty] of nextExpected.entries()) {
      this.expectedQtyByLine.set(receiptLineId, expectedQty);
    }
    for (const allocation of prepared) {
      const entries = this.allocationsByLine.get(allocation.receiptLineId) ?? [];
      entries.push(allocation);
      this.allocationsByLine.set(allocation.receiptLineId, entries);
    }
    for (const receiptLineId of touchedLineIds) {
      this.validateLine(receiptLineId);
    }
    return prepared;
  }

  applyConsume(params: {
    receiptLineId: string;
    quantity: number;
    sourceStatus: ReceiptAllocationStatus;
    sourceBinId: string;
    destinationLocationId?: string | null;
    destinationBinId?: string | null;
    destinationStatus?: ReceiptAllocationStatus | null;
    movementId: string;
    movementLineId?: string | null;
    expectedQuantityDelta?: number;
  }) {
    if (!this.expectedQtyByLine.has(params.receiptLineId)) {
      throw createReceiptAllocationError('RECEIPT_ALLOCATION_VALIDATION_SCOPE_MISMATCH', {
        receiptLineId: params.receiptLineId
      });
    }
    if (!params.sourceBinId) {
      throw createReceiptAllocationError('RECEIPT_ALLOCATION_BIN_TARGET_REQUIRED', {
        receiptLineId: params.receiptLineId,
        sourceStatus: params.sourceStatus
      });
    }
    if (!params.movementId || !params.movementLineId) {
      throw createReceiptAllocationError('RECEIPT_ALLOCATION_TRACEABILITY_VIOLATION', {
        receiptLineId: params.receiptLineId,
        movementId: params.movementId ?? null,
        movementLineId: params.movementLineId ?? null
      });
    }
    assertValidReceiptAllocationStatus(params.sourceStatus);
    if (params.destinationStatus) {
      assertValidReceiptAllocationStatus(params.destinationStatus);
      const VALID_TRANSITIONS = new Map<ReceiptAllocationStatus, Set<ReceiptAllocationStatus>>([
        [
          RECEIPT_ALLOCATION_STATUSES.QA,
          new Set([RECEIPT_ALLOCATION_STATUSES.AVAILABLE, RECEIPT_ALLOCATION_STATUSES.HOLD])
        ],
        [
          RECEIPT_ALLOCATION_STATUSES.HOLD,
          new Set([
            RECEIPT_ALLOCATION_STATUSES.AVAILABLE,
            RECEIPT_ALLOCATION_STATUSES.REWORK,
            RECEIPT_ALLOCATION_STATUSES.DISCARDED
          ])
        ]
      ]);
      if (!VALID_TRANSITIONS.get(params.sourceStatus)?.has(params.destinationStatus)) {
        throw createReceiptAllocationError('RECEIPT_ALLOCATION_STATUS_TRANSITION_INVALID', {
          receiptLineId: params.receiptLineId,
          sourceStatus: params.sourceStatus,
          destinationStatus: params.destinationStatus
        });
      }
      if (!params.destinationLocationId || !params.destinationBinId) {
        throw createReceiptAllocationError('RECEIPT_ALLOCATION_DESTINATION_REQUIRED', {
          receiptLineId: params.receiptLineId,
          destinationLocationId: params.destinationLocationId ?? null,
          destinationBinId: params.destinationBinId ?? null
        });
      }
    } else if (roundQuantity(params.expectedQuantityDelta ?? 0) >= 0) {
      throw createReceiptAllocationError('RECEIPT_ALLOCATION_STATUS_TRANSITION_INVALID', {
        receiptLineId: params.receiptLineId,
        sourceStatus: params.sourceStatus,
        expectedQuantityDelta: params.expectedQuantityDelta ?? 0
      });
    }

    const targetQuantity = roundQuantity(params.quantity);
    if (targetQuantity <= RECEIPT_STATUS_EPSILON) {
      throw createReceiptAllocationError('RECEIPT_ALLOCATION_QUANTITY_INVALID', {
        receiptLineId: params.receiptLineId,
        quantity: params.quantity
      });
    }
    let remaining = targetQuantity;
    const lineAllocations = this.allocationsByLine.get(params.receiptLineId) ?? [];
    const candidates = lineAllocations
      .filter(
        (allocation) =>
          allocation.status === params.sourceStatus
          && allocation.binId === params.sourceBinId
      );
    const updates: Array<{ id: string; quantity: number }> = [];
    const deletes: string[] = [];
    const inserts: ReceiptAllocation[] = [];

    for (const allocation of candidates) {
      if (remaining <= RECEIPT_STATUS_EPSILON) {
        break;
      }
      if (!allocation.id) {
        throw createReceiptAllocationError('RECEIPT_ALLOCATION_TRACEABILITY_VIOLATION', {
          receiptLineId: params.receiptLineId,
          sourceStatus: params.sourceStatus,
          sourceBinId: params.sourceBinId
        });
      }
      const consumed = Math.min(remaining, allocation.quantity);
      remaining = roundQuantity(remaining - consumed);
      const updatedQty = roundQuantity(allocation.quantity - consumed);
      if (updatedQty <= RECEIPT_STATUS_EPSILON) {
        deletes.push(allocation.id);
        allocation.quantity = 0;
      } else {
        updates.push({ id: allocation.id, quantity: updatedQty });
        allocation.quantity = updatedQty;
      }
      if (params.destinationStatus && params.destinationLocationId && params.destinationBinId) {
        inserts.push({
          id: uuidv4(),
          receiptId: allocation.receiptId,
          receiptLineId: allocation.receiptLineId,
          warehouseId: allocation.warehouseId,
          locationId: params.destinationLocationId,
          binId: params.destinationBinId,
          inventoryMovementId: params.movementId,
          inventoryMovementLineId: params.movementLineId,
          costLayerId: allocation.costLayerId,
          quantity: consumed,
          status: params.destinationStatus
        });
      }
    }
    if (remaining > RECEIPT_STATUS_EPSILON) {
      throw createReceiptAllocationError('RECEIPT_ALLOCATION_PRECHECK_FAILED', {
        receiptLineId: params.receiptLineId,
        sourceStatus: params.sourceStatus,
        sourceBinId: params.sourceBinId,
        requestedQuantity: targetQuantity,
        remainingQuantity: remaining
      });
    }

    this.allocationsByLine.set(
      params.receiptLineId,
      lineAllocations.filter((allocation) => allocation.quantity > RECEIPT_STATUS_EPSILON)
    );
    if (params.expectedQuantityDelta) {
      addExpectedDelta(this.expectedQtyByLine, params.receiptLineId, params.expectedQuantityDelta);
    }
    for (const insert of inserts) {
      const entries = this.allocationsByLine.get(insert.receiptLineId) ?? [];
      entries.push(insert);
      this.allocationsByLine.set(insert.receiptLineId, entries);
    }
    this.validateLine(params.receiptLineId);
    return { updates, deletes, inserts };
  }

  private quantityAvailable(params: {
    receiptLineId: string;
    status: ReceiptAllocationStatus;
    binId?: string | null;
  }) {
    return roundQuantity(
      (this.allocationsByLine.get(params.receiptLineId) ?? [])
        .filter(
          (allocation) =>
            allocation.status === params.status
            && (!params.binId || allocation.binId === params.binId)
        )
        .reduce((total, allocation) => total + allocation.quantity, 0)
    );
  }

  private validateAll() {
    for (const receiptLineId of this.expectedQtyByLine.keys()) {
      this.validateLine(receiptLineId);
    }
    for (const receiptLineId of this.allocationsByLine.keys()) {
      if (!this.expectedQtyByLine.has(receiptLineId)) {
        throw createReceiptAllocationError('RECEIPT_ALLOCATION_VALIDATION_SCOPE_MISMATCH', {
          receiptLineId
        });
      }
    }
  }

  private validateLine(receiptLineId: string) {
    const allocations = this.allocationsByLine.get(receiptLineId) ?? [];
    assertReceiptAllocationTraceability(allocations);
    assertReceiptAllocationMappingConsistency(allocations);
    for (const allocation of allocations) {
      assertValidReceiptAllocationStatus(allocation.status);
      if (allocation.receiptLineId !== receiptLineId) {
        throw createReceiptAllocationError('RECEIPT_ALLOCATION_VALIDATION_SCOPE_MISMATCH', {
          expectedReceiptLineId: receiptLineId,
          actualReceiptLineId: allocation.receiptLineId
        });
      }
    }
    assertReceiptAllocationQuantityConservation({
      receiptQuantity: this.expectedQtyByLine.get(receiptLineId) ?? 0,
      allocations
    });
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
          `SELECT id, movement_id
             FROM inventory_movement_lines
            WHERE tenant_id = $1
              AND id = ANY($2::uuid[])`,
          [params.tenantId, movementLineIds]
        )
      : Promise.resolve({ rows: [] })
  ]);
  const foundMovements = new Set(movementResult.rows.map((row: any) => row.id));
  const foundMovementLines = new Map(movementLineResult.rows.map((row: any) => [row.id, row.movement_id]));
  for (const allocation of params.allocations) {
    if (
      !allocation.inventoryMovementId
      || !allocation.inventoryMovementLineId
      || !foundMovements.has(allocation.inventoryMovementId)
      || foundMovementLines.get(allocation.inventoryMovementLineId) !== allocation.inventoryMovementId
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
  const aggregate = ReceiptAllocationAggregate.create({
    expectedQtyByReceiptLineId: params.expectedQtyByReceiptLineId,
    allocations: params.allocations
  });
  return buildReceiptAllocationWriteContext({
    tenantId: params.tenantId,
    kind: 'initial',
    expectedQtyByLine: aggregate.expectedQuantities(),
    aggregate
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
    expectedQtyByLine: new Map(context.expectedQtyByLine),
    aggregate: context.aggregate
  });
}

async function assertReceiptAllocationReceiptLineOwnership(params: {
  client: PoolClient;
  tenantId: string;
  allocations: ReceiptAllocation[];
}) {
  const receiptLineIds = Array.from(new Set(params.allocations.map((allocation) => allocation.receiptLineId)));
  if (receiptLineIds.length === 0) {
    return;
  }
  const result = await params.client.query(
    `SELECT id, purchase_order_receipt_id
       FROM purchase_order_receipt_lines
      WHERE tenant_id = $1
        AND id = ANY($2::uuid[])`,
    [params.tenantId, receiptLineIds]
  );
  if ((result.rowCount ?? 0) !== receiptLineIds.length) {
    const foundLineIds = new Set(result.rows.map((row) => String(row.id)));
    const missingReceiptLineIds = receiptLineIds.filter((receiptLineId) => !foundLineIds.has(receiptLineId));
    throw createReceiptAllocationError('RECEIPT_ALLOCATION_ORPHANED', {
      missingReceiptLineIds
    });
  }
  const receiptIdByLineId = new Map(result.rows.map((row) => [String(row.id), String(row.purchase_order_receipt_id)]));
  for (const allocation of params.allocations) {
    const authoritativeReceiptId = receiptIdByLineId.get(allocation.receiptLineId);
    if (!authoritativeReceiptId || authoritativeReceiptId !== allocation.receiptId) {
      throw createReceiptAllocationError('RECEIPT_ALLOCATION_ORPHANED', {
        receiptId: allocation.receiptId,
        authoritativeReceiptId: authoritativeReceiptId ?? null,
        receiptLineId: allocation.receiptLineId
      });
    }
  }
}

async function loadExpectedReceiptAllocationQuantities(params: {
  client: PoolClient;
  tenantId: string;
  receiptLineIds: string[];
}) {
  const lineResult = await params.client.query(
    `SELECT id, quantity_received
       FROM purchase_order_receipt_lines
      WHERE tenant_id = $1
        AND id = ANY($2::uuid[])
      ORDER BY created_at ASC, id ASC
      FOR UPDATE`,
    [params.tenantId, params.receiptLineIds]
  );
  if ((lineResult.rowCount ?? 0) !== params.receiptLineIds.length) {
    throw new Error('RECEIPT_ALLOCATION_VALIDATION_LINE_NOT_FOUND');
  }
  const expectedQtyByLine = new Map<string, number>();
  for (const row of lineResult.rows) {
    expectedQtyByLine.set(row.id, roundQuantity(Number(row.quantity_received ?? 0)));
  }
  const adjustmentResult = await params.client.query(
    `SELECT d.purchase_order_receipt_line_id AS receipt_line_id,
            COALESCE(SUM(d.discrepancy_qty), 0)::numeric AS adjustment_qty
       FROM receipt_reconciliation_discrepancies d
       JOIN receipt_reconciliation_resolutions r
         ON r.discrepancy_id = d.id
        AND r.tenant_id = d.tenant_id
        AND r.resolution_type = 'ADJUSTMENT'
      WHERE d.tenant_id = $1
        AND d.purchase_order_receipt_line_id = ANY($2::uuid[])
        AND d.status = 'ADJUSTED'
      GROUP BY d.purchase_order_receipt_line_id`,
    [params.tenantId, params.receiptLineIds]
  );
  for (const row of adjustmentResult.rows) {
    addExpectedDelta(expectedQtyByLine, row.receipt_line_id, Number(row.adjustment_qty ?? 0));
  }
  return expectedQtyByLine;
}

export async function validateReceiptAllocationMutationContext(params: {
  client: PoolClient;
  tenantId: string;
  requirements: ReceiptAllocationValidationRequirement[];
}): Promise<ValidatedReceiptAllocationMutationContext> {
  const receiptLineIds = Array.from(new Set(params.requirements.map((requirement) => requirement.receiptLineId)));
  if (receiptLineIds.length === 0) {
    throw createReceiptAllocationError('RECEIPT_ALLOCATION_VALIDATION_SCOPE_REQUIRED');
  }
  const expectedQtyByLine = await loadExpectedReceiptAllocationQuantities({
    client: params.client,
    tenantId: params.tenantId,
    receiptLineIds
  });
  const allocationsByLine = await loadReceiptAllocationsByLine(params.client, params.tenantId, receiptLineIds);
  const allAllocations = Array.from(allocationsByLine.values()).flat();
  await assertReceiptAllocationMovementLinks({
    client: params.client,
    tenantId: params.tenantId,
    allocations: allAllocations
  });
  await assertReceiptAllocationReceiptLineOwnership({
    client: params.client,
    tenantId: params.tenantId,
    allocations: allAllocations
  });
  const aggregate = ReceiptAllocationAggregate.create({
    expectedQtyByReceiptLineId: expectedQtyByLine,
    allocations: allAllocations
  });

  aggregate.assertRequirements(params.requirements);

  return buildReceiptAllocationWriteContext({
    tenantId: params.tenantId,
    kind: 'validated',
    expectedQtyByLine,
    aggregate
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
  assertReceiptAllocationMappingConsistency(allocations);
  await assertReceiptAllocationReceiptLineOwnership({ client, tenantId, allocations });
  await assertReceiptAllocationMovementLinks({ client, tenantId, allocations });
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

export async function createInitialReceiptAllocations(params: {
  client: PoolClient;
  tenantId: string;
  expectedQtyByReceiptLineId: Map<string, number>;
  allocations: ReceiptAllocation[];
  occurredAt: Date;
}) {
  const context = createInitialReceiptAllocationWriteContext({
    tenantId: params.tenantId,
    expectedQtyByReceiptLineId: params.expectedQtyByReceiptLineId,
    allocations: params.allocations
  });
  await insertReceiptAllocations(
    params.client,
    params.tenantId,
    context.aggregate.snapshotAllocations(),
    params.occurredAt,
    context
  );
}

export async function addReceiptAllocations(params: {
  client: PoolClient;
  tenantId: string;
  context: ValidatedReceiptAllocationMutationContext;
  allocations: ReceiptAllocation[];
  expectedQuantityDeltaByReceiptLineId?: Map<string, number>;
  occurredAt: Date;
}) {
  assertReceiptAllocationWriteContext(params.tenantId, params.context);
  const prepared = params.context.aggregate.applyInsert({
    allocations: params.allocations,
    expectedQuantityDeltaByReceiptLineId: params.expectedQuantityDeltaByReceiptLineId
  });
  await insertReceiptAllocations(
    params.client,
    params.tenantId,
    prepared,
    params.occurredAt,
    params.context
  );
  refreshContextSnapshot(params.context);
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
    throw createReceiptAllocationError('RECEIPT_ALLOCATION_REBUILD_CONTEXT_REQUIRED', {
      contextKind: params.context.kind
    });
  }
  assertContextCoversAllocations(params.context, params.allocations);
  for (const allocation of params.allocations) {
    if (allocation.receiptId !== params.receiptId) {
      throw createReceiptAllocationError('RECEIPT_ALLOCATION_RECEIPT_SCOPE_MISMATCH', {
        expectedReceiptId: params.receiptId,
        actualReceiptId: allocation.receiptId,
        receiptLineId: allocation.receiptLineId
      });
    }
  }
  await params.client.query('SAVEPOINT receipt_allocation_replace');
  try {
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
    await params.client.query('RELEASE SAVEPOINT receipt_allocation_replace');
  } catch (error) {
    await params.client.query('ROLLBACK TO SAVEPOINT receipt_allocation_replace');
    throw error;
  }
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
  expectedQuantityDelta?: number;
}) {
  assertReceiptAllocationWriteContext(params.tenantId, params.context);
  if (!params.context.receiptLineIds.has(params.receiptLineId)) {
    throw createReceiptAllocationError('RECEIPT_ALLOCATION_VALIDATION_SCOPE_MISMATCH', {
      receiptLineId: params.receiptLineId
    });
  }
  const plan = params.context.aggregate.applyConsume({
    receiptLineId: params.receiptLineId,
    quantity: params.quantity,
    sourceStatus: params.sourceStatus,
    sourceBinId: params.sourceBinId ?? '',
    destinationLocationId: params.destinationLocationId,
    destinationBinId: params.destinationBinId,
    destinationStatus: params.destinationStatus,
    movementId: params.movementId,
    movementLineId: params.movementLineId,
    expectedQuantityDelta: params.expectedQuantityDelta
  });
  for (const allocationId of plan.deletes) {
    const result = await params.client.query(
      `DELETE FROM receipt_allocations
        WHERE id = $1
          AND tenant_id = $2`,
      [allocationId, params.tenantId]
    );
    if ((result.rowCount ?? 0) !== 1) {
      throw createReceiptAllocationError('RECEIPT_ALLOCATION_MUTATION_STALE', {
        allocationId,
        receiptLineId: params.receiptLineId
      });
    }
  }
  for (const update of plan.updates) {
    const result = await params.client.query(
      `UPDATE receipt_allocations
          SET quantity = $3,
              updated_at = $4
        WHERE id = $1
          AND tenant_id = $2`,
      [update.id, params.tenantId, update.quantity, params.occurredAt]
    );
    if ((result.rowCount ?? 0) !== 1) {
      throw createReceiptAllocationError('RECEIPT_ALLOCATION_MUTATION_STALE', {
        allocationId: update.id,
        receiptLineId: params.receiptLineId
      });
    }
  }
  if (plan.inserts.length > 0) {
    await insertReceiptAllocations(
      params.client,
      params.tenantId,
      plan.inserts,
      params.occurredAt,
      params.context
    );
  }
  refreshContextSnapshot(params.context);
}

export async function moveReceiptAllocations(params: Parameters<typeof consumeReceiptAllocations>[0]) {
  await consumeReceiptAllocations(params);
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

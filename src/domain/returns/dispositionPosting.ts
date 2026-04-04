import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { roundQuantity, toNumber } from '../../lib/numbers';
import { buildPlannedMovementFromLines, planMovementLines } from '../../services/inventoryMovementPlanner';
import type { PlannedWorkOrderMovement } from '../../services/inventoryMovementPlanner';
import { ensureInventoryBalanceRowAndLock, persistInventoryMovement } from '../../domains/inventory';
import { validateResolvedStockLevels } from '../../services/stockValidation.service';
import { relocateTransferCostLayersInTx } from '../../services/transferCosting.service';
import {
  buildInventoryBalanceProjectionOp
} from '../../modules/platform/application/inventoryMutationSupport';
import type { InventoryCommandProjectionOp } from '../../modules/platform/application/runInventoryCommand';
import { assertProjectionDeltaContract } from '../inventory/mutationInvariants';
import { resolveWarehouseIdForLocation } from '../../services/warehouseDefaults.service';

type LockedReturnDispositionRow = {
  id: string;
  return_receipt_id: string;
  disposition_type: 'restock' | 'scrap' | 'quarantine_hold';
  occurred_at: string | Date | null;
  from_location_id: string;
  to_location_id: string | null;
  notes: string | null;
};

type LockedReturnDispositionLineRow = {
  id: string;
  line_number: number | null;
  item_id: string;
  uom: string;
  quantity: string | number;
  notes: string | null;
};

type ReceiptPostingStateRow = {
  status: string;
  inventory_movement_id: string | null;
};

type ReceiptTotalRow = {
  item_id: string;
  uom: string;
  qty: string | number;
};

type LocationPolicyRow = {
  role: string | null;
  is_sellable: boolean;
};

type DispositionReasonCodes = Readonly<{
  outbound: string;
  inbound: string;
}>;

export type ReturnDispositionPostPolicy = Readonly<{
  warehouseId: string;
  destinationLocationId: string;
  occurredAt: Date;
  reasonCodes: DispositionReasonCodes;
  itemIdsToLock: ReadonlyArray<string>;
}>;

type ReturnDispositionPlanPair = Readonly<{
  itemId: string;
  sourceLocationId: string;
  destinationLocationId: string;
  canonicalUom: string;
  quantity: number;
  outSourceLineId: string;
  inSourceLineId: string;
}>;

export type ReturnDispositionMovementPlan = Readonly<{
  movement: PlannedWorkOrderMovement;
  pairs: ReadonlyArray<ReturnDispositionPlanPair>;
  projectionOps: ReadonlyArray<InventoryCommandProjectionOp>;
}>;

async function loadLocationPolicyRow(params: {
  client: PoolClient;
  tenantId: string;
  locationId: string;
  notFoundCode: string;
}) {
  const result = await params.client.query<LocationPolicyRow>(
    `SELECT role, is_sellable
       FROM locations
      WHERE tenant_id = $1
        AND id = $2
      LIMIT 1`,
    [params.tenantId, params.locationId]
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new Error(params.notFoundCode);
  }
  return result.rows[0]!;
}

function buildDispositionReasonCodes(
  dispositionType: LockedReturnDispositionRow['disposition_type']
): DispositionReasonCodes {
  if (dispositionType === 'restock') {
    return Object.freeze({
      outbound: 'return_restock_out',
      inbound: 'return_restock_in'
    });
  }
  if (dispositionType === 'scrap') {
    return Object.freeze({
      outbound: 'return_scrap_out',
      inbound: 'return_scrap_in'
    });
  }
  return Object.freeze({
    outbound: 'return_quarantine_out',
    inbound: 'return_quarantine_in'
  });
}

export async function evaluateReturnDispositionPostPolicy(params: {
  client: PoolClient;
  tenantId: string;
  disposition: LockedReturnDispositionRow;
  dispositionLines: ReadonlyArray<LockedReturnDispositionLineRow>;
}) {
  const receiptResult = await params.client.query<ReceiptPostingStateRow>(
    `SELECT status, inventory_movement_id
       FROM return_receipts
      WHERE tenant_id = $1
        AND id = $2
      LIMIT 1
      FOR UPDATE`,
    [params.tenantId, params.disposition.return_receipt_id]
  );
  if ((receiptResult.rowCount ?? 0) === 0) {
    throw new Error('RETURN_DISPOSITION_RECEIPT_NOT_FOUND');
  }
  const receipt = receiptResult.rows[0]!;
  if (receipt.status !== 'posted' || !receipt.inventory_movement_id) {
    throw new Error('RETURN_DISPOSITION_RECEIPT_NOT_POSTED');
  }

  const warehouseId = await resolveWarehouseIdForLocation(
    params.tenantId,
    params.disposition.from_location_id,
    params.client
  );
  if (!warehouseId) {
    throw new Error('WAREHOUSE_SCOPE_REQUIRED');
  }

  const destinationLocationId = params.disposition.to_location_id;
  if (!destinationLocationId) {
    throw new Error('RETURN_DISPOSITION_DESTINATION_REQUIRED');
  }
  if (destinationLocationId === params.disposition.from_location_id) {
    throw new Error('RETURN_DISPOSITION_SAME_LOCATION');
  }

  const destinationWarehouseId = await resolveWarehouseIdForLocation(
    params.tenantId,
    destinationLocationId,
    params.client
  );
  if (!destinationWarehouseId || destinationWarehouseId !== warehouseId) {
    throw new Error('WAREHOUSE_SCOPE_MISMATCH');
  }

  const destinationPolicy = await loadLocationPolicyRow({
    client: params.client,
    tenantId: params.tenantId,
    locationId: destinationLocationId,
    notFoundCode: 'RETURN_DISPOSITION_DESTINATION_NOT_FOUND'
  });
  if (params.disposition.disposition_type === 'restock') {
    if (!destinationPolicy.is_sellable) {
      throw new Error('RETURN_DISPOSITION_RESTOCK_REQUIRES_SELLABLE');
    }
  } else if (params.disposition.disposition_type === 'scrap') {
    if (destinationPolicy.role !== 'SCRAP' || destinationPolicy.is_sellable) {
      throw new Error('RETURN_DISPOSITION_SCRAP_REQUIRES_SCRAP_LOCATION');
    }
  } else if (destinationPolicy.role !== 'HOLD' || destinationPolicy.is_sellable) {
    throw new Error('RETURN_DISPOSITION_HOLD_REQUIRES_HOLD_LOCATION');
  }

  const receiptTotalsResult = await params.client.query<ReceiptTotalRow>(
    `SELECT item_id, uom, COALESCE(SUM(quantity_received), 0)::numeric AS qty
       FROM return_receipt_lines
      WHERE tenant_id = $1
        AND return_receipt_id = $2
      GROUP BY item_id, uom`,
    [params.tenantId, params.disposition.return_receipt_id]
  );
  const priorDispositionTotalsResult = await params.client.query<ReceiptTotalRow>(
    `SELECT rdl.item_id, rdl.uom, COALESCE(SUM(rdl.quantity), 0)::numeric AS qty
       FROM return_disposition_lines rdl
       JOIN return_dispositions rd
         ON rd.id = rdl.return_disposition_id
        AND rd.tenant_id = rdl.tenant_id
      WHERE rd.tenant_id = $1
        AND rd.return_receipt_id = $2
        AND rd.status = 'posted'
        AND rd.id <> $3
      GROUP BY rdl.item_id, rdl.uom`,
    [params.tenantId, params.disposition.return_receipt_id, params.disposition.id]
  );

  const receiptTotals = new Map(
    receiptTotalsResult.rows.map((row) => [`${row.item_id}:${row.uom}`, roundQuantity(toNumber(row.qty ?? 0))])
  );
  const priorTotals = new Map(
    priorDispositionTotalsResult.rows.map((row) => [`${row.item_id}:${row.uom}`, roundQuantity(toNumber(row.qty ?? 0))])
  );
  const requestedTotals = new Map<string, number>();
  for (const line of params.dispositionLines) {
    const key = `${line.item_id}:${line.uom}`;
    requestedTotals.set(key, roundQuantity((requestedTotals.get(key) ?? 0) + toNumber(line.quantity)));
  }

  for (const [key, requestedQty] of requestedTotals.entries()) {
    const receiptQty = receiptTotals.get(key);
    if (receiptQty === undefined) {
      throw new Error('RETURN_DISPOSITION_LINE_RECEIPT_MISMATCH');
    }
    const projected = roundQuantity((priorTotals.get(key) ?? 0) + requestedQty);
    if (projected - receiptQty > 1e-6) {
      throw new Error('RETURN_DISPOSITION_QTY_EXCEEDS_RECEIVED');
    }
  }

  return Object.freeze({
    warehouseId,
    destinationLocationId,
    occurredAt: params.disposition.occurred_at ? new Date(params.disposition.occurred_at) : new Date(),
    reasonCodes: buildDispositionReasonCodes(params.disposition.disposition_type),
    itemIdsToLock: Array.from(
      new Set(
        params.dispositionLines
          .map((line) => line.item_id)
          .filter((value): value is string => typeof value === 'string' && value.length > 0)
      )
    ).sort((left, right) => left.localeCompare(right))
  }) satisfies ReturnDispositionPostPolicy;
}

export async function buildReturnDispositionMovementPlan(params: {
  client: PoolClient;
  tenantId: string;
  disposition: LockedReturnDispositionRow;
  dispositionLines: ReadonlyArray<LockedReturnDispositionLineRow>;
  policy: ReturnDispositionPostPolicy;
  idempotencyKey: string;
}) {
  const rawLines = [];
  for (const line of params.dispositionLines) {
    const qty = roundQuantity(toNumber(line.quantity));
    const outSourceLineId = `${params.disposition.id}:${line.id}:out`;
    const inSourceLineId = `${params.disposition.id}:${line.id}:in`;
    rawLines.push({
      sourceLineId: outSourceLineId,
      warehouseId: params.policy.warehouseId,
      itemId: line.item_id,
      locationId: params.disposition.from_location_id,
      quantity: -qty,
      uom: line.uom,
      defaultReasonCode: params.policy.reasonCodes.outbound,
      lineNotes: line.notes ?? `Return disposition ${params.disposition.id} line ${line.id} outbound`
    });
    rawLines.push({
      sourceLineId: inSourceLineId,
      warehouseId: params.policy.warehouseId,
      itemId: line.item_id,
      locationId: params.policy.destinationLocationId,
      quantity: qty,
      uom: line.uom,
      defaultReasonCode: params.policy.reasonCodes.inbound,
      lineNotes: line.notes ?? `Return disposition ${params.disposition.id} line ${line.id} inbound`
    });
  }

  const plannedLines = await planMovementLines({
    tenantId: params.tenantId,
    lines: rawLines,
    client: params.client
  });

  const movement = buildPlannedMovementFromLines({
    header: {
      id: uuidv4(),
      tenantId: params.tenantId,
      movementType: 'transfer',
      status: 'posted',
      externalRef: `return_disposition:${params.disposition.id}`,
      sourceType: 'return_disposition_post',
      sourceId: params.disposition.id,
      idempotencyKey: params.idempotencyKey,
      occurredAt: params.policy.occurredAt,
      postedAt: new Date(),
      notes: params.disposition.notes ?? null,
      createdAt: new Date(),
      updatedAt: new Date()
    },
    lines: plannedLines
  });

  const sortedLineBySourceLineId = new Map(
    movement.sortedLines.map((line, index) => [line.sourceLineId, { line, index }])
  );
  const pairs = params.dispositionLines.map((line) => {
    const outSourceLineId = `${params.disposition.id}:${line.id}:out`;
    const inSourceLineId = `${params.disposition.id}:${line.id}:in`;
    const outbound = sortedLineBySourceLineId.get(outSourceLineId)?.line;
    const inbound = sortedLineBySourceLineId.get(inSourceLineId)?.line;
    if (!outbound || !inbound) {
      throw new Error('RETURN_DISPOSITION_PLAN_PAIR_MISSING');
    }
    if (outbound.canonicalFields.canonicalUom !== inbound.canonicalFields.canonicalUom) {
      throw new Error('RETURN_DISPOSITION_CANONICAL_UOM_MISMATCH');
    }
    if (
      Math.abs(
        Math.abs(outbound.canonicalFields.quantityDeltaCanonical) - inbound.canonicalFields.quantityDeltaCanonical
      ) > 1e-6
    ) {
      throw new Error('RETURN_DISPOSITION_QUANTITY_IMBALANCE');
    }
    return Object.freeze({
      itemId: line.item_id,
      sourceLocationId: params.disposition.from_location_id,
      destinationLocationId: params.policy.destinationLocationId,
      canonicalUom: outbound.canonicalFields.canonicalUom,
      quantity: inbound.canonicalFields.quantityDeltaCanonical,
      outSourceLineId,
      inSourceLineId
    });
  });

  const projectionDeltas = movement.sortedLines.map((line) => ({
    itemId: line.itemId,
    locationId: line.locationId,
    uom: line.canonicalFields.canonicalUom,
    deltaOnHand: line.canonicalFields.quantityDeltaCanonical
  }));
  assertProjectionDeltaContract({
    movementDeltas: projectionDeltas,
    projectionDeltas,
    errorCode: 'RETURN_DISPOSITION_PROJECTION_CONTRACT_INVALID'
  });

  return Object.freeze({
    movement,
    pairs,
    projectionOps: projectionDeltas.map((delta) =>
      buildInventoryBalanceProjectionOp({
        tenantId: params.tenantId,
        itemId: delta.itemId,
        locationId: delta.locationId,
        uom: delta.uom,
        deltaOnHand: delta.deltaOnHand
      })
    )
  }) satisfies ReturnDispositionMovementPlan;
}

function compareLockTarget(
  left: { itemId: string; locationId: string; uom: string },
  right: { itemId: string; locationId: string; uom: string }
) {
  const itemCompare = left.itemId.localeCompare(right.itemId);
  if (itemCompare !== 0) return itemCompare;
  const locationCompare = left.locationId.localeCompare(right.locationId);
  if (locationCompare !== 0) return locationCompare;
  return left.uom.localeCompare(right.uom);
}

export async function executeReturnDispositionMovementPlan(params: {
  client: PoolClient;
  tenantId: string;
  dispositionId: string;
  plan: ReturnDispositionMovementPlan;
  occurredAt: Date;
}) {
  const lockedBalances = new Map<string, Awaited<ReturnType<typeof ensureInventoryBalanceRowAndLock>>>();
  const lockTargets = Array.from(
    new Map(
      params.plan.movement.sortedLines.map((line) => [
        `${line.itemId}:${line.locationId}:${line.canonicalFields.canonicalUom}`,
        {
          itemId: line.itemId,
          locationId: line.locationId,
          uom: line.canonicalFields.canonicalUom
        }
      ])
    ).values()
  ).sort(compareLockTarget);

  for (const target of lockTargets) {
    const row = await ensureInventoryBalanceRowAndLock(
      params.client,
      params.tenantId,
      target.itemId,
      target.locationId,
      target.uom
    );
    lockedBalances.set(`${target.itemId}:${target.locationId}:${target.uom}`, row);
  }

  validateResolvedStockLevels(
    params.occurredAt,
    params.plan.pairs.map((pair) => {
      const row = lockedBalances.get(`${pair.itemId}:${pair.sourceLocationId}:${pair.canonicalUom}`);
      return {
        itemId: pair.itemId,
        locationId: pair.sourceLocationId,
        uom: pair.canonicalUom,
        requested: pair.quantity,
        available: Number(row?.available ?? 0)
      };
    })
  );

  const movementResult = await persistInventoryMovement(params.client, params.plan.movement.persistInput);
  if (!movementResult.created) {
    return {
      movementId: movementResult.movementId,
      created: false,
      projectionOps: [] as InventoryCommandProjectionOp[]
    };
  }

  const indexBySourceLineId = new Map(
    params.plan.movement.sortedLines.map((line, index) => [line.sourceLineId, index])
  );
  await relocateTransferCostLayersInTx({
    client: params.client,
    tenantId: params.tenantId,
    transferMovementId: movementResult.movementId,
    occurredAt: params.occurredAt,
    notes: `Return disposition ${params.dispositionId}`,
    pairs: params.plan.pairs.map((pair) => {
      const outIndex = indexBySourceLineId.get(pair.outSourceLineId);
      const inIndex = indexBySourceLineId.get(pair.inSourceLineId);
      if (outIndex === undefined || inIndex === undefined) {
        throw new Error('RETURN_DISPOSITION_PERSISTED_LINE_MISSING');
      }
      const outLineId = movementResult.lineIds[outIndex];
      const inLineId = movementResult.lineIds[inIndex];
      if (!outLineId || !inLineId) {
        throw new Error('RETURN_DISPOSITION_PERSISTED_LINE_ID_MISSING');
      }
      return {
        itemId: pair.itemId,
        sourceLocationId: pair.sourceLocationId,
        destinationLocationId: pair.destinationLocationId,
        outLineId,
        inLineId,
        quantity: pair.quantity,
        uom: pair.canonicalUom
      };
    })
  });

  return {
    movementId: movementResult.movementId,
    created: true,
    projectionOps: [...params.plan.projectionOps]
  };
}

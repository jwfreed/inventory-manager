import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { roundQuantity, toNumber } from '../../lib/numbers';
import { calculateMovementCost } from '../../services/costing.service';
import { buildPlannedMovementFromLines, planMovementLines } from '../../services/inventoryMovementPlanner';
import type { PlannedWorkOrderMovement } from '../../services/inventoryMovementPlanner';
import { createCostLayer } from '../../services/costLayers.service';
import {
  buildInventoryBalanceProjectionOp
} from '../../modules/platform/application/inventoryMutationSupport';
import type { InventoryCommandProjectionOp } from '../../modules/platform/application/runInventoryCommand';
import { persistInventoryMovement } from '../../domains/inventory';
import { resolveWarehouseIdForLocation } from '../../services/warehouseDefaults.service';
import { assertProjectionDeltaContract } from '../inventory/mutationInvariants';

type LockedReturnReceiptRow = {
  id: string;
  tenant_id: string;
  return_authorization_id: string;
  received_at: string | Date | null;
  received_to_location_id: string;
  notes: string | null;
};

type LockedReturnReceiptLineRow = {
  id: string;
  item_id: string;
  uom: string;
  quantity_received: string | number;
  notes: string | null;
  return_authorization_line_id: string | null;
};

type ReceiptLocationPolicyRow = {
  role: string | null;
  is_sellable: boolean;
};

type ReturnAuthorizationLineRow = {
  id: string;
  item_id: string;
  uom: string;
  quantity_authorized: string | number;
};

export type ReturnReceiptPostPolicy = Readonly<{
  warehouseId: string;
  occurredAt: Date;
  itemIdsToLock: ReadonlyArray<string>;
}>;

type ReturnReceiptPlannedLine = Readonly<{
  receiptLineId: string;
  itemId: string;
  locationId: string;
  canonicalUom: string;
  quantity: number;
  unitCost: number | null;
  lineNotes: string | null;
}>;

export type ReturnReceiptMovementPlan = Readonly<{
  movement: PlannedWorkOrderMovement;
  plannedLines: ReadonlyArray<ReturnReceiptPlannedLine>;
  projectionOps: ReadonlyArray<InventoryCommandProjectionOp>;
}>;

async function assertReturnReceiptLocationPolicy(params: {
  client: PoolClient;
  tenantId: string;
  locationId: string;
}) {
  const locationResult = await params.client.query<ReceiptLocationPolicyRow>(
    `SELECT role, is_sellable
       FROM locations
      WHERE tenant_id = $1
        AND id = $2
      LIMIT 1`,
    [params.tenantId, params.locationId]
  );
  const location = locationResult.rows[0] ?? null;
  if (!location) {
    throw new Error('RETURN_RECEIPT_LOCATION_REQUIRED');
  }
  if (location.is_sellable) {
    throw new Error('RETURN_RECEIPT_LOCATION_MUST_BE_NON_SELLABLE');
  }
}

export async function evaluateReturnReceiptPostPolicy(params: {
  client: PoolClient;
  tenantId: string;
  receipt: LockedReturnReceiptRow;
  receiptLines: ReadonlyArray<LockedReturnReceiptLineRow>;
}) {
  await assertReturnReceiptLocationPolicy({
    client: params.client,
    tenantId: params.tenantId,
    locationId: params.receipt.received_to_location_id
  });

  const warehouseId = await resolveWarehouseIdForLocation(
    params.tenantId,
    params.receipt.received_to_location_id,
    params.client
  );
  if (!warehouseId) {
    throw new Error('WAREHOUSE_SCOPE_REQUIRED');
  }

  const returnAuthResult = await params.client.query<{ status: string }>(
    `SELECT status
       FROM return_authorizations
      WHERE id = $1
        AND tenant_id = $2
      FOR UPDATE`,
    [params.receipt.return_authorization_id, params.tenantId]
  );
  if (returnAuthResult.rowCount === 0) {
    throw new Error('RETURN_AUTH_NOT_FOUND');
  }
  const returnAuthStatus = returnAuthResult.rows[0]?.status ?? 'draft';
  if (returnAuthStatus === 'canceled' || returnAuthStatus === 'closed') {
    throw new Error('RETURN_AUTH_NOT_POSTABLE');
  }

  const authLineIds = Array.from(
    new Set(
      params.receiptLines
        .map((line) => line.return_authorization_line_id)
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
    )
  ).sort((left, right) => left.localeCompare(right));

  if (authLineIds.length > 0) {
    const authLineResult = await params.client.query<ReturnAuthorizationLineRow>(
      `SELECT id, item_id, uom, quantity_authorized
         FROM return_authorization_lines
        WHERE tenant_id = $1
          AND return_authorization_id = $2
          AND id = ANY($3::uuid[])
        ORDER BY id ASC
        FOR UPDATE`,
      [params.tenantId, params.receipt.return_authorization_id, authLineIds]
    );
    if (authLineResult.rowCount !== authLineIds.length) {
      throw new Error('RETURN_RECEIPT_LINE_INVALID_REFERENCE');
    }

    const postedTotalsResult = await params.client.query<{ line_id: string; qty: string | number }>(
      `SELECT rrl.return_authorization_line_id AS line_id,
              COALESCE(SUM(rrl.quantity_received), 0)::numeric AS qty
         FROM return_receipt_lines rrl
         JOIN return_receipts rr
           ON rr.id = rrl.return_receipt_id
          AND rr.tenant_id = rrl.tenant_id
        WHERE rr.tenant_id = $1
          AND rr.return_authorization_id = $2
          AND rr.status = 'posted'
          AND rr.id <> $3
          AND rrl.return_authorization_line_id = ANY($4::uuid[])
        GROUP BY rrl.return_authorization_line_id`,
      [params.tenantId, params.receipt.return_authorization_id, params.receipt.id, authLineIds]
    );

    const authLineMap = new Map(authLineResult.rows.map((row) => [row.id, row]));
    const postedTotals = new Map(
      postedTotalsResult.rows.map((row) => [row.line_id, roundQuantity(toNumber(row.qty ?? 0))])
    );

    for (const line of params.receiptLines) {
      if (!line.return_authorization_line_id) continue;
      const authLine = authLineMap.get(line.return_authorization_line_id);
      if (!authLine) {
        throw new Error('RETURN_RECEIPT_LINE_INVALID_REFERENCE');
      }
      if (authLine.item_id !== line.item_id || authLine.uom !== line.uom) {
        throw new Error('RETURN_RECEIPT_LINE_REFERENCE_MISMATCH');
      }
      const alreadyPosted = postedTotals.get(line.return_authorization_line_id) ?? 0;
      const projectedTotal = roundQuantity(alreadyPosted + toNumber(line.quantity_received));
      const authorizedQty = roundQuantity(toNumber(authLine.quantity_authorized));
      if (projectedTotal - authorizedQty > 1e-6) {
        throw new Error('RETURN_RECEIPT_QTY_EXCEEDS_AUTHORIZED');
      }
    }
  }

  return Object.freeze({
    warehouseId,
    occurredAt: params.receipt.received_at ? new Date(params.receipt.received_at) : new Date(),
    itemIdsToLock: Array.from(
      new Set(
        params.receiptLines
          .map((line) => line.item_id)
          .filter((value): value is string => typeof value === 'string' && value.length > 0)
      )
    ).sort((left, right) => left.localeCompare(right))
  }) satisfies ReturnReceiptPostPolicy;
}

export async function buildReturnReceiptMovementPlan(params: {
  client: PoolClient;
  tenantId: string;
  receipt: LockedReturnReceiptRow;
  receiptLines: ReadonlyArray<LockedReturnReceiptLineRow>;
  policy: ReturnReceiptPostPolicy;
  idempotencyKey: string;
}) {
  const rawLines = [];
  const lineCostByReceiptLineId = new Map<string, { unitCost: number | null; extendedCost: number | null }>();

  for (const line of params.receiptLines) {
    const quantity = roundQuantity(toNumber(line.quantity_received));
    const costData = await calculateMovementCost(
      params.tenantId,
      line.item_id,
      quantity,
      params.client
    );
    lineCostByReceiptLineId.set(line.id, {
      unitCost: costData.unitCost,
      extendedCost: costData.extendedCost
    });
    rawLines.push({
      sourceLineId: line.id,
      warehouseId: params.policy.warehouseId,
      itemId: line.item_id,
      locationId: params.receipt.received_to_location_id,
      quantity,
      uom: line.uom,
      defaultReasonCode: 'return_receipt',
      lineNotes: line.notes ?? `Return receipt ${params.receipt.id} line ${line.id}`,
      unitCost: costData.unitCost,
      extendedCost: costData.extendedCost
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
      movementType: 'receive',
      status: 'posted',
      externalRef: `return_receipt:${params.receipt.id}`,
      sourceType: 'return_receipt_post',
      sourceId: params.receipt.id,
      idempotencyKey: params.idempotencyKey,
      occurredAt: params.policy.occurredAt,
      postedAt: new Date(),
      notes: params.receipt.notes ?? null,
      createdAt: new Date(),
      updatedAt: new Date()
    },
    lines: plannedLines
  });

  const plannedReceiptLines = movement.sortedLines.map((line) => {
    const costData = lineCostByReceiptLineId.get(line.sourceLineId) ?? {
      unitCost: line.unitCost ?? null,
      extendedCost: line.extendedCost ?? null
    };
    return Object.freeze({
      receiptLineId: line.sourceLineId,
      itemId: line.itemId,
      locationId: line.locationId,
      canonicalUom: line.canonicalFields.canonicalUom,
      quantity: line.canonicalFields.quantityDeltaCanonical,
      unitCost: costData.unitCost,
      lineNotes: line.lineNotes ?? null
    });
  });

  const projectionDeltas = plannedReceiptLines.map((line) => ({
    itemId: line.itemId,
    locationId: line.locationId,
    uom: line.canonicalUom,
    deltaOnHand: line.quantity
  }));

  assertProjectionDeltaContract({
    movementDeltas: movement.sortedLines.map((line) => ({
      itemId: line.itemId,
      locationId: line.locationId,
      uom: line.canonicalFields.canonicalUom,
      deltaOnHand: line.canonicalFields.quantityDeltaCanonical
    })),
    projectionDeltas,
    errorCode: 'RETURN_RECEIPT_PROJECTION_CONTRACT_INVALID'
  });

  return Object.freeze({
    movement,
    plannedLines: plannedReceiptLines,
    projectionOps: projectionDeltas.map((delta) =>
      buildInventoryBalanceProjectionOp({
        tenantId: params.tenantId,
        itemId: delta.itemId,
        locationId: delta.locationId,
        uom: delta.uom,
        deltaOnHand: delta.deltaOnHand
      })
    )
  }) satisfies ReturnReceiptMovementPlan;
}

export async function executeReturnReceiptMovementPlan(params: {
  client: PoolClient;
  tenantId: string;
  receiptId: string;
  plan: ReturnReceiptMovementPlan;
  occurredAt: Date;
}) {
  const movementResult = await persistInventoryMovement(params.client, params.plan.movement.persistInput);
  if (!movementResult.created) {
    return {
      movementId: movementResult.movementId,
      created: false,
      projectionOps: [] as InventoryCommandProjectionOp[]
    };
  }

  for (let index = 0; index < params.plan.plannedLines.length; index += 1) {
    const line = params.plan.plannedLines[index]!;
    await createCostLayer({
      tenant_id: params.tenantId,
      item_id: line.itemId,
      location_id: line.locationId,
      uom: line.canonicalUom,
      quantity: line.quantity,
      unit_cost: line.unitCost ?? 0,
      source_type: 'receipt',
      source_document_id: line.receiptLineId,
      movement_id: movementResult.movementId,
      layer_date: params.occurredAt,
      notes: line.lineNotes ?? `Return receipt ${params.receiptId} line ${line.receiptLineId}`,
      client: params.client
    });
  }

  return {
    movementId: movementResult.movementId,
    created: true,
    projectionOps: [...params.plan.projectionOps]
  };
}

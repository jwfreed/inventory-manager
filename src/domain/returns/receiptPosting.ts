import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { roundQuantity, toNumber } from '../../lib/numbers';
import { calculateMovementCost } from '../../services/costing.service';
import { buildPlannedMovementFromLines, planMovementLines } from '../../services/inventoryMovementPlanner';
import type { PlannedWorkOrderMovement } from '../../services/inventoryMovementPlanner';
import { createCostLayer, createReceiptCostLayerOnce } from '../../services/costLayers.service';
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

type PersistedReturnReceiptMovementLineRow = {
  id: string;
  item_id: string;
  location_id: string;
  uom: string;
  canonical_uom: string | null;
  quantity_delta: string | number;
  quantity_delta_canonical: string | number | null;
  unit_cost: string | number | null;
  reason_code: string | null;
};

type PersistedReturnReceiptCostLayerRow = {
  source_document_id: string | null;
  item_id: string;
  location_id: string;
  uom: string;
  original_quantity: string | number;
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

export type ReturnReceiptCostArtifactAssessment = Readonly<{
  ready: boolean;
  repairable: boolean;
  reason: string | null;
  details: Record<string, unknown>;
}>;

function buildReceiptArtifactQuantityKey(params: {
  itemId: string;
  locationId: string;
  uom: string;
  quantity: number;
}) {
  return `${params.itemId}:${params.locationId}:${params.uom}:${roundQuantity(params.quantity).toFixed(6)}`;
}

function buildReceiptArtifactGroupKey(params: {
  itemId: string;
  locationId: string;
  uom: string;
}) {
  return `${params.itemId}:${params.locationId}:${params.uom}`;
}

function compareReceiptArtifactMovementLine(
  left: PersistedReturnReceiptMovementLineRow,
  right: PersistedReturnReceiptMovementLineRow
) {
  const leftUom = left.canonical_uom ?? left.uom;
  const rightUom = right.canonical_uom ?? right.uom;
  return (
    left.item_id.localeCompare(right.item_id)
    || left.location_id.localeCompare(right.location_id)
    || leftUom.localeCompare(rightUom)
    || roundQuantity(toNumber(left.quantity_delta_canonical ?? left.quantity_delta))
      .toFixed(6)
      .localeCompare(roundQuantity(toNumber(right.quantity_delta_canonical ?? right.quantity_delta)).toFixed(6))
    || roundQuantity(toNumber(left.unit_cost ?? 0)).toFixed(6)
      .localeCompare(roundQuantity(toNumber(right.unit_cost ?? 0)).toFixed(6))
    || (left.reason_code ?? '').localeCompare(right.reason_code ?? '')
    || left.id.localeCompare(right.id)
  );
}

async function loadReturnReceiptCostRepairContext(params: {
  client: PoolClient;
  tenantId: string;
  receiptId: string;
  movementId: string;
}) {
  const [receiptResult, receiptLinesResult, movementLinesResult, costLayersResult] = await Promise.all([
    params.client.query<LockedReturnReceiptRow>(
      `SELECT id, tenant_id, return_authorization_id, received_at, received_to_location_id, notes
         FROM return_receipts
        WHERE tenant_id = $1
          AND id = $2
        LIMIT 1`,
      [params.tenantId, params.receiptId]
    ),
    params.client.query<LockedReturnReceiptLineRow>(
      `SELECT id, item_id, uom, quantity_received, notes, return_authorization_line_id
         FROM return_receipt_lines
        WHERE tenant_id = $1
          AND return_receipt_id = $2
        ORDER BY created_at ASC, id ASC`,
      [params.tenantId, params.receiptId]
    ),
    params.client.query<PersistedReturnReceiptMovementLineRow>(
      `SELECT id,
              item_id,
              location_id,
              uom,
              canonical_uom,
              quantity_delta,
              quantity_delta_canonical,
              unit_cost,
              reason_code
         FROM inventory_movement_lines
        WHERE tenant_id = $1
          AND movement_id = $2
        ORDER BY item_id ASC,
                 location_id ASC,
                 COALESCE(canonical_uom, uom) ASC,
                 COALESCE(quantity_delta_canonical, quantity_delta) ASC,
                 COALESCE(unit_cost, 0) ASC,
                 COALESCE(reason_code, '') ASC,
                 id ASC`,
      [params.tenantId, params.movementId]
    ),
    params.client.query<PersistedReturnReceiptCostLayerRow>(
      `SELECT source_document_id, item_id, location_id, uom, original_quantity
         FROM inventory_cost_layers
        WHERE tenant_id = $1
          AND movement_id = $2
          AND source_type = 'receipt'
          AND voided_at IS NULL`,
      [params.tenantId, params.movementId]
    )
  ]);

  return {
    receipt: receiptResult.rows[0] ?? null,
    receiptLines: receiptLinesResult.rows,
    movementLines: movementLinesResult.rows.filter(
      (line) => roundQuantity(toNumber(line.quantity_delta_canonical ?? line.quantity_delta)) > 0
    ),
    costLayers: costLayersResult.rows
  };
}

export async function assessReturnReceiptCostArtifacts(params: {
  client: PoolClient;
  tenantId: string;
  receiptId: string;
  movementId: string;
}): Promise<ReturnReceiptCostArtifactAssessment> {
  const context = await loadReturnReceiptCostRepairContext(params);
  if (!context.receipt) {
    return Object.freeze({
      ready: false,
      repairable: false,
      reason: 'return_receipt_missing',
      details: { receiptId: params.receiptId }
    });
  }

  const expectedLineCount = context.receiptLines.length;
  const actualLayerCount = context.costLayers.length;
  const distinctSourceDocumentCount = new Set(
    context.costLayers
      .map((row) => row.source_document_id)
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
  ).size;
  const expectedMovementQuantity = roundQuantity(
    context.movementLines.reduce(
      (sum, row) => sum + toNumber(row.quantity_delta_canonical ?? row.quantity_delta),
      0
    )
  );
  const actualLayerQuantity = roundQuantity(
    context.costLayers.reduce((sum, row) => sum + toNumber(row.original_quantity), 0)
  );

  const expectedGroups = new Map<string, number>();
  for (const line of context.movementLines) {
    const key = buildReceiptArtifactGroupKey({
      itemId: line.item_id,
      locationId: line.location_id,
      uom: line.canonical_uom ?? line.uom
    });
    expectedGroups.set(
      key,
      roundQuantity((expectedGroups.get(key) ?? 0) + toNumber(line.quantity_delta_canonical ?? line.quantity_delta))
    );
  }

  const actualGroups = new Map<string, number>();
  for (const layer of context.costLayers) {
    const key = buildReceiptArtifactGroupKey({
      itemId: layer.item_id,
      locationId: layer.location_id,
      uom: layer.uom
    });
    actualGroups.set(
      key,
      roundQuantity((actualGroups.get(key) ?? 0) + toNumber(layer.original_quantity))
    );
  }

  const groupMismatch = expectedGroups.size !== actualGroups.size
    || [...expectedGroups.entries()].some(([key, quantity]) =>
      Math.abs(quantity - (actualGroups.get(key) ?? Number.NaN)) > 1e-6
    );

  const ready = expectedLineCount > 0
    && actualLayerCount === expectedLineCount
    && distinctSourceDocumentCount === actualLayerCount
    && Math.abs(expectedMovementQuantity - actualLayerQuantity) <= 1e-6
    && !groupMismatch;

  return Object.freeze({
    ready,
    repairable: !ready,
    reason: ready ? null : 'return_receipt_cost_layers_missing_or_inconsistent',
    details: {
      receiptId: params.receiptId,
      movementId: params.movementId,
      expectedLineCount,
      actualLayerCount,
      distinctSourceDocumentCount,
      expectedMovementQuantity,
      actualLayerQuantity,
      expectedGroups: Object.fromEntries(expectedGroups),
      actualGroups: Object.fromEntries(actualGroups)
    }
  });
}

export async function repairReturnReceiptCostArtifacts(params: {
  client: PoolClient;
  tenantId: string;
  receiptId: string;
  movementId: string;
}) {
  const context = await loadReturnReceiptCostRepairContext(params);
  if (!context.receipt) {
    throw new Error('RETURN_RECEIPT_NOT_FOUND');
  }
  if (context.receiptLines.length === 0) {
    throw new Error('RETURN_RECEIPT_NO_LINES');
  }

  const warehouseId = await resolveWarehouseIdForLocation(
    params.tenantId,
    context.receipt.received_to_location_id,
    params.client
  );
  if (!warehouseId) {
    throw new Error('WAREHOUSE_SCOPE_REQUIRED');
  }

  const plannedLines = await planMovementLines({
    tenantId: params.tenantId,
    lines: context.receiptLines.map((line) => ({
      sourceLineId: line.id,
      warehouseId,
      itemId: line.item_id,
      locationId: context.receipt!.received_to_location_id,
      quantity: roundQuantity(toNumber(line.quantity_received)),
      uom: line.uom,
      defaultReasonCode: 'return_receipt',
      lineNotes: line.notes ?? `Return receipt ${context.receipt!.id} line ${line.id}`
    })),
    client: params.client
  });

  const movementLineQueues = new Map<string, PersistedReturnReceiptMovementLineRow[]>();
  for (const row of [...context.movementLines].sort(compareReceiptArtifactMovementLine)) {
    const key = buildReceiptArtifactQuantityKey({
      itemId: row.item_id,
      locationId: row.location_id,
      uom: row.canonical_uom ?? row.uom,
      quantity: toNumber(row.quantity_delta_canonical ?? row.quantity_delta)
    });
    const queue = movementLineQueues.get(key) ?? [];
    queue.push(row);
    movementLineQueues.set(key, queue);
  }

  for (const line of plannedLines) {
    const key = buildReceiptArtifactQuantityKey({
      itemId: line.itemId,
      locationId: line.locationId,
      uom: line.canonicalFields.canonicalUom,
      quantity: line.canonicalFields.quantityDeltaCanonical
    });
    const queue = movementLineQueues.get(key);
    const movementLine = queue?.shift();
    if (!movementLine) {
      throw new Error('RETURN_RECEIPT_COST_REPAIR_MAPPING_MISSING');
    }
    await createReceiptCostLayerOnce({
      tenant_id: params.tenantId,
      item_id: line.itemId,
      location_id: line.locationId,
      uom: line.canonicalFields.canonicalUom,
      quantity: line.canonicalFields.quantityDeltaCanonical,
      unit_cost: toNumber(movementLine.unit_cost ?? 0),
      source_type: 'receipt',
      source_document_id: line.sourceLineId,
      movement_id: params.movementId,
      layer_date: context.receipt.received_at ? new Date(context.receipt.received_at) : new Date(),
      notes: line.lineNotes ?? `Return receipt ${context.receipt.id} line ${line.sourceLineId}`,
      client: params.client
    });
  }
}

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
          AND (
            rr.status = 'posted'
            OR 1 = (
              SELECT COUNT(*)::int
               FROM inventory_movements im
               WHERE im.tenant_id = rr.tenant_id
                 AND im.source_type = 'return_receipt_post'
                 AND im.source_id = rr.id::text
                 AND im.movement_type = 'receive'
                 AND im.status = 'posted'
                 AND EXISTS (
                   SELECT 1
                     FROM inventory_movement_lines iml
                    WHERE iml.tenant_id = im.tenant_id
                      AND iml.movement_id = im.id
                 )
            )
          )
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

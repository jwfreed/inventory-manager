import type { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import {
  ensureInventoryBalanceRowAndLock,
  persistInventoryMovement
} from '../../domains/inventory';
import { roundQuantity } from '../../lib/numbers';
import {
  buildInventoryBalanceProjectionOp
} from '../../modules/platform/application/inventoryMutationSupport';
import type { InventoryCommandProjectionOp } from '../../modules/platform/application/runInventoryCommand';
import { reverseTransferCostLayersInTx } from '../../services/transferCosting.service';
import { assertProjectionDeltaContract } from '../inventory/mutationInvariants';
import type { PreparedTransferReversal } from './transferReversalPolicy';
import {
  assertTransferReversalPlanInvariants,
  type TransferReversalPlan
} from './transferReversalPlan';

const EPSILON = 1e-6;

export type ExecutedTransferReversal = Readonly<{
  result: {
    reversalMovementId: string;
    reversalOfMovementId: string;
    created: boolean;
  };
  projectionOps: ReadonlyArray<InventoryCommandProjectionOp>;
}>;

function compareLockedTransferTarget(
  left: { locationId: string; itemId: string; uom: string },
  right: { locationId: string; itemId: string; uom: string }
) {
  const locationCompare = left.locationId.localeCompare(right.locationId);
  if (locationCompare !== 0) return locationCompare;
  const itemCompare = left.itemId.localeCompare(right.itemId);
  if (itemCompare !== 0) return itemCompare;
  return left.uom.localeCompare(right.uom);
}

function buildTransferReversalBalanceProjectionOp(params: {
  tenantId: string;
  itemId: string;
  locationId: string;
  uom: string;
  deltaOnHand: number;
}): InventoryCommandProjectionOp {
  return async (client) => {
    try {
      await buildInventoryBalanceProjectionOp(params)(client);
    } catch (error: any) {
      if (error?.code === '23514' && error?.constraint === 'chk_inventory_balance_nonneg') {
        throw new Error('TRANSFER_REVERSAL_NOT_POSSIBLE_CONSUMED');
      }
      throw error;
    }
  };
}

async function lockTransferReversalInventoryState(
  prepared: PreparedTransferReversal,
  movementPlan: TransferReversalPlan,
  client: PoolClient
) {
  const lockTargets = movementPlan.lines
    .map((line) => ({
      locationId: line.locationId,
      itemId: line.itemId,
      uom: line.canonicalUom ?? line.effectiveUom
    }))
    .sort(compareLockedTransferTarget);

  const uniqueTargets = lockTargets.filter((target, index, all) =>
    index === 0
    || target.locationId !== all[index - 1]!.locationId
    || target.itemId !== all[index - 1]!.itemId
    || target.uom !== all[index - 1]!.uom
  );

  const lockedRows = new Map<string, Awaited<ReturnType<typeof ensureInventoryBalanceRowAndLock>>>();
  for (const target of uniqueTargets) {
    const row = await ensureInventoryBalanceRowAndLock(
      client,
      prepared.tenantId,
      target.itemId,
      target.locationId,
      target.uom
    );
    lockedRows.set(`${target.itemId}:${target.locationId}:${target.uom}`, row);
  }

  return lockedRows;
}

function assertTransferReversalBalanceInvariants(params: {
  prepared: PreparedTransferReversal;
  movementPlan: TransferReversalPlan;
  lockedRows: Map<string, Awaited<ReturnType<typeof ensureInventoryBalanceRowAndLock>>>;
}) {
  for (const line of params.movementPlan.lines) {
    const balanceUom = line.canonicalUom ?? line.effectiveUom;
    const key = `${line.itemId}:${line.locationId}:${balanceUom}`;
    const balanceRow = params.lockedRows.get(key);
    if (!balanceRow) {
      throw new Error('TRANSFER_BALANCE_LOCK_FAILED');
    }

    if (line.reversalDirection !== 'out') {
      continue;
    }

    const requested = roundQuantity(Math.abs(line.quantityDeltaCanonical ?? line.quantityDelta));
    const available = roundQuantity(Number(balanceRow.available ?? 0));
    if (available + EPSILON < requested) {
      throw new Error('TRANSFER_REVERSAL_NOT_POSSIBLE_CONSUMED');
    }
  }
}

async function assertTransferReversalCostIntegrity(params: {
  client: PoolClient;
  tenantId: string;
  originalMovementId: string;
  reversalMovementId: string;
  reversalLineByOriginalLineId: Map<string, string>;
  expectedQuantity: number;
}) {
  const [originalLinksResult, reversalLinksResult, reversalConsumptionResult] = await Promise.all([
    params.client.query<{
      transfer_out_line_id: string;
      transfer_in_line_id: string;
      source_cost_layer_id: string;
      dest_cost_layer_id: string;
      quantity: string;
      unit_cost: string;
      extended_cost: string;
    }>(
      `SELECT transfer_out_line_id,
              transfer_in_line_id,
              source_cost_layer_id,
              dest_cost_layer_id,
              quantity::text,
              unit_cost::text,
              extended_cost::text
         FROM cost_layer_transfer_links
        WHERE tenant_id = $1
          AND transfer_movement_id = $2
        ORDER BY transfer_out_line_id ASC, transfer_in_line_id ASC, id ASC`,
      [params.tenantId, params.originalMovementId]
    ),
    params.client.query<{
      transfer_out_line_id: string;
      transfer_in_line_id: string;
      source_cost_layer_id: string;
      quantity: string;
      unit_cost: string;
      extended_cost: string;
    }>(
      `SELECT transfer_out_line_id,
              transfer_in_line_id,
              source_cost_layer_id,
              quantity::text,
              unit_cost::text,
              extended_cost::text
         FROM cost_layer_transfer_links
        WHERE tenant_id = $1
          AND transfer_movement_id = $2
        ORDER BY transfer_out_line_id ASC, transfer_in_line_id ASC, id ASC`,
      [params.tenantId, params.reversalMovementId]
    ),
    params.client.query<{ quantity: string; extended_cost: string }>(
      `SELECT COALESCE(SUM(consumed_quantity), 0)::text AS quantity,
              COALESCE(SUM(extended_cost), 0)::text AS extended_cost
         FROM cost_layer_consumptions
        WHERE tenant_id = $1
          AND movement_id = $2`,
      [params.tenantId, params.reversalMovementId]
    )
  ]);

  if ((originalLinksResult.rowCount ?? 0) < 1 || (reversalLinksResult.rowCount ?? 0) < 1) {
    throw new Error('TRANSFER_REVERSAL_COST_LINKS_REQUIRED');
  }
  if ((originalLinksResult.rowCount ?? 0) !== (reversalLinksResult.rowCount ?? 0)) {
    throw new Error('TRANSFER_REVERSAL_COST_LINK_COUNT_MISMATCH');
  }

  const reversalSignatureCounts = new Map<string, number>();
  for (const row of reversalLinksResult.rows) {
    const signature = [
      row.transfer_out_line_id,
      row.transfer_in_line_id,
      row.source_cost_layer_id,
      row.quantity,
      row.unit_cost,
      row.extended_cost
    ].join('|');
    reversalSignatureCounts.set(signature, (reversalSignatureCounts.get(signature) ?? 0) + 1);
  }

  let originalQuantity = 0;
  let originalCost = 0;
  for (const row of originalLinksResult.rows) {
    originalQuantity = roundQuantity(originalQuantity + Number(row.quantity));
    originalCost = roundQuantity(originalCost + Number(row.extended_cost));

    const reversalOutLineId = params.reversalLineByOriginalLineId.get(row.transfer_in_line_id);
    const reversalInLineId = params.reversalLineByOriginalLineId.get(row.transfer_out_line_id);
    if (!reversalOutLineId || !reversalInLineId) {
      throw new Error('TRANSFER_REVERSAL_LINE_MAPPING_MISSING');
    }

    const signature = [
      reversalOutLineId,
      reversalInLineId,
      row.dest_cost_layer_id,
      row.quantity,
      row.unit_cost,
      row.extended_cost
    ].join('|');
    const count = reversalSignatureCounts.get(signature) ?? 0;
    if (count < 1) {
      throw new Error('TRANSFER_REVERSAL_COST_REPLAY_MISMATCH');
    }
    reversalSignatureCounts.set(signature, count - 1);
  }

  if ([...reversalSignatureCounts.values()].some((count) => count !== 0)) {
    throw new Error('TRANSFER_REVERSAL_COST_REPLAY_MISMATCH');
  }

  const reversalQuantity = roundQuantity(Number(reversalConsumptionResult.rows[0]?.quantity ?? 0));
  const reversalCost = roundQuantity(Number(reversalConsumptionResult.rows[0]?.extended_cost ?? 0));

  if (Math.abs(originalQuantity - params.expectedQuantity) > EPSILON) {
    throw new Error('TRANSFER_REVERSAL_COST_QUANTITY_IMBALANCE');
  }
  if (Math.abs(reversalQuantity - params.expectedQuantity) > EPSILON) {
    throw new Error('TRANSFER_REVERSAL_COST_QUANTITY_IMBALANCE');
  }
  if (Math.abs(originalCost - reversalCost) > EPSILON) {
    throw new Error('TRANSFER_REVERSAL_COST_VALUE_IMBALANCE');
  }
}

export async function executeTransferReversalPlan(
  prepared: PreparedTransferReversal,
  movementPlan: TransferReversalPlan,
  client: PoolClient
): Promise<ExecutedTransferReversal> {
  assertTransferReversalPlanInvariants(prepared, movementPlan.lines);

  const lockedRows = await lockTransferReversalInventoryState(prepared, movementPlan, client);
  assertTransferReversalBalanceInvariants({
    prepared,
    movementPlan,
    lockedRows
  });

  const movementResult = await persistInventoryMovement(client, {
    id: uuidv4(),
    ...movementPlan.persistInput,
    lines: movementPlan.persistInput.lines.map((line) => ({ ...line })),
    metadata: null
  });

  const result = {
    reversalMovementId: movementResult.movementId,
    reversalOfMovementId: prepared.originalMovementId,
    created: movementResult.created
  };

  if (!movementResult.created) {
    const existingMovementResult = await client.query<{
      movement_type: string;
      reversal_of_movement_id: string | null;
    }>(
      `SELECT movement_type, reversal_of_movement_id
         FROM inventory_movements
        WHERE tenant_id = $1
          AND id = $2`,
      [prepared.tenantId, movementResult.movementId]
    );
    const existingMovement = existingMovementResult.rows[0];
    if (
      !existingMovement
      || existingMovement.movement_type !== prepared.movementType
      || existingMovement.reversal_of_movement_id !== prepared.originalMovementId
    ) {
      throw new Error('TRANSFER_VOID_CONFLICT');
    }
    return {
      result,
      projectionOps: []
    };
  }

  const reversalLineByOriginalLineId = new Map<string, string>();
  for (const line of movementPlan.lines) {
    reversalLineByOriginalLineId.set(line.originalLineId, line.id);
  }

  await reverseTransferCostLayersInTx({
    client,
    tenantId: prepared.tenantId,
    originalTransferMovementId: prepared.originalMovementId,
    reversalMovementId: movementResult.movementId,
    occurredAt: movementPlan.occurredAt,
    notes: `Transfer reversal ${prepared.originalMovementId}`,
    reversalLineByOriginalLineId
  });

  await assertTransferReversalCostIntegrity({
    client,
    tenantId: prepared.tenantId,
    originalMovementId: prepared.originalMovementId,
    reversalMovementId: movementResult.movementId,
    reversalLineByOriginalLineId,
    expectedQuantity: movementPlan.expectedQuantity
  });

  const projectionDeltas = movementPlan.lines
    .filter((line) => line.effectiveQty > EPSILON)
    .map((line) => ({
      itemId: line.itemId,
      locationId: line.locationId,
      uom: line.canonicalUom ?? line.effectiveUom,
      deltaOnHand: roundQuantity(line.quantityDeltaCanonical ?? line.quantityDelta)
    }));
  assertProjectionDeltaContract({
    movementDeltas: movementPlan.lines.map((line) => ({
      itemId: line.itemId,
      locationId: line.locationId,
      uom: line.canonicalUom ?? line.effectiveUom,
      deltaOnHand: roundQuantity(line.quantityDeltaCanonical ?? line.quantityDelta)
    })),
    projectionDeltas,
    errorCode: 'TRANSFER_REVERSAL_PROJECTION_CONTRACT_INVALID',
    epsilon: EPSILON
  });

  const projectionOps = projectionDeltas.map((delta) =>
      buildTransferReversalBalanceProjectionOp({
        tenantId: prepared.tenantId,
        itemId: delta.itemId,
        locationId: delta.locationId,
        uom: delta.uom,
        deltaOnHand: delta.deltaOnHand
      })
    );

  return {
    result,
    projectionOps
  };
}

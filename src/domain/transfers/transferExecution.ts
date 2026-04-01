import type { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { persistInventoryMovement } from '../../domains/inventory';
import { roundQuantity } from '../../lib/numbers';
import {
  buildInventoryBalanceProjectionOp
} from '../../modules/platform/application/inventoryMutationSupport';
import type { InventoryCommandProjectionOp } from '../../modules/platform/application/runInventoryCommand';
import { validateSufficientStock } from '../../services/stockValidation.service';
import { relocateTransferCostLayersInTx } from '../../services/transferCosting.service';
import type { PreparedTransferMutation } from './transferPolicy';
import { assertTransferMovementPlanInvariants, type TransferMovementPlan } from './transferPlan';

export type ExecutedTransferMutation = Readonly<{
  result: {
    movementId: string;
    created: boolean;
    replayed: boolean;
    idempotencyKey: string | null;
    sourceWarehouseId: string;
    destinationWarehouseId: string;
  };
  projectionOps: ReadonlyArray<InventoryCommandProjectionOp>;
}>;

function requirePersistedLineId(
  lineIds: string[],
  index: number
): string {
  const lineId = lineIds[index];
  if (!lineId) {
    throw new Error('TRANSFER_PERSISTED_LINE_ID_MISSING');
  }
  return lineId;
}

async function assertTransferCostIntegrity(params: {
  client: PoolClient;
  tenantId: string;
  movementId: string;
  outLineId: string;
  inLineId: string;
  expectedQuantity: number;
}) {
  const linkResult = await params.client.query<{
    quantity: string;
    extended_cost: string;
    link_count: string;
    distinct_source_layers: string;
    distinct_dest_layers: string;
  }>(
    `SELECT COALESCE(SUM(quantity), 0)::text AS quantity,
            COALESCE(SUM(extended_cost), 0)::text AS extended_cost,
            COUNT(*)::text AS link_count,
            COUNT(DISTINCT source_cost_layer_id)::text AS distinct_source_layers,
            COUNT(DISTINCT dest_cost_layer_id)::text AS distinct_dest_layers
       FROM cost_layer_transfer_links
      WHERE tenant_id = $1
        AND transfer_movement_id = $2
        AND transfer_out_line_id = $3
        AND transfer_in_line_id = $4`,
    [params.tenantId, params.movementId, params.outLineId, params.inLineId]
  );
  const linkRow = linkResult.rows[0];
  const linkedQuantity = roundQuantity(Number(linkRow?.quantity ?? 0));
  const linkedCost = roundQuantity(Number(linkRow?.extended_cost ?? 0));
  const linkCount = Number(linkRow?.link_count ?? 0);
  const distinctSourceLayers = Number(linkRow?.distinct_source_layers ?? 0);
  const distinctDestLayers = Number(linkRow?.distinct_dest_layers ?? 0);

  if (linkCount < 1) {
    throw new Error('TRANSFER_COST_LINKS_MISSING');
  }
  if (Math.abs(linkedQuantity - params.expectedQuantity) > 1e-6) {
    throw new Error('TRANSFER_COST_QUANTITY_IMBALANCE');
  }
  if (distinctSourceLayers !== linkCount || distinctDestLayers !== linkCount) {
    throw new Error('TRANSFER_COST_LAYER_DUPLICATION');
  }

  const [consumptionResult, destLayerResult] = await Promise.all([
    params.client.query<{ quantity: string; extended_cost: string }>(
      `SELECT COALESCE(SUM(consumed_quantity), 0)::text AS quantity,
              COALESCE(SUM(extended_cost), 0)::text AS extended_cost
         FROM cost_layer_consumptions
        WHERE tenant_id = $1
          AND movement_id = $2
          AND consumption_document_id = $3`,
      [params.tenantId, params.movementId, params.outLineId]
    ),
    params.client.query<{ quantity: string; extended_cost: string }>(
      `SELECT COALESCE(SUM(original_quantity), 0)::text AS quantity,
              COALESCE(SUM(extended_cost), 0)::text AS extended_cost
         FROM inventory_cost_layers
        WHERE tenant_id = $1
          AND movement_id = $2
          AND source_type = 'transfer_in'
          AND source_document_id = $3
          AND voided_at IS NULL`,
      [params.tenantId, params.movementId, params.inLineId]
    )
  ]);

  const consumedQuantity = roundQuantity(Number(consumptionResult.rows[0]?.quantity ?? 0));
  const consumedCost = roundQuantity(Number(consumptionResult.rows[0]?.extended_cost ?? 0));
  const receivedQuantity = roundQuantity(Number(destLayerResult.rows[0]?.quantity ?? 0));
  const receivedCost = roundQuantity(Number(destLayerResult.rows[0]?.extended_cost ?? 0));

  if (Math.abs(consumedQuantity - params.expectedQuantity) > 1e-6 || Math.abs(receivedQuantity - params.expectedQuantity) > 1e-6) {
    throw new Error('TRANSFER_COST_QUANTITY_IMBALANCE');
  }
  if (Math.abs(consumedCost - linkedCost) > 1e-6 || Math.abs(receivedCost - linkedCost) > 1e-6) {
    throw new Error('TRANSFER_COST_IMBALANCE');
  }
}

export async function executeTransferMovementPlan(
  prepared: PreparedTransferMutation,
  movementPlan: TransferMovementPlan,
  client: PoolClient
): Promise<ExecutedTransferMutation> {
  const invariantState = assertTransferMovementPlanInvariants(prepared, movementPlan.lines);

  const validation = await validateSufficientStock(
    prepared.tenantId,
    prepared.occurredAt,
    [
      {
        warehouseId: prepared.sourceWarehouseId,
        itemId: prepared.itemId,
        locationId: prepared.sourceLocationId,
        uom: prepared.uom,
        quantityToConsume: prepared.enteredQty
      }
    ],
    {
      actorId: prepared.actorId,
      overrideRequested: prepared.overrideNegative,
      overrideReason: prepared.overrideReason,
      overrideReference: `${prepared.sourceType}:${prepared.sourceId}`
    },
    { client }
  );

  const movementResult = await persistInventoryMovement(client, {
    id: uuidv4(),
    ...movementPlan.persistInput,
    lines: movementPlan.persistInput.lines.map((line) => ({ ...line })),
    metadata: validation.overrideMetadata ?? null
  });

  const result = {
    movementId: movementResult.movementId,
    created: movementResult.created,
    replayed: false,
    idempotencyKey: prepared.idempotencyKey,
    sourceWarehouseId: prepared.sourceWarehouseId,
    destinationWarehouseId: prepared.destinationWarehouseId
  };

  if (!movementResult.created) {
    return {
      result,
      projectionOps: []
    };
  }

  const outbound = movementPlan.lines[movementPlan.outLineIndex]!;
  const inbound = movementPlan.lines[movementPlan.inLineIndex]!;
  const outLineId = requirePersistedLineId(movementResult.lineIds, movementPlan.outLineIndex);
  const inLineId = requirePersistedLineId(movementResult.lineIds, movementPlan.inLineIndex);

  await relocateTransferCostLayersInTx({
    client,
    tenantId: prepared.tenantId,
    transferMovementId: movementResult.movementId,
    occurredAt: prepared.occurredAt,
    notes: prepared.notes,
    pairs: [
      {
        itemId: prepared.itemId,
        sourceLocationId: prepared.sourceLocationId,
        destinationLocationId: prepared.destinationLocationId,
        outLineId,
        inLineId,
        quantity: invariantState.inboundQty,
        uom: movementPlan.canonicalUom
      }
    ]
  });

  await assertTransferCostIntegrity({
    client,
    tenantId: prepared.tenantId,
    movementId: movementResult.movementId,
    outLineId,
    inLineId,
    expectedQuantity: invariantState.inboundQty
  });

  return {
    result,
    projectionOps: [
      buildInventoryBalanceProjectionOp({
        tenantId: prepared.tenantId,
        itemId: prepared.itemId,
        locationId: prepared.sourceLocationId,
        uom: outbound.canonicalFields.canonicalUom,
        deltaOnHand: outbound.canonicalFields.quantityDeltaCanonical
      }),
      buildInventoryBalanceProjectionOp({
        tenantId: prepared.tenantId,
        itemId: prepared.itemId,
        locationId: prepared.destinationLocationId,
        uom: inbound.canonicalFields.canonicalUom,
        deltaOnHand: inbound.canonicalFields.quantityDeltaCanonical
      })
    ]
  };
}

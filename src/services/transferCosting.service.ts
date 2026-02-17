import type { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { roundQuantity, toNumber } from '../lib/numbers';
import { createCostLayer } from './costLayers.service';

const EPSILON = 1e-6;

type SourceLayerRow = {
  id: string;
  item_id: string;
  location_id: string;
  uom: string;
  remaining_quantity: string | number;
  unit_cost: string | number;
};

export type TransferLinePair = {
  itemId: string;
  sourceLocationId: string;
  destinationLocationId: string;
  outLineId: string;
  inLineId: string;
  quantity: number;
  uom: string;
};

function compareTransferPair(left: TransferLinePair, right: TransferLinePair): number {
  const itemCompare = left.itemId.localeCompare(right.itemId);
  if (itemCompare !== 0) return itemCompare;
  const sourceCompare = left.sourceLocationId.localeCompare(right.sourceLocationId);
  if (sourceCompare !== 0) return sourceCompare;
  const destCompare = left.destinationLocationId.localeCompare(right.destinationLocationId);
  if (destCompare !== 0) return destCompare;
  return left.outLineId.localeCompare(right.outLineId);
}

async function lockAvailableLayersForUpdate(
  client: PoolClient,
  tenantId: string,
  itemId: string,
  sourceLocationId: string,
  uom: string
): Promise<SourceLayerRow[]> {
  const result = await client.query<SourceLayerRow>(
    `SELECT id,
            item_id,
            location_id,
            uom,
            remaining_quantity,
            unit_cost
       FROM inventory_cost_layers
      WHERE tenant_id = $1
        AND item_id = $2
        AND location_id = $3
        AND uom = $4
        AND remaining_quantity > 0
        AND voided_at IS NULL
      ORDER BY layer_date ASC, layer_sequence ASC, id ASC
      FOR UPDATE`,
    [tenantId, itemId, sourceLocationId, uom]
  );
  return result.rows;
}

async function updateLayerRemaining(
  client: PoolClient,
  layerId: string,
  nextRemaining: number,
  unitCost: number
) {
  await client.query(
    `UPDATE inventory_cost_layers
        SET remaining_quantity = $1,
            extended_cost = $2,
            updated_at = now()
      WHERE id = $3`,
    [nextRemaining, roundQuantity(nextRemaining * unitCost), layerId]
  );
}

export async function relocateTransferCostLayersInTx(params: {
  client: PoolClient;
  tenantId: string;
  transferMovementId: string;
  occurredAt: Date;
  pairs: TransferLinePair[];
  notes?: string | null;
}) {
  const sortedPairs = [...params.pairs].sort(compareTransferPair);

  for (const pair of sortedPairs) {
    const requestedQty = roundQuantity(Math.abs(pair.quantity));
    if (requestedQty <= EPSILON) {
      throw new Error('TRANSFER_INVALID_QUANTITY');
    }

    const layers = await lockAvailableLayersForUpdate(
      params.client,
      params.tenantId,
      pair.itemId,
      pair.sourceLocationId,
      pair.uom
    );

    const totalAvailable = roundQuantity(
      layers.reduce((sum, layer) => sum + toNumber(layer.remaining_quantity), 0)
    );
    if (totalAvailable + EPSILON < requestedQty) {
      throw new Error('TRANSFER_INSUFFICIENT_COST_LAYERS');
    }

    let remaining = requestedQty;
    let totalCost = 0;

    for (const layer of layers) {
      if (remaining <= EPSILON) break;
      const layerRemaining = roundQuantity(toNumber(layer.remaining_quantity));
      if (layerRemaining <= EPSILON) continue;

      const consumeQty = roundQuantity(Math.min(layerRemaining, remaining));
      const layerUnitCost = roundQuantity(toNumber(layer.unit_cost));
      const consumeCost = roundQuantity(consumeQty * layerUnitCost);

      await params.client.query(
        `INSERT INTO cost_layer_consumptions (
            id, tenant_id, cost_layer_id,
            consumed_quantity, unit_cost, extended_cost,
            consumption_type, consumption_document_id, movement_id,
            consumed_at, notes
         ) VALUES ($1,$2,$3,$4,$5,$6,'transfer_out',$7,$8,$9,$10)`,
        [
          uuidv4(),
          params.tenantId,
          layer.id,
          consumeQty,
          layerUnitCost,
          consumeCost,
          pair.outLineId,
          params.transferMovementId,
          params.occurredAt,
          params.notes ?? null
        ]
      );

      const nextRemaining = roundQuantity(layerRemaining - consumeQty);
      await updateLayerRemaining(params.client, layer.id, nextRemaining, layerUnitCost);

      const destLayer = await createCostLayer({
        tenant_id: params.tenantId,
        item_id: pair.itemId,
        location_id: pair.destinationLocationId,
        uom: pair.uom,
        quantity: consumeQty,
        unit_cost: layerUnitCost,
        source_type: 'transfer_in',
        source_document_id: pair.inLineId,
        movement_id: params.transferMovementId,
        layer_date: params.occurredAt,
        notes: params.notes ?? undefined,
        client: params.client
      });

      await params.client.query(
        `INSERT INTO cost_layer_transfer_links (
            id,
            tenant_id,
            transfer_movement_id,
            transfer_out_line_id,
            transfer_in_line_id,
            source_cost_layer_id,
            dest_cost_layer_id,
            quantity,
            unit_cost,
            extended_cost,
            created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          uuidv4(),
          params.tenantId,
          params.transferMovementId,
          pair.outLineId,
          pair.inLineId,
          layer.id,
          destLayer.id,
          consumeQty,
          layerUnitCost,
          consumeCost,
          params.occurredAt
        ]
      );

      remaining = roundQuantity(remaining - consumeQty);
      totalCost = roundQuantity(totalCost + consumeCost);
    }

    if (remaining > EPSILON) {
      throw new Error('TRANSFER_INSUFFICIENT_COST_LAYERS');
    }

    if (totalCost < 0) {
      throw new Error('TRANSFER_COST_NEGATIVE');
    }
  }
}

type ReversalLinkRow = {
  id: string;
  transfer_out_line_id: string;
  transfer_in_line_id: string;
  source_cost_layer_id: string;
  dest_cost_layer_id: string;
  quantity: string | number;
  unit_cost: string | number;
  source_item_id: string;
  source_location_id: string;
  source_uom: string;
  dest_item_id: string;
  dest_location_id: string;
  dest_uom: string;
  dest_remaining_quantity: string | number;
};

export async function reverseTransferCostLayersInTx(params: {
  client: PoolClient;
  tenantId: string;
  originalTransferMovementId: string;
  reversalMovementId: string;
  occurredAt: Date;
  reversalLineByOriginalLineId: Map<string, string>;
  notes?: string | null;
}) {
  const linkRows = await params.client.query<ReversalLinkRow>(
    `SELECT l.id,
            l.transfer_out_line_id,
            l.transfer_in_line_id,
            l.source_cost_layer_id,
            l.dest_cost_layer_id,
            l.quantity,
            l.unit_cost,
            scl.item_id AS source_item_id,
            scl.location_id AS source_location_id,
            scl.uom AS source_uom,
            dcl.item_id AS dest_item_id,
            dcl.location_id AS dest_location_id,
            dcl.uom AS dest_uom,
            dcl.remaining_quantity AS dest_remaining_quantity
       FROM cost_layer_transfer_links l
       JOIN inventory_cost_layers scl ON scl.id = l.source_cost_layer_id
       JOIN inventory_cost_layers dcl ON dcl.id = l.dest_cost_layer_id
      WHERE l.tenant_id = $1
        AND l.transfer_movement_id = $2
      ORDER BY scl.item_id, scl.location_id, dcl.location_id, l.id
      FOR UPDATE OF l, dcl`,
    [params.tenantId, params.originalTransferMovementId]
  );
  if (linkRows.rowCount === 0) {
    throw new Error('TRANSFER_REVERSAL_COST_LINKS_REQUIRED');
  }

  const destLayerIds = Array.from(new Set(linkRows.rows.map((row) => row.dest_cost_layer_id)));
  const consumedDest = await params.client.query<{ cost_layer_id: string }>(
    `SELECT DISTINCT cost_layer_id
       FROM cost_layer_consumptions
      WHERE tenant_id = $1
        AND cost_layer_id = ANY($2::uuid[])`,
    [params.tenantId, destLayerIds]
  );
  if (consumedDest.rowCount > 0) {
    throw new Error('TRANSFER_REVERSAL_NOT_POSSIBLE_CONSUMED');
  }

  for (const row of linkRows.rows) {
    const reversalOutLineId = params.reversalLineByOriginalLineId.get(row.transfer_in_line_id);
    const reversalInLineId = params.reversalLineByOriginalLineId.get(row.transfer_out_line_id);
    if (!reversalOutLineId || !reversalInLineId) {
      throw new Error('TRANSFER_REVERSAL_LINE_MAPPING_MISSING');
    }

    const quantity = roundQuantity(toNumber(row.quantity));
    const unitCost = roundQuantity(toNumber(row.unit_cost));
    const extendedCost = roundQuantity(quantity * unitCost);

    const currentRemaining = roundQuantity(toNumber(row.dest_remaining_quantity));
    if (currentRemaining + EPSILON < quantity) {
      throw new Error('TRANSFER_REVERSAL_NOT_POSSIBLE_CONSUMED');
    }

    await params.client.query(
      `INSERT INTO cost_layer_consumptions (
          id, tenant_id, cost_layer_id,
          consumed_quantity, unit_cost, extended_cost,
          consumption_type, consumption_document_id, movement_id,
          consumed_at, notes
       ) VALUES ($1,$2,$3,$4,$5,$6,'transfer_out',$7,$8,$9,$10)`,
      [
        uuidv4(),
        params.tenantId,
        row.dest_cost_layer_id,
        quantity,
        unitCost,
        extendedCost,
        reversalOutLineId,
        params.reversalMovementId,
        params.occurredAt,
        params.notes ?? null
      ]
    );

    const nextRemaining = roundQuantity(currentRemaining - quantity);
    await updateLayerRemaining(params.client, row.dest_cost_layer_id, nextRemaining, unitCost);

    const destLayer = await createCostLayer({
      tenant_id: params.tenantId,
      item_id: row.source_item_id,
      location_id: row.source_location_id,
      uom: row.source_uom,
      quantity,
      unit_cost: unitCost,
      source_type: 'transfer_in',
      source_document_id: reversalInLineId,
      movement_id: params.reversalMovementId,
      layer_date: params.occurredAt,
      notes: params.notes ?? undefined,
      client: params.client
    });

    await params.client.query(
      `INSERT INTO cost_layer_transfer_links (
          id,
          tenant_id,
          transfer_movement_id,
          transfer_out_line_id,
          transfer_in_line_id,
          source_cost_layer_id,
          dest_cost_layer_id,
          quantity,
          unit_cost,
          extended_cost,
          created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        uuidv4(),
        params.tenantId,
        params.reversalMovementId,
        reversalOutLineId,
        reversalInLineId,
        row.dest_cost_layer_id,
        destLayer.id,
        quantity,
        unitCost,
        extendedCost,
        params.occurredAt
      ]
    );

  }
}

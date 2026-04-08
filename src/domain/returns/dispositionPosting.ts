import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { roundQuantity, toNumber } from '../../lib/numbers';
import { buildPlannedMovementFromLines, planMovementLines } from '../../services/inventoryMovementPlanner';
import type { PlannedWorkOrderMovement } from '../../services/inventoryMovementPlanner';
import { ensureInventoryBalanceRowAndLock, persistInventoryMovement } from '../../domains/inventory';
import { validateResolvedStockLevels } from '../../services/stockValidation.service';
import { createCostLayer } from '../../services/costLayers.service';
import {
  assertNoDuplicateTransferLink,
  relocateTransferCostLayersInTx
} from '../../services/transferCosting.service';
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

type PersistedReturnDispositionMovementLineRow = {
  id: string;
  item_id: string;
  location_id: string;
  uom: string;
  canonical_uom: string | null;
  quantity_delta: string | number;
  quantity_delta_canonical: string | number | null;
  reason_code: string | null;
  line_notes: string | null;
};

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

export type ReturnDispositionCostArtifactAssessment = Readonly<{
  ready: boolean;
  repairable: boolean;
  reason: string | null;
  details: Record<string, unknown>;
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

function buildDispositionMovementLineKey(params: {
  itemId: string;
  locationId: string;
  uom: string;
  quantity: number;
  reasonCode: string;
}) {
  return `${params.itemId}:${params.locationId}:${params.uom}:${roundQuantity(params.quantity).toFixed(6)}:${params.reasonCode}`;
}

function parseDispositionSourceLineIdFromLineNotes(lineNotes: string | null): string | null {
  if (typeof lineNotes !== 'string') {
    return null;
  }
  const match = /^Return disposition ([0-9a-f-]{36}) line ([0-9a-f-]{36}) (outbound|inbound)$/i.exec(lineNotes.trim());
  if (!match) {
    return null;
  }
  return `${match[1]}:${match[2]}:${match[3].toLowerCase() === 'outbound' ? 'out' : 'in'}`;
}

async function buildReturnDispositionRepairPlan(params: {
  client: PoolClient;
  tenantId: string;
  disposition: LockedReturnDispositionRow;
  dispositionLines: ReadonlyArray<LockedReturnDispositionLineRow>;
}) {
  const warehouseId = await resolveWarehouseIdForLocation(
    params.tenantId,
    params.disposition.from_location_id,
    params.client
  );
  if (!warehouseId) {
    throw new Error('WAREHOUSE_SCOPE_REQUIRED');
  }
  if (!params.disposition.to_location_id) {
    throw new Error('RETURN_DISPOSITION_DESTINATION_REQUIRED');
  }

  const reasonCodes = buildDispositionReasonCodes(params.disposition.disposition_type);
  const plannedLines = await planMovementLines({
    tenantId: params.tenantId,
    lines: params.dispositionLines.flatMap((line) => {
      const quantity = roundQuantity(toNumber(line.quantity));
      return [
        {
          sourceLineId: `${params.disposition.id}:${line.id}:out`,
          warehouseId,
          itemId: line.item_id,
          locationId: params.disposition.from_location_id,
          quantity: -quantity,
          uom: line.uom,
          defaultReasonCode: reasonCodes.outbound,
          lineNotes: line.notes ?? `Return disposition ${params.disposition.id} line ${line.id} outbound`
        },
        {
          sourceLineId: `${params.disposition.id}:${line.id}:in`,
          warehouseId,
          itemId: line.item_id,
          locationId: params.disposition.to_location_id!,
          quantity,
          uom: line.uom,
          defaultReasonCode: reasonCodes.inbound,
          lineNotes: line.notes ?? `Return disposition ${params.disposition.id} line ${line.id} inbound`
        }
      ];
    }),
    client: params.client
  });

  const actualLineBySource = new Map(plannedLines.map((line) => [line.sourceLineId, line]));
  const pairs = params.dispositionLines.map((line) => {
    const outSourceLineId = `${params.disposition.id}:${line.id}:out`;
    const inSourceLineId = `${params.disposition.id}:${line.id}:in`;
    const outbound = actualLineBySource.get(outSourceLineId);
    const inbound = actualLineBySource.get(inSourceLineId);
    if (!outbound || !inbound) {
      throw new Error('RETURN_DISPOSITION_PLAN_PAIR_MISSING');
    }
    return {
      itemId: line.item_id,
      sourceLocationId: params.disposition.from_location_id,
      destinationLocationId: params.disposition.to_location_id!,
      canonicalUom: outbound.canonicalFields.canonicalUom,
      quantity: inbound.canonicalFields.quantityDeltaCanonical,
      outSourceLineId,
      inSourceLineId
    };
  });

  return {
    occurredAt: params.disposition.occurred_at ? new Date(params.disposition.occurred_at) : new Date(),
    plannedLines,
    pairs
  };
}

async function mapReturnDispositionPersistedLineIds(params: {
  client: PoolClient;
  tenantId: string;
  movementId: string;
  plannedLines: ReadonlyArray<{
    sourceLineId: string;
    itemId: string;
    locationId: string;
    canonicalFields: { canonicalUom: string; quantityDeltaCanonical: number };
    reasonCode: string;
  }>;
}) {
  const persistedLineResult = await params.client.query<PersistedReturnDispositionMovementLineRow>(
      `SELECT id,
              item_id,
              location_id,
              uom,
              canonical_uom,
              quantity_delta,
              quantity_delta_canonical,
              reason_code,
              line_notes
         FROM inventory_movement_lines
        WHERE tenant_id = $1
          AND movement_id = $2
      ORDER BY item_id ASC,
               location_id ASC,
               COALESCE(canonical_uom, uom) ASC,
               COALESCE(quantity_delta_canonical, quantity_delta) ASC,
               COALESCE(reason_code, '') ASC,
               id ASC`,
    [params.tenantId, params.movementId]
  );

  const plannedSourceIds = new Set(params.plannedLines.map((line) => line.sourceLineId));
  const lineIdBySource = new Map<string, string>();
  const unmatchedPersistedRows: PersistedReturnDispositionMovementLineRow[] = [];

  for (const row of persistedLineResult.rows) {
    const sourceLineId = parseDispositionSourceLineIdFromLineNotes(row.line_notes);
    if (sourceLineId && plannedSourceIds.has(sourceLineId)) {
      if (lineIdBySource.has(sourceLineId)) {
        throw new Error('RETURN_DISPOSITION_COST_REPAIR_AMBIGUOUS_MAPPING');
      }
      lineIdBySource.set(sourceLineId, row.id);
      continue;
    }
    unmatchedPersistedRows.push(row);
  }

  const unmatchedPlannedLines = params.plannedLines.filter(
    (line) => !lineIdBySource.has(line.sourceLineId)
  );
  const remainingShapeCounts = new Map<string, number>();
  for (const line of unmatchedPlannedLines) {
    const key = buildDispositionMovementLineKey({
      itemId: line.itemId,
      locationId: line.locationId,
      uom: line.canonicalFields.canonicalUom,
      quantity: line.canonicalFields.quantityDeltaCanonical,
      reasonCode: line.reasonCode
    });
    remainingShapeCounts.set(key, (remainingShapeCounts.get(key) ?? 0) + 1);
  }
  for (const count of remainingShapeCounts.values()) {
    if (count > 1) {
      throw new Error('RETURN_DISPOSITION_COST_REPAIR_AMBIGUOUS_MAPPING');
    }
  }

  const queueByKey = new Map<string, PersistedReturnDispositionMovementLineRow[]>();
  for (const row of unmatchedPersistedRows) {
    const key = buildDispositionMovementLineKey({
      itemId: row.item_id,
      locationId: row.location_id,
      uom: row.canonical_uom ?? row.uom,
      quantity: toNumber(row.quantity_delta_canonical ?? row.quantity_delta),
      reasonCode: row.reason_code ?? ''
    });
    const queue = queueByKey.get(key) ?? [];
    queue.push(row);
    queueByKey.set(key, queue);
  }

  for (const line of unmatchedPlannedLines) {
    const key = buildDispositionMovementLineKey({
      itemId: line.itemId,
      locationId: line.locationId,
      uom: line.canonicalFields.canonicalUom,
      quantity: line.canonicalFields.quantityDeltaCanonical,
      reasonCode: line.reasonCode
    });
    const queue = queueByKey.get(key);
    const row = queue?.shift();
    if (!row) {
      throw new Error('RETURN_DISPOSITION_PERSISTED_LINE_MISSING');
    }
    lineIdBySource.set(line.sourceLineId, row.id);
  }

  return lineIdBySource;
}

async function assertReturnDispositionTransferCostIntegrity(params: {
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

async function rebuildReturnDispositionLinksFromConsumptions(params: {
  client: PoolClient;
  tenantId: string;
  movementId: string;
  occurredAt: Date;
  note: string;
  lineIdBySource: Map<string, string>;
  pairs: ReadonlyArray<ReturnDispositionPlanPair>;
}) {
  const outLineIds = params.pairs
    .map((pair) => params.lineIdBySource.get(pair.outSourceLineId))
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  const consumptionResult = await params.client.query<{
    cost_layer_id: string;
    consumption_document_id: string;
    consumed_quantity: string | number;
    unit_cost: string | number;
    extended_cost: string | number;
  }>(
    `SELECT cost_layer_id,
            consumption_document_id,
            consumed_quantity,
            unit_cost,
            extended_cost
       FROM cost_layer_consumptions
      WHERE tenant_id = $1
        AND movement_id = $2
        AND consumption_type = 'transfer_out'
        AND consumption_document_id = ANY($3::uuid[])
      ORDER BY consumption_document_id ASC, id ASC`,
    [params.tenantId, params.movementId, outLineIds]
  );

  const rowsByOutLineId = new Map<string, typeof consumptionResult.rows>();
  for (const row of consumptionResult.rows) {
    const bucket = rowsByOutLineId.get(row.consumption_document_id) ?? [];
    bucket.push(row);
    rowsByOutLineId.set(row.consumption_document_id, bucket);
  }

  for (const pair of params.pairs) {
    const outLineId = params.lineIdBySource.get(pair.outSourceLineId);
    const inLineId = params.lineIdBySource.get(pair.inSourceLineId);
    if (!outLineId || !inLineId) {
      throw new Error('RETURN_DISPOSITION_PERSISTED_LINE_ID_MISSING');
    }

    const rows = rowsByOutLineId.get(outLineId) ?? [];
    const consumedQuantity = roundQuantity(rows.reduce((sum, row) => sum + toNumber(row.consumed_quantity), 0));
    if (Math.abs(consumedQuantity - pair.quantity) > 1e-6) {
      throw new Error('RETURN_DISPOSITION_COST_REPAIR_CONSUMPTION_MISMATCH');
    }

    for (const row of rows) {
      const quantity = roundQuantity(toNumber(row.consumed_quantity));
      const unitCost = roundQuantity(toNumber(row.unit_cost));
      const extendedCost = roundQuantity(toNumber(row.extended_cost));
      const destLayer = await createCostLayer({
        tenant_id: params.tenantId,
        item_id: pair.itemId,
        location_id: pair.destinationLocationId,
        uom: pair.canonicalUom,
        quantity,
        unit_cost: unitCost,
        source_type: 'transfer_in',
        source_document_id: inLineId,
        movement_id: params.movementId,
        layer_date: params.occurredAt,
        notes: params.note,
        client: params.client
      });

      await assertNoDuplicateTransferLink({
        client: params.client,
        tenantId: params.tenantId,
        transferMovementId: params.movementId,
        outLineId,
        inLineId,
        sourceCostLayerId: row.cost_layer_id,
        destCostLayerId: destLayer.id
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
          params.movementId,
          outLineId,
          inLineId,
          row.cost_layer_id,
          destLayer.id,
          quantity,
          unitCost,
          extendedCost,
          params.occurredAt
        ]
      );
    }
  }
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
        AND (
          rd.status = 'posted'
          OR 1 = (
            SELECT COUNT(*)::int
             FROM inventory_movements im
             WHERE im.tenant_id = rd.tenant_id
               AND im.source_type = 'return_disposition_post'
               AND im.source_id = rd.id::text
               AND im.movement_type = 'transfer'
               AND im.status = 'posted'
               AND EXISTS (
                 SELECT 1
                   FROM inventory_movement_lines iml
                  WHERE iml.tenant_id = im.tenant_id
                    AND iml.movement_id = im.id
               )
          )
        )
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

export async function assessReturnDispositionCostArtifacts(params: {
  client: PoolClient;
  tenantId: string;
  dispositionId: string;
  movementId: string;
}): Promise<ReturnDispositionCostArtifactAssessment> {
  const [dispositionResult, linesResult, summaryResult] = await Promise.all([
    params.client.query<LockedReturnDispositionRow>(
      `SELECT id,
              return_receipt_id,
              disposition_type,
              occurred_at,
              from_location_id,
              to_location_id,
              notes
         FROM return_dispositions
        WHERE tenant_id = $1
          AND id = $2
        LIMIT 1`,
      [params.tenantId, params.dispositionId]
    ),
    params.client.query<LockedReturnDispositionLineRow>(
      `SELECT id, line_number, item_id, uom, quantity, notes
         FROM return_disposition_lines
        WHERE tenant_id = $1
          AND return_disposition_id = $2
        ORDER BY line_number ASC NULLS LAST, created_at ASC, id ASC`,
      [params.tenantId, params.dispositionId]
    ),
    params.client.query<{
      link_count: string;
      consumption_count: string;
      transfer_in_layer_count: string;
    }>(
      `SELECT
          (SELECT COUNT(*)::text
             FROM cost_layer_transfer_links
            WHERE tenant_id = $1
              AND transfer_movement_id = $2) AS link_count,
          (SELECT COUNT(*)::text
             FROM cost_layer_consumptions
            WHERE tenant_id = $1
              AND movement_id = $2
              AND consumption_type = 'transfer_out') AS consumption_count,
          (SELECT COUNT(*)::text
             FROM inventory_cost_layers
            WHERE tenant_id = $1
              AND movement_id = $2
              AND source_type = 'transfer_in'
              AND voided_at IS NULL) AS transfer_in_layer_count`,
      [params.tenantId, params.movementId]
    )
  ]);

  const disposition = dispositionResult.rows[0] ?? null;
  if (!disposition) {
    return Object.freeze({
      ready: false,
      repairable: false,
      reason: 'return_disposition_missing',
      details: { dispositionId: params.dispositionId }
    });
  }

  const repairPlan = await buildReturnDispositionRepairPlan({
    client: params.client,
    tenantId: params.tenantId,
    disposition,
    dispositionLines: linesResult.rows
  });

  try {
    const lineIdBySource = await mapReturnDispositionPersistedLineIds({
      client: params.client,
      tenantId: params.tenantId,
      movementId: params.movementId,
      plannedLines: repairPlan.plannedLines
    });
    for (const pair of repairPlan.pairs) {
      const outLineId = lineIdBySource.get(pair.outSourceLineId);
      const inLineId = lineIdBySource.get(pair.inSourceLineId);
      if (!outLineId || !inLineId) {
        throw new Error('RETURN_DISPOSITION_PERSISTED_LINE_ID_MISSING');
      }
      await assertReturnDispositionTransferCostIntegrity({
        client: params.client,
        tenantId: params.tenantId,
        movementId: params.movementId,
        outLineId,
        inLineId,
        expectedQuantity: pair.quantity
      });
    }
    return Object.freeze({
      ready: true,
      repairable: false,
      reason: null,
      details: {
        dispositionId: params.dispositionId,
        movementId: params.movementId
      }
    });
  } catch (error) {
    const summary = summaryResult.rows[0] ?? {
      link_count: '0',
      consumption_count: '0',
      transfer_in_layer_count: '0'
    };
    return Object.freeze({
      ready: false,
      repairable: (error as Error)?.message !== 'RETURN_DISPOSITION_COST_REPAIR_AMBIGUOUS_MAPPING',
      reason: (error as Error)?.message === 'RETURN_DISPOSITION_COST_REPAIR_AMBIGUOUS_MAPPING'
        ? 'return_disposition_cost_repair_ambiguous_mapping'
        : 'return_disposition_cost_artifacts_missing_or_inconsistent',
      details: {
        dispositionId: params.dispositionId,
        movementId: params.movementId,
        validationError: (error as Error)?.message ?? 'RETURN_DISPOSITION_COST_VALIDATION_FAILED',
        linkCount: Number(summary.link_count ?? 0),
        consumptionCount: Number(summary.consumption_count ?? 0),
        transferInLayerCount: Number(summary.transfer_in_layer_count ?? 0)
      }
    });
  }
}

export async function repairReturnDispositionCostArtifacts(params: {
  client: PoolClient;
  tenantId: string;
  dispositionId: string;
  movementId: string;
}) {
  const dispositionResult = await params.client.query<LockedReturnDispositionRow>(
    `SELECT id,
            return_receipt_id,
            disposition_type,
            occurred_at,
            from_location_id,
            to_location_id,
            notes
       FROM return_dispositions
      WHERE tenant_id = $1
        AND id = $2
      LIMIT 1`,
    [params.tenantId, params.dispositionId]
  );
  const disposition = dispositionResult.rows[0] ?? null;
  if (!disposition) {
    throw new Error('RETURN_DISPOSITION_NOT_FOUND');
  }
  const linesResult = await params.client.query<LockedReturnDispositionLineRow>(
    `SELECT id, line_number, item_id, uom, quantity, notes
       FROM return_disposition_lines
      WHERE tenant_id = $1
        AND return_disposition_id = $2
      ORDER BY line_number ASC NULLS LAST, created_at ASC, id ASC`,
    [params.tenantId, params.dispositionId]
  );
  if ((linesResult.rowCount ?? 0) === 0) {
    throw new Error('RETURN_DISPOSITION_NO_LINES');
  }

  const repairPlan = await buildReturnDispositionRepairPlan({
    client: params.client,
    tenantId: params.tenantId,
    disposition,
    dispositionLines: linesResult.rows
  });
  const lineIdBySource = await mapReturnDispositionPersistedLineIds({
    client: params.client,
    tenantId: params.tenantId,
    movementId: params.movementId,
    plannedLines: repairPlan.plannedLines
  });

  const artifactCounts = await params.client.query<{
    link_count: string;
    consumption_count: string;
    transfer_in_layer_count: string;
  }>(
    `SELECT
        (SELECT COUNT(*)::text
           FROM cost_layer_transfer_links
          WHERE tenant_id = $1
            AND transfer_movement_id = $2) AS link_count,
        (SELECT COUNT(*)::text
           FROM cost_layer_consumptions
          WHERE tenant_id = $1
            AND movement_id = $2
            AND consumption_type = 'transfer_out') AS consumption_count,
        (SELECT COUNT(*)::text
           FROM inventory_cost_layers
          WHERE tenant_id = $1
            AND movement_id = $2
            AND source_type = 'transfer_in'
            AND voided_at IS NULL) AS transfer_in_layer_count`,
    [params.tenantId, params.movementId]
  );
  const counts = artifactCounts.rows[0] ?? {
    link_count: '0',
    consumption_count: '0',
    transfer_in_layer_count: '0'
  };
  const linkCount = Number(counts.link_count ?? 0);
  const consumptionCount = Number(counts.consumption_count ?? 0);
  const transferInLayerCount = Number(counts.transfer_in_layer_count ?? 0);
  if (linkCount === 0 && transferInLayerCount === 0 && consumptionCount > 0) {
    await rebuildReturnDispositionLinksFromConsumptions({
      client: params.client,
      tenantId: params.tenantId,
      movementId: params.movementId,
      occurredAt: repairPlan.occurredAt,
      note: `Return disposition ${params.dispositionId}`,
      lineIdBySource,
      pairs: repairPlan.pairs
    });
    return;
  }
  if (linkCount > 0 || transferInLayerCount > 0 || consumptionCount > 0) {
    throw new Error('RETURN_DISPOSITION_COST_REPAIR_UNSAFE');
  }

  await relocateTransferCostLayersInTx({
    client: params.client,
    tenantId: params.tenantId,
    transferMovementId: params.movementId,
    occurredAt: repairPlan.occurredAt,
    notes: `Return disposition ${params.dispositionId}`,
    pairs: repairPlan.pairs.map((pair) => {
      const outLineId = lineIdBySource.get(pair.outSourceLineId);
      const inLineId = lineIdBySource.get(pair.inSourceLineId);
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

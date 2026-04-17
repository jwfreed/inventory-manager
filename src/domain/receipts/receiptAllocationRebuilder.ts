import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { roundQuantity } from '../../lib/numbers';
import { RECEIPT_STATUS_EPSILON } from './receiptPolicy';
import {
  RECEIPT_ALLOCATION_STATUSES,
  createRebuildReceiptAllocationWriteContext,
  replaceReceiptAllocationsForReceipt,
  validateReceiptAllocationMutationContext,
  type ReceiptAllocation,
  type ReceiptAllocationStatus,
  type ReceiptAllocationValidationRequirement,
  type ValidatedReceiptAllocationMutationContext
} from './receiptAllocationModel';

type ReceiptLineRebuildRow = {
  id: string;
  purchase_order_receipt_id: string;
  inventory_movement_id: string | null;
  received_to_location_id: string;
  item_id: string;
  quantity_received: string | number;
};

type WorkingAllocation = ReceiptAllocation & {
  sortKey: string;
};

type MovementLineMatch = {
  id: string;
  quantity: string | number;
  line_notes: string | null;
  created_at: string;
};

function failAuthoritativeInconsistency(message: string): never {
  throw new Error(`RECEIPT_AUTHORITATIVE_DATA_INCONSISTENT:${message}`);
}

function nextSortKey(prefix: string, index: number) {
  return `${prefix}:${String(index).padStart(8, '0')}`;
}

async function loadWarehouseIdForLocation(
  client: PoolClient,
  tenantId: string,
  locationId: string
) {
  const result = await client.query(
    `SELECT COALESCE(warehouse_id, id) AS warehouse_id
       FROM locations
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, locationId]
  );
  const warehouseId = result.rows[0]?.warehouse_id;
  if (!warehouseId) {
    failAuthoritativeInconsistency('location_warehouse_missing');
  }
  return warehouseId as string;
}

async function loadDefaultBinForLocation(
  client: PoolClient,
  tenantId: string,
  locationId: string
) {
  const result = await client.query(
    `SELECT id
       FROM inventory_bins
      WHERE tenant_id = $1
        AND location_id = $2
      ORDER BY is_default DESC, created_at ASC, id ASC
      LIMIT 1`,
    [tenantId, locationId]
  );
  const binId = result.rows[0]?.id;
  if (!binId) {
    failAuthoritativeInconsistency('default_bin_missing');
  }
  return binId as string;
}

async function loadReceiptCostLayerId(
  client: PoolClient,
  tenantId: string,
  receiptLineId: string
) {
  const result = await client.query(
    `SELECT id
       FROM inventory_cost_layers
      WHERE tenant_id = $1
        AND source_type = 'receipt'
        AND source_document_id = $2
        AND voided_at IS NULL
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
    [tenantId, receiptLineId]
  );
  return result.rows[0]?.id ?? null;
}

async function findMovementLine(params: {
  client: PoolClient;
  tenantId: string;
  movementId: string;
  itemId: string;
  locationId: string;
  quantity: number;
  direction: 'positive' | 'negative';
  noteIncludes?: string;
}) {
  const result = await params.client.query<MovementLineMatch>(
    `SELECT id,
            COALESCE(quantity_delta_canonical, quantity_delta)::numeric AS quantity,
            line_notes,
            created_at
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND movement_id = $2
        AND item_id = $3
        AND location_id = $4
        AND ${params.direction === 'positive'
          ? 'COALESCE(quantity_delta_canonical, quantity_delta) > 0'
          : 'COALESCE(quantity_delta_canonical, quantity_delta) < 0'}
      ORDER BY created_at ASC, id ASC`,
    [params.tenantId, params.movementId, params.itemId, params.locationId]
  );
  let candidates = result.rows.filter(
    (row) => Math.abs(Math.abs(Number(row.quantity ?? 0)) - params.quantity) <= RECEIPT_STATUS_EPSILON
  );
  if (params.noteIncludes) {
    const noteMatches = candidates.filter((row) => row.line_notes?.includes(params.noteIncludes ?? ''));
    if (noteMatches.length > 0) {
      candidates = noteMatches;
    }
  }
  if (candidates.length !== 1) {
    failAuthoritativeInconsistency('movement_line_ambiguous');
  }
  return candidates[0];
}

function consumeWorkingAllocations(params: {
  allocations: WorkingAllocation[];
  receiptLineId: string;
  status: ReceiptAllocationStatus;
  binId?: string | null;
  quantity: number;
}) {
  let remaining = roundQuantity(params.quantity);
  const consumed: Array<{ allocation: WorkingAllocation; quantity: number }> = [];
  const candidates = params.allocations
    .filter(
      (allocation) =>
        allocation.receiptLineId === params.receiptLineId
        && allocation.status === params.status
        && (!params.binId || allocation.binId === params.binId)
    )
    .sort((left, right) => {
      const sortCompare = left.sortKey.localeCompare(right.sortKey);
      if (sortCompare !== 0) return sortCompare;
      return String(left.id ?? '').localeCompare(String(right.id ?? ''));
    });

  for (const allocation of candidates) {
    if (remaining <= RECEIPT_STATUS_EPSILON) {
      break;
    }
    const quantity = Math.min(remaining, allocation.quantity);
    consumed.push({ allocation: { ...allocation }, quantity });
    remaining = roundQuantity(remaining - quantity);
    allocation.quantity = roundQuantity(allocation.quantity - quantity);
  }

  for (let index = params.allocations.length - 1; index >= 0; index -= 1) {
    if (params.allocations[index].quantity <= RECEIPT_STATUS_EPSILON) {
      params.allocations.splice(index, 1);
    }
  }

  if (remaining > RECEIPT_STATUS_EPSILON) {
    failAuthoritativeInconsistency('allocation_consumption_underflow');
  }
  return consumed;
}

async function rebuildFromAuthoritativeSources(params: {
  client: PoolClient;
  tenantId: string;
  receiptId: string;
}) {
  const linesResult = await params.client.query<ReceiptLineRebuildRow>(
    `SELECT prl.id,
            prl.purchase_order_receipt_id,
            por.inventory_movement_id,
            por.received_to_location_id,
            pol.item_id,
            prl.quantity_received
       FROM purchase_order_receipt_lines prl
       JOIN purchase_order_receipts por
         ON por.id = prl.purchase_order_receipt_id
        AND por.tenant_id = prl.tenant_id
       JOIN purchase_order_lines pol
         ON pol.id = prl.purchase_order_line_id
        AND pol.tenant_id = prl.tenant_id
      WHERE prl.tenant_id = $1
        AND prl.purchase_order_receipt_id = $2
      ORDER BY prl.created_at ASC, prl.id ASC
      FOR UPDATE`,
    [params.tenantId, params.receiptId]
  );
  const lines = linesResult.rows;
  const allocations: WorkingAllocation[] = [];
  const expectedQtyByLine = new Map<string, number>();

  for (const [index, line] of lines.entries()) {
    const quantity = roundQuantity(Number(line.quantity_received ?? 0));
    expectedQtyByLine.set(line.id, quantity);
    if (quantity <= RECEIPT_STATUS_EPSILON) {
      continue;
    }
    if (!line.inventory_movement_id) {
      failAuthoritativeInconsistency('receipt_movement_missing');
    }
    const movementLine = await findMovementLine({
      client: params.client,
      tenantId: params.tenantId,
      movementId: line.inventory_movement_id,
      itemId: line.item_id,
      locationId: line.received_to_location_id,
      quantity,
      direction: 'positive',
      noteIncludes: line.id
    });
    const warehouseId = await loadWarehouseIdForLocation(
      params.client,
      params.tenantId,
      line.received_to_location_id
    );
    const binId = await loadDefaultBinForLocation(params.client, params.tenantId, line.received_to_location_id);
    const costLayerId = await loadReceiptCostLayerId(params.client, params.tenantId, line.id);
    allocations.push({
      id: uuidv4(),
      receiptId: line.purchase_order_receipt_id,
      receiptLineId: line.id,
      warehouseId,
      locationId: line.received_to_location_id,
      binId,
      inventoryMovementId: line.inventory_movement_id,
      inventoryMovementLineId: movementLine.id,
      costLayerId,
      quantity,
      status: RECEIPT_ALLOCATION_STATUSES.QA,
      sortKey: nextSortKey('receive', index)
    });
  }

  const qcResult = await params.client.query(
    `SELECT qe.id,
            qe.purchase_order_receipt_line_id,
            qe.event_type,
            qe.quantity,
            qe.source_bin_id,
            qe.destination_bin_id,
            prl.purchase_order_receipt_id,
            pol.item_id,
            ib.location_id AS destination_location_id,
            qil.inventory_movement_id
       FROM qc_events qe
       JOIN purchase_order_receipt_lines prl
         ON prl.id = qe.purchase_order_receipt_line_id
        AND prl.tenant_id = qe.tenant_id
       JOIN purchase_order_lines pol
         ON pol.id = prl.purchase_order_line_id
        AND pol.tenant_id = prl.tenant_id
       JOIN inventory_bins ib
         ON ib.id = qe.destination_bin_id
        AND ib.tenant_id = qe.tenant_id
       LEFT JOIN qc_inventory_links qil
         ON qil.qc_event_id = qe.id
        AND qil.tenant_id = qe.tenant_id
      WHERE qe.tenant_id = $1
        AND prl.purchase_order_receipt_id = $2
      ORDER BY qe.occurred_at ASC, qe.id ASC`,
    [params.tenantId, params.receiptId]
  );
  for (const [index, event] of qcResult.rows.entries()) {
    if (!event.inventory_movement_id) {
      failAuthoritativeInconsistency('qc_movement_missing');
    }
    const quantity = roundQuantity(Number(event.quantity ?? 0));
    const consumed = consumeWorkingAllocations({
      allocations,
      receiptLineId: event.purchase_order_receipt_line_id,
      status: RECEIPT_ALLOCATION_STATUSES.QA,
      binId: event.source_bin_id,
      quantity
    });
    const movementLine = await findMovementLine({
      client: params.client,
      tenantId: params.tenantId,
      movementId: event.inventory_movement_id,
      itemId: event.item_id,
      locationId: event.destination_location_id,
      quantity,
      direction: 'positive'
    });
    const destinationStatus =
      event.event_type === 'accept'
        ? RECEIPT_ALLOCATION_STATUSES.AVAILABLE
        : RECEIPT_ALLOCATION_STATUSES.HOLD;
    for (const [consumedIndex, item] of consumed.entries()) {
      allocations.push({
        ...item.allocation,
        id: uuidv4(),
        locationId: event.destination_location_id,
        binId: event.destination_bin_id,
        inventoryMovementId: event.inventory_movement_id,
        inventoryMovementLineId: movementLine.id,
        quantity: item.quantity,
        status: destinationStatus,
        sortKey: nextSortKey(`qc:${index}`, consumedIndex)
      });
    }
  }

  const putawayResult = await params.client.query(
    `SELECT pl.id,
            pl.purchase_order_receipt_line_id,
            pl.item_id,
            pl.quantity_planned,
            pl.from_bin_id,
            pl.to_location_id,
            pl.to_bin_id,
            pl.inventory_movement_id,
            p.inventory_movement_id AS putaway_movement_id
       FROM putaway_lines pl
       JOIN putaways p
         ON p.id = pl.putaway_id
      WHERE pl.tenant_id = $1
        AND p.purchase_order_receipt_id = $2
        AND pl.status = 'completed'
      ORDER BY pl.updated_at ASC, pl.id ASC`,
    [params.tenantId, params.receiptId]
  );
  for (const [index, line] of putawayResult.rows.entries()) {
    const movementId = line.inventory_movement_id ?? line.putaway_movement_id;
    if (!movementId) {
      failAuthoritativeInconsistency('putaway_movement_missing');
    }
    const quantity = roundQuantity(Number(line.quantity_planned ?? 0));
    const consumed = consumeWorkingAllocations({
      allocations,
      receiptLineId: line.purchase_order_receipt_line_id,
      status: RECEIPT_ALLOCATION_STATUSES.QA,
      binId: line.from_bin_id,
      quantity
    });
    const movementLine = await findMovementLine({
      client: params.client,
      tenantId: params.tenantId,
      movementId,
      itemId: line.item_id,
      locationId: line.to_location_id,
      quantity,
      direction: 'positive'
    });
    for (const [consumedIndex, item] of consumed.entries()) {
      allocations.push({
        ...item.allocation,
        id: uuidv4(),
        locationId: line.to_location_id,
        binId: line.to_bin_id,
        inventoryMovementId: movementId,
        inventoryMovementLineId: movementLine.id,
        quantity: item.quantity,
        status: RECEIPT_ALLOCATION_STATUSES.AVAILABLE,
        sortKey: nextSortKey(`putaway:${index}`, consumedIndex)
      });
    }
  }

  return {
    expectedQtyByLine,
    allocations: allocations
      .sort((left, right) => {
        const lineCompare = left.receiptLineId.localeCompare(right.receiptLineId);
        if (lineCompare !== 0) return lineCompare;
        return left.sortKey.localeCompare(right.sortKey);
      })
      .map(({ sortKey: _sortKey, ...allocation }) => allocation)
  };
}

export async function rebuildReceiptAllocations(params: {
  client: PoolClient;
  tenantId: string;
  receiptId: string;
  occurredAt: Date;
}) {
  const rebuilt = await rebuildFromAuthoritativeSources(params);
  const context = createRebuildReceiptAllocationWriteContext({
    tenantId: params.tenantId,
    expectedQtyByReceiptLineId: rebuilt.expectedQtyByLine,
    allocations: rebuilt.allocations
  });
  await replaceReceiptAllocationsForReceipt({
    client: params.client,
    tenantId: params.tenantId,
    receiptId: params.receiptId,
    allocations: rebuilt.allocations,
    occurredAt: params.occurredAt,
    context
  });
  return {
    linesRebuilt: rebuilt.expectedQtyByLine.size,
    allocationsCreated: rebuilt.allocations.length
  };
}

export async function validateOrRebuildReceiptAllocationsForMutation(params: {
  client: PoolClient;
  tenantId: string;
  receiptId: string;
  requirements: ReceiptAllocationValidationRequirement[];
  occurredAt: Date;
}): Promise<ValidatedReceiptAllocationMutationContext> {
  try {
    return await validateReceiptAllocationMutationContext(params);
  } catch (validationError) {
    try {
      await rebuildReceiptAllocations(params);
    } catch (rebuildError) {
      throw rebuildError;
    }
    try {
      return await validateReceiptAllocationMutationContext(params);
    } catch (_error) {
      throw new Error('RECEIPT_ALLOCATION_DRIFT_UNRECOVERABLE');
    }
  }
}
